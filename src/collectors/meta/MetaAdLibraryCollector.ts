import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { env } from '../../config/env.js';
import type { AdCollector, CollectedAd, CollectorCompetitor } from '../../domain/ad.js';

function hash(input: string) {
  return createHash('sha256').update(input).digest('hex');
}

function normalizeWhitespace(input: string) {
  return input.replace(/\s+/g, ' ').trim();
}

export class MetaAdLibraryCollector implements AdCollector {
  async collect(competitor: CollectorCompetitor): Promise<CollectedAd[]> {
    if (!competitor.metaAdLibraryUrl) return [];

    const browser = await chromium.launch({ headless: env.META_HEADLESS });
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1200 },
      userAgent:
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/127 Safari/537.36',
    });

    try {
      await page.goto(competitor.metaAdLibraryUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 60_000,
      });

      await page.waitForTimeout(4_000);
      for (let i = 0; i < 4; i += 1) {
        await page.mouse.wheel(0, 1400);
        await page.waitForTimeout(1_000);
      }

      const snapshots = await page.evaluate(() => {
        const candidates = Array.from(document.querySelectorAll('div'))
          .filter((el) => /Library ID|ID de la bibliothèque|Bibliotheks-ID|ID biblioteki/i.test(el.textContent || ''))
          .filter((el) => (el.textContent || '').length > 80 && (el.textContent || '').length < 12_000);

        const leafish = candidates.filter((el) => {
          return !Array.from(el.children).some((child) =>
            /Library ID|ID de la bibliothèque|Bibliotheks-ID|ID biblioteki/i.test(child.textContent || ''),
          );
        });

        return leafish.map((el) => {
          const text = (el.textContent || '').trim();
          const links = Array.from(el.querySelectorAll('a[href]')).map((a) => (a as HTMLAnchorElement).href);
          const images = Array.from(el.querySelectorAll('img[src]')).map((img) => (img as HTMLImageElement).src);
          const videos = Array.from(el.querySelectorAll('video source[src], video[src]')).map((v) =>
            (v as HTMLVideoElement).src || (v as HTMLSourceElement).src,
          );
          return { text, links, images, videos };
        });
      });

      const seen = new Set<string>();
      const ads: CollectedAd[] = [];

      for (const snapshot of snapshots) {
        const text = normalizeWhitespace(snapshot.text);
        const idMatch = text.match(/(?:Library ID|ID de la bibliothèque|Bibliotheks-ID|ID biblioteki)\s*:?\s*(\d+)/i);
        const externalId = idMatch?.[1];
        const landingUrl = snapshot.links.find((url) => {
          try {
            const host = new URL(url).hostname;
            return !host.includes('facebook.com') && !host.includes('instagram.com');
          } catch {
            return false;
          }
        });
        const creativeUrl = snapshot.videos[0] || snapshot.images[0];
        const format = snapshot.videos.length ? 'VIDEO' : snapshot.images.length ? 'IMAGE' : 'UNKNOWN';
        const fingerprint = hash(`${externalId || ''}|${text}|${landingUrl || ''}|${creativeUrl || ''}`);

        if (seen.has(fingerprint)) continue;
        seen.add(fingerprint);

        ads.push({
          source: 'META',
          externalId,
          fingerprint,
          format,
          primaryText: text,
          landingUrl,
          creativeUrl,
          adLibraryUrl: competitor.metaAdLibraryUrl,
          raw: snapshot,
        });
      }

      return ads;
    } finally {
      await browser.close();
    }
  }
}
