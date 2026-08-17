import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, type Page } from 'playwright';
import { TelegramNotifier } from './telegram/TelegramNotifier.js';
import type { CollectedAd } from './domain/ad.js';

const SCANNER_API = 'https://qfpwpqflqiwjqpojmngy.supabase.co/functions/v1/scanner-api';

type DbCompetitor = { id: string; name?: string | null; source_url: string; query?: string | null; is_active: boolean };
type Workspace = { id: string; chat_id: number; project_name: string; geo: string; competitors: DbCompetitor[] };
type Card = Awaited<ReturnType<typeof extractCards>>[number];

type ParsedAd = {
  libraryId: string;
  advertiser: string;
  startedAt?: string;
  format: 'IMAGE' | 'VIDEO' | 'UNKNOWN';
  cta?: string;
  destinationType: string;
  primaryText: string;
  landingUrl?: string;
  creativeUrl?: string;
  adLibraryUrl: string;
};

function authHeaders() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is required');
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

async function getWorkspaces(): Promise<Workspace[]> {
  const response = await fetch(SCANNER_API, { headers: authHeaders() });
  if (!response.ok) throw new Error(`scanner-api GET failed: ${response.status} ${await response.text()}`);
  const body = await response.json() as { workspaces?: Workspace[] };
  return body.workspaces || [];
}

async function reconcile(workspaceId: string, competitorId: string, ads: ParsedAd[]) {
  const response = await fetch(SCANNER_API, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ action: 'reconcile', workspaceId, competitorId, ads }),
  });
  if (!response.ok) throw new Error(`scanner-api reconcile failed: ${response.status} ${await response.text()}`);
  return response.json() as Promise<{ events: Array<{ type: 'NEW' | 'REACTIVATED' | 'STOPPED'; ad: any }> }>;
}

function clean(value: string) {
  return value.replace(/\u200b/g, '').replace(/\n{3,}/g, '\n\n').trim();
}

function queryFromUrl(sourceUrl: string, fallback?: string | null) {
  try {
    const url = new URL(sourceUrl);
    const path = url.pathname.split('/').filter(Boolean)[0];
    if (path) return path.replace(/^@/, '');
    return url.hostname.replace(/^www\./, '').split('.')[0];
  } catch {
    return fallback || sourceUrl;
  }
}

function displayName(competitor: DbCompetitor) {
  return competitor.name || queryFromUrl(competitor.source_url, competitor.query);
}

function metaCountry(geo: string) {
  const first = geo.toUpperCase().split(/[\s,;]+/).filter(Boolean)[0] || 'ALL';
  return first === 'EU' || first === 'ALL' ? 'ALL' : first;
}

function adLibraryUrl(query: string, country: string) {
  const params = new URLSearchParams({ active_status: 'active', ad_type: 'all', country, q: query, search_type: 'keyword_unordered' });
  return `https://www.facebook.com/ads/library/?${params.toString()}`;
}

function parseAdvertiser(cardText: string) {
  const match = cardText.match(/(?:See ad details|See summary details)\s*\n([^\n]+)\s*\nSponsored/i);
  if (match?.[1]) return clean(match[1]);
  const lines = cardText.split('\n').map((line) => line.trim()).filter(Boolean);
  const sponsoredIndex = lines.findIndex((line) => /^Sponsored$/i.test(line));
  return sponsoredIndex > 0 ? lines[sponsoredIndex - 1] : '';
}

function advertiserMatches(advertiser: string, competitor: DbCompetitor) {
  const normalizedAdvertiser = advertiser.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ');
  const handle = queryFromUrl(competitor.source_url, competitor.query).toLowerCase();
  const tokens = handle.split(/[._\-\s]+/).filter((token) => token.length >= 4 && !['agency', 'official', 'ukraine'].includes(token));
  if (!tokens.length) return true;
  return tokens.some((token) => normalizedAdvertiser.includes(token));
}

