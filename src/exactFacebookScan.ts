import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, type BrowserContext, type Page } from 'playwright';

const REPORT_URL = 'https://qfpwpqflqiwjqpojmngy.supabase.co/functions/v1/exact-facebook-report';

const pages = [
  { sourceUrl: 'https://www.facebook.com/profile.php?id=61556616056037' },
  { sourceUrl: 'https://www.facebook.com/profile.php?id=61586423325192' },
];

function inputIdFromFacebookUrl(sourceUrl: string) {
  try {
    return new URL(sourceUrl).searchParams.get('id') || 'unknown';
  } catch {
    return 'unknown';
  }
}

function adLibraryPageIdFromUrl(url: string) {
  try {
    const parsed = new URL(url);
    return parsed.searchParams.get('view_all_page_id');
  } catch {
    return null;
  }
}

async function report(result: any) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !result.pageId) return;
  const r = await fetch(REPORT_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(result),
  });
  if (!r.ok) throw new Error(`report failed: ${r.status} ${await r.text()}`);
}

async function clickCookieConsent(page: Page) {
  const patterns = [/Allow all cookies/i, /Accept all cookies/i, /Allow essential and optional cookies/i, /^Accept$/i];
  for (const pattern of patterns) {
    const btn = page.getByRole('button', { name: pattern }).first();
    if (await btn.count().catch(() => 0)) {
      await btn.click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(1000);
      return;
    }
  }
}

async function collectAdLibraryLinks(page: Page) {
  return page.evaluate(() => Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'))
    .map(a => ({ text: (a.innerText || a.textContent || '').trim(), href: a.href }))
    .filter(x => /facebook\.com\/ads\/library/i.test(x.href)));
}

async function clickAndCaptureAdLibrary(page: Page, locator: any) {
  const before = page.url();
  const popupPromise = page.waitForEvent('popup', { timeout: 7000 }).then(async popup => {
    await popup.waitForLoadState('domcontentloaded').catch(() => {});
    return popup.url();
  }).catch(() => undefined);

  await locator.click({ timeout: 7000 }).catch(() => {});
  await page.waitForTimeout(2500);
  const popupUrl = await popupPromise;
  const after = page.url();

  if (popupUrl && /facebook\.com\/ads\/library/i.test(popupUrl)) return popupUrl;
  if (after !== before && /facebook\.com\/ads\/library/i.test(after)) return after;
  return null;
}

