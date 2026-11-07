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
  for (const tab of ['Overview', 'Table', 'Account', 'Investments', 'Forecast', 'Prices', 'Stats']) {
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

test('search runs as an hledger query across the journal', async ({ page }) => {
  await openDemo(page);
  await page.getByRole('searchbox', { name: 'Search transactions' }).fill('coffee');
  await expect(page.locator('main li button.row').first()).toContainText('Bean There');
  await expect(page.locator('main li button.row', { hasText: 'Landlord' })).toHaveCount(0);
});

test('reconciling clears only the matching posting, not the whole transaction', async ({ page }) => {
  await openDemo(page);
  // An uncleared card purchase to reconcile.
  await page.getByRole('button', { name: /New transaction/ }).first().click().catch(() => page.getByRole('button', { name: 'New transaction' }).last().click());
  const dialog = page.getByRole('dialog', { name: 'New transaction' });
  await dialog.getByRole('combobox', { name: 'Description' }).fill('Bookshop | Birthday gift');
  await dialog.getByRole('combobox', { name: 'Account 1' }).fill('expenses:gifts');
  await dialog.getByRole('textbox', { name: 'Amount 1' }).fill('42');
  await dialog.getByRole('combobox', { name: 'Account 2' }).fill('liabilities:credit card');
  await dialog.getByRole('radio', { name: 'Pending' }).click();
  await dialog.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(dialog).toBeHidden();
  await page.goto('app/#/reconcile?account=liabilities:credit%20card');
  const row = page.locator('main li', { hasText: 'Bookshop' });
  await row.getByRole('checkbox').check();
  page.once('dialog', (d) => void d.accept());
  await page.getByRole('button', { name: /Finish anyway/ }).click();
  await expect(page.getByText(/Cleared 1 posting/)).toBeVisible();
  await page.goto('app/#/files');
  const file = await page.locator('main li a', { hasText: '.journal' }).allInnerTexts();
  void file;
  await page.goto('app/#/transactions');
  await page.getByRole('searchbox', { name: 'Search transactions' }).fill('Bookshop');
  await page.locator('main li button.row').first().click();
  await page.getByRole('button', { name: 'Show source' }).click();
  const code = page.getByRole('dialog', { name: 'Transaction' }).locator('pre.src');
  // Header keeps its pending mark; only the card posting gets "*".
  await expect(code).toContainText(/! Bookshop \| Birthday gift/);
  await expect(code).toContainText(/\* liabilities:credit card/);
});

test('editing in the form keeps a secondary date', async ({ page }) => {
  await openDemo(page);
  const first = page.locator('main li button.row').first();
  await first.click();
  await page.getByRole('dialog', { name: 'Transaction' }).getByRole('button', { name: 'Edit text' }).click();
  const edit = page.getByRole('dialog', { name: 'Edit transaction' });
  const ta = edit.getByRole('textbox', { name: 'Journal text' });
  const text = await ta.inputValue();
  await ta.fill(text.replace(/^(\d{4}-\d\d-\d\d)/, '$1=$1'));
  await expect(edit.getByText('hledger reads this')).toBeVisible();
  await edit.getByRole('button', { name: 'Save' }).click();
  await expect(edit).toBeHidden();
  await first.click();
  await page.getByRole('dialog', { name: 'Transaction' }).getByRole('button', { name: 'Edit', exact: true }).click();
  await edit.getByRole('combobox', { name: 'Description' }).fill('Kept date2 check');
  await edit.getByRole('button', { name: 'Save' }).click();
  await expect(edit).toBeHidden();
  await page.getByRole('searchbox', { name: 'Search transactions' }).fill('Kept date2 check');
  await page.locator('main li button.row').first().click();
  await expect(page.getByRole('dialog', { name: 'Transaction' })).toContainText(/\d{4}-\d\d-\d\d = \d{4}-\d\d-\d\d/);
});

test('a missing included file can be uploaded to fix the journal', async ({ page }) => {
  await openDemo(page);
  // Import a journal whose included file wasn't copied along.
  await page.goto('app/#/settings?add=1');
  await page.locator('input[type=file][accept*=".journal"]').setInputFiles({
    name: 'main.journal',
    mimeType: 'text/plain',
    buffer: Buffer.from('include extra.journal\n\n2026-01-01 Opening\n    assets:cash  $10\n    equity:opening\n'),
  });
  await page.goto('app/#/transactions');
  await expect(page.getByRole('heading', { name: 'Missing included files' })).toBeVisible();
  await expect(page.getByText('extra.journal').first()).toBeVisible();
  await page.locator('section.miss input[type=file]').setInputFiles({ name: 'extra.journal', mimeType: 'text/plain', buffer: Buffer.from('2026-01-02 Uploaded\n    expenses:gifts  $1\n    assets:cash\n') });
  await expect(page.getByRole('heading', { name: 'Missing included files' })).toBeHidden();
  await expect(page.locator('main li button.row', { hasText: 'Uploaded' })).toHaveCount(1);
});

test('hide amounts blurs every amount', async ({ page }) => {
  await openDemo(page);
  await page.getByRole('button', { name: 'Hide amounts' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-private', '');
  await page.getByRole('button', { name: 'Show amounts' }).click();
  await expect(page.locator('html')).not.toHaveAttribute('data-private', '');
});

test('reports export as CSV produced by hledger', async ({ page }) => {
  await openDemo(page);
  await page.goto('app/#/statements?kind=bs');
  await expect(page.getByText('Total assets')).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'CSV' }).click()]);
  expect(download.suggestedFilename()).toMatch(/^balance-sheet-\d{4}-\d\d-\d\d\.csv$/);
  const text = await (await download.createReadStream()).toArray();
  expect(Buffer.concat(text).toString('utf8')).toMatch(/assets/);
});

