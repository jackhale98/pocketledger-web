// Visit each Reports tab at phone width: overflow + axe + screenshot.
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
const out = process.env.OUT;
const W = +(process.env.W ?? 375);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await browser.newContext({ viewport: { width: W, height: 812 }, deviceScaleFactor: out ? 2 : 1, colorScheme: process.env.SCHEME ?? 'light' });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.goto('http://localhost:4329/pocketledger-web/app/');
await page.locator('main li button.row').first().waitFor({ timeout: 30000 });
await page.goto('http://localhost:4329/pocketledger-web/app/#/reports');
for (const tab of (process.argv[2] ?? 'Overview,Table,Account,Prices,Stats').split(',')) {
  await page.getByRole('tab', { name: tab }).click();
  await page.waitForTimeout(2000);
  const r = await page.evaluate(() => ({ vw: document.documentElement.clientWidth, sw: document.documentElement.scrollWidth }));
  const a = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).exclude('#pl-loader').analyze();
  console.log(tab.padEnd(9), r.sw > r.vw ? `OVERFLOW ${r.sw}>${r.vw}` : 'fits', 'axe:', a.violations.map((v) => `${v.id}(${v.nodes.length}) ${v.nodes[0]?.html.slice(0, 80)}`).join('; ') || 'clean');
  if (out) await page.screenshot({ path: `${out}/r-${tab.toLowerCase()}.png`, fullPage: true });
}
console.log(errs.length ? 'page errors: ' + errs.join(' | ') : 'no page errors');
await browser.close();
