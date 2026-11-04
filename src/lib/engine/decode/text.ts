import type { AccountType } from '../../contracts/engine';

/** `hledger accounts --types` lines: `assets:bank   ; type: A` */
export function decodeAccountTypes(stdout: string): { name: string; type: AccountType | null }[] {
  const out: { name: string; type: AccountType | null }[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const m = /^(.*?)\s*(?:;\s*type:\s*([ALERXCV]))?\s*$/.exec(raw);
    if (!m) continue;
    out.push({ name: m[1]!.trim(), type: (m[2] as AccountType | undefined) ?? null });
  }
  return out;
}

export const decodeLines = (stdout: string): string[] =>
  stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

export interface PricePoint {
  date: string;
  commodity: string;
  /** Price amount as written by hledger, e.g. "$1.08" or "1.12 EUR". */
  price: string;
  /** Numeric part as a canonical decimal string ('.' mark). */
  quantity: string;
  /** Commodity the price is in. */
  in: string;
}

/** `hledger prices` lines: `P 2026-05-01 EUR $1.08`. */
export function decodePrices(stdout: string): PricePoint[] {
  const out: PricePoint[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^P\s+(\d{4}-\d\d-\d\d)\s+("[^"]+"|\S+)\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const price = m[3]!;
    const num = /-?[\d.,]*\d/.exec(price)?.[0] ?? '0';
    const inC = price.replace(num, '').replace(/"/g, '').trim();
    // hledger prints prices in the commodity's display style; normalise the number.
    const lastSep = Math.max(num.lastIndexOf('.'), num.lastIndexOf(','));
    const decimals = lastSep >= 0 && num.length - lastSep - 1 !== 3 ? num[lastSep] : null;
    const canon = decimals ? num.split(decimals).map((p, i) => (i === 0 ? p.replace(/[.,]/g, '') : p)).join('.') : num.replace(/[.,]/g, '');
    out.push({ date: m[1]!, commodity: m[2]!.replace(/"/g, ''), price, quantity: canon, in: inC });
  }
  return out;
}

export interface RoiRow {
  begin: string;
  end: string;
  valueBegin: string;
  cashflow: string;
  valueEnd: string;
  pnl: string;
  irr: string;
  twrPeriod: string;
  twrYear: string;
}

/** `hledger roi` text table rows (one per period). */
export function decodeRoi(stdout: string): RoiRow[] {
  const rows: RoiRow[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').map((c) => c.trim()).filter((c) => c !== '');
    if (cells.length < 10 || !/^\d+$/.test(cells[0]!)) continue;
    const [, begin, end, valueBegin, cashflow, valueEnd, pnl, irr, twrPeriod, twrYear] = cells as [string, ...string[]];
    rows.push({ begin: begin!, end: end!, valueBegin: valueBegin!, cashflow: cashflow!, valueEnd: valueEnd!, pnl: pnl!, irr: irr!, twrPeriod: twrPeriod!, twrYear: twrYear! });
  }
  return rows;
}
