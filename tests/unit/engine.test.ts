import { describe, expect, it } from 'vitest';
import { fixture, hasWasm, makeEngine, snapshot } from '../helpers/engine';
import { formatAmount, fromMantissa, sumMixed } from '../../src/lib/engine/decimal';
import { parseHledgerJson } from '../../src/lib/engine/decode/json';
import type { AmountStyle } from '../../src/lib/contracts/amount';
import { splitQuery, queryArgs, isReadOnlyCommand } from '../../src/lib/engine/args';

describe('decimal', () => {
  it('fromMantissa', () => {
    expect(fromMantissa('500000', 2)).toBe('5000.00');
    expect(fromMantissa('-5', 2)).toBe('-0.05');
    expect(fromMantissa('-0', 2)).toBe('0.00');
    expect(fromMantissa('123456789012345678901234567890', 10)).toBe('12345678901234567890.1234567890');
  });
  it('keeps big mantissas exact through JSON', () => {
    const v = parseHledgerJson<{ decimalMantissa: string }>('{"decimalMantissa": 123456789012345678901}');
    expect(v.decimalMantissa).toBe('123456789012345678901');
  });
  it('formats like hledger', () => {
    const usd: AmountStyle = { side: 'L', spaced: false, decimalMark: '.', digitGroups: { separator: ',', sizes: [3] }, precision: 2 };
    expect(formatAmount({ commodity: '$', quantity: '-1234.5', style: usd })).toBe('-$1,234.50');
    const eur: AmountStyle = { side: 'R', spaced: true, decimalMark: ',', digitGroups: { separator: '.', sizes: [3] }, precision: 2 };
    expect(formatAmount({ commodity: 'EUR', quantity: '1234567.891', style: eur })).toBe('1.234.567,89 EUR');
  });
  it('sums per commodity exactly', () => {
    const s: AmountStyle = { side: 'L', spaced: false, decimalMark: '.', digitGroups: null, precision: 2 };
    const r = sumMixed([{ commodity: '$', quantity: '0.1', style: s }], [{ commodity: '$', quantity: '0.2', style: s }]);
    expect(r[0]!.quantity).toBe('0.3');
  });
});

describe('args', () => {
  it('splits queries with quotes', () => {
    expect(splitQuery(`expenses desc:"whole foods" 'date:this month'`)).toEqual(['expenses', 'desc:whole foods', 'date:this month']);
  });
  it('maps opts', () => {
    expect(queryArgs({ period: { begin: '2024-01-01', end: '2025-01-01', interval: 'monthly' }, valueIn: 'USD', depth: 2 })).toEqual([
      '-b', '2024-01-01', '-e', '2025-01-01', '-M', '-X', 'USD', '--depth', '2',
    ]);
  });
  it('refuses write commands', () => {
    expect(isReadOnlyCommand(['bal'])).toBe(true);
    expect(isReadOnlyCommand(['import', 'x.csv'])).toBe(false);
    expect(isReadOnlyCommand(['print', '-o', 'x.journal'])).toBe(false);
  });
  it('allows close, which only prints entries, but not with an output file', () => {
    expect(isReadOnlyCommand(['close', '--migrate', '-e', '2027-01-01'])).toBe(true);
    expect(isReadOnlyCommand(['close', '--retain', '-e', '2027-01-01'])).toBe(true);
    expect(isReadOnlyCommand(['close', '--migrate', '-o', 'x.journal'])).toBe(false);
  });
});

