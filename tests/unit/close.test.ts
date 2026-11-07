import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  closeArgs,
  globToRegExp,
  isIncluded,
  nextYearPath,
  parseCloseOutput,
  planClose,
  planInclude,
  priorCloseEntries,
  PRIOR_CLOSE_QUERIES,
  type CloseEntry,
  type CloseMode,
} from '../../src/lib/journal/close';
import type { Txn } from '../../src/lib/contracts/engine';
import { hasWasm, makeEngine, snapshot } from '../helpers/engine';

function demoVault(): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else out[p.slice('src/demo/vault/'.length)] = readFileSync(p, 'utf8');
    }
  };
  walk('src/demo/vault');
  return out;
}

const SAMPLE = `2026-12-31 closing balances  ; clopen:
    assets:checking          $-10.00 = $0.00
    equity:opening/closing balances

2027-01-01 opening balances  ; clopen:
    assets:checking           $10.00 = $10.00
    equity:opening/closing balances

`;

describe('close planning', () => {
  it('builds hledger close arguments', () => {
    expect(closeArgs('migrate', 2026)).toEqual(['close', '--migrate', '-e', '2027-01-01']);
    expect(closeArgs('retain', 2026, { showCosts: true })).toEqual(['close', '--retain', '-e', '2027-01-01', '--show-costs']);
  });

  it('splits hledger output into verbatim entries', () => {
    const e = parseCloseOutput(SAMPLE);
    expect(e.map((x) => [x.date, x.description, x.hasAmounts])).toEqual([
      ['2026-12-31', 'closing balances', true],
      ['2027-01-01', 'opening balances', true],
    ]);
    expect(e[0]!.text).toBe(SAMPLE.split('\n\n')[0]);
    expect(parseCloseOutput('2026-12-31 closing balances  ; clopen:\n    assets:x   0 VTI = 0 VTI\n    equity:x\n\n')[0]!.hasAmounts).toBe(false);
    expect(parseCloseOutput(SAMPLE.replace(/\n/g, '\r\n'))).toEqual(e);
  });

  it('names the new year file after the old one', () => {
    expect(nextYearPath('2026/2026.journal', 2026, 'main.journal')).toBe('2027/2027.journal');
    expect(nextYearPath('2026.journal', 2026, 'main.journal')).toBe('2027.journal');
    expect(nextYearPath('books/2026-home.hledger', 2026, 'books/main.hledger')).toBe('books/2027-home.hledger');
    expect(nextYearPath('main.journal', 2026, 'main.journal')).toBe('2027.journal');
    expect(nextYearPath('ledger/all.journal', 2026, 'ledger/main.journal')).toBe('ledger/2027.journal');
    expect(nextYearPath('12026.journal', 2026, 'main.journal')).toBe('2027.journal');
  });

  it('matches include globs like hledger', () => {
    expect(globToRegExp('2026/*.journal').test('2026/2026.journal')).toBe(true);
    expect(globToRegExp('2026/*.journal').test('2026/x/2026.journal')).toBe(false);
    expect(globToRegExp('**/*.journal').test('2026/x/2026.journal')).toBe(true);
    expect(globToRegExp('**/*.journal').test('top.journal')).toBe(true);
    expect(globToRegExp('20[0-9][0-9].journal').test('2027.journal')).toBe(true);
    expect(globToRegExp('202?.journal').test('2027.journal')).toBe(true);
    const files = { 'main.journal': 'include accounts.journal\ninclude years/*.journal\n', 'years/2026.journal': '' };
    expect(isIncluded(files, 'main.journal', 'years/2027.journal')).toBe(true);
    expect(isIncluded(files, 'main.journal', '2027.journal')).toBe(false);
    expect(isIncluded({ 'a/main.journal': 'include ../b/*.j\n' }, 'a/main.journal', 'b/x.j')).toBe(true);
  });

  it('adds an include only when needed, mirroring the old year’s', () => {
    const demo = { 'main.journal': 'include accounts.journal\ninclude 2026/*.journal\n; end\n' };
    expect(planInclude(demo, 'main.journal', '2026/2026.journal', '2027/2027.journal', 2026)).toEqual({
      file: 'main.journal',
      beforeLine: 3,
      text: 'include 2027/*.journal',
    });
    const explicit = { 'main.journal': 'include 2025.journal\ninclude 2026.journal\n' };
    expect(planInclude(explicit, 'main.journal', '2026.journal', '2027.journal', 2026)?.text).toBe('include 2027.journal');
    const glob = { 'main.journal': 'include *.journal\n' };
    expect(planInclude(glob, 'main.journal', '2026.journal', '2027.journal', 2026)).toBeNull();
    const none = { 'main.journal': '2026-01-01 x\n    a  $1\n    b' };
    expect(planInclude(none, 'main.journal', 'main.journal', '2027.journal', 2026)).toEqual({ file: 'main.journal', beforeLine: 4, text: '\ninclude 2027.journal' });
    const other = { 'main.journal': 'include accounts.journal\n\n2026-01-01 x\n    a  $1\n    b\n' };
    expect(planInclude(other, 'main.journal', 'main.journal', '2027.journal', 2026)).toEqual({ file: 'main.journal', beforeLine: 2, text: 'include 2027.journal' });
  });

  it('appends verbatim, creates the new file and inserts the include, touching nothing else', () => {
    const [closing, opening] = parseCloseOutput(SAMPLE) as [CloseEntry, CloseEntry];
    const files = {
      'main.journal': '﻿include 2026/*.journal\r\n; tail comment\r\n',
      '2026/2026.journal': '2026-01-01 x\r\n    assets:checking  $10.00\r\n    equity:x',
    };
    const inc = planInclude(files, 'main.journal', '2026/2026.journal', '2027/2027.journal', 2026);
    const r = planClose(files, 'main.journal', [
      { file: '2026/2026.journal', entry: closing },
      { file: '2027/2027.journal', entry: opening },
    ], inc);
    expect(r.created).toEqual(['2027/2027.journal']);
    expect(r.files['main.journal']).toBe('﻿include 2026/*.journal\r\ninclude 2027/*.journal\r\n; tail comment\r\n');
    // A file without a final newline keeps none; one blank line separates the entry.
    expect(r.files['2026/2026.journal']).toBe(files['2026/2026.journal'] + '\r\n\r\n' + closing.text.replace(/\n/g, '\r\n'));
    expect(r.files['2027/2027.journal']).toBe(opening.text.replace(/\n/g, '\r\n') + '\r\n');
    // Same file for both entries.
    const same = planClose({ 'm.journal': 'a\n\n' }, 'm.journal', [{ file: 'm.journal', entry: closing }, { file: 'm.journal', entry: opening }], null);
    expect(same.files['m.journal']).toBe(`a\n\n${closing.text}\n\n${opening.text}\n`);
  });

  it('recognises entries of an earlier close', () => {
    let n = 0;
    const t = (date: string, description: string, tags: [string, string][] = []): Txn =>
      ({ index: ++n, date, status: '', code: '', description, comment: '', tags, postings: [] }) as Txn;
    const txns = [
      t('2026-05-01', 'Opening balances'), // the books' first opening entry, not a close of 2026
      t('2026-01-01', 'opening balances', [['clopen', '']]), // the opening from closing 2025
    ];
    expect(priorCloseEntries(txns, 'migrate', 2026)).toEqual([]);
    expect(priorCloseEntries([...txns, t('2026-12-31', 'closing balances', [['clopen', '']])], 'migrate', 2026)).toHaveLength(1);
    expect(priorCloseEntries([t('2027-01-01', 'Opening balances')], 'migrate', 2026)).toHaveLength(1);
    expect(priorCloseEntries([t('2026-12-31', 'retain earnings', [['retain', '']])], 'retain', 2026)).toHaveLength(1);
    expect(priorCloseEntries([t('2026-12-31', 'retain earnings')], 'migrate', 2026)).toEqual([]);
    const dup = t('2026-12-31', 'closing balances');
    expect(priorCloseEntries([dup, dup], 'migrate', 2026)).toHaveLength(1);
  });
});

