// Year-end closing: the entries come from hledger's own `close` command
// (printed, never written by hledger); this module only decides where they
// go and plans the text changes. See src/app/views/CloseYearView.svelte.
//
// - Migrate (`close --migrate`): a "closing balances" entry on the last day of
//   the year zeroes every asset/liability balance into
//   equity:opening/closing balances, and an "opening balances" entry on the
//   first day of the next year restores them — normally in a new file for the
//   new year.
// - Retain (`close --retain`): a "retain earnings" entry on the last day of
//   the year moves the year's revenue and expense balances to
//   equity:retained earnings.

import type { Txn } from '../contracts/engine';
import type { Patch } from '../contracts/writer';
import { detectEol, isBlank, splitLines } from './locate';
import { apply, parsePostingLine } from './writer';

export type CloseMode = 'migrate' | 'retain';

/** The hledger arguments that print the closing entries for `year` (the balances at the end of that year). */
export function closeArgs(mode: CloseMode, year: number, opts: { showCosts?: boolean } = {}): string[] {
  return ['close', mode === 'migrate' ? '--migrate' : '--retain', '-e', `${year + 1}-01-01`, ...(opts.showCosts ? ['--show-costs'] : [])];
}

export interface CloseEntry {
  /** The entry's date, as hledger printed it (YYYY-MM-DD). */
  date: string;
  description: string;
  /** The entry's text exactly as hledger printed it, LF line ends, no trailing newline. */
  text: string;
  /** False when every amount in it is zero: nothing left to close. */
  hasAmounts: boolean;
}

/** Split `hledger close` output into its entries, keeping each one's text verbatim. */
export function parseCloseOutput(stdout: string): CloseEntry[] {
  const blocks = stdout.replace(/\r\n/g, '\n').split(/\n[ \t]*\n/);
  const out: CloseEntry[] = [];
  for (const b of blocks) {
    const lines = b.split('\n').filter((l, i, a) => !(isBlank(l) && (i === 0 || i === a.length - 1)));
    while (lines.length && isBlank(lines[0]!)) lines.shift();
    while (lines.length && isBlank(lines[lines.length - 1]!)) lines.pop();
    if (!lines.length) continue;
    const m = /^(\d{4}-\d\d-\d\d)\s+(.*?)(\s+;.*)?$/.exec(lines[0]!);
    if (!m) continue;
    const hasAmounts = lines.slice(1).some((l) => {
      const p = parsePostingLine(l);
      return !!p && /[1-9]/.test(p.amount);
    });
    out.push({ date: m[1]!, description: m[2]!.trim(), text: lines.join('\n'), hasAmounts });
  }
  return out;
}

/** Entries an earlier close of `year` left behind, found among `txns` (dated in the year or on the next year's first day). */
export function priorCloseEntries(found: Txn[], mode: CloseMode, year: number): Txn[] {
  const txns = [...new Map(found.map((t) => [t.index, t])).values()];
  const inYear = (t: Txn) => t.date.startsWith(`${year}-`);
  const hasTag = (t: Txn, name: string) => t.tags.some(([k]) => k === name);
  const desc = (t: Txn) => t.description.trim().toLowerCase();
  if (mode === 'retain') return txns.filter((t) => inYear(t) && (desc(t) === 'retain earnings' || hasTag(t, 'retain')));
  return txns.filter((t) => {
    const opening = desc(t) === 'opening balances';
    if (t.date === `${year + 1}-01-01`) return opening || hasTag(t, 'clopen');
    return inYear(t) && (desc(t) === 'closing balances' || (hasTag(t, 'clopen') && !opening));
  });
}

/** hledger query terms that find earlier close entries around `year` (pass with period `${year}-01-01`..`${year+1}-01-02`). */
export const PRIOR_CLOSE_QUERIES: string[][] = [['desc:^(closing balances|opening balances|retain earnings)$'], ['tag:^(clopen|retain)$']];

// ─── Where the new year's entries go ───

const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '');

/**
 * The new year's file, mirroring the old year's name and layout:
 * `2026.journal` → `2027.journal`, `2026/2026.journal` → `2027/2027.journal`,
 * `books/2026-home.journal` → `books/2027-home.journal`. A file without the
 * year in its path gets `YYYY.journal` next to the root journal.
 */
export function nextYearPath(oldFile: string, year: number, rootFile: string): string {
  if (yearRe(year, false).test(oldFile)) return bumpYear(oldFile, year);
  return `${dirOf(rootFile)}${year + 1}.journal`;
}

/** The year as a whole number inside a path (not part of a longer number). */
const yearRe = (year: number, global: boolean) => new RegExp(`(^|[^0-9])${year}(?=[^0-9]|$)`, global ? 'g' : '');
const bumpYear = (s: string, year: number) => s.replace(yearRe(year, true), (_, pre: string) => `${pre}${year + 1}`);

/** A glob as hledger's `include` reads it: `*` and `?` within one path part, `**` across parts, `[…]` classes. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*' && glob[i + 1] === '*') {
      re += glob[i + 2] === '/' ? '(?:.*/)?' : '.*';
      i += glob[i + 2] === '/' ? 2 : 1;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '[') {
      const end = glob.indexOf(']', i + 1);
      if (end < 0) re += '\\[';
      else {
        re += `[${glob.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`;
        i = end;
      }
    } else re += c.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** Resolve `a/b/../c` and `./x` segments. */
