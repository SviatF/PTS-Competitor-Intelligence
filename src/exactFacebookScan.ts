import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, type Page } from 'playwright';

const REPORT_URL = 'https://qfpwpqflqiwjqpojmngy.supabase.co/functions/v1/exact-facebook-report';
const pageIds = ['229968643535520', '961705790368723'];

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
  if (!token) return;
  const r = await fetch(REPORT_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(result),
  });
  if (!r.ok) throw new Error(`report failed: ${r.status} ${await r.text()}`);
}

async function clickCookieConsent(page: Page) {
  for (const pattern of [/Allow all cookies/i, /Accept all cookies/i, /Allow essential and optional cookies/i, /^Accept$/i]) {
    const btn = page.getByRole('button', { name: pattern }).first();
    if (await btn.count().catch(() => 0)) {
      await btn.click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(1000);
      return;
    }
  }
}

async function scan(page: Page, pageId: string) {
  const url = adLibraryUrl(pageId);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await clickCookieConsent(page);
  await page.waitForTimeout(5000);

  let body = '';
  let state: 'ADS' | 'EMPTY' | 'INCOMPLETE' = 'INCOMPLETE';
  const started = Date.now();
  while (Date.now() - started < 45_000) {
    body = await page.locator('body').innerText().catch(() => '');
    if (/Library ID\s*:?\s*\d+/i.test(body)) { state = 'ADS'; break; }
    if (/No ads match|No results|There are no ads|doesn't have any ads|no active ads/i.test(body)) { state = 'EMPTY'; break; }
    await page.mouse.wheel(0, 1800);
    await page.waitForTimeout(1500);
  }

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
  const libraryIds = [...new Set([...body.matchAll(/Library ID\s*:?\s*(\d+)/gi)].map(m => m[1]))];
  const advertisers = [...new Set([...body.matchAll(/(?:See ad details|See summary details)\s*\n([^\n]+)\s*\nSponsored/gi)]
    .map(m => m[1].trim()).filter(Boolean))];
  const resultCountMatch = body.match(/~?([\d,.]+)\s+results?/i);

  return {
    pageId,
    sourceUrl: null,
    url,
    finalUrl: page.url(),
    status: state,
    count: state === 'INCOMPLETE' ? null : libraryIds.length,
    libraryIds,
    advertisers,
    visibleResultCount: resultCountMatch ? resultCountMatch[1] : null,
    bodySnippet: body.slice(0, 12000),
  };
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
  await context.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));

  const results: any[] = [];
  try {
    for (const pageId of pageIds) {
      const page = await context.newPage();
      try {
        const result = await scan(page, pageId);
        results.push(result);
        console.log(`[exact-facebook-id] page=${pageId} status=${result.status} ads=${result.libraryIds.length} visibleResults=${result.visibleResultCount || '-'} advertisers=${result.advertisers.join(' | ')}`);
        await report(result);
        await writeFile(`artifacts/exact-facebook/${pageId}.json`, JSON.stringify(result, null, 2), 'utf8');
        await page.screenshot({ path: `artifacts/exact-facebook/${pageId}.png`, fullPage: true }).catch(() => {});
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
  await writeFile('artifacts/exact-facebook/summary.json', JSON.stringify(results, null, 2), 'utf8');
}

main().catch(error => { console.error(error); process.exit(1); });

// manual rerun exact ids 2026-08-18T03:36-07:00
