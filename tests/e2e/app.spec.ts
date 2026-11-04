import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

async function openDemo(page: Page) {
  await page.goto('app/');
  // The engine compiles, parses the demo vault, then the list renders.
  await expect(page.getByRole('heading', { level: 1, name: 'Transactions' })).toBeVisible();
  await expect(page.locator('main li button.row').first()).toBeVisible({ timeout: 30_000 });
}

const axe = (page: Page) => new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).exclude('#pl-loader');

test('landing page is accessible and links to the app', async ({ page }) => {
  await page.goto('./');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('in your pocket');
  expect((await axe(page).analyze()).violations).toEqual([]);
});

test('demo vault loads with hledger and lists transactions', async ({ page }) => {
  await openDemo(page);
  await expect(page.getByText(/\d+ transactions/)).toBeVisible();
  expect((await axe(page).analyze()).violations).toEqual([]);
});

test('add, edit and delete a transaction', async ({ page }) => {
  await openDemo(page);
  const add = page.getByRole('button', { name: /New transaction/ }).first();
  await (await add.isVisible() ? add : page.getByRole('button', { name: 'New transaction' }).last()).click();
  const dialog = page.getByRole('dialog', { name: 'New transaction' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('combobox', { name: 'Description' }).fill('E2E Bakery | croissants');
  await dialog.getByRole('combobox', { name: 'Account 1' }).fill('expenses:dining');
  await dialog.getByRole('textbox', { name: 'Amount 1' }).fill('7.25');
  await dialog.getByRole('combobox', { name: 'Account 2' }).fill('assets:cash');
  await expect(dialog.getByText('Balanced')).toBeVisible();
  expect((await axe(page).include('dialog').analyze()).violations).toEqual([]);
  await dialog.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole('searchbox', { name: 'Search transactions' }).fill('E2E Bakery');
  const row = page.locator('main li button.row', { hasText: 'E2E Bakery' });
  await expect(row).toHaveCount(1);

  // Edit
  await row.click();
  const detail = page.getByRole('dialog', { name: 'Transaction' });
  await detail.getByRole('button', { name: 'Edit', exact: true }).click();
  const edit = page.getByRole('dialog', { name: 'Edit transaction' });
  await edit.getByRole('textbox', { name: 'Amount 1' }).fill('8.50');
  await edit.getByRole('button', { name: 'Save' }).click();
  await expect(edit).toBeHidden();
  await expect(row).toContainText('8.50');

  // Delete, then undo
  await row.click();
  await detail.getByRole('button', { name: 'Edit', exact: true }).click();
  await edit.getByRole('button', { name: 'Delete' }).click();
  await expect(row).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo' }).first().click();
  await expect(row).toHaveCount(1);
});

test('an unbalanced text edit is refused with hledger’s message', async ({ page }) => {
  await openDemo(page);
  await page.locator('main li button.row').first().click();
  await page.getByRole('dialog', { name: 'Transaction' }).getByRole('button', { name: 'Edit text' }).click();
  const edit = page.getByRole('dialog', { name: 'Edit transaction' });
  const ta = edit.getByRole('textbox', { name: 'Journal text' });
  const text = await ta.inputValue();
  // Give the inferred posting an explicit, wrong amount.
  const lines = text.split('\n');
  lines[lines.length - 1] = lines[lines.length - 1] + '  $1.00';
  await ta.fill(lines.join('\n'));
  await expect(edit.getByRole('status').filter({ hasText: 'hledger:' })).toBeVisible();
  await expect(edit.getByRole('button', { name: 'Save' })).toBeDisabled();
});

for (const view of ['accounts', 'reports', 'statements', 'budget', 'import', 'reconcile', 'settings', 'console', 'check', 'files']) {
  test(`${view} view renders and is accessible`, async ({ page }) => {
    await openDemo(page);
    await page.goto(`app/#/${view}`);
    await page.waitForTimeout(400);
    await expect(page.locator('main')).not.toContainText('could not');
    if (view === 'accounts') await expect(page.getByRole('link', { name: 'checking' })).toBeVisible();
    if (view === 'budget') await expect(page.getByText('Spending goals')).toBeVisible();
    if (view === 'reports') await expect(page.getByRole('img', { name: 'Net worth by month' })).toBeVisible();
    if (view === 'statements') await expect(page.getByText('Total assets')).toBeVisible();
    expect((await axe(page).analyze()).violations).toEqual([]);
  });
}

test('CSV import previews with hledger rules and flags nothing as duplicate', async ({ page }) => {
  await openDemo(page);
  await page.goto('app/#/import');
  await page.getByLabel('CSV in vault').selectOption('import/bank.csv');
  await expect(page.getByText('5 transactions')).toBeVisible();
  await page.getByRole('button', { name: /Import 5/ }).click();
  await expect(page.getByText('Imported 5 transactions')).toBeVisible();
});

test('works offline after the first visit', async ({ page, context, browserName }) => {
  test.skip(browserName === 'webkit', 'service worker offline mode differs in WebKit test builds');
  await openDemo(page);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await expect(page.locator('main li button.row').first()).toBeVisible({ timeout: 30_000 });
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('main li button.row').first()).toBeVisible({ timeout: 30_000 });
  await context.setOffline(false);
});

test('every Reports tab fits a phone screen and is accessible', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await openDemo(page);
  await page.goto('app/#/reports');
  for (const tab of ['Overview', 'Table', 'Account', 'Forecast', 'Prices', 'Stats']) {
    await page.getByRole('tab', { name: tab }).click();
    await page.waitForTimeout(800);
    const { sw, vw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, vw: document.documentElement.clientWidth }));
    expect(sw, `${tab} overflows horizontally`).toBeLessThanOrEqual(vw);
    expect((await axe(page).analyze()).violations, `${tab} axe`).toEqual([]);
  }
});

test('expense breakdown drills into categories', async ({ page }) => {
  await openDemo(page);
  await page.goto('app/#/reports');
  await page.getByRole('tab', { name: 'Overview' }).click();
  await page.getByRole('button', { name: /^rent/ }).click();
  await expect(page).toHaveURL(/#\/account\/expenses:rent/);
});
