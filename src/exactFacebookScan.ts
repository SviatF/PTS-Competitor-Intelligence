import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const REPORT_URL = 'https://qfpwpqflqiwjqpojmngy.supabase.co/functions/v1/exact-facebook-report';
const pages = [
  { pageId: '61556616056037', sourceUrl: 'https://www.facebook.com/profile.php?id=61556616056037' },
  { pageId: '61586423325192', sourceUrl: 'https://www.facebook.com/profile.php?id=61586423325192' },
];

function adLibraryUrl(pageId: string) {
  const p = new URLSearchParams({
    active_status: 'active',
    ad_type: 'all',
    country: 'ALL',
    is_targeted_country: 'false',
    media_type: 'all',
    search_type: 'page',
    view_all_page_id: pageId,
  });
  return `https://www.facebook.com/ads/library/?${p.toString()}`;
}

async function report(result: any) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN missing');
  const r = await fetch(REPORT_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(result),
  });
  if (!r.ok) throw new Error(`report failed: ${r.status} ${await r.text()}`);
}

async function clickCookieConsent(page: any) {
  const patterns = [/Allow all cookies/i, /Accept all cookies/i, /Allow essential and optional cookies/i];
  for (const p of patterns) {
    const btn = page.getByRole('button', { name: p }).first();
    if (await btn.count().catch(() => 0)) {
      await btn.click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(1000);
      break;
    }
  }
}

async function main() {
  await mkdir('artifacts/exact-facebook', { recursive: true });
  const browser = await chromium.launch({
    headless: false,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
  });
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1200 },
    locale: 'en-US',
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  const results: any[] = [];
  try {
    for (const item of pages) {
      const page = await context.newPage();
      const url = adLibraryUrl(item.pageId);
      console.log(`[exact-facebook] page=${item.pageId} url=${url}`);
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await clickCookieConsent(page);
        await page.waitForTimeout(5000);

        // Wait explicitly for either ad cards or an explicit empty-state message.
        const start = Date.now();
        let body = '';
        let state: 'ADS' | 'EMPTY' | 'INCOMPLETE' = 'INCOMPLETE';
        while (Date.now() - start < 45000) {
          body = await page.locator('body').innerText().catch(() => '');
          if (/Library ID\s*:?\s*\d+/i.test(body)) { state = 'ADS'; break; }
          if (/No ads match|No results|There are no ads|doesn't have any ads|no active ads/i.test(body)) { state = 'EMPTY'; break; }
          await page.mouse.wheel(0, 1800);
          await page.waitForTimeout(1500);
        }

        // Continue scrolling when ads exist so lazy-loaded cards are included.
        if (state === 'ADS') {
          let prev = -1;
          let stable = 0;
          for (let i = 0; i < 40; i++) {
            body = await page.locator('body').innerText().catch(() => '');
            const count = new Set([...body.matchAll(/Library ID\s*:?\s*(\d+)/gi)].map(m => m[1])).size;
            stable = count === prev ? stable + 1 : 0;
            prev = count;
            if (stable >= 4) break;
            await page.mouse.wheel(0, 2600);
            await page.waitForTimeout(1200);
          }
        }

        body = await page.locator('body').innerText().catch(() => '');
        const ids = [...new Set([...body.matchAll(/Library ID\s*:?\s*(\d+)/gi)].map(m => m[1]))];
        const advertisers = [...new Set([...body.matchAll(/(?:See ad details|See summary details)\s*\n([^\n]+)\s*\nSponsored/gi)].map(m => m[1].trim()).filter(Boolean))];
        const resultCountMatch = body.match(/~?([\d,.]+)\s+results?/i);
        const visibleResultCount = resultCountMatch ? resultCountMatch[1] : null;

        const result = {
          ...item,
          url,
          finalUrl: page.url(),
          status: state,
          count: state === 'INCOMPLETE' ? null : ids.length,
          libraryIds: ids,
          advertisers,
          visibleResultCount,
          bodySnippet: body.slice(0, 12000),
        };
        results.push(result);
        console.log(`[exact-facebook] page=${item.pageId} state=${state} ads=${ids.length} visibleResults=${visibleResultCount || '-'} advertisers=${advertisers.join(' | ')}`);
        await report(result);
        await writeFile(`artifacts/exact-facebook/${item.pageId}.json`, JSON.stringify(result, null, 2), 'utf8');
        await page.screenshot({ path: `artifacts/exact-facebook/${item.pageId}.png`, fullPage: true }).catch(() => {});
      } catch (e) {
        const result = { ...item, url, error: String(e), status: 'ERROR', count: null, libraryIds: [], advertisers: [] };
        results.push(result);
        await report(result).catch(() => {});
        console.error(`[exact-facebook] page=${item.pageId} failed`, e);
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
  await writeFile('artifacts/exact-facebook/summary.json', JSON.stringify(results, null, 2), 'utf8');
}

main().catch(e => { console.error(e); process.exit(1); });