describe.skipIf(!hasWasm)('close with hledger (demo vault)', () => {
  const ROOT = 'main.journal';
  /** Zero in every commodity (hledger's JSON totals keep amounts with different costs apart). */
  const sum = (amounts: { commodity: string; quantity: string }[]) => {
    const by = new Map<string, number>();
    for (const a of amounts) by.set(a.commodity, (by.get(a.commodity) ?? 0) + Number(a.quantity));
    return [...by.values()].every((v) => Math.abs(v) < 1e-9);
  };

  async function closeDemo(mode: CloseMode, showCosts = false) {
    const files = demoVault();
    const e = await makeEngine();
    expect((await e.load(snapshot(files, ROOT))).ok).toBe(true);
    const out = await e.raw(closeArgs(mode, 2026, { showCosts }));
    expect(out.code, out.stderr).toBe(0);
    const entries = parseCloseOutput(out.stdout);
    const placements =
      mode === 'migrate'
        ? [
            { file: '2026/2026.journal', entry: entries[0]! },
            { file: nextYearPath('2026/2026.journal', 2026, ROOT), entry: entries[1]! },
          ]
        : [{ file: '2026/2026.journal', entry: entries[0]! }];
    const inc = mode === 'migrate' ? planInclude(files, ROOT, '2026/2026.journal', '2027/2027.journal', 2026) : null;
    const plan = planClose(files, ROOT, placements, inc);
    const before = { all: await e.balance({ period: { end: '2027-01-01' } }), e };
    const e2 = await makeEngine();
    const loaded = await e2.load(snapshot(plan.files, ROOT));
    expect(loaded.ok, JSON.stringify(loaded)).toBe(true);
    return { files, plan, entries, before, e2, out };
  }

  it('migrate: appends hledger’s text verbatim, zeroes the year, and the opening equals the closing', async () => {
    const { files, plan, entries, before, e2, out } = await closeDemo('migrate');
    expect(entries.map((x) => x.description)).toEqual(['closing balances', 'opening balances']);
    expect(plan.files['2026/2026.journal']).toBe(files['2026/2026.journal'] + '\n' + entries[0]!.text + '\n');
    expect(plan.files['2027/2027.journal']).toBe(entries[1]!.text + '\n');
    expect(out.stdout).toContain(entries[0]!.text);
    expect(plan.files['main.journal']).toBe(files['main.journal']!.replace('include 2026/*.journal\n', 'include 2026/*.journal\ninclude 2027/*.journal\n'));
    for (const f of Object.keys(files)) if (!['2026/2026.journal', 'main.journal'].includes(f)) expect(plan.files[f]).toBe(files[f]);
    // The generated entries keep their balance assertions.
    expect(entries[0]!.text).toMatch(/= \$0\.00/);

    // Every asset and liability balance is zero at the end of 2026…
    const yearEnd = await e2.balance({ query: ['type:AL'], period: { end: '2027-01-01' } });
    expect(yearEnd.rows.every((r) => sum(r.amount))).toBe(true);
    expect(sum(yearEnd.total)).toBe(true);
    // …and the opening entry restores exactly the balances before closing.
    const opened = await e2.balance({ query: ['type:AL'], period: { end: '2027-01-02' } });
    const prior = before.all.rows.filter((r) => /^(assets|liabilities)/.test(r.account) && !sum(r.amount));
    const key = (r: { account: string; amount: { commodity: string; quantity: string }[] }) => {
      const by = new Map<string, number>();
      for (const a of r.amount) by.set(a.commodity, Math.round(((by.get(a.commodity) ?? 0) + Number(a.quantity)) * 1e6) / 1e6);
      return `${r.account} ${[...by].sort().map(([c, q]) => `${q} ${c}`).join(',')}`;
    };
    expect(opened.rows.filter((r) => !sum(r.amount)).map(key).sort()).toEqual(prior.filter((r) => !before.all.rows.some((c) => c.account.startsWith(r.account + ':'))).map(key).sort());
    // Revenue and expenses are untouched by a migrate.
    const is = await e2.balance({ query: ['type:RX'], period: { end: '2027-01-01' } });
    expect(sum(is.total)).toBe(false);

    // Running it again is detected, and hledger has nothing left to move.
    const found: Txn[] = [];
    for (const q of PRIOR_CLOSE_QUERIES) found.push(...(await e2.transactions({ query: q, period: { begin: '2026-01-01', end: '2027-01-02' } })));
    expect(priorCloseEntries(found, 'migrate', 2026).map((t) => t.description)).toEqual(expect.arrayContaining(['closing balances', 'opening balances']));
    const again = parseCloseOutput((await e2.raw(closeArgs('migrate', 2026))).stdout);
    expect(again.every((x) => !x.hasAmounts)).toBe(true);
    // Before closing, nothing was detected (the demo's own "Opening balances" in May is not a close).
    const none: Txn[] = [];
    for (const q of PRIOR_CLOSE_QUERIES) none.push(...(await before.e.transactions({ query: q, period: { begin: '2026-01-01', end: '2027-01-02' } })));
    expect(none.length).toBeGreaterThan(0);
    expect(priorCloseEntries(none, 'migrate', 2026)).toEqual([]);
  });

  it('retain: the year’s revenues and expenses are zero, moved to retained earnings', async () => {
    const { plan, entries, files, before, e2 } = await closeDemo('retain');
    expect(entries).toHaveLength(1);
    expect(entries[0]!.text).toMatch(/equity:retained earnings$/);
    expect(plan.files['2026/2026.journal']).toBe(files['2026/2026.journal'] + '\n' + entries[0]!.text + '\n');
    const rx = await e2.balance({ query: ['type:RX'], period: { end: '2027-01-01' } });
    expect(rx.rows.every((r) => sum(r.amount))).toBe(true);
    const net = before.all.rows.filter((r) => /^(income|expenses):/.test(r.account));
    expect(net.length).toBeGreaterThan(5);
    const re = await e2.balance({ query: ['acct:^equity:retained earnings$'], period: { end: '2027-01-01' } });
    // Retained earnings = minus (income + expenses), per commodity.
    const expect$ = net.flatMap((r) => r.amount).filter((a) => a.commodity === '$').reduce((s, a) => s + Number(a.quantity), 0);
    expect(Number(re.total.find((a) => a.commodity === '$')!.quantity)).toBeCloseTo(expect$, 2);
    const found: Txn[] = [];
    for (const q of PRIOR_CLOSE_QUERIES) found.push(...(await e2.transactions({ query: q, period: { begin: '2026-01-01', end: '2027-01-02' } })));
    expect(priorCloseEntries(found, 'retain', 2026)).toHaveLength(1);
  });

  it('keeps lot costs with --show-costs, and hledger accepts the result', async () => {
    const { entries } = await closeDemo('migrate', true);
    expect(entries[0]!.text).toMatch(/VTI @ \$/);
    expect(entries[1]!.text).toMatch(/VTI @ \$/);
  });
});