test('a market price can be added from the Prices tab', async ({ page }) => {
  await openDemo(page);
  await page.goto('app/#/reports');
  await page.getByRole('tab', { name: 'Prices' }).click();
  await page.getByRole('button', { name: 'Add price' }).click();
  const sheet = page.getByRole('dialog', { name: 'Add a market price' });
  await sheet.getByRole('combobox', { name: 'Commodity' }).fill('VTI');
  await sheet.getByRole('textbox', { name: 'Price of one unit' }).fill('301.25');
  await sheet.getByRole('combobox', { name: 'In currency' }).fill('$');
  expect((await axe(page).include('dialog').analyze()).violations).toEqual([]);
  await sheet.getByRole('button', { name: 'Add price' }).click();
  await expect(sheet).toBeHidden();
  await expect(page.getByText(/Added P \d{4}-\d\d-\d\d VTI \$301\.25 to prices\.journal/)).toBeVisible();
  await expect(page.locator('main tr', { hasText: 'VTI' }).first()).toContainText('$301.25');
});

test('table rows can be grouped by payee and spending by merchant', async ({ page }) => {
  await openDemo(page);
  await page.goto('app/#/reports');
  await page.getByRole('tab', { name: 'Table' }).click();
  await page.getByLabel('Rows').selectOption('payee');
  await expect(page.locator('main table')).toContainText('Landlord');
  await page.getByRole('tab', { name: 'Overview' }).click();
  await page.getByRole('button', { name: 'Merchant' }).click();
  await expect(page.locator('ul.rank')).toContainText('Landlord');
});

test('auto-posting rules are applied to reports', async ({ page }) => {
  await openDemo(page);
  await page.goto('app/#/files/main.journal');
  await page.getByRole('button', { name: 'Edit' }).click();
  const ta = page.getByRole('textbox', { name: /Contents of main.journal/ });
  await ta.fill((await ta.inputValue()) + '\n= expenses:coffee\n    (tracking:caffeine)  *1\n');
  await expect(page.getByText('hledger reads this')).toBeVisible();
  await page.getByRole('button', { name: 'Save' }).click();
  await page.goto('app/#/accounts');
  await expect(page.getByRole('link', { name: 'tracking' })).toBeVisible();
});

test('Investments tab values the demo VTI holding with cost, value and gain', async ({ page }) => {
  await openDemo(page);
  await page.goto('app/#/reports');
  await page.getByRole('tab', { name: 'Investments' }).click();
  const holdings = page.locator('section[aria-labelledby="hold-h"]');
  await expect(holdings.getByRole('heading', { name: 'Holdings' })).toBeVisible();
  const vti = holdings.locator('tbody tr, li').filter({ hasText: 'VTI' }).filter({ hasText: 'assets:brokerage' });
  await expect(vti).toHaveCount(1);
  // Units, then cost, market value and gain: dollar amounts from hledger (-B, -X $, --gain -X $).
  await expect(vti).toContainText(/\d+\.000 VTI/);
  await expect.poll(async () => ((await vti.innerText()).match(/\$[\d,]+\.\d\d/g) ?? []).length).toBeGreaterThanOrEqual(4);
  await expect(page.getByRole('heading', { name: 'Returns' })).toBeVisible();
  await expect(page.locator('section[aria-labelledby="ret-h"]')).toContainText('%');
  await expect(page.getByRole('heading', { name: 'Allocation' })).toBeVisible();
  await expect(page.getByRole('img', { name: /Market value and cost of all holdings/ })).toBeVisible();
  expect((await axe(page).analyze()).violations).toEqual([]);

  await page.setViewportSize({ width: 375, height: 812 });
  await expect(holdings.locator('li').filter({ hasText: 'VTI' }).first()).toBeVisible();
  await page.waitForTimeout(500);
  const { sw, vw, wide } = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    // The tab strip and period chips scroll sideways by design; the tab's own content must fit.
    const wide = [...document.querySelectorAll('#rp *')].filter((e) => e.getBoundingClientRect().right > vw + 1).map((e) => `${e.tagName}.${e.className}`);
    return { sw: document.documentElement.scrollWidth, vw, wide };
  });
  expect(sw, 'Investments overflows horizontally').toBeLessThanOrEqual(vw);
  expect(wide, 'elements wider than 375px').toEqual([]);
  expect((await axe(page).analyze()).violations, 'Investments axe at 375px').toEqual([]);
});

