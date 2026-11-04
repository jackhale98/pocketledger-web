// Plan minimal line patches for add / edit / replace-text / delete.

import type { Txn, VaultSnapshot } from '../../contracts/engine';
import { StalePatchError, type Patch, type PostingDraft, type TxnDraft } from '../../contracts/writer';
import {
  attachedCommentStart,
  isBlank,
  normalizeSpan,
  rangeText,
  splitLines,
  splitText,
  type Lines,
} from '../locate';
import { canonicalNumber, parseNumber } from './amount';
import {
  commentLines,
  formatCommentLine,
  formatHeaderLine,
  formatPosting,
  formatPostingLine,
  formatTxn,
  normalizeAssertion,
  normalizeCost,
  resolveCommodity,
  type Layout,
} from './format';
import { draftFromParsed, normalizeDate, parseTxnLines, type ParsedPosting, type ParsedTxn } from './parse';
import { commodityStyle, styleForFile, type InferredStyle } from './style';
import { assertValidDraft } from './validate';

interface Located {
  file: string;
  text: string;
  lines: Lines;
  startLine: number;
  endLine: number;
}

/** Find a transaction's lines in the snapshot, verifying the span against the text. */
export function locateTxn(snapshot: VaultSnapshot, txn: Txn): Located {
  const src = txn.source;
  if (!src) throw new Error('This transaction is not in any file (generated), so it cannot be changed');
  const text = snapshot.files[src.file];
  if (text === undefined) throw new StalePatchError(src.file, src.startLine);
  const lines = splitLines(text);
  const span = normalizeSpan(lines, src);
  if (!span) throw new StalePatchError(src.file, src.startLine);
  return { file: src.file, text, lines, ...span };
}

// ─── Comparison ───

const ws = (s: string | undefined): string => (s ?? '').trim().replace(/\s+/g, ' ');

function sameComment(a: string | undefined, b: string | undefined): boolean {
  return commentLines(a).join('\n') === commentLines(b).join('\n');
}

function sameFirstCommentLine(a: string | undefined, b: string | undefined): boolean {
  return (commentLines(a)[0] ?? '') === (commentLines(b)[0] ?? '');
}

function sameCommentRest(a: string | undefined, b: string | undefined): boolean {
  return commentLines(a).slice(1).join('\n') === commentLines(b).slice(1).join('\n');
}

function sameAmount(a: PostingDraft, b: PostingDraft, style: InferredStyle): boolean {
  const x = (a.amount ?? '').trim();
  const y = (b.amount ?? '').trim();
  if (!x || !y) return x === y;
  const ca = resolveCommodity(a, style);
  if (ca !== resolveCommodity(b, style)) return false;
  const mark = commodityStyle(ca, style).decimalMark;
  const nx = parseNumber(x, mark);
  const ny = parseNumber(y, mark);
  return nx && ny ? canonicalNumber(nx) === canonicalNumber(ny) : x === y;
}

function samePrefix(a: PostingDraft, b: PostingDraft): boolean {
  return a.account.trim() === b.account.trim() && (a.type ?? 'regular') === (b.type ?? 'regular') && (a.status ?? '') === (b.status ?? '');
}

function samePosting(a: PostingDraft, b: PostingDraft, style: InferredStyle): boolean {
  return (
    samePrefix(a, b) &&
    sameAmount(a, b, style) &&
    ws(normalizeCost(a.cost)) === ws(normalizeCost(b.cost)) &&
    ws(normalizeAssertion(a.assertion)) === ws(normalizeAssertion(b.assertion)) &&
    sameComment(a.comment, b.comment)
  );
}

type Step = { kind: 'keep'; o: number; n: number } | { kind: 'modify'; o: number; n: number } | { kind: 'add'; n: number };

/**
 * Align original and new postings: an LCS on structural equality keeps
 * unchanged postings; between kept ones, postings pair up in order as
 * modifications, leftovers are additions or removals.
 */
