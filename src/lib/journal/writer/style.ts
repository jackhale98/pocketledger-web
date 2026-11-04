// Infer how a journal file is written, so new text looks like its neighbours.

import type { JournalStyle } from '../../contracts/writer';
import { BOM, detectEol, findTxnSpans, splitLines } from '../locate';
import { isSymbolCommodity, parseAmount, parseNumber, type CommodityStyle, type DecimalMark } from './amount';
import { parsePostingLine } from './parse';

/**
 * JournalStyle plus what the contract has no field for: the per-commodity
 * styles (side, spacing, marks, precision) the file uses. It is a JournalStyle,
 * so it can be passed anywhere one is expected; `formatTxn` uses the extra
 * fields when they are present.
 */
export interface InferredStyle extends JournalStyle {
  commodities: Record<string, CommodityStyle>;
  /** Posting amounts the inference saw (0 = nothing to infer from; defaults used). */
  samples: number;
}

const DEFAULT_INDENT = '    ';

class Counter<K> {
  private m = new Map<K, number>();
  add(k: K, n = 1): void {
    this.m.set(k, (this.m.get(k) ?? 0) + n);
  }
  get size(): number {
    return this.m.size;
  }
  get total(): number {
    let t = 0;
    for (const v of this.m.values()) t += v;
    return t;
  }
  /** Most common key (first seen wins ties), with its count. */
  top(): [K, number] | null {
    let best: [K, number] | null = null;
    for (const [k, v] of this.m) if (!best || v > best[1]) best = [k, v];
    return best;
  }
}

interface CommodityStats {
  layout: Counter<string>; // "L " / "L" / "R " / "R"
  group: Counter<string>;
  precision: Counter<number>;
  count: number;
}

function stripComment(s: string): string {
  const i = s.indexOf(';');
  return (i < 0 ? s : s.slice(0, i)).trim();
}

/** The decimal mark a number's text shows on its own, if unambiguous. */
function markVote(num: string): DecimalMark | null {
  const dots = num.split('.').length - 1;
  const commas = num.split(',').length - 1;
  if (dots && commas) return num.lastIndexOf('.') > num.lastIndexOf(',') ? '.' : ',';
  if (dots + commas !== 1) return null;
  const mark: DecimalMark = dots ? '.' : ',';
  return num.length - num.indexOf(mark) - 1 === 3 ? null : mark;
}

/** A commodity directive's amount: a single mark is the decimal mark (hledger's rule there). */
function directiveStyle(text: string, fileMark: DecimalMark | null): (CommodityStyle & { commodity: string }) | null {
  const a = parseAmount(text);
  if (!a || !a.side) return null;
  const n = a.number;
  const dots = n.split('.').length - 1;
  const commas = n.split(',').length - 1;
  let mark: DecimalMark = fileMark ?? '.';
  if (dots && commas) mark = n.lastIndexOf('.') > n.lastIndexOf(',') ? '.' : ',';
  else if (dots === 1 && !commas) mark = '.';
  else if (commas === 1 && !dots) mark = ',';
  const parsed = parseNumber(n, mark);
  if (!parsed) return null;
  return {
    commodity: a.commodity,
    side: a.side,
    spaced: a.spaced,
    decimalMark: mark,
    groupMark: parsed.group,
    precision: parsed.frac.length,
  };
}

