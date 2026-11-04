import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { commodityStyle, inferStyle, styleForFile } from '../../src/lib/journal/writer';

const fx = (f: string) => readFileSync(join(import.meta.dirname, '..', 'fixtures', f), 'utf8');

describe('inferStyle', () => {
  it('defaults for an empty file', () => {
    expect(inferStyle('')).toMatchObject({
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
    });
  });

  it('indent: the most common, spaces or tab', () => {
    expect(inferStyle('2024-01-15 Test\n    expenses:food  $50.00\n    assets:checking\n').indent).toBe('    ');
    expect(inferStyle(fx('example.hledger')).indent).toBe('  ');
    expect(inferStyle(fx('writer/tabs.journal')).indent).toBe('\t');
  });

  it('amount column: the common end column, or null without consistent alignment', () => {
    expect(inferStyle(fx('example.hledger')).amountColumn).toBe(83);
    expect(inferStyle(fx('sample-with-budget.journal')).amountColumn).toBe(41);
    expect(inferStyle(fx('comma_decimal.journal')).amountColumn).toBe(44);
    expect(inferStyle(fx('basic.journal')).amountColumn).toBeNull();
    expect(inferStyle(fx('edge_cases.journal')).amountColumn).toBeNull();
  });

  it('commodity side, spacing and default commodity', () => {
    expect(inferStyle(fx('basic.journal'))).toMatchObject({ commoditySide: 'L', commoditySpaced: false, defaultCommodity: '$' });
    expect(inferStyle(fx('example.hledger'))).toMatchObject({ commoditySide: 'R', commoditySpaced: true, defaultCommodity: 'USD' });
    expect(inferStyle('D 1.000,00 EUR\n\n2024-01-01 x\n    a  $1\n    b\n').defaultCommodity).toBe('EUR');
  });

  it('decimal mark and digit grouping', () => {
    expect(inferStyle(fx('comma_decimal.journal'))).toMatchObject({ decimalMark: ',', thousandsSeparator: '.' });
    expect(inferStyle('2024-01-01 x\n    a  1.234,56 EUR\n    b\n')).toMatchObject({ decimalMark: ',', thousandsSeparator: '.' });
    expect(inferStyle(fx('sample-with-budget.journal'))).toMatchObject({ decimalMark: '.', thousandsSeparator: ',' });
  });

  it('date separator, EOL, BOM and final newline', () => {
    expect(inferStyle(fx('writer/comma-slash.journal')).dateSeparator).toBe('/');
    const crlf = inferStyle('﻿2024-01-01 x\r\n    a  $1.00\r\n    b');
    expect(crlf).toMatchObject({ eol: '\r\n', bom: true, finalNewline: false });
    expect(inferStyle('2024-01-01 x\n    a  $1\n').eol).toBe('\n');
  });

  it('commodity directives declare the style, and win over usage', () => {
    const s = inferStyle(fx('multicurrency.journal'));
    expect(s.commodities['EUR']).toMatchObject({ side: 'L', spaced: true, decimalMark: ',', groupMark: '.', precision: 2 });
    expect(s.commodities['$']).toMatchObject({ side: 'L', spaced: false, decimalMark: '.', groupMark: ',' });
    expect(s.commodities['AAPL']).toMatchObject({ side: 'R', precision: 0 });
  });

  it('uses the usual precision, not the maximum', () => {
    expect(inferStyle(fx('example.hledger')).commodities['USD']!.precision).toBe(2);
  });

  it('a new commodity gets a sensible default: symbols left, codes right', () => {
    const s = inferStyle(fx('basic.journal'));
    expect(commodityStyle('€', s)).toMatchObject({ side: 'L', spaced: false });
    expect(commodityStyle('CHF', s)).toMatchObject({ side: 'R', spaced: true });
  });

  it('a file with nothing to learn from borrows the root file style', () => {
    const files = { 'main.journal': fx('comma_decimal.journal'), '2025.journal': '; empty year\n' };
    const s = styleForFile(files, '2025.journal', 'main.journal');
    expect(s.decimalMark).toBe(',');
    expect(s.amountColumn).toBe(44);
    expect(s.finalNewline).toBe(true);
  });
});