function alignPostings(orig: PostingDraft[], next: PostingDraft[], style: InferredStyle): Step[] {
  const n = orig.length;
  const m = next.length;
  const eq = (i: number, j: number) => samePosting(orig[i]!, next[j]!, style);
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) dp[i]![j] = eq(i, j) ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const steps: Step[] = [];
  let i = 0;
  let j = 0;
  let gapO: number[] = [];
  let gapN: number[] = [];
  const flush = () => {
    gapN.forEach((nj, k) => steps.push(k < gapO.length ? { kind: 'modify', o: gapO[k]!, n: nj } : { kind: 'add', n: nj }));
    gapO = [];
    gapN = [];
  };
  while (i < n || j < m) {
    if (i < n && j < m && eq(i, j) && dp[i]![j] === dp[i + 1]![j + 1]! + 1) {
      flush();
      steps.push({ kind: 'keep', o: i++, n: j++ });
    } else if (j >= m || (i < n && dp[i + 1]![j]! >= dp[i]![j + 1]!)) {
      gapO.push(i++);
    } else {
      gapN.push(j++);
    }
  }
  flush();
  return steps;
}

/** Column this transaction's amounts end at: its own (majority of 2+), else the file's. */
function localColumn(parsed: ParsedTxn, style: InferredStyle): number | null {
  const ends = parsed.postings.map((p) => p.line.amountEnd).filter((e): e is number => e !== null);
  const counts = new Map<number, number>();
  for (const e of ends) counts.set(e, (counts.get(e) ?? 0) + 1);
  let best: [number, number] | null = null;
  for (const [e, c] of counts) if (!best || c > best[1]) best = [e, c];
  if (best && best[1] >= 2 && best[1] * 2 > ends.length) return best[0];
  return style.amountColumn;
}

function renderEdited(parsed: ParsedTxn, draft: TxnDraft, style: InferredStyle): string[] {
  const orig = draftFromParsed(parsed);
  const indent = parsed.postings[0]?.line.indent ?? style.indent;
  const layout: Layout = { style, indent, column: localColumn(parsed, style) };
  const out: string[] = [];
  const rendered: PostingDraft[] = [];

  // Header line.
  const h = parsed.header;
  const sameDate = normalizeDate(draft.date.trim()) === orig.date;
  const sameDate2 = normalizeDate((draft.date2 ?? '').trim()) === (orig.date2 ?? '');
  const sameHeader =
    sameDate &&
    sameDate2 &&
    (draft.status ?? '') === (orig.status ?? '') &&
    (draft.code ?? '').trim() === (orig.code ?? '') &&
    draft.description.trim() === orig.description.trim() &&
    sameFirstCommentLine(draft.comment, orig.comment);
  if (sameHeader) out.push(h.raw);
  else {
    out.push(formatHeaderLine(draft, style, { line: h, date: sameDate, date2: sameDate2, comment: sameFirstCommentLine(draft.comment, orig.comment) }));
  }
  if (sameCommentRest(draft.comment, orig.comment)) out.push(...parsed.headerComments);
  else out.push(...commentLines(draft.comment).slice(1).map((c) => formatCommentLine(c, indent)));

  // Postings.
  const keepLines = (p: ParsedPosting) => [p.line.raw, ...p.commentLines];
  for (const step of alignPostings(orig.postings, draft.postings, style)) {
    const np = draft.postings[step.n]!;
    if (step.kind === 'keep') {
      out.push(...keepLines(parsed.postings[step.o]!));
      continue;
    }
    rendered.push(np);
    if (step.kind === 'add') {
      out.push(...formatPosting(np, layout));
      continue;
    }
    const op = orig.postings[step.o]!;
    const pp = parsed.postings[step.o]!;
    out.push(
      formatPostingLine(np, layout, {
        line: pp.line,
        amount: sameAmount(np, op, style) && resolveCommodity(np, style) === resolveCommodity(op, style),
        cost: ws(normalizeCost(np.cost)) === ws(normalizeCost(op.cost)),
        assertion: ws(normalizeAssertion(np.assertion)) === ws(normalizeAssertion(op.assertion)),
        comment: sameFirstCommentLine(np.comment, op.comment),
      }),
    );
    if (sameCommentRest(np.comment, op.comment)) out.push(...pp.commentLines);
    else out.push(...commentLines(np.comment).slice(1).map((c) => formatCommentLine(c, pp.line.indent)));
  }
  // Validate only what is being written anew; kept lines are the file's business.
  assertValidDraft(sameHeader ? { date: orig.date, description: '', postings: rendered } : { ...draft, postings: rendered });
  return out;
}

