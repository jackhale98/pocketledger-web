// Investment holdings: joins hledger's balance reports (native units, cost -B, market value -X C,
// unrealized gain --gain -X C) per account × commodity. Every number comes from hledger; this
// module only matches rows up and does exact decimal sums and ratios (never floats).
import type { AmountStyle, BalanceReport, Engine, MixedAmount, QueryOpts } from '$lib/contracts/engine';
import { decodePrices, decodeRoi, type PricePoint, type RoiRow } from '$lib/engine/decode/text';
import { accountQuery } from '$lib/engine/hledger-engine';
import { dec, isZero, quantityOf, sumMixed } from '$lib/engine/decimal';

/** One (account, commodity) position whose commodity is not the valuation currency. */
export interface Position {
  account: string;
  commodity: string;
  /** Units held, exact decimal string. */
  units: string;
  /** hledger's display style for the commodity (from the units report). */
  style: AmountStyle;
}

export interface Holding extends Position {
  /** hledger -B: cost basis as hledger computes it (sales reduce it at their sale price). */
  cost: MixedAmount;
  /** hledger -X C: market value. */
  value: MixedAmount;
  /** hledger --gain -X C: unrealized gain (value minus valued cost). */
  gain: MixedAmount;
  /** The same three in the valuation currency alone, or null when the amount holds anything else
   *  (e.g. no cost was recorded, or no price is known). */
  costIn: string | null;
  valueIn: string | null;
  gainIn: string | null;
  /** gain ÷ cost × 100, rounded to 2 places; null when the cost is zero or not in the currency. */
  gainPct: string | null;
  /** Latest market price of the commodity up to the report date. */
  price: PricePoint | null;
}

export interface HoldingTotals {
  cost: MixedAmount;
  value: MixedAmount;
  gain: MixedAmount;
  costIn: string | null;
  valueIn: string | null;
  gainIn: string | null;
  gainPct: string | null;
}

/** Commodity-free amounts carry an empty symbol; anything else is a holding. */
export function positions(units: BalanceReport, currency: string): Position[] {
  const out: Position[] = [];
  for (const row of units.rows)
    for (const a of sumMixed(row.amount))
      if (a.commodity !== currency && a.commodity !== '' && !isZero(a.quantity)) out.push({ account: row.account, commodity: a.commodity, units: a.quantity, style: a.style });
  return out.sort((a, b) => a.account.localeCompare(b.account) || a.commodity.localeCompare(b.commodity));
}

/** Distinct held commodities, in first-seen order. */
export const heldCommodities = (ps: Position[]): string[] => [...new Set(ps.map((p) => p.commodity))];

/** Escape a commodity symbol for an hledger `cur:` regex matching exactly that symbol. */
export const curQuery = (...symbols: string[]): string => {
  const esc = symbols.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return `cur:^${esc.length === 1 ? esc[0] : `(${esc.join('|')})`}$`;
};

/** Quantity in `currency` when the amount holds only that currency (or nothing), else null. */
export function amountIn(ma: MixedAmount, currency: string): string | null {
  const s = sumMixed(ma);
  if (s.some((a) => a.commodity !== currency)) return null;
  return dec(quantityOf(s, currency)).toString();
}

/** gain / cost as a percentage with 2 decimals (half-even), or null if undefined. */
export function percent(gain: string | null, cost: string | null): string | null {
  if (gain == null || cost == null) return null;
  const c = dec(cost);
  if (c.isZero()) return null;
  return dec(gain).div(c.abs()).times(100).toFixed(2);
}

/** Latest price per commodity, preferring prices quoted in `currency`. Points must be ≤ the report date. */
export function latestPrices(points: PricePoint[], currency: string): Map<string, PricePoint> {
  const best = new Map<string, PricePoint>();
  for (const p of points) {
    const cur = best.get(p.commodity);
    const better =
      !cur ||
      (p.in === currency && cur.in !== currency) ||
      ((p.in === currency) === (cur.in === currency) && p.date >= cur.date);
    if (better) best.set(p.commodity, p);
  }
  return best;
}

const rowAmount = (r: BalanceReport | undefined, account: string): MixedAmount => r?.rows.find((x) => x.account === account)?.amount ?? [];

export interface HoldingReports {
  /** Native balances (no valuation) of the accounts considered, flat. */
  units: BalanceReport;
  /** Per held commodity: the same query narrowed with `cur:`, valued each way. */
  cost: Record<string, BalanceReport>;
  value: Record<string, BalanceReport>;
  gain: Record<string, BalanceReport>;
  prices?: PricePoint[];
}

/** Join the per-mode reports into one row per position. */
export function joinHoldings(r: HoldingReports, currency: string): Holding[] {
  const latest = latestPrices(r.prices ?? [], currency);
  return positions(r.units, currency).map((p) => {
    const cost = sumMixed(rowAmount(r.cost[p.commodity], p.account));
    const value = sumMixed(rowAmount(r.value[p.commodity], p.account));
    const gain = sumMixed(rowAmount(r.gain[p.commodity], p.account));
    const costIn = amountIn(cost, currency);
    const gainIn = amountIn(gain, currency);
    return {
      ...p,
      cost,
      value,
      gain,
      costIn,
      valueIn: amountIn(value, currency),
      gainIn,
      gainPct: percent(gainIn, costIn),
      price: latest.get(p.commodity) ?? null,
    };
  });
}

