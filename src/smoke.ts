import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, type Page } from 'playwright';
import { TelegramNotifier } from './telegram/TelegramNotifier.js';
import type { CollectedAd } from './domain/ad.js';

type CompetitorConfig = {
  slug: string;
  name: string;
  query: string;
  country: string;
  advertiserPattern: RegExp;
};

const competitors: CompetitorConfig[] = [
  {
    slug: 'mriydiy-camp',
    name: 'MRIYDIY Camp',
    query: 'mriydiy',
    country: 'UA',
    advertiserPattern: /(mriy|мрій).*?(camp|табір)|(camp|табір).*?(mriy|мрій)/i,
  },
  {
    slug: 'emily-kids-camp',
    name: 'Emily Kids Camp',
    query: 'emily_kids_camp',
    country: 'UA',
    advertiserPattern: /Emily (Resort|Kids)/i,
  },
  {
    slug: 'supercamp-ua',
    name: 'Supercamp UA',
    query: 'supercamp.ua',
    country: 'UA',
    advertiserPattern: /SuperCamp/i,
  },
];

function adLibraryUrl(query: string, country: string) {
  const params = new URLSearchParams({
    active_status: 'active',
    ad_type: 'all',
    country,
    q: query,
    search_type: 'keyword_unordered',
  });
  return `https://www.facebook.com/ads/library/?${params.toString()}`;
}

function clean(value: string) {
  return value.replace(/\u200b/g, '').replace(/\n{3,}/g, '\n\n').trim();
}

function parseAdvertiser(cardText: string) {
  const match = cardText.match(/(?:See ad details|See summary details)\s*\n([^\n]+)\s*\nSponsored/i);
  if (match?.[1]) return clean(match[1]);

  const lines = cardText.split('\n').map((line) => line.trim()).filter(Boolean);
  const sponsoredIndex = lines.findIndex((line) => /^Sponsored$/i.test(line));
  return sponsoredIndex > 0 ? lines[sponsoredIndex - 1] : '';
}

function parsePrimaryText(cardText: string) {
  const sponsoredIndex = cardText.search(/\nSponsored\s*\n/i);
  if (sponsoredIndex < 0) return clean(cardText).slice(0, 5000);

  let text = cardText.slice(sponsoredIndex).replace(/^\n?Sponsored\s*\n/i, '');
  const stopMarkers = ['\nLow impression count', '\nImpressions:', '\nOpen Dropdown', '\nSee ad details'];

  for (const marker of stopMarkers) {
    const index = text.indexOf(marker);
    if (index > 0) text = text.slice(0, index);
  }

  return clean(text).slice(0, 5000);
}

function parseStartedAt(cardText: string) {
  return cardText.match(/Started running on\s+([^\n·]+)/i)?.[1]?.trim();
}

async function loadAllVisibleAds(page: Page) {
  let previousCount = 0;
  let stableRounds = 0;

  for (let round = 0; round < 30; round += 1) {
    const body = await page.locator('body').innerText().catch(() => '');
    const count = new Set([...body.matchAll(/Library ID\s*:?\s*(\d+)/gi)].map((m) => m[1])).size;

    if (count === previousCount) stableRounds += 1;
    else stableRounds = 0;

    previousCount = count;
    if (stableRounds >= 3 && round >= 5) break;

    await page.mouse.wheel(0, 2800);
    await page.waitForTimeout(1200);
  }
}

