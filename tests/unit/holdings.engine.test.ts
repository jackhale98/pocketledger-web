// Holdings against real hledger (WASM): every number must equal what native hledger 1.52.4 prints
// for the same report (cost = -B, value = -X $, gain = --gain -X $). Expected values below were
// taken from /home/user/dl/native/hledger -O json on the same files.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fixture, hasWasm, makeEngine, snapshot } from '../helpers/engine';
import { fetchHoldings, fetchReturns, historyQuery, totals } from '../../src/app/lib/holdings';
import { valuationOpts } from '../../src/app/state/settings.svelte';
import { quantityOf, sumMixed } from '../../src/lib/engine/decimal';
import type { BalanceReport } from '../../src/lib/contracts/engine';

const row = (r: BalanceReport, account: string, c = '$') => quantityOf(sumMixed(r.rows.find((x) => x.account === account)?.amount ?? []), c);

describe.skipIf(!hasWasm)('holdings with hledger', () => {
  async function engine() {
    const e = await makeEngine();
    const r = await e.load(snapshot({ 'main.journal': fixture('investments.journal') }));
    expect(r.ok).toBe(true);
    return e;
  }

  it('cost, value and gain per account × commodity equal -B, -X and --gain', async () => {
    const e = await engine();
    const { holdings } = await fetchHoldings(e, { currency: '$' });
    const by = (a: string, c: string) => holdings.find((h) => h.account === a && h.commodity === c)!;
    expect(holdings.map((h) => `${h.account} ${h.units} ${h.commodity}`)).toEqual([
      'assets:brokerage 20 BND',
      'assets:brokerage 6 VTI',
      'assets:ira 2 BND',
      'assets:ira 5 VTI',
    ]);
    // hledger bal --flat -H type:A cur:^VTI$ -B / -X $ / --gain -X $
    expect(by('assets:brokerage', 'VTI')).toMatchObject({ costIn: '1160', valueIn: '1141.998', gainIn: '-18.002', gainPct: '-1.55' });
    expect(by('assets:ira', 'VTI')).toMatchObject({ costIn: '1050', valueIn: '951.665', gainIn: '-98.335', gainPct: '-9.37' });
    // hledger bal --flat -H type:A cur:^BND$ …  (the gift at $0 has no -B row)
    expect(by('assets:brokerage', 'BND')).toMatchObject({ costIn: '1502.5', valueIn: '1462', gainIn: '-40.5' });
    expect(by('assets:ira', 'BND')).toMatchObject({ costIn: '0', valueIn: '146.2', gainIn: '146.2', gainPct: null });
    expect(by('assets:ira', 'VTI').price).toMatchObject({ date: '2026-03-31', price: '$190.333' });
    expect(by('assets:ira', 'BND').price).toMatchObject({ date: '2026-03-31', price: '$73.10' });
  });

  it('the summed rows equal hledger’s own totals over all holdings', async () => {
    const e = await engine();
    const { holdings } = await fetchHoldings(e, { currency: '$' });
    const t = totals(holdings, '$');
    const q = { query: ['type:A', 'cur:^(VTI|BND)$'], accumulation: 'historical' as const };
    const cost = await e.balance({ ...q, ...valuationOpts({ valuation: 'cost', valueIn: '$' }) });
    const value = await e.balance({ ...q, ...valuationOpts({ valuation: 'value', valueIn: '$' }) });
    const gain = await e.balance({ ...q, ...valuationOpts({ valuation: 'gain', valueIn: '$' }) });
    expect(t.costIn).toBe(quantityOf(cost.total, '$').replace(/\.?0+$/, ''));
    expect(t.valueIn).toBe('3701.863');
    expect(quantityOf(value.total, '$')).toBe('3701.863');
    expect(t.gainIn).toBe('-10.637');
    expect(quantityOf(gain.total, '$')).toBe('-10.637');
  });

  it('honours the report end date (holdings and valuation as of then)', async () => {
    const e = await engine();
    const { holdings } = await fetchHoldings(e, { currency: '$', period: { begin: '2026-02-01', end: '2026-03-20' } });
    const vti = holdings.find((h) => h.account === 'assets:brokerage' && h.commodity === 'VTI')!;
    // hledger bal --flat type:A -H -b 2026-02-01 -e 2026-03-20 cur:^VTI$ -X $  →  $1,293.00 (6 × $215.50)
    expect(vti.valueIn).toBe('1293');
    expect(vti.gainIn).toBe('133');
    expect(vti.price?.date).toBe('2026-02-28');
  });

  it('value vs cost history equals balance -M --historical -X $ and -B', async () => {
    const e = await engine();
    const { holdings } = await fetchHoldings(e, { currency: '$' });
    const base = { period: { interval: 'monthly' as const }, accumulation: 'historical' as const };
    const all = historyQuery(holdings, null);
    expect(all).toEqual(['type:A', 'cur:^(BND|VTI)$']);
    const v = await e.periodicBalance({ ...base, query: all, valuation: 'value', valueIn: '$' });
    const k = await e.periodicBalance({ ...base, query: all, valuation: 'cost' });
    expect(v.totals.amounts.map((m) => quantityOf(sumMixed(m), '$'))).toEqual(['3530', '4712.5', '3701.863']);
    expect(k.totals.amounts.map((m) => quantityOf(sumMixed(m), '$'))).toEqual(['3502.5', '4552.5', '3712.5']);
    const ira = holdings.find((h) => h.account === 'assets:ira' && h.commodity === 'VTI')!;
    const one = await e.periodicBalance({ ...base, query: historyQuery(holdings, ira), valuation: 'value', valueIn: '$' });
    expect(one.totals.amounts.map((m) => quantityOf(sumMixed(m), '$'))).toEqual(['0', '1077.5', '951.665']);
  });

  it('returns per account come from hledger roi', async () => {
    const e = await engine();
    const r = await fetchReturns(e, ['assets:brokerage', 'assets:ira'], '$');
    expect(r.get('assets:ira')).toMatchObject({ irr: '38.46%', pnl: '$47.86', valueEnd: '$1,097.86' });
    expect(r.get('assets:brokerage')).toMatchObject({ irr: '-7.69%', pnl: '$-58.50' });
  });

  it('valuation modes on the demo vault match native hledger', async () => {
    const dir = resolve('src/demo/vault');
    const files: Record<string, string> = {};
    for (const f of ['main.journal', 'accounts.journal', 'prices.journal', 'budget.journal', '2026/2026.journal']) files[f] = readFileSync(resolve(dir, f), 'utf8');
    const e = await makeEngine();
    expect((await e.load(snapshot(files, 'main.journal'))).ok).toBe(true);
    const asWritten = await e.balance(valuationOpts({ valuation: '', valueIn: '$' }));
    expect(row(asWritten, 'assets:brokerage', 'VTI')).toBe('32');
    // hledger bal -B
    const cost = await e.balance(valuationOpts({ valuation: 'cost', valueIn: '$' }));
    expect(row(cost, 'assets:brokerage')).toBe('10715');
    expect(row(cost, 'assets:euro cash')).toBe('131.868');
    expect(row(cost, 'expenses:travel')).toBe('1135.4');
    // hledger bal -X '$'
    const value = await e.balance(valuationOpts({ valuation: 'value', valueIn: '$' }));
    expect(row(value, 'assets:brokerage')).toBe('11367.2');
    expect(row(value, 'assets:cash')).toBe('266.89');
    // hledger bal --gain -X '$'
    const gain = await e.balance(valuationOpts({ valuation: 'gain', valueIn: '$' }));
    expect(gain.rows.map((r) => [r.account, row(gain, r.account)])).toEqual([
      ['assets:brokerage', '652.2'],
      ['assets:euro cash', '1.188'],
      ['expenses:travel', '8.2'],
    ]);
    expect(quantityOf(sumMixed(gain.total), '$')).toBe('661.588');
  });
});
