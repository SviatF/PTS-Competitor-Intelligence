import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, type Page } from 'playwright';
import { TelegramNotifier } from './telegram/TelegramNotifier.js';
import type { CollectedAd } from './domain/ad.js';

const SCANNER_API = 'https://qfpwpqflqiwjqpojmngy.supabase.co/functions/v1/scanner-api';

type Workspace = {
  id: string;
  chat_id: number;
  project_name: string;
  geo: string;
  competitors: Array<{
    id: string;
    name: string;
    query: string;
    channel?: string;
    is_active: boolean;
    exact_advertiser_name?: string | null;
  }>;
};

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

function token() {
  const value = process.env.TELEGRAM_BOT_TOKEN;
  if (!value) throw new Error('TELEGRAM_BOT_TOKEN is required');
  return value;
}

function headers() {
  return { authorization: `Bearer ${token()}`, 'content-type': 'application/json' };
}

async function getWorkspaces(): Promise<Workspace[]> {
  const r = await fetch(SCANNER_API, { headers: headers() });
  if (!r.ok) throw new Error(`scanner-api GET failed ${r.status}: ${await r.text()}`);
  const body = await r.json() as any;
  return body.workspaces || [];
}

async function reconcile(workspaceId: string, competitorId: string, ads: ParsedAd[]) {
  const r = await fetch(SCANNER_API, {
    method: 'POST', headers: headers(),
    body: JSON.stringify({ action: 'reconcile', workspaceId, competitorId, ads }),
  });
  if (!r.ok) throw new Error(`reconcile failed ${r.status}: ${await r.text()}`);
  return r.json() as Promise<{ events: Array<{ type: 'NEW' | 'REACTIVATED' | 'STOPPED'; ad: any }> }>;
}

function adLibraryUrl(pageId: string) {
  const p = new URLSearchParams({
    active_status: 'active', ad_type: 'all', country: 'ALL',
    is_targeted_country: 'false', media_type: 'all', search_type: 'page',
    view_all_page_id: pageId,
  });
  return `https://www.facebook.com/ads/library/?${p.toString()}`;
}

async function clickCookieConsent(page: Page) {
  for (const pattern of [/Allow all cookies/i, /Accept all cookies/i, /Allow essential and optional cookies/i, /^Accept$/i]) {
    const btn = page.getByRole('button', { name: pattern }).first();
    if (await btn.count().catch(() => 0)) {
      await btn.click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(1000);
      break;
    }
  }
}

async function loadAll(page: Page) {
  const started = Date.now();
  let last = -1;
  let stable = 0;
  while (Date.now() - started < 60_000) {
    const body = await page.locator('body').innerText().catch(() => '');
    const count = new Set([...body.matchAll(/Library ID\s*:?\s*(\d+)/gi)].map(m => m[1])).size;
    stable = count === last ? stable + 1 : 0;
    last = count;
    if (count > 0 && stable >= 4) break;
    await page.mouse.wheel(0, 2600);
    await page.waitForTimeout(1200);
  }
}

function clean(value: string) {
  return value.replace(/\u200b/g, '').replace(/\n{3,}/g, '\n\n').trim();
}

function parseAdvertiser(text: string) {
  const m = text.match(/(?:See ad details|See summary details)\s*\n([^\n]+)\s*\nSponsored/i);
  if (m?.[1]) return clean(m[1]);
  const lines = text.split('\n').map(x => x.trim()).filter(Boolean);
  const i = lines.findIndex(x => /^Sponsored$/i.test(x));
  return i > 0 ? lines[i - 1] : '';
}

function parseStartedAt(text: string) {
  return text.match(/Started running on\s+([^\n·]+)/i)?.[1]?.trim();
}

const ctas = ['Send Message','Learn More','Sign Up','Book Now','Apply Now','Contact Us','Get Offer','Shop Now','Get Quote','Subscribe','Download','Watch More','Order Now','Buy Now','Get Started','WhatsApp'];
function parseCta(text: string, candidates: string[]) {
  for (const c of candidates) {
    const found = ctas.find(x => x.toLowerCase() === c.trim().toLowerCase());
    if (found) return found;
  }
  const lower = text.toLowerCase();
  return ctas.find(x => lower.includes(x.toLowerCase()));
}

