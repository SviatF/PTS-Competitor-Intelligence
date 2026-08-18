import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const REPORT_URL = 'https://qfpwpqflqiwjqpojmngy.supabase.co/functions/v1/exact-facebook-report';
const pages = [
  { pageId: '61556616056037', sourceUrl: 'https://www.facebook.com/profile.php?id=61556616056037' },
  { pageId: '61586423325192', sourceUrl: 'https://www.facebook.com/profile.php?id=61586423325192' },
];

function adLibraryUrl(pageId: string) {
  const p = new URLSearchParams({ active_status: 'active', ad_type: 'all', country: 'ALL', view_all_page_id: pageId });
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

async function main() {
  await mkdir('artifacts/exact-facebook', { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1200 }, locale: 'en-US' });
  const results: any[] = [];
  try {
    for (const item of pages) {
      const page = await context.newPage();
      const url = adLibraryUrl(item.pageId);
      console.log(`[exact-facebook] page=${item.pageId} url=${url}`);
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(7000);
        let prev = 0, stable = 0;
        for (let i = 0; i < 30; i++) {
          const body = await page.locator('body').innerText().catch(() => '');
          const count = new Set([...body.matchAll(/Library ID\s*:?\s*(\d+)/gi)].map(m => m[1])).size;
          stable = count === prev ? stable + 1 : 0;
          prev = count;
          if (stable >= 3 && i >= 5) break;
          await page.mouse.wheel(0, 2800);
          await page.waitForTimeout(1000);
        }
        const body = await page.locator('body').innerText().catch(() => '');
        const ids = [...new Set([...body.matchAll(/Library ID\s*:?\s*(\d+)/gi)].map(m => m[1]))];
        const advertisers = [...new Set([...body.matchAll(/(?:See ad details|See summary details)\s*\n([^\n]+)\s*\nSponsored/gi)].map(m => m[1].trim()).filter(Boolean))];
        const result = { ...item, url, finalUrl: page.url(), count: ids.length, libraryIds: ids, advertisers, bodySnippet: body.slice(0, 6000) };
        results.push(result);
        console.log(`[exact-facebook] page=${item.pageId} ads=${ids.length} advertisers=${advertisers.join(' | ')}`);
        await report(result);
        await writeFile(`artifacts/exact-facebook/${item.pageId}.json`, JSON.stringify(result, null, 2), 'utf8');
      } catch (e) {
        const result = { ...item, url, error: String(e), count: 0, libraryIds: [], advertisers: [] };
        results.push(result);
        await report(result).catch(() => {});
        console.error(`[exact-facebook] page=${item.pageId} failed`, e);
      } finally { await page.close(); }
    }
  } finally { await browser.close(); }
  await writeFile('artifacts/exact-facebook/summary.json', JSON.stringify(results, null, 2), 'utf8');
}

main().catch(e => { console.error(e); process.exit(1); });