test('valuation control switches Accounts between units, cost, market value and gain', async ({ page }) => {
  await openDemo(page);
  await page.goto('app/#/accounts');
  const row = page.getByRole('row').filter({ has: page.getByRole('link', { name: 'brokerage', exact: true }) });
  await expect(row).toContainText('VTI');
  const mode = page.getByRole('combobox', { name: 'Amounts' });
  await mode.selectOption({ label: 'Cost' });
  await expect(row).not.toContainText('VTI');
  await expect(row).toContainText(/\$[\d,]+\.\d\d/);
  const cost = (await row.locator('.val').innerText()).trim();
  await mode.selectOption({ label: 'Market value' });
  await page.getByRole('combobox', { name: 'in currency' }).selectOption('$');
  await expect(row.locator('.val')).not.toHaveText(cost);
  await expect(row).toContainText(/\$[\d,]+\.\d\d/);
  await mode.selectOption({ label: 'Unrealized gain' });
  await expect(row.locator('.val')).toHaveText(/^\$[\d,]+\.\d\d$/);
  // VTI's price rose after almost every demo purchase, so the unrealized gain is positive and below the cost.
  const gain = Number((await row.locator('.val').innerText()).replace(/[^\d.]/g, ''));
  expect(gain).toBeGreaterThan(0);
  expect(gain).toBeLessThan(Number(cost.replace(/[^\d.]/g, '')));
  expect((await axe(page).analyze()).violations).toEqual([]);
  // The choice is a saved setting.
  await page.reload();
  await expect(page.getByRole('combobox', { name: 'Amounts' })).toHaveValue('gain');
  await mode.selectOption({ label: 'As written' });
  await expect(row).toContainText('VTI');
});

async function fitsPhone(page: Page, what: string) {
  const { sw, vw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, vw: document.documentElement.clientWidth }));
  expect(sw, `${what} overflows horizontally`).toBeLessThanOrEqual(vw);
}

test('close year: migrate balances with hledger close, warn on a second close, undo', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await openDemo(page);
  await page.goto('app/#/close');
  const preview = page.getByRole('region', { name: 'Preview' });
  await expect(preview.locator('pre.src').filter({ hasText: /^\d{4}-12-31 closing balances/ })).toBeVisible();
  await expect(preview.locator('pre.src').filter({ hasText: /^\d{4}-01-01 opening balances/ })).toBeVisible();
  // The demo keeps one folder per year, included by a glob: a new file and a mirrored include.
  await expect(preview).toContainText('Create 2027/2027.journal');
  await expect(preview.locator('pre.src').filter({ hasText: 'include 2027/*.journal' })).toBeVisible();
  await expect(page.getByText(/hledger command: hledger close --migrate -e \d{4}-01-01/)).toBeVisible();
  await fitsPhone(page, 'close view');
  expect((await axe(page).analyze()).violations).toEqual([]);

  await page.getByRole('button', { name: /^Close \d{4}$/ }).click();
  await expect(page.getByText(/Closed \d{4} · created 2027\/2027\.journal/)).toBeVisible();
  // Closing again is detected and needs confirmation.
  await expect(page.getByText(/looks closed already/)).toBeVisible();
  await expect(page.getByRole('button', { name: /^Close \d{4}$/ })).toBeDisabled();
  await expect(preview).toContainText('Nothing to close');
  expect((await axe(page).analyze()).violations).toEqual([]);

  await page.goto('app/#/transactions');
  await page.getByRole('searchbox', { name: 'Search transactions' }).fill('desc:closing');
  await expect(page.locator('main li button.row', { hasText: 'closing balances' })).toHaveCount(1);
  await page.getByRole('button', { name: /^Undo close/ }).click();
  await expect(page.locator('main li button.row', { hasText: 'closing balances' })).toHaveCount(0);

  // Retain earnings: one entry, to equity:retained earnings.
  await page.goto('app/#/close');
  await page.getByRole('radio', { name: /Retain earnings/ }).check();
  await expect(preview.locator('pre.src').filter({ hasText: 'equity:retained earnings' })).toBeVisible();
  await expect(preview.locator('pre.src')).toHaveCount(1);
  await expect(page.getByText(/looks closed already/)).toHaveCount(0);
});

