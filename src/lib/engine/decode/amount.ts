import type { Amount, AmountStyle, MixedAmount } from '../../contracts/amount';
import { fromMantissa } from '../decimal';

export interface HAmountStyle {
  ascommodityside: 'L' | 'R';
  ascommodityspaced: boolean;
  asdecimalmark: string | null;
  asdigitgroups: null | [string, number[]];
  asprecision: number | { tag?: string; contents?: number } | null | string;
  asrounding?: string;
}
export interface HQuantity {
  decimalMantissa: string | number;
  decimalPlaces: number;
  floatingPoint?: number;
}
export interface HAmount {
  acommodity: string;
  aquantity: HQuantity;
  astyle: HAmountStyle;
  acost: null | { tag: 'UnitCost' | 'TotalCost'; contents: HAmount };
  acostbasis?: unknown;
}

export function decodeStyle(s: HAmountStyle): AmountStyle {
  let precision: number | null = null;
  if (typeof s.asprecision === 'number') precision = s.asprecision;
  else if (s.asprecision && typeof s.asprecision === 'object' && typeof s.asprecision.contents === 'number')
    precision = s.asprecision.contents;
  return {
    side: s.ascommodityside === 'R' ? 'R' : 'L',
    spaced: !!s.ascommodityspaced,
    decimalMark: s.asdecimalmark === ',' ? ',' : '.',
    digitGroups: s.asdigitgroups ? { separator: s.asdigitgroups[0], sizes: s.asdigitgroups[1] } : null,
    precision,
  };
}

export function decodeAmount(a: HAmount): Amount {
  const out: Amount = {
    commodity: a.acommodity,
    quantity: fromMantissa(String(a.aquantity.decimalMantissa), a.aquantity.decimalPlaces),
    style: decodeStyle(a.astyle),
  };
  if (a.acost) out.cost = { kind: a.acost.tag === 'TotalCost' ? 'total' : 'unit', amount: decodeAmount(a.acost.contents) };
  return out;
}

export const decodeMixed = (ma: HAmount[] | null | undefined): MixedAmount => (ma ?? []).map(decodeAmount);
