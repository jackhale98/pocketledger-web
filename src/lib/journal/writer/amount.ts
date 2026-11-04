// Amount text: parsing what a journal (or a user) wrote, and rendering a
// number + commodity in a journal's style. Pure string work, no floats:
// a value is never rounded, only padded to the commodity's precision.

export type DecimalMark = '.' | ',';

/** How one commodity is written in a file. */
export interface CommodityStyle {
  side: 'L' | 'R';
  spaced: boolean;
  decimalMark: DecimalMark;
  /** Digit group mark ("," in 1,000.00), null for none. Groups are of 3. */
  groupMark: string | null;
  /** Minimum decimal places to write; null = as typed. */
  precision: number | null;
}

/** The pieces of an amount like `$-1,234.50`, `-12.50 EUR` or `10 "VANGUARD FUND"`. */
export interface AmountParts {
  sign: '' | '-';
  /** The unsigned number exactly as written, e.g. "1,234.50". */
  number: string;
  /** Unquoted commodity symbol; '' when the amount has none. */
  commodity: string;
  side: 'L' | 'R' | null;
  spaced: boolean;
}

/** A parsed number: digits only, no marks. */
export interface ParsedNumber {
  neg: boolean;
  int: string;
  frac: string;
  /** The digit group mark the text used, if any. */
  group: string | null;
}

/** Characters that may appear in an unquoted commodity symbol (hledger's "simple" commodity). */
const SYMBOL = String.raw`[^\s\d"\-+.,@*;{}=()\[\]<>]+`;
const QUOTED = String.raw`"[^"\r\n]*"`;
const COMM = `(?:${QUOTED}|${SYMBOL})`;
const NUM = String.raw`(?:\d[\d.,']*|[.,]\d[\d.,']*)`;
const AMOUNT_RE = new RegExp(
  String.raw`^([-+]?)[ \t]*(?:(${COMM})([ \t]*))?([-+]?)[ \t]*(${NUM})(?:([ \t]*)(${COMM}))?$`,
);
const SIMPLE_SYMBOL_RE = new RegExp(`^${SYMBOL}$`);

function unquote(c: string): string {
  return c.startsWith('"') && c.endsWith('"') && c.length >= 2 ? c.slice(1, -1) : c;
}

/** Parse an amount's text (no cost/assertion). Null for anything else (expressions, `*2` multipliers, …). */
export function parseAmount(text: string): AmountParts | null {
  const m = AMOUNT_RE.exec(text.trim());
  if (!m) return null;
  const [, sign1 = '', left, leftGap = '', sign2 = '', num = '', rightGap = '', right] = m;
  if (left !== undefined && right !== undefined) return null;
  if (sign1 && sign2) return null;
  if (sign2 && left === undefined) return null; // "--5"-like
  const sign = sign1 === '-' || sign2 === '-' ? '-' : '';
  if (left !== undefined) {
    // "$ -5" and "$- 5" are both spaced; "$-5" is not.
    const between = text.trim().slice(sign1.length).trimStart().slice(left.length);
    const spaced = leftGap.length > 0 || /^[-+]?[ \t]/.test(between);
    return { sign, number: num, commodity: unquote(left), side: 'L', spaced };
  }
  if (right !== undefined) {
    return { sign, number: num, commodity: unquote(right), side: 'R', spaced: rightGap.length > 0 };
  }
  return { sign, number: num, commodity: '', side: null, spaced: false };
}

function count(s: string, ch: string): number {
  let n = 0;
  for (const c of s) if (c === ch) n++;
  return n;
}

/**
 * Parse an unsigned number written with `decimalMark`, leniently enough for
 * user input: when both `.` and `,` appear the last one is the decimal mark;
 * a single "other" mark followed by exactly three digits is a group mark
 * ("1,234" under `.`), otherwise it is taken as the decimal mark the user
 * meant ("12,5" under `.` is 12.5). `'` is always a group mark.
 */