function parsePrimaryText(text: string) {
  const i = text.search(/\nSponsored\s*\n/i);
  if (i < 0) return clean(text).slice(0, 5000);
  let out = text.slice(i).replace(/^\n?Sponsored\s*\n/i, '');
  for (const marker of ['\nLow impression count','\nImpressions:','\nOpen Dropdown','\nSee ad details','\nSee summary details','\nActive\nLibrary ID:']) {
    const j = out.indexOf(marker);
    if (j > 0) out = out.slice(0, j);
  }
  return clean(out).slice(0, 5000);
}

function cleanLandingUrl(href: string) {
  try {
    const u = new URL(href);
    if ((u.hostname === 'l.facebook.com' || u.hostname === 'lm.facebook.com') && u.pathname === '/l.php') {
      const target = u.searchParams.get('u');
      if (target) return decodeURIComponent(target);
    }
    if (u.hostname === 'facebook.com' || u.hostname.endsWith('.facebook.com') || u.hostname.endsWith('meta.com')) return undefined;
    return u.toString();
  } catch { return undefined; }
}

async function extractAds(page: Page, fallbackAdvertiser: string, pageId: string): Promise<ParsedAd[]> {
  const cards = await page.evaluate(() => {
    const leaves = Array.from(document.querySelectorAll<HTMLElement>('body *')).filter(el => el.childElementCount === 0 && /^Library ID\s*:?\s*\d+$/i.test((el.textContent || '').trim()));
    const result: any[] = [];
    const seen = new Set<string>();
    for (const marker of leaves) {
      const id = (marker.textContent || '').match(/(\d+)/)?.[1];
      if (!id || seen.has(id)) continue;
      let node: HTMLElement | null = marker;
      let card: HTMLElement | null = null;
      for (let d = 0; d < 16 && node; d++) {
        const text = (node.innerText || '').trim();
        const ids = [...text.matchAll(/Library ID\s*:?\s*(\d+)/gi)].map(m => m[1]);
        const uniqueIds = [...new Set(ids)];
        if (text.length > 120 && /Sponsored/i.test(text) && /Started running on/i.test(text) && uniqueIds.length === 1 && uniqueIds[0] === id) card = node;
        if (uniqueIds.length > 1) break;
        node = node.parentElement;
      }
      if (!card) continue;
      seen.add(id);
      const hrefs = Array.from(card.querySelectorAll<HTMLAnchorElement>('a[href]')).map(a => a.href).filter(Boolean);
      const buttons = Array.from(card.querySelectorAll<HTMLElement>('a,button,[role="button"]')).map(el => (el.innerText || el.textContent || '').trim()).filter(Boolean);
      const images = Array.from(card.querySelectorAll<HTMLImageElement>('img')).map(img => {
        const r = img.getBoundingClientRect();
        return { url: img.currentSrc || img.src, w: r.width, h: r.height, nw: img.naturalWidth, nh: img.naturalHeight, alt: img.alt || '' };
      }).filter(x => x.url);
      const videos = Array.from(card.querySelectorAll<HTMLVideoElement>('video')).flatMap(v => [v.currentSrc, v.src, ...Array.from(v.querySelectorAll<HTMLSourceElement>('source[src]')).map(s => s.src)]).filter(Boolean);
      result.push({ id, text: card.innerText, hrefs: [...new Set(hrefs)], buttons: [...new Set(buttons)], images, videos: [...new Set(videos)] });
    }
    return result;
  });

  const url = adLibraryUrl(pageId);
  return cards.map((card: any) => {
    const advertiser = parseAdvertiser(card.text) || fallbackAdvertiser;
    const landingUrl = card.hrefs.map(cleanLandingUrl).find(Boolean);
    const cta = parseCta(card.text, card.buttons);
    const all = card.hrefs.join(' ').toLowerCase();
    const destinationType = all.includes('whatsapp') || (cta || '').toLowerCase().includes('whatsapp') ? 'WHATSAPP'
      : all.includes('m.me/') || all.includes('messenger') || (cta || '').toLowerCase().includes('message') ? 'MESSAGES'
      : landingUrl ? 'WEBSITE' : 'META_INTERNAL';
    const video = card.videos.find((x: string) => /^https?:/i.test(x));
    const image = card.images
      .filter((x: any) => /^https?:/i.test(x.url) && /fbcdn|fbsbx|cdninstagram/i.test(x.url) && x.w >= 120 && x.h >= 90 && !/profile|avatar/i.test(x.alt))
      .sort((a: any,b: any) => b.w*b.h-a.w*a.h || b.nw*b.nh-a.nw*a.nh)[0];
    return {
      libraryId: card.id,
      advertiser,
      startedAt: parseStartedAt(card.text),
      format: video ? 'VIDEO' : image ? 'IMAGE' : 'UNKNOWN',
      cta,
      destinationType,
      primaryText: parsePrimaryText(card.text),
      landingUrl,
      creativeUrl: video || image?.url,
      adLibraryUrl: url,
    } satisfies ParsedAd;
  });
}

