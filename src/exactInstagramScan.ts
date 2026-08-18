import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, type BrowserContext, type Page } from 'playwright';

const SCANNER_API = 'https://qfpwpqflqiwjqpojmngy.supabase.co/functions/v1/scanner-api';
const profiles = [
  'https://www.instagram.com/tot_yarik/',
  'https://www.instagram.com/traffic.money.ag/',
  'https://www.instagram.com/taboo.agency/',
  'https://www.instagram.com/ads.wind/',
];

function handleFromUrl(url: string) {
  return new URL(url).pathname.split('/').filter(Boolean)[0] || 'unknown';
}

async function reportDiscovery(handle: string, result: any) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is required');
  const bestScan = [...(result.scans || [])].sort((a: any, b: any) => Number(b.count || 0) - Number(a.count || 0))[0];
  const exactAdLibraryUrl = bestScan?.finalUrl || bestScan?.link?.href || result.discovery?.links?.[0]?.href || null;
  const status = exactAdLibraryUrl ? 'FOUND' : result.error ? 'ERROR' : 'NOT_FOUND';
  const response = await fetch(SCANNER_API, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'instagram_discovery', handle, status, exactAdLibraryUrl, exactAdvertiserName: null, payload: result }),
  });
  if (!response.ok) throw new Error(`discovery persistence failed: ${response.status} ${await response.text()}`);
}

async function configureInstagramAuth(context: BrowserContext) {
  const fullCookieHeader = process.env.INSTAGRAM_COOKIE_HEADER?.trim();
  if (fullCookieHeader) {
    const cookies = fullCookieHeader.split(';').map(part => part.trim()).filter(Boolean).map(part => {
      const i = part.indexOf('=');
      return i > 0 ? { name: part.slice(0, i).trim(), value: part.slice(i + 1).trim() } : null;
    }).filter((x): x is { name: string; value: string } => Boolean(x?.name && x?.value));
    if (cookies.length) {
      await context.addCookies(cookies.map(c => ({ ...c, domain: '.instagram.com', path: '/', secure: true, sameSite: 'None' as const })));
      console.log(`[exact-instagram] full cookie session configured (${cookies.length} cookies)`);
      return;
    }
  }

  const sessionId = process.env.INSTAGRAM_SESSIONID?.trim();
  if (sessionId) {
    await context.addCookies([{ name: 'sessionid', value: sessionId, domain: '.instagram.com', path: '/', httpOnly: true, secure: true, sameSite: 'None' }]);
    console.log('[exact-instagram] sessionid-only cookie configured');
  } else {
    console.log('[exact-instagram] no Instagram cookies configured');
  }
}

async function clickIfVisible(page: Page, patterns: RegExp[]) {
  for (const pattern of patterns) {
    const candidates = [page.getByRole('button', { name: pattern }), page.getByRole('link', { name: pattern }), page.getByText(pattern, { exact: false })];
    for (const locator of candidates) {
      if (!(await locator.count().catch(() => 0))) continue;
      const first = locator.first();
      if (await first.isVisible().catch(() => false)) {
        await first.click({ timeout: 5_000 }).catch(() => {});
        await page.waitForTimeout(1_500);
        return true;
      }
    }
  }
  return false;
}

async function collectAdLibraryLinks(page: Page) {
  return page.evaluate(() => Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'))
    .map(a => ({ text: (a.innerText || a.textContent || '').trim(), href: a.href }))
    .filter(x => /ads\/library|active ads/i.test(`${x.text} ${x.href}`)));
}

