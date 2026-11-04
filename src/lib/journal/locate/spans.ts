// Transaction boundaries, the way hledger's journal syntax defines them:
// a transaction starts with a date at column 0 and continues over the
// following indented, non-blank lines (postings and `;` comment lines). A
// blank or whitespace-only line, or any line starting at column 0, ends it.

import type { SourceSpan } from '../../contracts/engine';
import { splitLines, type Lines } from './lines';

const DATE = String.raw`\d{1,4}[-/.]\d{1,2}(?:[-/.]\d{1,2})?`;
/** A simple date, as a whole string: 2024-01-15, 2024/1/5, 1/15 (year from a `Y` directive). */
export const DATE_RE = new RegExp(`^${DATE}$`);
const HEADER_RE = new RegExp(`^${DATE}(?:=${DATE})?(?=[ \\t;]|$)`);

/** A transaction header: a date (optionally `=DATE2`) at column 0. */
export function isTxnHeader(line: string): boolean {
  return HEADER_RE.test(line);
}

/** A line that belongs to the item above it: indented and not blank. */
export function isContinuation(line: string): boolean {
  return /^[ \t]+\S/.test(line);
}

export function isBlank(line: string): boolean {
  return /^\s*$/.test(line);
}

/** An indented `;` comment line (part of a transaction). Indented `#` lines are postings to hledger. */
export function isIndentedComment(line: string): boolean {
  return /^[ \t]+;/.test(line);
}

/** A top-level comment line (`;`, `#` or `*` at column 0). */
export function isTopLevelComment(line: string): boolean {
  return /^[;#*]/.test(line);
}

function isCommentBlockStart(line: string): boolean {
  return /^comment\s*$/.test(line);
}

function isCommentBlockEnd(line: string): boolean {
  return /^end\s+comment\s*$/.test(line);
}

/** Last line (1-based) of the transaction whose header is at `startLine`. */
export function txnExtent(lines: readonly string[], startLine: number): number {
  let end = startLine;
  while (end < lines.length && isContinuation(lines[end]!)) end++;
  return end;
}

/** Spans of every transaction in a file (skipping `comment … end comment` blocks), in file order. */
export function findTxnSpans(text: string | Lines, file: string): SourceSpan[] {
  const lines = typeof text === 'string' ? splitLines(text).lines : text.lines;
  const spans: SourceSpan[] = [];
  let inBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (inBlock) {
      if (isCommentBlockEnd(line)) inBlock = false;
      continue;
    }
    if (isCommentBlockStart(line)) {
      inBlock = true;
      continue;
    }
    if (isTxnHeader(line)) {
      const endLine = txnExtent(lines, i + 1);
      spans.push({ file, startLine: i + 1, endLine });
      i = endLine - 1;
    }
  }
  return spans;
}

/**
 * Check a span against the text and return the transaction's real extent, or
 * null when the start line is not a transaction header (a stale span).
 *
 * The end line is not trusted: the extent is re-derived from the text, which
 * trims trailing blank / column-0 lines a span may include and extends a span
 * that stops short of the transaction's last posting or comment line.
 */
export function normalizeSpan(l: Lines, span: { startLine: number; endLine: number }): { startLine: number; endLine: number } | null {
  const { startLine } = span;
  if (!Number.isInteger(startLine) || startLine < 1 || startLine > l.lines.length) return null;
  if (!isTxnHeader(l.lines[startLine - 1]!)) return null;
  return { startLine, endLine: txnExtent(l.lines, startLine) };
}

/** First line of the run of top-level comment lines directly above `line` (no blank in between), or `line` itself. */
export function attachedCommentStart(lines: readonly string[], line: number): number {
  let k = line;
  while (k > 1 && isTopLevelComment(lines[k - 2]!)) k--;
  return k;
}