function parsePrimaryText(cardText: string) {
  const sponsoredIndex = cardText.search(/\nSponsored\s*\n/i);
  if (sponsoredIndex < 0) return clean(cardText).slice(0, 5000);
  let text = cardText.slice(sponsoredIndex).replace(/^\n?Sponsored\s*\n/i, '');
  for (const marker of ['\nLow impression count', '\nImpressions:', '\nOpen Dropdown', '\nSee ad details']) {
    const index = text.indexOf(marker);
    if (index > 0) text = text.slice(0, index);
  }
  return clean(text).slice(0, 5000);
}

function parseStartedAt(cardText: string) {
  return cardText.match(/Started running on\s+([^\n·]+)/i)?.[1]?.trim();
}

const knownCtas = ['Send Message','Learn More','Sign Up','Book Now','Apply Now','Contact Us','Get Offer','Shop Now','Get Quote','Subscribe','Download','Watch More','Order Now','Buy Now','Get Started','WhatsApp','Надіслати повідомлення','Дізнатися більше','Зареєструватися','Забронювати','Зв’язатися з нами','Отримати пропозицію','Купити','Замовити'];

function parseCta(cardText: string, ctaTexts: string[]) {
  for (const value of ctaTexts) {
    const normalized = clean(value);
    if (knownCtas.some((cta) => cta.toLowerCase() === normalized.toLowerCase())) return normalized;
  }
  const lower = cardText.toLowerCase();
  return knownCtas.find((cta) => lower.includes(cta.toLowerCase()));
}

async function loadAllVisibleAds(page: Page) {
  let previousCount = 0;
  let stableRounds = 0;
  for (let round = 0; round < 30; round += 1) {
    const body = await page.locator('body').innerText().catch(() => '');
    const count = new Set([...body.matchAll(/Library ID\s*:?\s*(\d+)/gi)].map((m) => m[1])).size;
    stableRounds = count === previousCount ? stableRounds + 1 : 0;
    previousCount = count;
    if (stableRounds >= 3 && round >= 5) break;
    await page.mouse.wheel(0, 2800);
    await page.waitForTimeout(1200);
  }
}

async function extractCards(page: Page) {
  return page.evaluate(() => {
    const markerElements = Array.from(document.querySelectorAll<HTMLElement>('body *')).filter((el) => el.childElementCount === 0 && /^Library ID\s*:?\s*\d+$/i.test((el.textContent ?? '').trim()));
    const seen = new Set<string>();
    const cards: Array<{ libraryId: string; text: string; hrefs: string[]; ctaTexts: string[]; images: Array<{ url: string; renderedWidth: number; renderedHeight: number; naturalWidth: number; naturalHeight: number; alt: string }>; videoUrls: string[] }> = [];

    for (const marker of markerElements) {
      const libraryId = (marker.textContent ?? '').match(/(\d+)/)?.[1];
      if (!libraryId || seen.has(libraryId)) continue;
      let node: HTMLElement | null = marker;
      let card: HTMLElement | null = null;
      for (let depth = 0; depth < 14 && node; depth += 1) {
        const text = (node.innerText ?? '').trim();
        if (text.length > 120 && /Sponsored/i.test(text) && /Started running on/i.test(text)) {
          card = node;
          if (text.length > 900) break;
        }
        if (text.length > 18000) break;
        node = node.parentElement;
      }
      if (!card) continue;
      seen.add(libraryId);

      const hrefs = Array.from(card.querySelectorAll<HTMLAnchorElement>('a[href]')).map((a) => a.href).filter(Boolean);
      const ctaTexts = Array.from(card.querySelectorAll<HTMLElement>('a,button,[role="button"]')).map((el) => (el.innerText || el.textContent || '').trim()).filter((v) => v && v.length <= 60);
      const images: Array<{ url: string; renderedWidth: number; renderedHeight: number; naturalWidth: number; naturalHeight: number; alt: string }> = [];
      for (const img of Array.from(card.querySelectorAll<HTMLImageElement>('img'))) {
        const rect = img.getBoundingClientRect();
        const urls = [img.currentSrc || img.src, ...img.srcset.split(',').map((part) => part.trim().split(/\s+/)[0])].filter(Boolean);
        for (const url of urls) images.push({ url, renderedWidth: Math.round(rect.width), renderedHeight: Math.round(rect.height), naturalWidth: img.naturalWidth || 0, naturalHeight: img.naturalHeight || 0, alt: img.alt || '' });
      }
      for (const el of Array.from(card.querySelectorAll<HTMLElement>('*'))) {
        const match = getComputedStyle(el).backgroundImage.match(/url\(["']?(https?:\/\/[^"')]+)["']?\)/i);
        if (!match?.[1]) continue;
        const rect = el.getBoundingClientRect();
        images.push({ url: match[1], renderedWidth: Math.round(rect.width), renderedHeight: Math.round(rect.height), naturalWidth: 0, naturalHeight: 0, alt: '' });
      }
      const videos = Array.from(card.querySelectorAll<HTMLVideoElement>('video'));
      const videoUrls = videos.flatMap((video) => [video.src, video.currentSrc, ...Array.from(video.querySelectorAll<HTMLSourceElement>('source[src]')).map((source) => source.src)]).filter(Boolean);
      cards.push({ libraryId, text: card.innerText, hrefs: [...new Set(hrefs)], ctaTexts: [...new Set(ctaTexts)], images, videoUrls: [...new Set(videoUrls)] });
    }
    return cards;
  });
}

