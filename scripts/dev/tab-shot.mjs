// Screenshot one Reports tab (dev aid). OUT=dir node scripts/dev/tab-shot.mjs Investments name [w] [h]
import { chromium } from 'playwright';
const [, , tab = 'Investments', name = 'tab', w = '390', h = '1500'] = process.argv;
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: +w, height: +h }, deviceScaleFactor: 2 });
await page.goto('http://localhost:4329/pocketledger-web/app/');
await page.locator('main li button.row').first().waitFor({ timeout: 30000 });
await page.goto('http://localhost:4329/pocketledger-web/app/#/reports');
await page.getByRole('tab', { name: tab }).click();
await page.waitForTimeout(2500);
await page.screenshot({ path: `${process.env.OUT}/${name}.png` });
await browser.close();