function computeStyle(text: string): InferredStyle {
  const l = splitLines(text);
  const lines = l.lines;
  const eol = detectEol(text);
  const bom = text.startsWith(BOM);
  const finalNewline = lines.length === 0 ? true : l.eols[lines.length - 1] !== '';

  // Directives.
  let decimalDirective: DecimalMark | null = null;
  let dDirective: string | null = null;
  const directiveStyles: Record<string, CommodityStyle> = {};
  const pendingCommodity: { text: string }[] = [];
  let inBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (inBlock) {
      if (/^end\s+comment\s*$/.test(line)) inBlock = false;
      continue;
    }
    if (/^comment\s*$/.test(line)) {
      inBlock = true;
      continue;
    }
    let m: RegExpExecArray | null;
    if ((m = /^decimal-mark\s+([.,])/.exec(line))) decimalDirective = m[1] as DecimalMark;
    else if ((m = /^D\s+(.+)$/.exec(line))) {
      const body = stripComment(m[1]!);
      pendingCommodity.push({ text: body });
      const a = parseAmount(body);
      if (a) dDirective = a.commodity;
    } else if ((m = /^commodity\s+(.+)$/.exec(line))) {
      let body = stripComment(m[1]!);
      if (!parseAmount(body)) {
        // `commodity EUR` with an indented `format 1.000,00 EUR` subdirective.
        for (let j = i + 1; j < lines.length && /^[ \t]+\S/.test(lines[j]!); j++) {
          const f = /^[ \t]+format\s+(.+)$/.exec(lines[j]!);
          if (f) body = stripComment(f[1]!);
        }
      }
      pendingCommodity.push({ text: body });
    }
  }

  // Postings.
  const indents = new Counter<string>();
  const ends = new Counter<number>();
  const dateSeps = new Counter<'-' | '/' | '.'>();
  const votes = new Counter<DecimalMark>();
  const used = new Counter<string>();
  const raw: { commodity: string; number: string; layout: string }[] = [];
  for (const span of findTxnSpans(l, '')) {
    const sep = /^\d+([-/.])/.exec(lines[span.startLine - 1]!);
    if (sep) dateSeps.add(sep[1] as '-' | '/' | '.');
    for (let i = span.startLine; i < span.endLine; i++) {
      const line = lines[i]!;
      if (/^[ \t]+;/.test(line)) continue;
      const p = parsePostingLine(line);
      if (!p) continue;
      indents.add(p.indent);
      if (p.amountEnd !== null) ends.add(p.amountEnd);
      const a = p.amount ? parseAmount(p.amount) : null;
      if (!a) continue;
      const v = markVote(a.number);
      if (v) votes.add(v);
      if (a.commodity) used.add(a.commodity);
      raw.push({ commodity: a.commodity, number: a.number, layout: `${a.side ?? 'R'}${a.spaced ? ' ' : ''}` });
    }
  }

  const decimalMark: DecimalMark = decimalDirective ?? votes.top()?.[0] ?? '.';
  for (const { text: t } of pendingCommodity) {
    const s = directiveStyle(t, decimalDirective);
    if (s) {
      const { commodity, ...style } = s;
      directiveStyles[commodity] = style;
    }
  }

  const stats = new Map<string, CommodityStats>();
  const groups = new Counter<string>();
  for (const r of raw) {
    const mark = directiveStyles[r.commodity]?.decimalMark ?? decimalMark;
    const n = parseNumber(r.number, mark);
    let s = stats.get(r.commodity);
    if (!s) stats.set(r.commodity, (s = { layout: new Counter(), group: new Counter(), precision: new Counter(), count: 0 }));
    s.count++;
    s.layout.add(r.layout);
    if (n) {
      s.precision.add(n.frac.length);
      if (n.group) {
        s.group.add(n.group);
        groups.add(n.group);
      }
    }
  }
  const thousandsSeparator = groups.top()?.[0] ?? null;

  const commodities: Record<string, CommodityStyle> = {};
  for (const [c, s] of stats) {
    const layout = s.layout.top()![0];
    commodities[c] = {
      side: layout[0] === 'L' ? 'L' : 'R',
      spaced: layout.length > 1,
      decimalMark,
      groupMark: s.group.top()?.[0] ?? null,
      // The usual precision, not the maximum: one rounding entry of 0.00143 USD must not make every new USD amount 5 places.
      precision: s.precision.top()?.[0] ?? null,
    };
  }
  // A commodity directive is the declared style, and wins.
  for (const [c, d] of Object.entries(directiveStyles)) commodities[c] = d;

  const defaultCommodity = dDirective ?? used.top()?.[0] ?? null;
  const main = defaultCommodity !== null ? commodities[defaultCommodity] : undefined;

  const total = ends.total;
  const topEnd = ends.top();
  const amountColumn = topEnd && topEnd[1] >= 2 && topEnd[1] * 2 >= total ? topEnd[0] : null;

  return {
    indent: indents.top()?.[0] ?? DEFAULT_INDENT,
    amountColumn,
    commoditySide: main?.side ?? 'L',
    commoditySpaced: main?.spaced ?? false,
    decimalMark,
    thousandsSeparator,
    dateSeparator: dateSeps.top()?.[0] ?? '-',
    eol,
    bom,
    finalNewline,
    defaultCommodity,
    commodities,
    samples: raw.length,
  };
}

const cache = new Map<string, InferredStyle>();

/** Infer a file's style. Memoised on the text (a small LRU), so planning many edits on one file is cheap. */
export function inferStyle(text: string): InferredStyle {
  const hit = cache.get(text);
  if (hit) {
    cache.delete(text);
    cache.set(text, hit);
    return hit;
  }
  const s = computeStyle(text);
  cache.set(text, s);
  if (cache.size > 8) cache.delete(cache.keys().next().value!);
  return s;
}

function isInferred(style: JournalStyle): style is InferredStyle {
  return typeof (style as Partial<InferredStyle>).commodities === 'object';
}

/** The style to write `commodity` in: the file's own, else a default from the journal style. */
export function commodityStyle(commodity: string, style: JournalStyle): CommodityStyle {
  const known = isInferred(style) ? style.commodities[commodity] : undefined;
  if (known) return known;
  let side: 'L' | 'R';
  let spaced: boolean;
  if (commodity === '') {
    side = 'R';
    spaced = false;
  } else if (isSymbolCommodity(commodity)) {
    side = 'L';
    spaced = style.commoditySide === 'L' && style.commoditySpaced;
  } else if (style.commoditySide === 'L' && style.commoditySpaced) {
    side = 'L';
    spaced = true;
  } else {
    side = 'R';
    spaced = true;
  }
  return { side, spaced, decimalMark: style.decimalMark, groupMark: style.thousandsSeparator, precision: null };
}

/**
 * Style for writing into `file` of a vault: the file's own, filling in from
 * the root file when the target has no postings to learn from (a new or
 * directive-only file), as hledger applies the root's directives to includes.
 */
export function styleForFile(files: Record<string, string>, file: string, rootFile: string): InferredStyle {
  const text = files[file] ?? '';
  const own = inferStyle(text);
  if (file === rootFile || own.samples > 0) return own;
  const root = files[rootFile];
  if (root === undefined) return own;
  const base = inferStyle(root);
  return {
    ...base,
    commodities: { ...base.commodities, ...own.commodities },
    defaultCommodity: own.defaultCommodity ?? base.defaultCommodity,
    eol: text.includes('\n') ? own.eol : base.eol,
    bom: own.bom,
    finalNewline: own.finalNewline,
    samples: 0,
  };
}
