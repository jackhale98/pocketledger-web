// Periodic transaction rules (`~ PERIOD  [DESCRIPTION]` + postings), located
// the way hledger's journal syntax defines them: a `~` at column 0 starts the
// rule, which continues over the following indented, non-blank lines
// (postings and `;` comment lines). A blank line or any column-0 line ends it.

import type { SourceSpan } from '../../contracts/engine';
import { isContinuation, splitLines, type Lines } from '../locate';

/** A periodic rule header: `~` at column 0. */
export function isRuleHeader(line: string): boolean {
  return line.startsWith('~');
}

/** Last line (1-based) of the rule whose header is at `startLine`. */
export function ruleExtent(lines: readonly string[], startLine: number): number {
  let end = startLine;
  while (end < lines.length && isContinuation(lines[end]!)) end++;
  return end;
}

/** Spans of every periodic rule in a file (skipping `comment … end comment` blocks), in file order. */
export function findRuleSpans(text: string | Lines, file: string): SourceSpan[] {
  const lines = typeof text === 'string' ? splitLines(text).lines : text.lines;
  const spans: SourceSpan[] = [];
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
    if (isRuleHeader(line)) {
      const endLine = ruleExtent(lines, i + 1);
      spans.push({ file, startLine: i + 1, endLine });
      i = endLine - 1;
    }
  }
  return spans;
}

/**
 * Check a rule span against the text and return its real extent, or null when
 * the start line is not a rule header (a stale span). The end is re-derived.
 */
export function normalizeRuleSpan(l: Lines, span: { startLine: number; endLine?: number }): { startLine: number; endLine: number } | null {
  const { startLine } = span;
  if (!Number.isInteger(startLine) || startLine < 1 || startLine > l.lines.length) return null;
  if (!isRuleHeader(l.lines[startLine - 1]!)) return null;
  return { startLine, endLine: ruleExtent(l.lines, startLine) };
}