async function discoverExactAdLibraryUrl(page: Page, sourceUrl: string) {
  await page.goto(sourceUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await clickCookieConsent(page);
  await page.waitForTimeout(5000);

  let links = await collectAdLibraryLinks(page);
  const direct = links.find(link => adLibraryPageIdFromUrl(link.href));
  if (direct) return { method: 'direct-ad-library-link', url: direct.href };

  const transparencyCandidates = [
    page.getByText(/Page transparency/i, { exact: false }),
    page.getByRole('button', { name: /Page transparency/i }),
    page.getByRole('link', { name: /Page transparency/i }),
  ];

  for (const candidate of transparencyCandidates) {
    if (!(await candidate.count().catch(() => 0))) continue;
    const first = candidate.first();
    if (!(await first.isVisible().catch(() => false))) continue;
    await first.click({ timeout: 7000 }).catch(() => {});
    await page.waitForTimeout(2500);
    break;
  }

  links = await collectAdLibraryLinks(page);
  const afterTransparency = links.find(link => adLibraryPageIdFromUrl(link.href));
  if (afterTransparency) return { method: 'page-transparency-link', url: afterTransparency.href };

  const goToAdLibraryCandidates = [
    page.getByRole('link', { name: /Go to Ad Library|Ad Library/i }),
    page.getByRole('button', { name: /Go to Ad Library|Ad Library/i }),
    page.getByText(/Go to Ad Library/i, { exact: false }),
  ];

  for (const candidate of goToAdLibraryCandidates) {
    if (!(await candidate.count().catch(() => 0))) continue;
    const first = candidate.first();
    if (!(await first.isVisible().catch(() => false))) continue;
    const captured = await clickAndCaptureAdLibrary(page, first);
    if (captured && adLibraryPageIdFromUrl(captured)) return { method: 'page-transparency-click', url: captured };
  }

  const html = await page.content().catch(() => '');
  const embeddedUrls = [...html.matchAll(/https?:\\?\/\\?\/(?:www\\?\.)?facebook\\?\.com\\?\/ads\\?\/library[^"'<>\s]*/gi)]
    .map(match => match[0].replace(/\\u0026/g, '&').replace(/\\\//g, '/'));
  const embedded = embeddedUrls.find(url => adLibraryPageIdFromUrl(url));
  if (embedded) return { method: 'embedded-html', url: embedded };

  const body = await page.locator('body').innerText().catch(() => '');
  return {
    method: 'not-found',
    url: null,
    bodySnippet: body.slice(0, 10000),
    finalFacebookUrl: page.url(),
  };
}

async function scanExactAdLibrary(page: Page, url: string) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await clickCookieConsent(page);
  await page.waitForTimeout(5000);

  let body = '';
  let state: 'ADS' | 'EMPTY' | 'INCOMPLETE' = 'INCOMPLETE';
  const start = Date.now();
  while (Date.now() - start < 45_000) {
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
    status: state,
    count: state === 'INCOMPLETE' ? null : libraryIds.length,
    libraryIds,
    advertisers,
    visibleResultCount: resultCountMatch ? resultCountMatch[1] : null,
    finalUrl: page.url(),
    bodySnippet: body.slice(0, 12000),
  };
}

async function createContext() {
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
  return { browser, context };
}

async function main() {
  await mkdir('artifacts/exact-facebook', { recursive: true });
  const { browser, context } = await createContext();
  const results: any[] = [];

  try {
    for (const item of pages) {
      const inputId = inputIdFromFacebookUrl(item.sourceUrl);
      const discoveryPage = await context.newPage();
      console.log(`[facebook-discovery] source=${item.sourceUrl}`);

      try {
        const discovery = await discoverExactAdLibraryUrl(discoveryPage, item.sourceUrl);
        const discoveredUrl = discovery.url;
        const discoveredPageId = discoveredUrl ? adLibraryPageIdFromUrl(discoveredUrl) : null;

        console.log(`[facebook-discovery] input_id=${inputId} method=${discovery.method} real_ad_library_id=${discoveredPageId || 'NOT_FOUND'}`);

        if (!discoveredUrl || !discoveredPageId) {
          const result = {
            pageId: `discovery-${inputId}`,
            sourceUrl: item.sourceUrl,
            inputFacebookId: inputId,
            discoveredAdLibraryPageId: null,
            discovery,
            status: 'DISCOVERY_INCOMPLETE',
            count: null,
            libraryIds: [],
            advertisers: [],
            error: 'Could not resolve exact Ad Library view_all_page_id from Facebook Page Transparency',
          };
          results.push(result);
          await writeFile(`artifacts/exact-facebook/${inputId}-discovery.json`, JSON.stringify(result, null, 2), 'utf8');
          await discoveryPage.screenshot({ path: `artifacts/exact-facebook/${inputId}-discovery.png`, fullPage: true }).catch(() => {});
          continue;
        }

        const scanPage = await context.newPage();
        try {
          const scan = await scanExactAdLibrary(scanPage, discoveredUrl);
          const result = {
            pageId: discoveredPageId,
            sourceUrl: item.sourceUrl,
            inputFacebookId: inputId,
            discoveredAdLibraryPageId: discoveredPageId,
            discoveryMethod: discovery.method,
            url: discoveredUrl,
            ...scan,
          };
          results.push(result);
          console.log(`[exact-facebook] input_id=${inputId} real_ad_library_id=${discoveredPageId} state=${scan.status} ads=${scan.libraryIds.length} visibleResults=${scan.visibleResultCount || '-'}`);
          await report(result);
          await writeFile(`artifacts/exact-facebook/${inputId}-${discoveredPageId}.json`, JSON.stringify(result, null, 2), 'utf8');
          await scanPage.screenshot({ path: `artifacts/exact-facebook/${inputId}-${discoveredPageId}.png`, fullPage: true }).catch(() => {});
        } finally {
          await scanPage.close();
        }
      } catch (error) {
        const result = {
          pageId: `error-${inputId}`,
          sourceUrl: item.sourceUrl,
          inputFacebookId: inputId,
          status: 'ERROR',
          count: null,
          libraryIds: [],
          advertisers: [],
          error: String(error),
        };
        results.push(result);
        console.error(`[facebook-discovery] input_id=${inputId} failed`, error);
      } finally {
        await discoveryPage.close();
      }
    }
  } finally {
    await browser.close();
  }

  await writeFile('artifacts/exact-facebook/summary.json', JSON.stringify(results, null, 2), 'utf8');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
