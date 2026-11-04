// formatTxn and amount rendering. Many cases are ported from PocketLedger's
// crates/hledger-parser/src/writer.rs tests.

import { describe, expect, it } from 'vitest';
import type { JournalStyle, PostingDraft, TxnDraft } from '../../src/lib/contracts/writer';
import {
  DraftError,
  draftFromText,
  formatNumber,
  formatTxn,
  inferStyle,
  parseAmount,
  parseNumber,
  planAdd,
  renderAmount,
  validateDraft,
} from '../../src/lib/journal/writer';

const base: JournalStyle = {
  indent: '    ',
  amountColumn: null,
  commoditySide: 'L',
  commoditySpaced: false,
  decimalMark: '.',
  thousandsSeparator: null,
  dateSeparator: '-',
  eol: '\n',
  bom: false,
  finalNewline: true,
  defaultCommodity: null,
};

const p = (account: string, amount?: string, commodity?: string, extra: Partial<PostingDraft> = {}): PostingDraft => ({
  account,
  ...(amount !== undefined ? { amount } : {}),
  ...(commodity !== undefined ? { commodity } : {}),
  ...extra,
});

const txn = (description: string, postings: PostingDraft[], extra: Partial<TxnDraft> = {}): TxnDraft => ({ date: '2024-01-15', description, postings, ...extra });