function cleanLandingUrl(href: string) {
  try {
    const url = new URL(href);
    const host = url.hostname.toLowerCase();
    if ((host === 'l.facebook.com' || host === 'lm.facebook.com') && url.pathname === '/l.php') {
      const target = url.searchParams.get('u');
      if (target) return decodeURIComponent(target);
    }
    if (host === 'facebook.com' || host.endsWith('.facebook.com') || host === 'meta.com' || host.endsWith('.meta.com')) return undefined;
    return url.toString();
  } catch { return undefined; }
}

function pickLandingUrl(hrefs: string[]) {
  for (const href of hrefs) {
    const cleaned = cleanLandingUrl(href);
    if (cleaned) return cleaned;
  }
  return undefined;
}

function detectDestinationType(hrefs: string[], landingUrl: string | undefined, cta: string | undefined) {
  const all = hrefs.join(' ').toLowerCase();
  const c = (cta || '').toLowerCase();
  if (all.includes('wa.me') || all.includes('whatsapp') || c.includes('whatsapp')) return 'WHATSAPP';
  if (all.includes('m.me/') || all.includes('messenger') || all.includes('instagram.com/direct') || c.includes('message') || c.includes('повідомлення')) return 'MESSAGES';
  if (all.includes('leadgen') || all.includes('lead_form') || c.includes('sign up') || c.includes('зареєструватися')) return 'LEAD_FORM';
  if (landingUrl) return 'WEBSITE';
  return 'META_INTERNAL';
}

function pickCreativeUrl(card: Card) {
  const video = card.videoUrls.find((url) => /^https?:/i.test(url));
  if (video) return { url: video, format: 'VIDEO' as const };
  const image = card.images
    .filter((x) => /^https?:/i.test(x.url) && /fbcdn|fbsbx|cdninstagram/i.test(x.url))
    .filter((x) => x.renderedWidth >= 120 && x.renderedHeight >= 90 && !/profile|avatar/i.test(x.alt))
    .sort((a, b) => b.renderedWidth * b.renderedHeight - a.renderedWidth * a.renderedHeight || b.naturalWidth * b.naturalHeight - a.naturalWidth * a.naturalHeight)[0];
  return image ? { url: image.url, format: 'IMAGE' as const } : { url: undefined, format: 'UNKNOWN' as const };
}

