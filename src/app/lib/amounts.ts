// Parsing what people type into amount fields, and balancing drafts locally
// (a hint only: hledger has the final word when the draft is saved).
import { dec, Decimal } from '$lib/engine/decimal';
import type { AmountStyle } from '$lib/contracts/amount';

export interface ParsedAmount {
  /** Canonical decimal ('.' mark), or null if empty. */
  quantity: string | null;
  /** Commodity typed inline ("$12", "12 EUR"), if any. */
  commodity: string | null;
  error?: string;
}

/** Parse "12.50", "-1,234.5", "$12", "12 EUR", "1.234,50" (with decimalMark ','), "=12*3" (simple expression). */
export function parseAmountInput(raw: string, decimalMark: '.' | ',' = '.'): ParsedAmount {
  let s = raw.trim();
  if (!s) return { quantity: null, commodity: null };
  let commodity: string | null = null;
  const lead = /^(-?)\s*([^\d\s.,+\-=()]+)\s*(.*)$/.exec(s);
  if (lead && lead[2]) {
    commodity = lead[2];
    s = (lead[1] ?? '') + (lead[3] ?? '');
  } else {
    const trail = /^(.*?[\d.,)])\s*([^\d\s.,+\-*/=()]+)$/.exec(s);
    if (trail) {
      commodity = trail[2]!;
      s = trail[1]!;
    }
  }
  if (commodity) commodity = commodity.replace(/^"|"$/g, '');
  s = s.replace(/\s+/g, '');
  const normalise = (t: string) =>
    decimalMark === ','
      ? t.replace(/\./g, '').replace(',', '.')
      : t.replace(/,(?=\d{3}(\D|$))/g, '').replace(',', '.');
  try {
    if (/^=?[\d.,+\-*/()]+$/.test(s) && /[+*/]|\d-\d/.test(s.replace(/^=/, ''))) {
      // A tiny calculator: 12.5+3.20, 3*4.99
      const expr = normalise(s.replace(/^=/, ''));
      if (!/^[\d.+\-*/()]+$/.test(expr)) throw new Error('bad');
      return { quantity: evalExpr(expr).toString(), commodity };
    }
    const n = normalise(s);
    if (!/^[-+]?\d*\.?\d+$|^[-+]?\d+\.$/.test(n)) return { quantity: null, commodity, error: 'Not a number' };
    return { quantity: dec(n.replace(/\.$/, '')).toString(), commodity };
  } catch {
    return { quantity: null, commodity, error: 'Not a number' };
  }
}

/** Shunting-free recursive descent over + - * / ( ) with exact decimals. */
function evalExpr(expr: string): Decimal {
  let i = 0;
  const peek = () => expr[i];
  const num = (): Decimal => {
    if (peek() === '(') {
      i++;
      const v = add();
      i++;
      return v;
    }
    if (peek() === '-') {
      i++;
      return num().neg();
    }
    const m = /^\d*\.?\d+/.exec(expr.slice(i));
    if (!m) throw new Error('bad');
    i += m[0].length;
    return dec(m[0]);
  };
  const mul = (): Decimal => {
    let v = num();
    while (peek() === '*' || peek() === '/') {
      const op = expr[i++];
      const r = num();
      v = op === '*' ? v.times(r) : v.div(r);
    }
    return v;
  };
  const add = (): Decimal => {
    let v = mul();
    while (peek() === '+' || peek() === '-') {
      const op = expr[i++];
      const r = mul();
      v = op === '+' ? v.plus(r) : v.minus(r);
    }
    return v;
  };
  const v = add();
  if (i !== expr.length) throw new Error('bad');
  return v.toDecimalPlaces(10);
}

/** Render a canonical quantity for writing into a journal using a commodity style's decimal mark. */
export function toJournalNumber(q: string, style?: AmountStyle): string {
  return style?.decimalMark === ',' ? q.replace('.', ',') : q;
}

export interface BalanceLine {
  quantity: string | null;
  commodity: string;
  hasCost: boolean;
}

export interface BalanceState {
  /** Sum per commodity of the written amounts. */
  sums: Map<string, Decimal>;
  blanks: number;
  /** Local verdict: 'ok' balanced or one blank to infer; 'unbalanced'; 'unknown' (costs / multi-commodity: let hledger decide). */
  status: 'ok' | 'unbalanced' | 'unknown' | 'empty';
}

export function balanceOf(lines: BalanceLine[]): BalanceState {
  const sums = new Map<string, Decimal>();
  let blanks = 0;
  let cost = false;
  let filled = 0;
  for (const l of lines) {
    if (l.hasCost) cost = true;
    if (l.quantity == null) {
      blanks++;
      continue;
    }
    filled++;
    sums.set(l.commodity, (sums.get(l.commodity) ?? dec(0)).plus(l.quantity));
  }
  if (filled === 0) return { sums, blanks, status: 'empty' };
  const nonzero = [...sums.values()].filter((v) => !v.isZero()).length;
  if (cost || (sums.size > 1 && nonzero > 1 && blanks === 0)) return { sums, blanks, status: 'unknown' };
  if (blanks === 1) return { sums, blanks, status: sums.size <= 1 || nonzero <= 1 ? 'ok' : 'unknown' };
  if (blanks > 1) return { sums, blanks, status: 'unbalanced' };
  return { sums, blanks, status: nonzero === 0 ? 'ok' : 'unbalanced' };
}

export const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
