import { describe, expect, it } from 'vitest';
import type { AmountStyle, MixedAmount } from '../../src/lib/contracts/amount';
import type { BalanceReport } from '../../src/lib/contracts/engine';
import { allocation, amountIn, curQuery, exactAccountQuery, joinHoldings, latestPrices, percent, positions, roiArgs, totals } from '../../src/app/lib/holdings';
import { valuationOpts, marketCurrency } from '../../src/app/state/settings.svelte';
import { queryArgs } from '../../src/lib/engine/args';

const S: AmountStyle = { side: 'L', spaced: false, decimalMark: '.', digitGroups: null, precision: 2 };
const amt = (...xs: [string, string][]): MixedAmount => xs.map(([quantity, commodity]) => ({ commodity, quantity, style: S }));
const report = (rows: [string, MixedAmount][]): BalanceReport => ({ rows: rows.map(([account, amount]) => ({ account, displayName: account, indent: 0, amount })), total: [] });

// Units: brokerage holds two funds and cash; the IRA holds a fund bought at cost and gifted bonds.
const units = report([
  ['assets:brokerage', amt(['20.0000', 'BND'], ['6.000', 'VTI'], ['12.50', '$'])],
  ['assets:checking', amt(['6287.50', '$'])],
  ['assets:ira', amt(['2.0000', 'BND'], ['5.000', 'VTI'])],
]);
const reports = {
  units,
  cost: {
    VTI: report([['assets:brokerage', amt(['1160.00', '$'])], ['assets:ira', amt(['1050.00', '$'])]]),
    // The gifted bonds cost $0: hledger leaves the zero row out.
    BND: report([['assets:brokerage', amt(['1502.500', '$'])]]),
  },
  value: {
    VTI: report([['assets:brokerage', amt(['1141.998', '$'])], ['assets:ira', amt(['951.665', '$'])]]),
    BND: report([['assets:brokerage', amt(['1462.00', '$'])], ['assets:ira', amt(['146.20', '$'])]]),
  },
  gain: {
    VTI: report([['assets:brokerage', amt(['-18.002', '$'])], ['assets:ira', amt(['-98.335', '$'])]]),
    BND: report([['assets:brokerage', amt(['-40.500', '$'])], ['assets:ira', amt(['146.20', '$'])]]),
  },
  prices: [
    { date: '2026-03-31', commodity: 'VTI', price: '$190.333', quantity: '190.333', in: '$' },
    { date: '2026-01-31', commodity: 'VTI', price: '$205.00', quantity: '205.00', in: '$' },
    { date: '2026-04-02', commodity: 'BND', price: '68.00 EUR', quantity: '68.00', in: 'EUR' },
    { date: '2026-03-31', commodity: 'BND', price: '$73.10', quantity: '73.10', in: '$' },
  ],
};