function toCollectedAd(ad: ParsedAd): CollectedAd {
  return {
    source: 'META', externalId: ad.libraryId, fingerprint: `META:${ad.libraryId}`, format: ad.format,
    primaryText: ad.primaryText, cta: ad.cta, landingUrl: ad.landingUrl, creativeUrl: ad.creativeUrl,
    adLibraryUrl: ad.adLibraryUrl, raw: { advertiser: ad.advertiser, startedAt: ad.startedAt, destinationType: ad.destinationType },
  };
}

async function main() {
  const workspaces = await getWorkspaces();
  console.log(`[scanner] due workspaces=${workspaces.length}`);
  if (!workspaces.length) return;

  await mkdir('artifacts/meta-extract', { recursive: true });
  const notifier = new TelegramNotifier();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1200 }, locale: 'en-US', userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0 Safari/537.36' });

  try {
    for (const workspace of workspaces) {
      for (const competitor of (workspace.competitors || []).filter((c) => c.is_active)) {
        const query = queryFromUrl(competitor.source_url, competitor.query);
        const country = metaCountry(workspace.geo);
        const page = await context.newPage();
        const name = displayName(competitor);
        console.log(`[scanner] ${workspace.project_name} -> ${name} query=${query} country=${country}`);

        try {
          await page.goto(adLibraryUrl(query, country), { waitUntil: 'domcontentloaded', timeout: 60_000 });
          await page.waitForTimeout(7_000);
          await loadAllVisibleAds(page);
          const cards = await extractCards(page);
          const matched = cards.map((card) => ({ card, advertiser: parseAdvertiser(card.text) })).filter(({ advertiser }) => advertiserMatches(advertiser, competitor));
          console.log(`[scanner] raw=${cards.length} matched=${matched.length}`);

          const ads: ParsedAd[] = matched.map(({ card, advertiser }) => {
            const creative = pickCreativeUrl(card);
            const landingUrl = pickLandingUrl(card.hrefs);
            const cta = parseCta(card.text, card.ctaTexts);
            return {
              libraryId: card.libraryId,
              advertiser,
              startedAt: parseStartedAt(card.text),
              format: creative.format,
              cta,
              destinationType: detectDestinationType(card.hrefs, landingUrl, cta),
              primaryText: parsePrimaryText(card.text),
              landingUrl,
              creativeUrl: creative.url,
              adLibraryUrl: `https://www.facebook.com/ads/library/?id=${card.libraryId}`,
            };
          });

          const state = await reconcile(workspace.id, competitor.id, ads);
          for (const event of state.events || []) {
            if (event.type === 'STOPPED') {
              await notifier.sendStopped({ chatId: workspace.chat_id, projectName: workspace.project_name, competitorName: name, libraryId: event.ad.libraryId, startedAt: event.ad.startedAt, lastSeenAt: event.ad.lastSeenAt });
              continue;
            }
            const current = ads.find((ad) => ad.libraryId === event.ad.libraryId) || event.ad as ParsedAd;
            await notifier.sendNewAd({ chatId: workspace.chat_id, projectName: workspace.project_name, geo: workspace.geo, competitorName: name, eventType: event.type, ad: toCollectedAd(current) });
            await new Promise((resolve) => setTimeout(resolve, 700));
          }

          const safe = `${workspace.project_name}-${name}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || competitor.id;
          await writeFile(`artifacts/meta-extract/${safe}.json`, JSON.stringify({ query, country, raw: cards.length, matched: matched.length, ads }, null, 2), 'utf8');
        } catch (error) {
          console.error(`[scanner] ${name} failed`, error);
        } finally {
          await page.close();
        }
      }
    }
  } finally {
    await browser.close();
  }
}

main().catch((error) => { console.error('[scanner] fatal', error); process.exit(1); });
