// Read periodic rules into drafts. The posting lines of a rule have exactly
// the syntax of a transaction's, so they are read by the writer's own parser
// (through a stand-in date header); only the `~` header is read here.

import type { SourceSpan } from '../../contracts/engine';
import type { PostingDraft } from '../../contracts/writer';
import { rangeText, splitLines, type Lines } from '../locate';
import { draftFromText } from '../writer';
import { findRuleSpans } from './spans';

/** A rule as the form edits it. */
export interface RuleDraft {
  /** hledger period expression, e.g. "monthly", "every 2 weeks from 2026-01-05 to 2026-12-31". */
  period: string;
  /** Text after the period (and two spaces); may be ''. */
  description: string;
  /** Same-line comment after the description, plus comment lines (joined with '\n'), as in TxnDraft. */
  comment?: string;
  postings: PostingDraft[];
}

/** A rule found in a file. */
export interface PeriodicRule extends RuleDraft {
  /** Where it lives: file, header line, last line (1-based, inclusive). */
  span: SourceSpan;
  /** Exact text of the span (terminators between lines as in the file, none after the last). */
  text: string;
}

export interface RuleHeader {
  raw: string;
  /** Period expression as written (trimmed). */
  period: string;
  description: string;
  /** Inline comment text after `;`, trimmed; null when there is no `;`. */
  comment: string | null;
  /** Everything after the description (or period): whitespace and `; comment`, verbatim. */
  tail: string;
}

/** Date and description of the stand-in header used to read and write posting lines with the writer. */
export const STAND_IN_DATE = '2000-01-01';
export const STAND_IN_DESC = 'X';
export const STAND_IN_HEADER = `${STAND_IN_DATE} ${STAND_IN_DESC}`;

/**
 * Parse `~ PERIOD  DESCRIPTION  ; comment`. The period ends at two or more
 * spaces/tabs (any mix), as in hledger; a single space or tab does not end it.
 */
export function parseRuleHeader(raw: string): RuleHeader | null {
  if (!raw.startsWith('~')) return null;
  const rest = raw.slice(1);
  const sc = rest.indexOf(';');
  const main = sc < 0 ? rest : rest.slice(0, sc);
  const mainTrim = main.trimEnd();
  const tail = rest.slice(mainTrim.length);
  const body = mainTrim.trimStart();
  const gap = /[ \t]{2,}/.exec(body);
  const period = gap ? body.slice(0, gap.index) : body;
  const description = gap ? body.slice(gap.index + gap[0].length) : '';
  return { raw, period, description, comment: sc < 0 ? null : rest.slice(sc + 1).trim(), tail };
}

/** The rule's lines with its header swapped for a transaction header carrying the same comment tail. */
export function standInLines(lines: readonly string[], header: RuleHeader): string[] {
  return [STAND_IN_HEADER + header.tail, ...lines.slice(1)];
}

/** Parse a rule's lines (header first). Null when line 1 is not a `~` header. */
export function parseRuleLines(lines: readonly string[]): (RuleDraft & { header: RuleHeader }) | null {
  const header = lines[0] === undefined ? null : parseRuleHeader(lines[0]);
  if (!header) return null;
  const d = draftFromText(standInLines(lines, header).join('\n'));
  const out: RuleDraft & { header: RuleHeader } = { header, period: header.period, description: header.description, postings: d.postings };
  if (d.comment !== undefined) out.comment = d.comment;
  return out;
}

/** Parse a rule from its text (header line first). Throws when it does not start with `~`. */
export function ruleFromText(text: string): RuleDraft {
  const r = parseRuleLines(splitLines(text.startsWith('﻿') ? text.slice(1) : text).lines);
  if (!r) throw new Error('Not a periodic rule: the first line must start with ~');
  const { header: _h, ...draft } = r;
  return draft;
}

/** Every periodic rule in one file, in file order. */
export function rulesInFile(text: string | Lines, file: string): PeriodicRule[] {
  const l = typeof text === 'string' ? splitLines(text) : text;
  return findRuleSpans(l, file).map((span) => {
    const r = parseRuleLines(l.lines.slice(span.startLine - 1, span.endLine))!;
    const { header: _h, ...draft } = r;
    return { ...draft, span, text: rangeText(l, span.startLine, span.endLine)! };
  });
}

/** Every periodic rule in the given files (default: all of them, sorted by path), in file then line order. */
export function findRules(files: Record<string, string>, paths: string[] = Object.keys(files).sort()): PeriodicRule[] {
  return paths.flatMap((p) => (files[p] === undefined ? [] : rulesInFile(files[p]!, p)));
}

// ─── Period expressions ───

/** Whitespace runs collapsed: hledger ends the period at the first double space. */
export const normalizePeriod = (p: string): string => p.trim().replace(/\s+/g, ' ');

export interface PeriodParts {
  /** The interval part, e.g. "monthly", "every 2 weeks", "every 15th day of month". */
  interval: string;
  from: string;
  to: string;
}

/**
 * Split "INTERVAL [from DATE] [to DATE]" into parts. Only `from`/`to` (not
 * `since`/`until`/`..`) are split off, and only when recomposing gives the
 * same expression; otherwise everything stays in `interval`.
 */
export function splitPeriod(period: string): PeriodParts {
  const p = normalizePeriod(period);
  const m = /^(.+?)(?: from (\S+))?(?: to (\S+))?$/i.exec(p);
  if (m) {
    const parts = { interval: m[1]!, from: m[2] ?? '', to: m[3] ?? '' };
    if (composePeriod(parts).toLowerCase() === p.toLowerCase() && !/\b(from|to|since|until|in)\b|\.\./i.test(parts.interval)) return parts;
  }
  return { interval: p, from: '', to: '' };
}

export function composePeriod(parts: PeriodParts): string {
  let s = normalizePeriod(parts.interval);
  if (parts.from.trim()) s += ` from ${parts.from.trim()}`;
  if (parts.to.trim()) s += ` to ${parts.to.trim()}`;
  return s;
}

/** `2026` / `2026-05` / `2026/5/3` → `YYYY-MM-DD` (first day), or null for anything else (smart dates). */
export function periodDate(d: string): string | null {
  const m = /^(\d{4})(?:[-/.](\d{1,2})(?:[-/.](\d{1,2}))?)?$/.exec(d.trim());
  if (!m) return null;
  return `${m[1]}-${(m[2] ?? '1').padStart(2, '0')}-${(m[3] ?? '1').padStart(2, '0')}`;
}

function addMonths(iso: string, months: number): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  const t = y * 12 + (m - 1) + months;
  const ny = Math.floor(t / 12);
  const nm = (t % 12) + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${String(nm).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

/**
 * A `--forecast` window in which a rule with this period generates at least
 * one transaction if it can (13 months from its `from` date, else from today,
 * or ending at its `to` date when that is earlier). hledger only checks that a
 * rule balances when it generates something, so saving checks in this window.
 */
export function ruleCheckWindow(period: string, today: string): string {
  const { from, to } = splitPeriod(period);
  const f = periodDate(from);
  const t = periodDate(to);
  let start = f ?? today;
  if (!f && t && t <= start) start = addMonths(t, -13);
  let end = addMonths(start, 13);
  if (t && t > start && t < end) end = t;
  return `${start}..${end}`;
}