export function parseNumber(text: string, decimalMark: DecimalMark): ParsedNumber | null {
  let s = text.trim();
  let neg = false;
  if (s.startsWith('-') || s.startsWith('+')) {
    neg = s[0] === '-';
    s = s.slice(1).trimStart();
  }
  let group: string | null = null;
  if (s.includes("'")) {
    group = "'";
    s = s.replace(/'/g, '');
  }
  if (!/^[\d.,]+$/.test(s) || !/\d/.test(s)) return null;
  const dots = count(s, '.');
  const commas = count(s, ',');
  let dec: string | null = null;
  if (dots > 0 && commas > 0) {
    dec = s.lastIndexOf('.') > s.lastIndexOf(',') ? '.' : ',';
    if (count(s, dec) > 1) return null;
    group = dec === '.' ? ',' : '.';
  } else if (dots > 0 || commas > 0) {
    const mark = dots > 0 ? '.' : ',';
    const n = dots + commas;
    if (n > 1) {
      group = mark;
    } else if (mark === decimalMark) {
      dec = mark;
    } else {
      const after = s.length - s.indexOf(mark) - 1;
      if (after === 3 && s.indexOf(mark) > 0) group = mark;
      else dec = mark;
    }
  }
  let intPart = s;
  let frac = '';
  if (dec !== null) {
    const i = s.lastIndexOf(dec);
    intPart = s.slice(0, i);
    frac = s.slice(i + 1);
    if (!/^\d*$/.test(frac)) return null;
  }
  if (group !== null && group !== "'") intPart = intPart.split(group).join('');
  if (!/^\d*$/.test(intPart)) return null;
  if (intPart === '' && frac === '') return null;
  return { neg, int: intPart, frac, group };
}

/** Canonical value string ("-1234.5", "0") for comparing two numbers. */
export function canonicalNumber(n: ParsedNumber): string {
  const int = n.int.replace(/^0+(?=\d)/, '') || '0';
  const frac = n.frac.replace(/0+$/, '');
  const zero = /^0*$/.test(int) && frac === '';
  return `${n.neg && !zero ? '-' : ''}${int}${frac ? `.${frac}` : ''}`;
}

function groupDigits(int: string, mark: string): string {
  const out: string[] = [];
  for (let end = int.length; end > 0; end -= 3) out.unshift(int.slice(Math.max(0, end - 3), end));
  return out.join(mark);
}

/** Write a number in a style: its decimal mark, grouping, and at least its precision (never rounds). */
export function formatNumber(n: ParsedNumber, style: Pick<CommodityStyle, 'decimalMark' | 'groupMark' | 'precision'>): string {
  let int = n.int.replace(/^0+(?=\d)/, '') || '0';
  if (style.groupMark && style.groupMark !== style.decimalMark && int.length > 3) int = groupDigits(int, style.groupMark);
  let frac = n.frac;
  if (style.precision !== null && frac.length < style.precision) frac = frac.padEnd(style.precision, '0');
  return `${n.neg ? '-' : ''}${int}${frac ? `${style.decimalMark}${frac}` : ''}`;
}

/** Quote a commodity symbol when hledger needs it quoted (spaces, digits, punctuation). */
export function quoteCommodity(c: string): string {
  return SIMPLE_SYMBOL_RE.test(c) ? c : `"${c}"`;
}

/** True for a symbol commodity like `$` or `€` (no letters), which hledger convention writes on the left. */
export function isSymbolCommodity(c: string): boolean {
  return c !== '' && !/\p{L}/u.test(c);
}

function place(num: string, commodity: string, style: CommodityStyle): string {
  if (!commodity) return num;
  const q = quoteCommodity(commodity);
  const sp = style.spaced ? ' ' : '';
  return style.side === 'L' ? `${q}${sp}${num}` : `${num}${sp}${q}`;
}

/**
 * Render a typed amount with its commodity. A left-side commodity takes the
 * sign after the symbol (`$-12.50`), as hledger itself prints it. Text that is
 * not a plain number (e.g. an expression) is written verbatim.
 */
export function renderAmount(amount: string, commodity: string, style: CommodityStyle): string {
  const n = parseNumber(amount, style.decimalMark);
  if (!n) return place(amount.trim(), commodity, style);
  return place(formatNumber(n, style), commodity, style);
}

/** Visual width of text, expanding tabs to 8-column stops. */
export function visualWidth(text: string, startCol = 0): number {
  let col = startCol;
  for (const ch of text) {
    if (ch === '\t') col += 8 - (col % 8);
    else col++;
  }
  return col - startCol;
}