test('rename an account and its subaccounts everywhere, with a preview', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await openDemo(page);
  await page.goto('app/#/accounts');
  await page.getByRole('button', { name: 'Rename expenses:coffee' }).click();
  const dialog = page.getByRole('dialog', { name: 'Rename account' });
  const name = dialog.getByRole('textbox', { name: 'New name' });
  // Renaming onto an existing account asks to merge.
  await name.fill('expenses:dining');
  await expect(dialog.getByText(/already exists/)).toBeVisible();
  const go = dialog.getByRole('button', { name: /^Rename \(/ });
  await expect(go).toBeDisabled();
  await dialog.getByRole('checkbox', { name: 'Merge into the existing account' }).check();
  await expect(go).toBeEnabled();
  await name.fill('expenses:food:coffee');
  await expect(dialog.getByText(/already exists/)).toHaveCount(0);
  await expect(dialog.getByRole('list', { name: 'Lines that will change' })).toContainText('account expenses:food:coffee');
  await expect(dialog.getByText(/\d+ lines in \d+ files will change/)).toBeVisible();
  await fitsPhone(page, 'rename sheet');
  expect((await axe(page).include('dialog').analyze()).violations).toEqual([]);
  await go.click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText(/Renamed expenses:coffee to expenses:food:coffee/)).toBeVisible();
  await page.getByRole('button', { name: 'Expand all' }).click();
  await expect(page.getByRole('link', { name: 'coffee' })).toBeVisible();
  await page.goto('app/#/transactions');
  await page.getByRole('searchbox', { name: 'Search transactions' }).fill('Bean There');
  await expect(page.locator('main li button.row').first()).toContainText('food:coffee');
});

test('bulk recategorise, mark and delete selected transactions as one undoable change', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await openDemo(page);
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Search transactions' }).fill('Bean There');
  const rows = page.locator('main li label.row');
  await expect(rows.first()).toContainText('Bean There');
  await expect(rows.filter({ hasNotText: 'Bean There' })).toHaveCount(0);
  const count = await rows.count();
  expect(count).toBeGreaterThan(2);
  const bar = page.getByRole('region', { name: 'Selected transactions' });
  await bar.getByRole('button', { name: `Select all ${count}` }).click();
  await expect(bar).toContainText(`${count} selected`);
  await fitsPhone(page, 'select mode');
  expect((await axe(page).analyze()).violations).toEqual([]);

  // Change account: coffee → dining in all of them.
  await bar.getByRole('button', { name: 'Account' }).click();
  const sheet = page.getByRole('dialog', { name: 'Change account' });
  await sheet.getByRole('combobox', { name: 'Replace' }).selectOption('expenses:coffee');
  await sheet.getByRole('combobox', { name: 'With' }).fill('expenses:dining');
  expect((await axe(page).include('dialog').analyze()).violations).toEqual([]);
  await sheet.getByRole('button', { name: `Change in ${count} transactions` }).click();
  await expect(sheet).toBeHidden();
  await expect(page.getByText(`Changed expenses:coffee to expenses:dining in ${count} transactions`)).toBeVisible();
  await expect(rows.first()).toContainText('dining');
  await expect(rows.filter({ hasText: 'expenses:coffee' })).toHaveCount(0);

  // Mark two pending; the selection survives a filter change.
  await rows.nth(0).getByRole('checkbox').check();
  await rows.nth(1).getByRole('checkbox').check();
  await page.getByRole('searchbox', { name: 'Search transactions' }).fill('');
  await expect(bar).toContainText('2 selected');
  await page.getByRole('searchbox', { name: 'Search transactions' }).fill('Bean There');
  await bar.getByRole('button', { name: 'Status' }).click();
  await page.getByRole('dialog', { name: 'Set status' }).getByRole('button', { name: /Pending/ }).click();
  await expect(page.getByText('Marked 2 transactions pending')).toBeVisible();
  await expect(rows.filter({ hasText: 'Pending' })).toHaveCount(2);

  // Delete, confirm, then undo in one step.
  await rows.nth(0).getByRole('checkbox').check();
  await rows.nth(1).getByRole('checkbox').check();
  await rows.nth(2).getByRole('checkbox').check();
  await bar.getByRole('button', { name: 'Delete' }).click();
  const confirm = page.getByRole('dialog', { name: 'Delete transactions' });
  await confirm.getByRole('button', { name: 'Delete 3 transactions' }).click();
  await expect(page.getByText('Deleted 3 transactions')).toBeVisible();
  await expect(rows).toHaveCount(count - 3);
  await page.getByRole('status').getByRole('button', { name: 'Undo' }).click();
  await expect(rows).toHaveCount(count);
  await bar.getByRole('button', { name: 'Done' }).click();
  await expect(page.locator('main li button.row').first()).toBeVisible();
});
