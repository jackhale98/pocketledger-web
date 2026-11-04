import { chromium } from 'playwright';
const [,, out = 'shot', path = 'app/', w = '390', h = '844'] = process.argv;
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: +w, height: +h }, deviceScaleFactor: 1 });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
const t0 = Date.now();
await page.goto(`http://localhost:4329/pocketledger-web/${path}`);
try { await page.locator('main li button.row').first().waitFor({ timeout: 30000 }); console.log('list visible after', Date.now() - t0, 'ms'); } catch { console.log('no list'); }
await page.waitForTimeout(1500);
await page.screenshot({ path: `${process.env.OUT}/${out}.png`, fullPage: false });
console.log(logs.slice(0, 20).join('\n'));
await browser.close();
