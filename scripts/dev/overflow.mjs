// Report pages whose content is wider than a phone viewport.
import { chromium } from 'playwright';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: +(process.env.W ?? 375), height: 812 } });
await page.goto('http://localhost:4329/pocketledger-web/app/');
await page.locator('main li button.row').first().waitFor({ timeout: 30000 });
for (const v of (process.argv[2] ?? 'transactions,accounts,reports,statements,budget,import,reconcile,settings,console,check,files,more').split(',')) {
  await page.goto(`http://localhost:4329/pocketledger-web/app/#/${v}`);
  await page.waitForTimeout(1500);
  const r = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const wide = [...document.querySelectorAll('main *')].filter((e) => e.getBoundingClientRect().right > vw + 1).slice(0, 3).map((e) => `${e.tagName.toLowerCase()}.${[...e.classList].join('.')} → ${Math.round(e.getBoundingClientRect().right)}`);
    return { vw, sw: document.documentElement.scrollWidth, wide };
  });
  console.log(v.padEnd(13), r.sw > r.vw ? `OVERFLOW ${r.sw}>${r.vw}` : 'ok', r.wide.join(' | '));
}
await browser.close();
