import { chromium } from 'playwright';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await browser.newContext();
const page = await ctx.newPage();
page.on('console', (m) => !m.text().includes('wasi') && console.log('[console]', m.text()));
await page.goto('http://localhost:4329/pocketledger-web/app/');
await page.waitForTimeout(6000);
console.log(await page.evaluate(async () => {
  const regs = await navigator.serviceWorker.getRegistrations();
  return JSON.stringify(regs.map((r) => ({ scope: r.scope, active: r.active?.state, installing: r.installing?.state, waiting: r.waiting?.state })));
}));
console.log(await page.evaluate(async () => JSON.stringify(await Promise.all((await caches.keys()).map(async (k) => [k, (await (await caches.open(k)).keys()).length])))));
await browser.close();