function replacePatch(loc: Located, newLines: string[], eol: string): Patch[] {
  const expected = rangeText(loc.lines, loc.startLine, loc.endLine)!;
  const text = newLines.join(eol);
  if (text === expected) return [];
  return [{ op: 'replace', file: loc.file, startLine: loc.startLine, endLine: loc.endLine, expected, text }];
}

// ─── Public planners ───

/**
 * Edit a transaction. Everything the draft leaves as it was stays
 * byte-identical: the header line, unchanged postings and comment lines, and
 * within a changed posting the amount/cost/assertion/comment text that did not
 * change. Returns [] when nothing changed.
 */
export function planEdit(snapshot: VaultSnapshot, txn: Txn, draft: TxnDraft): Patch[] {
  const loc = locateTxn(snapshot, txn);
  const style = styleForFile(snapshot.files, loc.file, snapshot.rootFile);
  const parsed = parseTxnLines(loc.lines.lines.slice(loc.startLine - 1, loc.endLine))!;
  return replacePatch(loc, renderEdited(parsed, draft, style), style.eol);
}

/** Replace a transaction's text verbatim (EOLs normalised to the file's; leading/trailing blank lines dropped). Empty text deletes it. */
export function planReplaceText(snapshot: VaultSnapshot, txn: Txn, text: string): Patch[] {
  const loc = locateTxn(snapshot, txn);
  const style = styleForFile(snapshot.files, loc.file, snapshot.rootFile);
  const lines = splitText(text.startsWith('﻿') ? text.slice(1) : text);
  while (lines.length && isBlank(lines[lines.length - 1]!)) lines.pop();
  while (lines.length && isBlank(lines[0]!)) lines.shift();
  if (!lines.length) return planDelete(snapshot, txn);
  return replacePatch(loc, lines, style.eol);
}

/** Delete a transaction and one adjacent blank separator line (the one after it, else the one before). */
export function planDelete(snapshot: VaultSnapshot, txn: Txn): Patch[] {
  const loc = locateTxn(snapshot, txn);
  const all = loc.lines.lines;
  let { startLine, endLine } = loc;
  if (endLine < all.length && isBlank(all[endLine]!)) endLine++;
  else if (startLine > 1 && isBlank(all[startLine - 2]!)) startLine--;
  const expected = rangeText(loc.lines, startLine, endLine)!;
  return [{ op: 'delete', file: loc.file, startLine, endLine, expected }];
}

/**
 * Add a transaction. Appended to the target file with one blank line before
 * it; the file's final-newline state is kept (a file without a final newline
 * still has none afterwards). With `dateOrder` and `txns`, it is inserted
 * before the first transaction of that file dated after it (and above any
 * comment lines directly attached to that transaction).
 */
export function planAdd(snapshot: VaultSnapshot, draft: TxnDraft, opts: { targetFile?: string; dateOrder?: boolean; txns?: Txn[] } = {}): Patch[] {
  assertValidDraft(draft);
  const file = opts.targetFile ?? snapshot.rootFile;
  const text = snapshot.files[file] ?? '';
  const style = styleForFile(snapshot.files, file, snapshot.rootFile);
  const eol = style.eol;
  const body = formatTxn(draft, style);
  const l = splitLines(text);

  if (opts.dateOrder && opts.txns) {
    const date = normalizeDate(draft.date.trim());
    let before: number | null = null;
    for (const t of opts.txns) {
      const src = t.source;
      if (!src || src.file !== file || t.generated) continue;
      if (normalizeDate(t.date) <= date) continue;
      if (!normalizeSpan(l, src)) continue;
      if (before === null || src.startLine < before) before = src.startLine;
    }
    if (before !== null) {
      const at = attachedCommentStart(l.lines, before);
      const prevBlank = at === 1 || isBlank(l.lines[at - 2]!);
      return [{ op: 'insert', file, beforeLine: at, text: `${prevBlank ? '' : eol}${body}${eol}` }];
    }
  }

  if (l.lines.length === 0) return [{ op: 'append', file, text: body + (style.finalNewline ? eol : '') }];
  const last = l.lines[l.lines.length - 1]!;
  if (l.eols[l.lines.length - 1] !== '') {
    return [{ op: 'append', file, text: `${isBlank(last) ? '' : eol}${body}${eol}` }];
  }
  // No final newline: end the last line, separate, and keep no final newline.
  return [{ op: 'append', file, text: `${eol}${isBlank(last) ? '' : eol}${body}` }];
}
