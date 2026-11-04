// Exact decimal arithmetic on amount quantities (never JS floats).
import Decimal from 'decimal.js-light';
import type { Amount, AmountStyle, MixedAmount } from '../contracts/amount';

Decimal.config({ precision: 64, rounding: Decimal.ROUND_HALF_EVEN });

export { Decimal };

export const dec = (s: string | number): Decimal => new Decimal(s);

/** Canonical decimal string from an integer mantissa and decimal places (hledger's Decimal). */
export function fromMantissa(mantissa: string, places: number): string {
  let neg = false;
  let m = mantissa.trim();
  if (m.startsWith('-')) {
    neg = true;
    m = m.slice(1);
  }
  m = m.replace(/^0+(?=\d)/, '');
  if (places > 0) {
    m = m.padStart(places + 1, '0');
    m = `${m.slice(0, m.length - places)}.${m.slice(m.length - places)}`;
  }
  if (/^0(\.0*)?$/.test(m)) neg = false;
  return (neg ? '-' : '') + m;
}

export const isZero = (q: string) => /^-?0*(\.0*)?$/.test(q);
export const isNegative = (q: string) => q.startsWith('-') && !isZero(q);

export const DEFAULT_STYLE: AmountStyle = {
  side: 'L',
  spaced: false,
  decimalMark: '.',
  digitGroups: null,
  precision: null,
};

export function styleFor(commodity: string): AmountStyle {
  // hledger's default for unknown commodities: symbols like $ € £ left, words right & spaced.
  if (!commodity) return { ...DEFAULT_STYLE };
  if (/^[A-Za-z]/.test(commodity)) return { ...DEFAULT_STYLE, side: 'R', spaced: true };
  return { ...DEFAULT_STYLE };
}

/** Sum a mixed amount per commodity (costs dropped). Zero entries removed. */
export function sumMixed(...amounts: MixedAmount[]): MixedAmount {
  const map = new Map<string, { q: Decimal; style: AmountStyle }>();
  for (const ma of amounts)
    for (const a of ma) {
      const cur = map.get(a.commodity);
      if (cur) cur.q = cur.q.plus(a.quantity);
      else map.set(a.commodity, { q: dec(a.quantity), style: a.style });
    }
  const out: MixedAmount = [];
  for (const [commodity, { q, style }] of map) if (!q.isZero()) out.push({ commodity, quantity: q.toString(), style });
  return out;
}

export function negateMixed(ma: MixedAmount): MixedAmount {
  return ma.map((a) => ({ ...a, quantity: dec(a.quantity).neg().toString() }));
}

/** Quantity of one commodity in a mixed amount ('0' if absent). */
export function quantityOf(ma: MixedAmount, commodity: string): string {
  return ma.find((a) => a.commodity === commodity)?.quantity ?? '0';
}

/** Number for charts only (never for arithmetic that is written back). */
export const toNumber = (q: string) => Number(q);

function groupDigits(int: string, groups: { separator: string; sizes: number[] }): string {
  const sizes = groups.sizes.length ? groups.sizes : [3];
  const parts: string[] = [];
  let rest = int;
  let i = 0;
  while (rest.length > 0) {
    const size = sizes[Math.min(i, sizes.length - 1)]!;
    if (rest.length <= size) {
      parts.unshift(rest);
      break;
    }
    parts.unshift(rest.slice(-size));
    rest = rest.slice(0, -size);
    i++;
  }
  return parts.join(groups.separator);
}

export interface FormatOpts {
  /** Override precision (e.g. 0 for compact chart labels). */
  precision?: number;
  /** Show '+' on positives. */
  signed?: boolean;
  /** Apply digit grouping even if the style has none (default true for display). */
  group?: boolean;
}

/** Format a quantity + commodity the way hledger would display it with this style. */
export function formatAmount(a: Pick<Amount, 'commodity' | 'quantity' | 'style'>, opts: FormatOpts = {}): string {
  const style = a.style ?? styleFor(a.commodity);
  let d = dec(a.quantity);
  const precision = opts.precision ?? style.precision;
  let s: string;
  if (precision != null) s = d.toFixed(precision);
  else s = d.toString();
  if (s.includes('e')) s = d.toFixed();
  const neg = s.startsWith('-');
  if (neg) s = s.slice(1);
  if (/^0(\.0*)?$/.test(s)) d = dec(0);
  let [int, frac] = s.split('.') as [string, string | undefined];
  const groups = style.digitGroups ?? (opts.group !== false ? { separator: style.decimalMark === ',' ? '.' : ',', sizes: [3] } : null);
  if (groups) int = groupDigits(int, groups);
  let num = frac ? `${int}${style.decimalMark}${frac}` : int;
  const sign = neg && !d.isZero() ? '-' : opts.signed && !d.isZero() ? '+' : '';
  const c = a.commodity;
  const quoted = c && /[^\p{L}\p{Sc}]/u.test(c) && !/^[$€£¥₹₽₩]$/.test(c) ? `"${c}"` : c;
  if (!c) return sign + num;
  if (style.side === 'L') return `${sign}${quoted}${style.spaced ? ' ' : ''}${num}`;
  return `${sign}${num}${style.spaced ? ' ' : ''}${quoted}`;
}

export function formatMixed(ma: MixedAmount, opts: FormatOpts = {}): string {
  if (ma.length === 0) return '0';
  return ma.map((a) => formatAmount(a, opts)).join(', ');
}