export function totals(hs: Holding[], currency: string): HoldingTotals {
  const cost = sumMixed(...hs.map((h) => h.cost));
  const value = sumMixed(...hs.map((h) => h.value));
  const gain = sumMixed(...hs.map((h) => h.gain));
  const costIn = amountIn(cost, currency);
  const gainIn = amountIn(gain, currency);
  return { cost, value, gain, costIn, valueIn: amountIn(value, currency), gainIn, gainPct: percent(gainIn, costIn) };
}

/** Market value (in the currency) grouped by commodity or account; positive positions only, largest first. */
export function allocation(hs: Holding[], by: 'commodity' | 'account'): { name: string; value: string }[] {
  const m = new Map<string, ReturnType<typeof dec>>();
  for (const h of hs) {
    if (h.valueIn == null) continue;
    const v = dec(h.valueIn);
    if (v.lte(0)) continue;
    const k = by === 'commodity' ? h.commodity : h.account;
    m.set(k, (m.get(k) ?? dec(0)).plus(v));
  }
  return [...m.entries()].sort((a, b) => b[1].comparedTo(a[1]) || a[0].localeCompare(b[0])).map(([name, v]) => ({ name, value: v.toString() }));
}

export interface HoldingsQuery {
  /** Valuation currency (the chart currency). */
  currency: string;
  /** Extra hledger query words (the shared report filter). */
  query?: string[];
  /** Report period; holdings are balances at its end (historical, so earlier purchases count). */
  period?: { begin?: string; end?: string };
}

/** An `acct:` query for exactly this account (flat report rows are the account's own postings). */
export const exactAccountQuery = (name: string) => `acct:^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;

/** Asset accounts only: the same rule as the Account tab's returns. */
export const HOLDINGS_SCOPE = 'type:A';

/**
 * Run the hledger reports behind the holdings table:
 *   bal --flat -H type:A [query]                              (units)
 *   bal --flat -H type:A cur:^C$ [query] -B                   (cost, per held commodity C)
 *   bal --flat -H type:A cur:^C$ [query] -X <currency>        (market value)
 *   bal --flat -H type:A cur:^C$ [query] --gain -X <currency> (unrealized gain)
 *   prices -e <end|tomorrow> cur:^(C1|C2…)$                   (latest P price per commodity)
 */
export async function fetchHoldings(engine: Pick<Engine, 'balance' | 'raw'>, o: HoldingsQuery): Promise<{ holdings: Holding[]; reports: HoldingReports }> {
  const words = o.query ?? [];
  const base: QueryOpts = { period: o.period ?? {}, accumulation: 'historical' };
  const units = await engine.balance({ ...base, query: [HOLDINGS_SCOPE, ...words] });
  const cs = heldCommodities(positions(units, o.currency));
  const reports: HoldingReports = { units, cost: {}, value: {}, gain: {}, prices: [] };
  await Promise.all(
    cs.map(async (c) => {
      const q = { ...base, query: [HOLDINGS_SCOPE, curQuery(c), ...words] };
      const [cost, value, gain] = await Promise.all([
        engine.balance({ ...q, valuation: 'cost' }),
        engine.balance({ ...q, valuation: 'value', valueIn: o.currency }),
        engine.balance({ ...q, valuation: 'gain', valueIn: o.currency }),
      ]);
      reports.cost[c] = cost;
      reports.value[c] = value;
      reports.gain[c] = gain;
    }),
  );
  if (cs.length) {
    const r = await engine.raw(['prices', '-e', o.period?.end ?? 'tomorrow', curQuery(...cs)]);
    if (r.code === 0) reports.prices = decodePrices(r.stdout);
  }
  return { holdings: joinHoldings(reports, o.currency), reports };
}

/** Query for the value-vs-cost history: one position, or every held commodity in asset accounts. */
export function historyQuery(hs: Position[], one: Position | null, words: string[] = []): string[] {
  return one ? [exactAccountQuery(one.account), curQuery(one.commodity), ...words] : [HOLDINGS_SCOPE, curQuery(...heldCommodities(hs)), ...words];
}

/** hledger roi argv for one investment account (as the Account tab runs it). */
export function roiArgs(account: string, currency: string, period: { begin?: string; end?: string } = {}, pnl = 'type:RX'): string[] {
  const a = ['roi', '--inv', accountQuery(account), ...(pnl ? ['--pnl', pnl] : []), `--value=end,${currency}`, '--infer-market-prices'];
  if (period.begin) a.push('-b', period.begin);
  if (period.end) a.push('-e', period.end);
  return a;
}

/** Returns per account from `hledger roi` (whole period: the last row). Failures map to an error message. */
export async function fetchReturns(
  engine: Pick<Engine, 'raw'>,
  accounts: string[],
  currency: string,
  period: { begin?: string; end?: string } = {},
): Promise<Map<string, RoiRow | { error: string }>> {
  const out = new Map<string, RoiRow | { error: string }>();
  await Promise.all(
    accounts.map(async (acct) => {
      const r = await engine.raw(roiArgs(acct, currency, period));
      if (r.code !== 0) out.set(acct, { error: r.stderr.replace(/^hledger: Error: /, '').split('\n')[0] || 'roi failed' });
      else {
        const rows = decodeRoi(r.stdout);
        const last = rows[rows.length - 1];
        out.set(acct, last ?? { error: 'No investment activity in this period' });
      }
    }),
  );
  return out;
}