function collected(ad: any): CollectedAd {
  return {
    source: 'META', externalId: ad.libraryId, fingerprint: `META:${ad.libraryId}`,
    format: ad.format || 'UNKNOWN', primaryText: ad.primaryText || '', cta: ad.cta,
    landingUrl: ad.landingUrl, creativeUrl: ad.creativeUrl, adLibraryUrl: ad.adLibraryUrl,
    raw: { advertiser: ad.advertiser, startedAt: ad.startedAt, destinationType: ad.destinationType },
  };
}

async function main() {
  await mkdir('artifacts/exact-production', { recursive: true });
  const notifier = new TelegramNotifier();
  const workspaces = await getWorkspaces();
  const browser = await chromium.launch({ headless: false, args: ['--disable-blink-features=AutomationControlled','--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1200 }, locale: 'en-US', userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36' });
  await context.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));
  try {
    for (const ws of workspaces) {
      const targets = (ws.competitors || []).filter(c => c.is_active && c.channel === 'META' && /^\d{6,25}$/.test(String(c.query || '')));
      for (const competitor of targets) {
        const pageId = String(competitor.query);
        const page = await context.newPage();
        try {
          const url = adLibraryUrl(pageId);
          console.log(`[meta] ${ws.project_name} ${competitor.name} page=${pageId}`);
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
          await clickCookieConsent(page);
          await page.waitForTimeout(5000);
          await loadAll(page);
          const body = await page.locator('body').innerText().catch(() => '');
          const hasAds = /Library ID\s*:?\s*\d+/i.test(body);
          const explicitEmpty = /No ads match|No results|There are no ads|doesn't have any ads|no active ads/i.test(body);
          if (!hasAds && !explicitEmpty) {
            console.log(`[meta] ${competitor.name} INCOMPLETE — skipping reconcile`);
            continue;
          }
          const ads = hasAds ? await extractAds(page, competitor.exact_advertiser_name || competitor.name, pageId) : [];
          await writeFile(`artifacts/exact-production/${ws.id}-${pageId}.json`, JSON.stringify(ads, null, 2), 'utf8');
          const { events } = await reconcile(ws.id, competitor.id, ads);
          console.log(`[meta] ${competitor.name} ads=${ads.length} events=${events.length}`);
          for (const event of events) {
            if (event.type === 'STOPPED') {
              await notifier.sendStopped({ chatId: ws.chat_id, projectName: ws.project_name, competitorName: competitor.exact_advertiser_name || competitor.name, libraryId: String(event.ad.libraryId || ''), startedAt: event.ad.startedAt, lastSeenAt: event.ad.lastSeenAt });
            } else {
              await notifier.sendNewAd({ chatId: ws.chat_id, projectName: ws.project_name, geo: ws.geo, competitorName: competitor.exact_advertiser_name || competitor.name, eventType: event.type, ad: collected(event.ad) });
            }
          }
        } finally {
          await page.screenshot({ path: `artifacts/exact-production/${ws.id}-${pageId}.png`, fullPage: true }).catch(() => {});
          await page.close();
        }
      }
    }
  } finally {
    await browser.close();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