describe('formatTxn (ported from writer.rs)', () => {
  it('writes a simple transaction with an inferred posting', () => {
    const out = formatTxn(txn('Grocery Store', [p('expenses:food', '50.00', '$'), p('assets:checking')]), base);
    const lines = out.split('\n');
    expect(lines[0]).toBe('2024-01-15 Grocery Store');
    expect(lines[1]!.startsWith('    expenses:food')).toBe(true);
    expect(lines[1]!.endsWith('$50.00')).toBe(true);
    expect(lines[2]!.trim()).toBe('assets:checking');
    expect(out.endsWith('\n')).toBe(false);
    expect(draftFromText(out).postings).toHaveLength(2);
  });

  it('writes status and code', () => {
    expect(formatTxn(txn('Cleared Purchase', [p('a', '1', '$'), p('b')], { status: '*' }), base)).toMatch(/^2024-01-15 \* Cleared Purchase\n/);
    expect(formatTxn(txn('Check Payment', [p('a', '1', '$'), p('b')], { code: '1001' }), base)).toMatch(/^2024-01-15 \(1001\) Check Payment\n/);
    expect(formatTxn(txn('All', [p('a', '1', '$'), p('b')], { status: '!', code: 'X' }), base)).toMatch(/^2024-01-15 ! \(X\) All\n/);
  });

  it('writes multiple commodities, codes on the right, spaced', () => {
    const out = formatTxn(txn('Exchange', [p('assets:eur', '100.00', 'EUR'), p('assets:usd', '-110.00', 'USD')]), base);
    expect(out).toContain('100.00 EUR');
    expect(out).toContain('-110.00 USD');
  });

  it('appends unit and total costs verbatim, with their precision', () => {
    expect(formatTxn(txn('X', [p('assets:eur', '100.00', 'EUR', { cost: '@ $1.10' }), p('assets:usd')]), base)).toContain('100.00 EUR @ $1.10');
    expect(formatTxn(txn('X', [p('assets:eur', '100.00', 'EUR', { cost: '@@ $110.00' }), p('assets:usd')]), base)).toContain('100.00 EUR @@ $110.00');
    expect(formatTxn(txn('X', [p('assets:eur', '100.00', 'EUR', { cost: '@ $1.2345' }), p('assets:usd')]), base)).toContain('@ $1.2345');
    // A bare price gets `@ ` in front.
    expect(formatTxn(txn('X', [p('assets:eur', '100', 'EUR', { cost: '$1.10' }), p('assets:usd')]), base)).toContain('100 EUR @ $1.10');
  });

  it('never rounds away precision', () => {
    const style = inferStyle('2024-01-01 x\n    a  0.01 BTC\n    b\n');
    expect(formatTxn(txn('Buy', [p('assets:btc', '0.00012345', 'BTC'), p('assets:cash')]), style)).toContain('0.00012345 BTC');
  });

  it('writes inline and multi-line comments', () => {
    expect(formatTxn(txn('Grocery', [p('e', '50.00', '$'), p('a')], { comment: 'category:food' }), base)).toContain('Grocery  ; category:food');
    const d = txn('Grocery', [p('e', '50.00', '$', { comment: 'inline\nfollow-up' }), p('a')], { comment: 'first line\nsecond line' });
    const out = formatTxn(d, base);
    expect(out).toContain('Grocery  ; first line\n    ; second line\n');
    expect(out).toContain('  ; inline\n    ; follow-up\n');
    const back = draftFromText(out);
    expect(back.comment).toBe('first line\nsecond line');
    expect(back.postings[0]!.comment).toBe('inline\nfollow-up');
  });

  it('writes a secondary date', () => {
    expect(formatTxn(txn('Backdated', [p('a', '10.00', '$'), p('b')], { date2: '2024-01-16' }), base)).toMatch(/^2024-01-15=2024-01-16 Backdated\n/);
  });

  it('appends balance assertions verbatim, and writes assignments with two spaces', () => {
    expect(formatTxn(txn('Opening', [p('assets:checking', '1000.00', '$', { assertion: '= $1000.00' }), p('equity')]), base)).toContain('$1000.00 = $1000.00');
    expect(formatTxn(txn('T', [p('assets', '10.00', '$', { assertion: '==* $160.00' }), p('equity')]), base)).toContain('$10.00 ==* $160.00');
    expect(formatTxn(txn('T', [p('assets:cash', undefined, undefined, { assertion: '$50' }), p('equity')]), base)).toContain('    assets:cash  = $50\n');
  });

  it('quotes commodities that need it, and they re-parse', () => {
    const out = formatTxn(txn('Fund buy', [p('assets:funds', '1.5', 'VANGUARD FUND'), p('assets:cash')]), base);
    expect(out).toContain('1.5 "VANGUARD FUND"');
    expect(draftFromText(out).postings[0]!.commodity).toBe('VANGUARD FUND');
  });

  it('round-trips parse -> write -> parse', () => {
    const input = '2024-01-15 Grocery Store\n    expenses:food  $50.00\n    assets:checking';
    const d = draftFromText(input);
    expect(formatTxn(d, inferStyle(input))).toBe(input);
  });

  it('writes CRLF for a CRLF style, without a trailing EOL', () => {
    const out = formatTxn(txn('x', [p('a', '1.00', '$'), p('b')]), { ...base, eol: '\r\n' });
    expect(out.split('\r\n')).toHaveLength(3);
    expect(out.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('virtual postings, posting status, blank amounts', () => {
    const out = formatTxn(
      txn('V', [p('budget', '-5', '$', { type: 'virtual' }), p('goal', '5', '$', { type: 'balanced-virtual', status: '*' }), p('assets:cash')]),
      base,
    );
    expect(out).toContain('    (budget)  $-5');
    expect(out).toContain('    * [goal]  $5');
    expect(out.split('\n')[3]).toBe('    assets:cash');
  });

  it('uses the style date separator', () => {
    expect(formatTxn(txn('x', [p('a', '1', '$'), p('b')]), { ...base, dateSeparator: '/' })).toMatch(/^2024\/01\/15 x/);
  });
});

describe('amount rendering', () => {
  it('puts the sign after a left-side symbol, as hledger prints it', () => {
    expect(formatTxn(txn('x', [p('a', '-12.50', '$'), p('b')]), base)).toContain('$-12.50');
    expect(formatTxn(txn('x', [p('a', '-12.50', 'EUR'), p('b')]), base)).toContain('-12.50 EUR');
    expect(parseAmount('-$12.50')).toEqual({ sign: '-', number: '12.50', commodity: '$', side: 'L', spaced: false });
    expect(parseAmount('$ -12.50')).toMatchObject({ sign: '-', commodity: '$', spaced: true });
    expect(parseAmount('EUR 1.000,00')).toMatchObject({ commodity: 'EUR', side: 'L', spaced: true, number: '1.000,00' });
    expect(parseAmount('10 "VANGUARD FUND"')).toMatchObject({ commodity: 'VANGUARD FUND', side: 'R' });
    expect(parseAmount('(1 + 2)')).toBeNull();
  });

  it('follows the commodity style of the file: side, marks, grouping, usual precision', () => {
    const style = inferStyle('commodity $1,000.00\n\n2024-01-01 x\n    a  $1,500.00\n    b  10 AAPL\n    c\n');
    expect(formatTxn(txn('x', [p('a', '1500', '$'), p('b', '3', 'AAPL'), p('c')]), style)).toContain('$1,500.00');
    expect(formatTxn(txn('x', [p('a', '1500', '$'), p('b', '3', 'AAPL'), p('c')]), style)).toContain('3 AAPL');
    expect(formatTxn(txn('x', [p('a', '1500', '$'), p('b', '3', 'AAPL'), p('c')]), style)).not.toContain('3.00 AAPL');
  });

  it('comma-decimal journals round-trip through the writer', () => {
    const text = 'decimal-mark ,\n\n2024-01-15 Rent\n    expenses:rent   1.234,56 EUR\n    assets:bank\n';
    const style = inferStyle(text);
    const d = draftFromText(text.split('\n').slice(2).join('\n'));
    expect(d.postings[0]).toMatchObject({ amount: '1.234,56', commodity: 'EUR' });
    expect(formatTxn(d, style)).toContain('1.234,56 EUR');
    // A user typing with a dot still gets the file's mark.
    expect(formatTxn(txn('x', [p('a', '12.5', 'EUR'), p('b')]), style)).toContain('12,50 EUR');
  });

  it('formats numbers: precision, marks, grouping (never rounds)', () => {
    const n = (s: string) => parseNumber(s, '.')!;
    expect(formatNumber(n('100'), { decimalMark: '.', groupMark: null, precision: 2 })).toBe('100.00');
    expect(formatNumber(n('100.5'), { decimalMark: '.', groupMark: null, precision: 2 })).toBe('100.50');
    expect(formatNumber(n('100.123'), { decimalMark: '.', groupMark: null, precision: 2 })).toBe('100.123');
    expect(formatNumber(n('100'), { decimalMark: '.', groupMark: null, precision: 0 })).toBe('100');
    expect(formatNumber(n('1234.56'), { decimalMark: ',', groupMark: null, precision: 2 })).toBe('1234,56');
    expect(formatNumber(n('-0.5'), { decimalMark: ',', groupMark: null, precision: 2 })).toBe('-0,50');
    expect(formatNumber(n('1000'), { decimalMark: '.', groupMark: ',', precision: 2 })).toBe('1,000.00');
    expect(formatNumber(n('-1234567.5'), { decimalMark: '.', groupMark: ',', precision: 2 })).toBe('-1,234,567.50');
    expect(formatNumber(n('999'), { decimalMark: '.', groupMark: ',', precision: 2 })).toBe('999.00');
    expect(formatNumber(n('1234.5'), { decimalMark: ',', groupMark: '.', precision: 2 })).toBe('1.234,50');
  });

  it('reads typed numbers leniently but never ambiguously against the file mark', () => {
    expect(parseNumber('1,234.56', '.')).toMatchObject({ int: '1234', frac: '56' });
    expect(parseNumber('1.234,56', '.')).toMatchObject({ int: '1234', frac: '56' });
    expect(parseNumber('1,234', '.')).toMatchObject({ int: '1234', frac: '' });
    expect(parseNumber('1,5', '.')).toMatchObject({ int: '1', frac: '5' });
    expect(parseNumber('1,234', ',')).toMatchObject({ int: '1', frac: '234' });
    expect(parseNumber('1.234', ',')).toMatchObject({ int: '1234', frac: '' });
    expect(parseNumber('abc', '.')).toBeNull();
    expect(renderAmount('(1 + 2)', '$', { side: 'L', spaced: false, decimalMark: '.', groupMark: null, precision: 2 })).toBe('$(1 + 2)');
  });
});

describe('alignment', () => {
  it('right-aligns amount (+cost) to the style column, with at least two spaces', () => {
    const style = { ...base, amountColumn: 40 };
    const out = formatTxn(txn('x', [p('expenses:food', '5.00', '$'), p('assets:eur', '10', 'EUR', { cost: '@ $1.10' }), p('b')]), style).split('\n');
    expect(out[1]!.length).toBe(40);
    expect(out[1]!.endsWith('$5.00')).toBe(true);
    expect(out[2]!.length).toBe(40);
    const long = formatTxn(txn('x', [p('a'.repeat(50), '5.00', '$'), p('b')]), style).split('\n');
    expect(long[1]).toBe(`    ${'a'.repeat(50)}  $5.00`);
  });

  it('uses the inferred column of an aligned file', () => {
    const text = '2024-01-01 a\n    expenses:food            $10.00\n    assets:cash             $-10.00\n\n2024-01-02 b\n    expenses:rent           $500.00\n    assets:cash\n';
    const style = inferStyle(text);
    expect(style.amountColumn).toBe('    expenses:food            $10.00'.length);
    const out = formatTxn(txn('x', [p('expenses:x', '1', '$'), p('assets:cash')]), style);
    expect(out.split('\n')[1]).toBe(`    expenses:x${' '.repeat(16)}$1.00`);
    expect(out.split('\n')[1]!.length).toBe(35);
  });
});

describe('validation', () => {
  it('rejects drafts that would corrupt the file structure', () => {
    expect(validateDraft(txn('ok', [p('a', '1', '$'), p('b')]))).toEqual([]);
    expect(validateDraft(txn('bad; desc', [p('a')])).join()).toMatch(/description/);
    expect(validateDraft(txn('x\ny', [p('a')])).join()).toMatch(/line breaks/);
    expect(validateDraft(txn('x', [p('a  b', '1')])).join()).toMatch(/double spaces/);
    expect(validateDraft(txn('x', [p(' ')])).join()).toMatch(/empty/);
    expect(validateDraft(txn('x', [p('(a)')])).join()).toMatch(/virtual/);
    expect(validateDraft({ ...txn('x', [p('a')]), date: '15 Jan' }).join()).toMatch(/date/);
    const snapshot = { rootFile: 'm', files: { m: '' }, revision: '' };
    expect(() => planAdd(snapshot, txn('bad;', [p('a')]))).toThrow(DraftError);
  });
});