async function extractCards(page: Page) {
  return page.evaluate(() => {
    const markerElements = Array.from(document.querySelectorAll<HTMLElement>('body *')).filter((el) => {
      if (el.childElementCount !== 0) return false;
      const text = (el.textContent ?? '').trim();
      return /^Library ID\s*:?\s*\d+$/i.test(text);
    });

    const seen = new Set<string>();
    const cards: Array<{
      libraryId: string;
      text: string;
      hrefs: string[];
      imageUrls: string[];
      videoUrls: string[];
      videoPosters: string[];
    }> = [];

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

      const hrefs = Array.from(card.querySelectorAll<HTMLAnchorElement>('a[href]'))
        .map((a) => a.href)
        .filter(Boolean);
      const imageUrls = Array.from(card.querySelectorAll<HTMLImageElement>('img'))
        .map((img) => img.currentSrc || img.src)
        .filter(Boolean);
      const videos = Array.from(card.querySelectorAll<HTMLVideoElement>('video'));
      const videoUrls = videos.flatMap((video) => {
        const direct = [video.src, video.currentSrc];
        const sources = Array.from(video.querySelectorAll<HTMLSourceElement>('source[src]')).map((source) => source.src);
        return [...direct, ...sources].filter(Boolean);
      });
      const videoPosters = videos.map((video) => video.poster).filter(Boolean);

      cards.push({
        libraryId,
        text: card.innerText,
        hrefs: [...new Set(hrefs)],
        imageUrls: [...new Set(imageUrls)],
        videoUrls: [...new Set(videoUrls)],
        videoPosters: [...new Set(videoPosters)],
      });
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

    if (host === 'facebook.com' || host.endsWith('.facebook.com')) return undefined;
    if (host === 'meta.com' || host.endsWith('.meta.com')) return undefined;

    return url.toString();
  } catch {
    return undefined;
  }
}

function pickLandingUrl(hrefs: string[]) {
  for (const href of hrefs) {
    const cleaned = cleanLandingUrl(href);
    if (cleaned) return cleaned;
  }
  return undefined;
}

function pickCreativeUrl(card: Awaited<ReturnType<typeof extractCards>>[number]) {
  const video = card.videoUrls.find((url) => /^https?:/i.test(url) && !/^blob:/i.test(url));
  if (video) return { url: video, format: 'VIDEO' as const };

  const image = card.imageUrls.find((url) => /^https?:/i.test(url) && /fbcdn|fbsbx|cdninstagram/i.test(url));
  if (image) return { url: image, format: 'IMAGE' as const };

  return { url: undefined, format: 'UNKNOWN' as const };
}

async function main() {
  console.log('[extractor] starting live Meta competitor extraction');
  await mkdir('artifacts/meta-extract', { recursive: true });

  const notifier = new TelegramNotifier();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1200 },
    locale: 'en-US',
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0 Safari/537.36',
  });

  let grandTotal = 0;
  const sentLibraryIds = new Set<string>();

  try {
    for (const competitor of competitors) {
      const page = await context.newPage();
      const url = adLibraryUrl(competitor.query, competitor.country);
      console.log(`\n[extractor] ===== ${competitor.name} =====`);
      console.log(`[extractor] url=${url}`);

      try {
        const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        await page.waitForTimeout(7_000);
        await loadAllVisibleAds(page);

        const cards = await extractCards(page);
        const accepted = cards
          .map((card) => ({ card, advertiser: parseAdvertiser(card.text) }))
          .filter(({ advertiser }) => competitor.advertiserPattern.test(advertiser));

        console.log(`[extractor] status=${response?.status() ?? 'n/a'} rawCards=${cards.length} accepted=${accepted.length}`);

        const output: unknown[] = [];

        for (const { card, advertiser } of accepted) {
          if (sentLibraryIds.has(card.libraryId)) {
            console.log(`[extractor] skip duplicate Library ID ${card.libraryId}`);
            continue;
          }
          sentLibraryIds.add(card.libraryId);

          const creative = pickCreativeUrl(card);
          const landingUrl = pickLandingUrl(card.hrefs);
          const primaryText = parsePrimaryText(card.text);
          const startedAt = parseStartedAt(card.text);
          const adLibraryUrl = `https://www.facebook.com/ads/library/?id=${card.libraryId}`;

          const ad: CollectedAd = {
            source: 'META',
            externalId: card.libraryId,
            fingerprint: `META:${card.libraryId}`,
            format: creative.format,
            primaryText,
            landingUrl,
            creativeUrl: creative.url,
            adLibraryUrl,
            raw: {
              advertiser,
              startedAt,
              cardText: card.text,
              hrefs: card.hrefs,
              imageUrls: card.imageUrls,
              videoUrls: card.videoUrls,
              videoPosters: card.videoPosters,
            },
          };

          output.push({
            libraryId: card.libraryId,
            advertiser,
            startedAt,
            format: ad.format,
            text: primaryText,
            landingUrl,
            creativeUrl: creative.url,
            adLibraryUrl,
          });

          console.log(`[extractor] ad=${card.libraryId} advertiser=${JSON.stringify(advertiser)} format=${ad.format} started=${JSON.stringify(startedAt)}`);

          await notifier.sendNewAd({
            projectName: 'The Camp',
            geo: competitor.country,
            competitorName: competitor.name,
            ad,
          });

          await new Promise((resolve) => setTimeout(resolve, 900));
        }

        grandTotal += output.length;
        await writeFile(`artifacts/meta-extract/${competitor.slug}.json`, JSON.stringify(output, null, 2), 'utf8');
        await page.screenshot({ path: `artifacts/meta-extract/${competitor.slug}.png`, fullPage: true });
      } catch (error) {
        console.error(`[extractor] ${competitor.name} failed`, error);
        await writeFile(`artifacts/meta-extract/${competitor.slug}-error.txt`, String(error), 'utf8');
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }

  console.log(`[extractor] finished total=${grandTotal}`);
}

main().catch((error) => {
  console.error('[extractor] fatal', error);
  process.exit(1);
});
