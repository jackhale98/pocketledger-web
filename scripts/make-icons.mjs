// Render PNG icons from the SVGs with the pre-installed Playwright Chromium.
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
const page = await browser.newPage();
const shots = [
  ['public/favicon.svg', 'public/icons/icon-192.png', 192],
  ['public/favicon.svg', 'public/icons/icon-512.png', 512],
  ['public/favicon.svg', 'public/icons/apple-touch-icon.png', 180],
  ['public/icons/maskable.svg', 'public/icons/icon-maskable-512.png', 512],
];
for (const [src, out, size] of shots) {
  const svg = readFileSync(src, 'utf8');
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
  await page.locator('svg').screenshot({ path: out, omitBackground: true });
}
await browser.close();
console.log('icons written');
