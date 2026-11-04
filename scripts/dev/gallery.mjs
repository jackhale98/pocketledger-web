import { chromium } from 'playwright';
const out = process.env.OUT;
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
async function shot(name, path, w, h, scheme = 'light', act) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, colorScheme: scheme });
  const page = await ctx.newPage();
  await page.goto('http://localhost:4329/pocketledger-web/app/');
  await page.locator('main li button.row').first().waitFor({ timeout: 30000 });
  if (path) await page.goto(`http://localhost:4329/pocketledger-web/app/${path}`);
  await page.waitForTimeout(1500);
  if (act) await act(page);
  await page.screenshot({ path: `${out}/${name}.png` });
  await ctx.close();
}
await shot('m-transactions', '', 390, 844);
await shot('m-editor', '', 390, 844, 'light', async (p) => {
  await p.getByRole('button', { name: 'New transaction' }).last().click();
  await p.getByRole('combobox', { name: 'Description' }).fill('Bean There | Coffee');
  await p.getByRole('combobox', { name: 'Account 1' }).fill('expenses:coffee');
  await p.getByRole('textbox', { name: 'Amount 1' }).fill('4.50');
  await p.getByRole('combobox', { name: 'Account 2' }).fill('assets:cash');
  await p.keyboard.press('Escape').catch(() => {});
  await p.getByRole('combobox', { name: 'Account 2' }).blur();
  await p.waitForTimeout(400);
});
await shot('m-accounts-dark', '#/accounts', 390, 844, 'dark');
await shot('d-reports-dark', '#/reports', 1280, 860, 'dark');
await shot('d-transactions', '', 1280, 860);
await browser.close();