describe('holdings join', () => {
  const hs = joinHoldings(reports, '$');

  it('finds one position per account × non-currency commodity', () => {
    expect(positions(units, '$').map((p) => `${p.account} ${p.units} ${p.commodity}`)).toEqual([
      'assets:brokerage 20 BND',
      'assets:brokerage 6 VTI',
      'assets:ira 2 BND',
      'assets:ira 5 VTI',
    ]);
  });

  it('joins cost, value and gain per row exactly', () => {
    const vti = hs.find((h) => h.account === 'assets:brokerage' && h.commodity === 'VTI')!;
    expect([vti.costIn, vti.valueIn, vti.gainIn]).toEqual(['1160', '1141.998', '-18.002']);
    // -18.002 / 1160 = -1.5518…%
    expect(vti.gainPct).toBe('-1.55');
    expect(vti.price?.quantity).toBe('190.333');
  });

  it('handles a zero-cost gift: cost 0, gain % undefined', () => {
    const gift = hs.find((h) => h.account === 'assets:ira' && h.commodity === 'BND')!;
    expect(gift.cost).toEqual([]);
    expect(gift.costIn).toBe('0');
    expect(gift.gainIn).toBe('146.2');
    expect(gift.gainPct).toBeNull();
  });

  it('keeps negative gains negative', () => {
    const ira = hs.find((h) => h.account === 'assets:ira' && h.commodity === 'VTI')!;
    expect(ira.gainIn).toBe('-98.335');
    expect(ira.gainPct).toBe('-9.37');
  });

  it('prefers prices in the valuation currency', () => {
    const bnd = hs.find((h) => h.commodity === 'BND')!;
    expect(bnd.price?.price).toBe('$73.10');
    expect(latestPrices(reports.prices, 'EUR').get('BND')?.price).toBe('68.00 EUR');
  });

  it('totals with exact decimals (no float drift)', () => {
    const t = totals(hs, '$');
    expect(t.costIn).toBe('3712.5');
    expect(t.valueIn).toBe('3701.863');
    expect(t.gainIn).toBe('-10.637');
    expect(t.gainPct).toBe('-0.29');
    // 0.1 + 0.2 stays 0.3
    const tiny = joinHoldings(
      {
        units: report([['a', amt(['1', 'X'])], ['b', amt(['1', 'X'])]]),
        cost: { X: report([['a', amt(['0.1', '$'])], ['b', amt(['0.2', '$'])]]) },
        value: { X: report([['a', amt(['0.1', '$'])], ['b', amt(['0.2', '$'])]]) },
        gain: { X: report([]) },
      },
      '$',
    );
    expect(totals(tiny, '$').costIn).toBe('0.3');
  });

  it('reports amounts not convertible to the currency as null', () => {
    const noCost = joinHoldings(
      {
        units: report([['assets:cash', amt(['-18.40', 'EUR'], ['5', '$'])]]),
        cost: { EUR: report([['assets:cash', amt(['-18.40', 'EUR'])]]) },
        value: { EUR: report([['assets:cash', amt(['-20.608', '$'])]]) },
        gain: { EUR: report([]) },
      },
      '$',
    )[0]!;
    expect(noCost.costIn).toBeNull();
    expect(noCost.valueIn).toBe('-20.608');
    expect(noCost.gainIn).toBe('0');
    expect(noCost.gainPct).toBeNull();
    expect(totals([noCost], '$').costIn).toBeNull();
  });

  it('allocates positive market value by commodity and by account', () => {
    expect(allocation(hs, 'commodity')).toEqual([
      { name: 'VTI', value: '2093.663' },
      { name: 'BND', value: '1608.2' },
    ]);
    expect(allocation(hs, 'account')).toEqual([
      { name: 'assets:brokerage', value: '2603.998' },
      { name: 'assets:ira', value: '1097.865' },
    ]);
  });

  it('helpers', () => {
    expect(curQuery('VTI')).toBe('cur:^VTI$');
    expect(exactAccountQuery('assets:my (ira)')).toBe('acct:^assets:my \\(ira\\)$');
    expect(curQuery('$', 'S&P.500')).toBe('cur:^(\\$|S&P\\.500)$');
    expect(amountIn([], '$')).toBe('0');
    expect(percent('1', '3')).toBe('33.33');
    expect(percent('5', '0')).toBeNull();
    expect(roiArgs('assets:ira', '$', { begin: '2026-01-01' })).toEqual([
      'roi', '--inv', 'acct:^assets:ira(:|$)', '--pnl', 'type:RX', '--value=end,$', '--infer-market-prices', '-b', '2026-01-01',
    ]);
  });
});

describe('valuation setting', () => {
  it('maps each mode to QueryOpts and hledger flags', () => {
    expect(valuationOpts({ valuation: '', valueIn: '$' })).toEqual({});
    expect(queryArgs(valuationOpts({ valuation: 'cost', valueIn: '$' }))).toEqual(['-B']);
    expect(queryArgs(valuationOpts({ valuation: 'value', valueIn: '$' }))).toEqual(['-X', '$']);
    expect(queryArgs(valuationOpts({ valuation: 'value', valueIn: '' }))).toEqual(['-V']);
    expect(queryArgs(valuationOpts({ valuation: 'gain', valueIn: '$' }))).toEqual(['--gain', '-X', '$']);
    expect(queryArgs(valuationOpts({ valuation: 'gain', valueIn: '$' }, { gain: false }))).toEqual(['-X', '$']);
    expect(marketCurrency({ valuation: 'cost', valueIn: '$' })).toBe('');
    expect(marketCurrency({ valuation: 'gain', valueIn: 'EUR' })).toBe('EUR');
  });
});