describe.skipIf(!hasWasm)('HledgerEngine', () => {
  it('loads and lists transactions with source spans', async () => {
    const e = await makeEngine();
    const r = await e.load(snapshot({ 'main.journal': fixture('basic.journal') }));
    expect(r.ok).toBe(true);
    const txns = await e.transactions();
    expect(txns[0]!.source).toEqual({ file: 'main.journal', startLine: 12, endLine: 14 });
    expect(txns[0]!.status).toBe('*');
    expect(txns[0]!.postings[1]!.inferred).toBe(true);
    expect(txns[0]!.postings[0]!.inferred).toBe(false);
    expect(txns[0]!.postings[0]!.amount[0]!.quantity).toBe('5000.00');
  });

  it('reports a parse error with file and line, and keeps the previous snapshot', async () => {
    const e = await makeEngine();
    await e.load(snapshot({ 'main.journal': fixture('basic.journal') }));
    const bad = await e.load(snapshot({ 'main.journal': '2024-01-01 x\n    a  $1\n    b  $2\n' }));
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.errors[0]!.kind).toBe('balance');
      expect(bad.errors[0]!.file).toBe('main.journal');
      expect(bad.errors[0]!.line).toBe(1);
      expect(bad.errors[0]!.message).toContain('unbalanced');
    }
    expect((await e.transactions()).length).toBeGreaterThan(5);
  });

  it('resolves includes', async () => {
    const e = await makeEngine();
    const r = await e.load(
      snapshot({
        'main.journal': 'include accounts.journal\ninclude 2024/*.journal\n',
        'accounts.journal': 'account assets:cash  ; type: C\naccount expenses:food\n',
        '2024/jan.journal': '2024-01-02 Shop\n    expenses:food  $5\n    assets:cash\n',
        '2024/feb.journal': '2024-02-02 Shop\n    expenses:food  $7\n    assets:cash\n',
      }, 'main.journal'),
    );
    expect(r.ok).toBe(true);
    const txns = await e.transactions();
    expect(txns.map((t) => t.source?.file)).toEqual(['2024/jan.journal', '2024/feb.journal']);
    const accts = await e.accounts();
    expect(accts.find((a) => a.name === 'assets:cash')?.type).toBe('C');
  });

  it('checks a snapshot without replacing the loaded one', async () => {
    const e = await makeEngine();
    await e.load(snapshot({ 'main.journal': fixture('basic.journal') }));
    const errs = await e.check(snapshot({ 'main.journal': '2024-02-01 y\n    a  1\n    b\n2024-01-01 x\n    a  1\n    b\n' }), ['ordereddates']);
    expect(errs[0]!.kind).toBe('check');
    expect(errs[0]!.line).toBe(4);
    expect((await e.transactions())[0]!.description).toBe('Opening Balance');
  });

  it('catches an unbalanced periodic rule only when forecasting (as the save pipeline does)', async () => {
    const e = await makeEngine();
    const bad = snapshot({ 'main.journal': '~ monthly from 2026-01\n    expenses:rent  $100\n    assets:bank  $-90\n\n2026-01-05 x\n    a  $1\n    b\n' });
    expect(await e.check(bad)).toEqual([]);
    const errs = await e.check(bad, ['-I', '--forecast=2025-01-01..2028-01-01']);
    expect(errs.length).toBe(1);
    expect(errs[0]!.message).toMatch(/unbalanced|balance/i);
    const good = snapshot({ 'main.journal': '~ monthly from 2026-01\n    expenses:rent  $100\n    assets:bank\n' });
    expect(await e.check(good, ['-I', '--forecast=2025-01-01..2028-01-01'])).toEqual([]);
  });

  it('produces statements, budgets and registers', async () => {
    const e = await makeEngine();
    await e.load(snapshot({ 'main.journal': fixture('sample-with-budget.journal') }));
    const bs = await e.balanceSheet();
    expect(bs.sections.map((s) => s.title)).toContain('Assets');
    const is = await e.incomeStatement({ period: { interval: 'monthly' } });
    expect(is.columns.length).toBeGreaterThan(0);
    const b = await e.budget({ period: { interval: 'monthly' } });
    expect(b.rows.some((r) => r.cells.some((c) => c.budget))).toBe(true);
    const reg = await e.register('assets');
    expect(reg.length).toBeGreaterThan(0);
    expect(reg[0]!.txnIndex).toBeGreaterThan(0);
    const v = await e.version();
    expect(v.hledger).toBe('1.52.4');
  });

  it('previews CSV with rules', async () => {
    const e = await makeEngine();
    await e.load(snapshot({ 'main.journal': fixture('basic.journal') }));
    const p = await e.csvPreview('bank.csv', 'bank.csv.rules', {
      'bank.csv': 'Date,Description,Amount\n2024-03-01,Coffee,-3.50\n2024-03-02,Salary,1000\n',
      'bank.csv.rules': 'skip 1\nfields date, description, amount\ncurrency $\naccount1 assets:bank:checking\nif Coffee\n  account2 expenses:food\n',
    });
    expect(p.errors).toEqual([]);
    expect(p.txns).toHaveLength(2);
    expect(p.txns[0]!.postings.map((x) => x.account)).toEqual(['assets:bank:checking', 'expenses:food']);
  });
});
