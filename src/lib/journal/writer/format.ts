// Render drafts as journal text in a file's style.

import type { JournalStyle, PostingDraft, TxnDraft } from '../../contracts/writer';
import { parseAmount, renderAmount, visualWidth } from './amount';
import type { HeaderLine, PostingLine } from './parse';
import { normalizeDate } from './parse';
import { commodityStyle } from './style';

/** Where and how a transaction's postings are laid out. */
export interface Layout {
  style: JournalStyle;
  indent: string;
  /** Column amounts (with their cost) end at; null = two spaces after the account. */
  column: number | null;
}

/** Commodity a posting's amount is written in: its own, else (undefined) the style's default. '' = none. */
export function resolveCommodity(p: PostingDraft, style: JournalStyle): string {
  return p.commodity ?? style.defaultCommodity ?? '';
}

export function formatDate(date: string, style: JournalStyle): string {
  const d = normalizeDate(date.trim());
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d.replace(/-/g, style.dateSeparator) : d;
}

/** `@ $1.10` / `@@ 110 EUR` / `{$100}`; a bare price gets `@ ` in front. */
export function normalizeCost(cost: string | undefined): string {
  const c = (cost ?? '').trim();
  if (!c) return '';
  return /^[@{([]/.test(c) ? c : `@ ${c}`;
}

/** `= $500` / `==* 0`; a bare amount gets `= ` in front. */
export function normalizeAssertion(assertion: string | undefined): string {
  const a = (assertion ?? '').trim();
  if (!a) return '';
  return a.startsWith('=') ? a : `= ${a}`;
}

/** Comment as lines; [] when there is none. The first line goes inline. */
export function commentLines(comment: string | undefined): string[] {
  if (comment === undefined) return [];
  const lines = comment.split(/\r\n|\r|\n/);
  while (lines.length > 1 && lines[lines.length - 1]!.trim() === '') lines.pop();
  return lines.map((s) => s.trim());
}

export function formatCommentLine(text: string, indent: string): string {
  return text ? `${indent}; ${text}` : `${indent};`;
}

function inlineComment(first: string | undefined): string {
  return first ? `  ; ${first}` : '';
}

/**
 * Render a posting's amount. `like` is the amount text the posting had before
 * an edit: when the commodity is the same, its side and spacing are kept (the
 * number still follows the commodity's marks and precision).
 */
export function formatAmountText(p: PostingDraft, style: JournalStyle, like?: string): string {
  const amount = (p.amount ?? '').trim();
  if (!amount) return '';
  const commodity = resolveCommodity(p, style);
  let cs = commodityStyle(commodity, style);
  const before = like ? parseAmount(like) : null;
  if (before?.side && before.commodity === commodity) cs = { ...cs, side: before.side, spaced: before.spaced };
  return renderAmount(amount, commodity, cs);
}

export function accountText(p: PostingDraft): string {
  const a = p.account.trim();
  if (p.type === 'virtual') return `(${a})`;
  if (p.type === 'balanced-virtual') return `[${a}]`;
  return a;
}

/** Pieces of an original posting line to reuse verbatim when the draft did not change them. */
export interface PostingReuse {
  line: PostingLine;
  amount: boolean;
  cost: boolean;
  assertion: boolean;
  /** Inline (first-line) comment unchanged. */
  comment: boolean;
}

/** Render one posting line (no comment continuation lines). */
export function formatPostingLine(p: PostingDraft, layout: Layout, reuse?: PostingReuse): string {
  const orig = reuse?.line;
  const indent = orig?.indent ?? layout.indent;
  const prefix = `${indent}${p.status ? `${p.status} ` : ''}${accountText(p)}`;
  const amount = reuse?.amount ? orig!.amount : formatAmountText(p, layout.style, orig?.amount);
  const cost = reuse?.cost ? orig!.cost : normalizeCost(p.cost);
  const assertion = reuse?.assertion ? orig!.assertion : normalizeAssertion(p.assertion);
  const amountCost = [amount, cost].filter(Boolean).join(' ');

  let line = prefix;
  if (amountCost) {
    let gap: string;
    const origPrefixSame = orig && orig.raw.startsWith(prefix) && orig.gap && orig.raw.slice(prefix.length).startsWith(orig.gap);
    const origAmountCost = orig ? [orig.amount, orig.cost].filter(Boolean).join(' ') : '';
    if (origPrefixSame && visualWidth(origAmountCost) === visualWidth(amountCost)) {
      gap = orig.gap; // same layout as before: keep the exact whitespace
    } else if (layout.column !== null) {
      const pad = layout.column - visualWidth(prefix) - visualWidth(amountCost);
      gap = ' '.repeat(Math.max(2, pad));
    } else if (orig?.gap) {
      gap = orig.gap;
    } else {
      gap = '  ';
    }
    line += gap + amountCost;
  }
  if (assertion) line += (amountCost ? ' ' : '  ') + assertion;
  if (reuse?.comment) line += orig!.tail;
  else line += inlineComment(commentLines(p.comment)[0]);
  return line;
}

/** Render a posting: its line plus comment continuation lines. */
export function formatPosting(p: PostingDraft, layout: Layout): string[] {
  const [, ...rest] = commentLines(p.comment);
  return [formatPostingLine(p, layout), ...rest.map((c) => formatCommentLine(c, layout.indent))];
}

/** Header pieces to reuse verbatim from the original header line. */
export interface HeaderReuse {
  line: HeaderLine;
  date: boolean;
  date2: boolean;
  /** Inline comment (and the whitespace before it) unchanged. */
  comment: boolean;
}

/** `DATE[=DATE2] [STATUS] [(CODE)] DESCRIPTION[  ; comment]` */
export function formatHeaderLine(d: TxnDraft, style: JournalStyle, reuse?: HeaderReuse): string {
  const date = reuse?.date ? reuse.line.date : formatDate(d.date, style);
  const date2Text = d.date2?.trim() ? (reuse?.date2 && reuse.line.date2 ? reuse.line.date2 : formatDate(d.date2, style)) : '';
  const parts = [date2Text ? `${date}=${date2Text}` : date];
  if (d.status) parts.push(d.status);
  if (d.code?.trim()) parts.push(`(${d.code.trim()})`);
  if (d.description.trim()) parts.push(d.description.trim());
  const head = parts.join(' ');
  if (reuse?.comment) return head + reuse.line.tail;
  return head + inlineComment(commentLines(d.comment)[0]);
}

/** Render a transaction (no trailing EOL) in a style. */
export function formatTxn(draft: TxnDraft, style: JournalStyle): string {
  const layout: Layout = { style, indent: style.indent, column: style.amountColumn };
  const [, ...rest] = commentLines(draft.comment);
  const lines = [
    formatHeaderLine(draft, style),
    ...rest.map((c) => formatCommentLine(c, style.indent)),
    ...draft.postings.flatMap((p) => formatPosting(p, layout)),
  ];
  return lines.join(style.eol);
}