async function discoverExactAdLibrary(page: Page, profileUrl: string) {
  await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(6_000);
  await clickIfVisible(page, [/Allow all cookies/i, /Accept all/i, /Allow essential and optional cookies/i, /Not now/i]);

  let links = await collectAdLibraryLinks(page);
  if (links.length) return { method: 'direct-link', links };

  let openedAbout = await clickIfVisible(page, [/About this account/i]);
  if (!openedAbout) {
    const options = page.locator('svg[aria-label="Options"], svg[aria-label="More options"], button[aria-label="Options"], button[aria-label="More options"]');
    if (await options.count().catch(() => 0)) {
      await options.first().click({ timeout: 5_000 }).catch(() => {});
      await page.waitForTimeout(1_000);
      openedAbout = await clickIfVisible(page, [/About this account/i]);
    }
  }

  links = await collectAdLibraryLinks(page);
  if (links.length) return { method: openedAbout ? 'about-account-link' : 'link-after-menu', links };

  const activeAds = page.getByText(/Active ads/i, { exact: false }).first();
  if (await activeAds.count().catch(() => 0) && await activeAds.isVisible().catch(() => false)) {
    const before = page.url();
    const popupPromise = page.waitForEvent('popup', { timeout: 5_000 }).then(async p => { await p.waitForLoadState('domcontentloaded').catch(() => {}); return p.url(); }).catch(() => undefined);
    await activeAds.click({ timeout: 5_000 }).catch(() => {});
    await page.waitForTimeout(2_000);
    const popupUrl = await popupPromise;
    const after = page.url();
    if (popupUrl && /facebook\.com\/ads\/library/i.test(popupUrl)) return { method: 'active-ads-popup', links: [{ text: 'Active ads', href: popupUrl }] };
    if (after !== before && /facebook\.com\/ads\/library/i.test(after)) return { method: 'active-ads-navigation', links: [{ text: 'Active ads', href: after }] };
  }

  const bodyText = await page.locator('body').innerText().catch(() => '');
  const html = await page.content().catch(() => '');
  const embedded = [...html.matchAll(/https?:\\?\/\\?\/(?:www\\?\.)?facebook\\?\.com\\?\/ads\\?\/library[^"'<>\\s]*/gi)]
    .map(m => m[0].replace(/\\u0026/g, '&').replace(/\\\//g, '/'));
  if (embedded.length) return { method: 'embedded-html', links: [...new Set(embedded)].map(href => ({ text: 'embedded', href })) };

  return {
    method: 'not-found', links: [], bodySnippet: bodyText.slice(0, 6000),
    hasLoginWall: /log into instagram|log in|sign up/i.test(bodyText),
    hasAboutText: /about this account/i.test(bodyText), hasActiveAdsText: /active ads/i.test(bodyText), finalProfileUrl: page.url(),
  };
}

async function scanAdLibrary(page: Page, url: string) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(7_000);
  let previous = 0, stable = 0;
  for (let i = 0; i < 30; i++) {
    const body = await page.locator('body').innerText().catch(() => '');
    const count = new Set([...body.matchAll(/Library ID\s*:?\s*(\d+)/gi)].map(m => m[1])).size;
    stable = count === previous ? stable + 1 : 0;
    previous = count;
    if (stable >= 3 && i >= 5) break;
    await page.mouse.wheel(0, 2800);
    await page.waitForTimeout(1000);
  }
  const body = await page.locator('body').innerText().catch(() => '');
  const ids = [...new Set([...body.matchAll(/Library ID\s*:?\s*(\d+)/gi)].map(m => m[1]))];
  return { count: ids.length, libraryIds: ids, bodySnippet: body.slice(0, 5000), finalUrl: page.url() };
}

async function main() {
  await mkdir('artifacts/exact-instagram', { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1200 }, locale: 'en-US', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/150.0.0.0 Safari/537.36' });
  await configureInstagramAuth(context);

  const results: any[] = [];
  try {
    for (const profileUrl of profiles) {
      const handle = handleFromUrl(profileUrl);
      const page = await context.newPage();
      console.log(`\n[exact-instagram] ${handle}`);
      try {
        const discovery = await discoverExactAdLibrary(page, profileUrl);
        console.log(`[exact-instagram] discovery=${discovery.method} links=${discovery.links.length} loginWall=${Boolean((discovery as any).hasLoginWall)}`);
        const exactLinks = discovery.links.filter((x: any) => /facebook\.com\/ads\/library/i.test(x.href));
        const scans = [];
        for (const link of exactLinks.slice(0, 3)) {
          const scanPage = await context.newPage();
          try {
            const scan = await scanAdLibrary(scanPage, link.href);
            scans.push({ link, ...scan });
            console.log(`[exact-instagram] ${handle} active_ads=${scan.count}`);
          } finally { await scanPage.close(); }
        }
        const result = { handle, profileUrl, discovery, scans };
        results.push(result);
        await reportDiscovery(handle, result);
        await writeFile(`artifacts/exact-instagram/${handle.replace(/[^a-z0-9._-]/gi, '_')}.json`, JSON.stringify(result, null, 2), 'utf8');
        await page.screenshot({ path: `artifacts/exact-instagram/${handle.replace(/[^a-z0-9._-]/gi, '_')}.png`, fullPage: true }).catch(() => {});
      } catch (error) {
        const result = { handle, profileUrl, error: String(error) };
        results.push(result);
        await reportDiscovery(handle, result).catch(() => {});
        console.error(`[exact-instagram] ${handle} failed`, error);
      } finally { await page.close(); }
    }
  } finally { await browser.close(); }
  await writeFile('artifacts/exact-instagram/summary.json', JSON.stringify(results, null, 2), 'utf8');
}

main().catch(err => { console.error(err); process.exit(1); });
