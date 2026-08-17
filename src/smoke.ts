import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const competitors = [
  {
    slug: 'mriydiy-camp',
    name: 'MRIYDIY Camp',
    queries: ['mriydiy.camp', 'mriydiy camp', 'mriydiy'],
  },
  {
    slug: 'emily-kids-camp',
    name: 'Emily Kids Camp',
    queries: ['emily_kids_camp', 'emily kids camp', 'emily camp'],
  },
  {
    slug: 'supercamp-ua',
    name: 'Supercamp UA',
    queries: ['supercamp.ua', 'supercamp ua', 'supercamp'],
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

function classify(body: string) {
  const normalized = body.toLowerCase();
  return {
    hasLibraryId: /library id|id бібліотеки|бібліотек/i.test(body),
    hasLoginWall:
      normalized.includes('log into facebook') ||
      normalized.includes('log in to facebook') ||
      normalized.includes('увійдіть у facebook'),
    hasNoResults:
      normalized.includes('no ads match') ||
      normalized.includes('no results') ||
      normalized.includes('ми не знайшли') ||
      normalized.includes('немає результатів'),
    hasCookieWall:
      normalized.includes('allow all cookies') ||
      normalized.includes('cookie') ||
      normalized.includes('файли cookie'),
    hasError:
      normalized.includes('something went wrong') ||
      normalized.includes('try again later') ||
      normalized.includes('щось пішло не так'),
  };
}

async function main() {
  console.log('[smoke-v2] starting Meta Ad Library diagnostics');
  await mkdir('artifacts/meta-smoke', { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1200 },
    locale: 'en-US',
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0 Safari/537.36',
  });

  try {
    for (const competitor of competitors) {
      console.log(`\n[smoke-v2] ===== ${competitor.name} =====`);

      const variants = [
        ...competitor.queries.map((q) => ({ q, country: 'ALL' })),
        { q: competitor.queries[0], country: 'UA' },
      ];

      for (let index = 0; index < variants.length; index += 1) {
        const variant = variants[index];
        const page = await context.newPage();
        const url = adLibraryUrl(variant.q, variant.country);
        const prefix = `artifacts/meta-smoke/${competitor.slug}-${index + 1}`;

        console.log(`[smoke-v2] query=${JSON.stringify(variant.q)} country=${variant.country}`);
        console.log(`[smoke-v2] url=${url}`);

        try {
          const response = await page.goto(url, {
            waitUntil: 'domcontentloaded',
            timeout: 60_000,
          });

          await page.waitForTimeout(6_000);

          for (let i = 0; i < 3; i += 1) {
            await page.mouse.wheel(0, 1400);
            await page.waitForTimeout(1_000);
          }

          const title = await page.title();
          const finalUrl = page.url();
          const bodyText = (await page.locator('body').innerText().catch(() => '')).slice(0, 50_000);
          const html = await page.content();
          const flags = classify(bodyText);
          const libraryIds = [...bodyText.matchAll(/Library ID\s*:?\s*(\d+)/gi)].map((m) => m[1]);
          const uniqueLibraryIds = [...new Set(libraryIds)];

          console.log(
            `[smoke-v2] status=${response?.status() ?? 'n/a'} title=${JSON.stringify(title)} finalUrl=${finalUrl}`,
          );
          console.log(`[smoke-v2] flags=${JSON.stringify(flags)} libraryIds=${uniqueLibraryIds.length}`);
          console.log(`[smoke-v2] bodyPreview=${JSON.stringify(bodyText.slice(0, 1200))}`);

          await page.screenshot({ path: `${prefix}.png`, fullPage: true });
          await writeFile(`${prefix}.html`, html, 'utf8');
          await writeFile(`${prefix}.txt`, bodyText, 'utf8');
          await writeFile(
            `${prefix}.json`,
            JSON.stringify(
              {
                competitor: competitor.name,
                query: variant.q,
                country: variant.country,
                requestedUrl: url,
                finalUrl,
                status: response?.status() ?? null,
                title,
                flags,
                libraryIds: uniqueLibraryIds,
              },
              null,
              2,
            ),
            'utf8',
          );
        } catch (error) {
          console.error(`[smoke-v2] variant failed`, error);
          await writeFile(`${prefix}-error.txt`, String(error), 'utf8');
          await page.screenshot({ path: `${prefix}-error.png`, fullPage: true }).catch(() => undefined);
        } finally {
          await page.close();
        }
      }
    }
  } finally {
    await browser.close();
  }

  console.log('[smoke-v2] diagnostics complete');
}

main().catch((error) => {
  console.error('[smoke-v2] fatal', error);
  process.exit(1);
});
