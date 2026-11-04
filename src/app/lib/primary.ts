import type { MixedAmount } from '$lib/contracts/amount';
import type { AmountStyle } from '$lib/contracts/amount';
import { app } from '../state/app.svelte';
import { settings } from '../state/settings.svelte';
import { formatAmount, styleFor } from '$lib/engine/decimal';

/** The commodity charts are drawn in: the "Value in" choice, else the most used one. */
export function chartCommodity(): string {
  if (settings.v.valueIn) return settings.v.valueIn;
  const count = new Map<string, number>();
  for (const t of app.txns) for (const p of t.postings) for (const a of p.amount) count.set(a.commodity, (count.get(a.commodity) ?? 0) + 1);
  return [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
}

export function styleOf(commodity: string): AmountStyle {
  return app.commodities.find((c) => c.symbol === commodity)?.style ?? styleFor(commodity);
}

/** Numeric value of one commodity in a mixed amount (charts only). */
export const numberIn = (ma: MixedAmount, commodity: string): number => Number(ma.find((a) => a.commodity === commodity)?.quantity ?? 0);

/** Format a chart number back with the commodity's style. */
export function fmtIn(commodity: string, precision?: number) {
  const style = styleOf(commodity);
  return (v: number) => formatAmount({ commodity, quantity: v.toFixed(Math.max(2, style.precision ?? 2)), style }, precision != null ? { precision } : {});
}

/** Other commodities present that the chart can't show. */
export const otherCommodities = (amounts: MixedAmount[], commodity: string) =>
  [...new Set(amounts.flatMap((m) => m.filter((a) => a.commodity !== commodity && Number(a.quantity) !== 0).map((a) => a.commodity)))];
