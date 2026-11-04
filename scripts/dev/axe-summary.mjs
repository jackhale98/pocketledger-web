// Summarise axe violations per view (dev aid). Needs `astro preview --port 4329` running.
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
const views = (process.argv[2] ?? ',accounts,reports,statements,budget,import,reconcile,settings,console,check,files,more').split(',');
const scheme = process.env.SCHEME ?? 'light';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await browser.newContext({ colorScheme: scheme, viewport: { width: +(process.env.W ?? 1280), height: 900 } });
const page = await ctx.newPage();
await page.goto('http://localhost:4329/pocketledger-web/app/');
await page.locator('main li button.row').first().waitFor({ timeout: 30000 });
const seen = new Map();
for (const v of views) {
  if (v) await page.goto(`http://localhost:4329/pocketledger-web/app/#/${v}`);
  await page.waitForTimeout(1200);
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).exclude('#pl-loader').analyze();
  for (const vi of r.violations)
    for (const n of vi.nodes) {
      const d = n.any[0]?.data ?? {};
      const key = vi.id === 'color-contrast' ? `contrast ${d.fgColor} on ${d.bgColor} (${d.contrastRatio})` : `${vi.id}: ${n.target.join(' ')}`;
      if (!seen.has(key)) seen.set(key, `${v || 'transactions'} · ${n.html.slice(0, 90)}`);
    }
}
for (const [k, v] of seen) console.log(k, '\n   ', v);
console.log(seen.size, 'distinct issues');
await browser.close();