function normalizePath(p: string): string {
  const out: string[] = [];
  for (const part of p.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

export interface IncludeLine {
  /** File holding the directive. */
  file: string;
  /** 1-based line number. */
  line: number;
  /** The path or glob as written. */
  pattern: string;
  /** The pattern resolved against the including file's directory (vault-relative). */
  resolved: string;
}

/** Every `include` directive in the vault's journal files. */
export function includeLines(files: Record<string, string>): IncludeLine[] {
  const out: IncludeLine[] = [];
  for (const [file, text] of Object.entries(files)) {
    if (!/\.(journal|hledger|ledger|j)$/i.test(file)) continue;
    splitLines(text).lines.forEach((l, i) => {
      const m = /^include[ \t]+(.+?)[ \t]*(?:[ \t];.*)?$/.exec(l);
      if (!m) return;
      const pattern = m[1]!.replace(/^[a-z]+:(?!\/)/i, ''); // FORMAT: prefix
      if (pattern.startsWith('/') || pattern.startsWith('~')) return;
      out.push({ file, line: i + 1, pattern: m[1]!, resolved: normalizePath(dirOf(file) + pattern) });
    });
  }
  return out;
}

/** Whether `path` is read by hledger: the root itself, or matched by an include. */
export function isIncluded(files: Record<string, string>, rootFile: string, path: string): boolean {
  if (path === rootFile) return true;
  return includeLines(files).some((inc) => globToRegExp(inc.resolved).test(path));
}

export interface IncludePlan {
  file: string;
  /** Insert the directive before this 1-based line. */
  beforeLine: number;
  text: string;
}

/**
 * The `include` line that makes hledger read `newFile`, or null when an existing
 * include already matches it. It mirrors the include that reads the old year's
 * file (`include 2026/*.journal` → `include 2027/*.journal`) and goes right after
 * it; otherwise `include <path>` goes after the root journal's last include, or
 * at the end of the root journal.
 */
export function planInclude(files: Record<string, string>, rootFile: string, oldFile: string, newFile: string, year: number): IncludePlan | null {
  if (isIncluded(files, rootFile, newFile)) return null;
  const incs = includeLines(files);
  const forOld = incs.find((inc) => globToRegExp(inc.resolved).test(oldFile) && yearRe(year, false).test(inc.pattern));
  if (forOld) {
    const pattern = bumpYear(forOld.pattern, year);
    const resolved = normalizePath(dirOf(forOld.file) + pattern.replace(/^[a-z]+:(?!\/)/i, ''));
    if (globToRegExp(resolved).test(newFile)) return { file: forOld.file, beforeLine: forOld.line + 1, text: `include ${pattern}` };
  }
  const rel = relativePath(dirOf(rootFile), newFile);
  const rootIncs = incs.filter((i) => i.file === rootFile);
  const last = rootIncs[rootIncs.length - 1];
  if (last) return { file: rootFile, beforeLine: last.line + 1, text: `include ${rel}` };
  // No includes yet: at the end of the root journal, after a blank line.
  const lines = splitLines(files[rootFile] ?? '').lines;
  const blankBefore = lines.length === 0 || isBlank(lines[lines.length - 1]!);
  return { file: rootFile, beforeLine: lines.length + 1, text: `${blankBefore ? '' : '\n'}include ${rel}` };
}

function relativePath(fromDir: string, to: string): string {
  const a = fromDir.split('/').filter(Boolean);
  const b = to.split('/');
  let i = 0;
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/');
}

// ─── Planning the text changes ───

/** Append `body` to a file with one blank line before it, keeping the file's final-newline state (like the writer's planAdd). */
export function appendPatch(files: Record<string, string>, file: string, body: string): Patch {
  const text = files[file] ?? '';
  const eol = detectEol(text);
  const l = splitLines(text);
  if (l.lines.length === 0) return { op: 'append', file, text: body + eol };
  const last = l.lines[l.lines.length - 1]!;
  if (l.eols[l.lines.length - 1] !== '') return { op: 'append', file, text: `${isBlank(last) ? '' : eol}${body}${eol}` };
  return { op: 'append', file, text: `${eol}${isBlank(last) ? '' : eol}${body}` };
}

export interface ClosePlacement {
  /** Vault-relative file the entry goes to (created when missing). */
  file: string;
  entry: CloseEntry;
}

export interface ClosePlan {
  files: Record<string, string>;
  /** Files that did not exist before. */
  created: string[];
}

/**
 * Apply the close: each entry is appended to its file verbatim (a missing file
 * is created, with the root journal's line endings), and the include, if any,
 * is inserted. Every other line of every file stays byte-identical.
 */
export function planClose(files: Record<string, string>, rootFile: string, placements: ClosePlacement[], include: IncludePlan | null): ClosePlan {
  const created: string[] = [];
  const rootEol = detectEol(files[rootFile] ?? '');
  // The include first: its line number refers to the files as they are now.
  let next = include ? apply(files, [{ op: 'insert', file: include.file, beforeLine: include.beforeLine, text: include.text }]) : { ...files };
  for (const { file, entry } of placements) {
    if (next[file] === undefined) {
      created.push(file);
      next = { ...next, [file]: entry.text.replace(/\n/g, rootEol) + rootEol };
    } else next = apply(next, [appendPatch(next, file, entry.text)]);
  }
  return { files: next, created };
}
