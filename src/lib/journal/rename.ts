// Rename an account (and its subaccounts) everywhere in a vault's text.
//
// Pure and minimal: only the account-name portion of an affected line changes.
// Descriptions, comments, amounts and every other line stay byte-identical, and
// so do line endings and a BOM (lines are split losslessly). When the name
// changes length, the whitespace before the amount (or before a trailing
// comment) is re-padded so the amount keeps its end column; when there is no
// room, two spaces are kept. Whitespace containing tabs is left as it was.
//
// What is renamed:
// - posting lines of transactions, periodic `~` rules (budgets, forecasts) and
//   auto-posting `=` rules, including `(virtual)` / `[balanced]` postings and
//   postings with balance assertions;
// - `account` directives;
// - the account terms of an auto-posting rule's query (`= expenses:food`,
//   `= acct:^expenses:food$`, quoted terms), when a term names the account
//   exactly (a bare word is a substring regex in hledger; only whole names match);
// - `alias OLD = NEW` targets naming the account (not regex aliases);
// - `apply account` prefixes naming the account;
// - `account1`…`accountN` / `account` assignments in CSV `.rules` files.
//
// `assets:cash2` is never renamed when renaming `assets:cash` (only the name
// itself or names below it, `assets:cash:…`, match).

import { isBlank, isIndentedComment, isTopLevelComment, isTxnHeader, joinLines, splitLines } from './locate';
import { parsePostingLine, visualWidth } from './writer';

export interface RenameChange {
  file: string;
  /** 1-based line number (same before and after: renames never add or remove lines). */
  line: number;
  before: string;
  after: string;
}

export interface RenamePlan {
  /** All files, with the renamed ones changed. Unchanged files are the same strings. */
  files: Record<string, string>;
  changes: RenameChange[];
}

const JOURNAL_RE = /\.(journal|hledger|ledger|j|prices)$/i;
const RULES_RE = /\.rules$/i;

/** Problems with a new account name, as a user-facing message; null when it can be written. */
export function accountNameProblem(name: string): string | null {
  if (!name.trim()) return 'The account name is empty';
  if (name !== name.trim()) return 'The account name must not start or end with spaces';
  if (/[\r\n\t]/.test(name) || / {2}/.test(name)) return 'The account name must not contain tabs, double spaces or line breaks';
  if (name.includes(';')) return "The account name must not contain ';'";
  if (/^[([*!]/.test(name) || /[)\]]$/.test(name)) return 'The account name must not start with ( [ * ! or end with ) ]';
  if (name.startsWith(':') || name.endsWith(':') || name.includes('::')) return 'The account name has an empty part';
  return null;
}

/** `name` renamed from `from` to `to`, or null when it is neither `from` nor below it. */
export function renamedAccount(name: string, from: string, to: string): string | null {
  if (name === from) return to;
  if (name.startsWith(from + ':')) return to + name.slice(from.length);
  return null;
}

/**
 * The whitespace between a renamed name and what follows it, re-padded so the
 * following text keeps its column: `ws` shrinks or grows by the change in width,
 * keeping at least two spaces. Tabs, or nothing following, keep `ws` as is.
 */
function repad(ws: string, delta: number, followed: boolean): string {
  if (!followed || ws.includes('\t') || delta === 0) return ws;
  return ' '.repeat(Math.max(2, ws.length - delta));
}

/** Replace `old` (at `start` in `raw`) with `neu`, re-padding the whitespace after it. */
function splice(raw: string, start: number, old: string, neu: string): string {
  const rest = raw.slice(start + old.length);
  const ws = /^[ \t]*/.exec(rest)![0];
  const after = rest.slice(ws.length);
  const delta = visualWidth(raw.slice(0, start) + neu) - visualWidth(raw.slice(0, start) + old);
  return raw.slice(0, start) + neu + repad(ws, delta, after !== '') + after;
}

function renamePosting(raw: string, from: string, to: string): string | null {
  const p = parsePostingLine(raw);
  if (!p) return null;
  const renamed = renamedAccount(p.account, from, to);
  if (renamed === null) return null;
  let start = p.indent.length;
  if (p.status) {
    start++;
    while (raw[start] === ' ' || raw[start] === '\t') start++;
  }
  const wrap = (a: string) => (p.type === 'virtual' ? `(${a})` : p.type === 'balanced-virtual' ? `[${a}]` : a);
  const old = wrap(p.account);
  if (!raw.startsWith(old, start)) return null;
  return splice(raw, start, old, wrap(renamed));
}

/** A name that runs to two consecutive whitespace characters or the end of the line, as hledger reads directive account names. */
function nameAt(raw: string, start: number): string {
  let end = raw.length;
  for (let i = start; i < raw.length - 1; i++) {
    if (/[ \t]/.test(raw[i]!) && /[ \t]/.test(raw[i + 1]!)) {
      end = i;
      break;
    }
  }
  return raw.slice(start, end).trimEnd();
}

function renameAccountDirective(raw: string, from: string, to: string): string | null {
  const m = /^account[ \t]+/.exec(raw);
  if (!m) return null;
  const name = nameAt(raw, m[0].length);
  const renamed = renamedAccount(name, from, to);
  return renamed === null ? null : splice(raw, m[0].length, name, renamed);
}

function renameApplyAccount(raw: string, from: string, to: string): string | null {
  const m = /^apply[ \t]+account[ \t]+/.exec(raw);
  if (!m) return null;
  const name = nameAt(raw, m[0].length);
  const renamed = renamedAccount(name, from, to);
  return renamed === null ? null : splice(raw, m[0].length, name, renamed);
}

/** `alias OLD = NEW`: rename NEW when it names the account. Regex aliases (`alias /re/ = …`) are left alone. */
function renameAlias(raw: string, from: string, to: string): string | null {
  const m = /^(alias[ \t]+)([^=]*)=([ \t]*)/.exec(raw);
  if (!m || m[2]!.trim().startsWith('/')) return null;
  const start = m[0].length;
  const target = nameAt(raw, start);
  const renamed = renamedAccount(target, from, to);
  return renamed === null ? null : raw.slice(0, start) + renamed + raw.slice(start + target.length);
}

const QUERY_PREFIXES = /^(not:)?(desc|payee|note|amt|date|date2|tag|status|cur|code|real|depth|expr|type|inacct|inacctonly):/i;

/** Rename account terms in an auto-posting rule's query (`= QUERY`), keeping everything else. */
function renameAutoRuleHeader(raw: string, from: string, to: string): string | null {
  if (!raw.startsWith('=')) return null;
  let out = '';
  let changed = false;
  let i = 0;
  while (i < raw.length) {
    const c = raw[i]!;
    if (c === ' ' || c === '\t' || (i === 0 && c === '=')) {
      out += c;
      i++;
      continue;
    }
    if (c === ';') {
      out += raw.slice(i); // a trailing comment
      break;
    }
    // One query term: up to unquoted whitespace.
    let j = i;
    let quote: string | null = null;
    while (j < raw.length && (quote || (raw[j] !== ' ' && raw[j] !== '\t'))) {
      if (quote && raw[j] === quote) quote = null;
      else if (!quote && (raw[j] === '"' || raw[j] === "'")) quote = raw[j]!;
      j++;
    }
    const term = raw.slice(i, j);
    const next = renameQueryTerm(term, from, to);
    if (next !== null) changed = true;
    out += next ?? term;
    i = j;
  }
  return changed ? out : null;
}

function renameQueryTerm(term: string, from: string, to: string): string | null {
  // Quotes can wrap the whole term ("acct:a b") or just the value (acct:"a b").
  let q = '';
  let body = term;
  if (body.length >= 2 && (body[0] === '"' || body[0] === "'") && body.endsWith(body[0]!)) {
    q = body[0]!;
    body = body.slice(1, -1);
  }
  if (QUERY_PREFIXES.test(body)) return null;
  const prefix = /^(not:)?(acct:)?/i.exec(body)![0];
  let value = body.slice(prefix.length);
  let vq = '';
  if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.endsWith(value[0]!)) {
    vq = value[0]!;
    value = value.slice(1, -1);
  }
  const caret = value.startsWith('^') ? '^' : '';
  const dollar = value.length > caret.length && value.endsWith('$') ? '$' : '';
  const renamed = renamedAccount(value.slice(caret.length, value.length - dollar.length), from, to);
  if (renamed === null) return null;
  const v = `${caret}${renamed}${dollar}`;
  // A name with spaces must be quoted to stay one term.
  if (!q && !vq && /\s/.test(renamed)) return `"${prefix}${v}"`;
  return `${q}${prefix}${vq}${v}${vq}${q}`;
}

/** `account1 NAME` / `account NAME` in CSV rules (top level or inside `if` blocks). */
function renameRulesLine(raw: string, from: string, to: string): string | null {
  const m = /^([ \t]*account\d*[ \t]+)(.*?)([ \t]*)$/.exec(raw);
  if (!m) return null;
  const renamed = renamedAccount(m[2]!, from, to);
  return renamed === null ? null : m[1] + renamed + m[3];
}

type Ctx = 'none' | 'postings' | 'other';

function renameJournalLines(lines: string[], from: string, to: string, onChange: (i: number, after: string) => void): void {
  let ctx: Ctx = 'none';
  let inBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    if (inBlock) {
      if (/^end\s+comment\s*$/.test(raw)) inBlock = false;
      continue;
    }
    if (/^comment\s*$/.test(raw)) {
      inBlock = true;
      ctx = 'none';
      continue;
    }
    if (isBlank(raw)) {
      ctx = 'none';
      continue;
    }
    if (/^[ \t]/.test(raw)) {
      if (ctx === 'postings' && !isIndentedComment(raw)) {
        const r = renamePosting(raw, from, to);
        if (r !== null && r !== raw) onChange(i, r);
      }
      continue;
    }
    // A column-0 line starts a new item.
    let r: string | null = null;
    if (isTopLevelComment(raw)) ctx = 'none';
    else if (isTxnHeader(raw) || raw.startsWith('~')) ctx = 'postings';
    else if (raw.startsWith('=')) {
      ctx = 'postings';
      r = renameAutoRuleHeader(raw, from, to);
    } else {
      ctx = 'other';
      r = renameAccountDirective(raw, from, to) ?? renameAlias(raw, from, to) ?? renameApplyAccount(raw, from, to);
    }
    if (r !== null && r !== raw) onChange(i, r);
  }
}

/**
 * Rename account `from` and all its subaccounts to `to` in every journal and
 * CSV rules file. Returns the new file map (files without changes are returned
 * untouched) and the list of changed lines. Throws when `to` is not a valid
 * account name.
 */
export function planRenameAccount(files: Record<string, string>, from: string, to: string): RenamePlan {
  const problem = accountNameProblem(to);
  if (problem) throw new Error(problem);
  if (!from.trim()) throw new Error('Choose an account to rename');
  const out: Record<string, string> = { ...files };
  const changes: RenameChange[] = [];
  if (from === to) return { files: out, changes };
  for (const file of Object.keys(files).sort()) {
    const journal = JOURNAL_RE.test(file);
    const rules = RULES_RE.test(file);
    if (!journal && !rules) continue;
    const l = splitLines(files[file]!);
    const fileChanges: RenameChange[] = [];
    const onChange = (i: number, after: string) => {
      fileChanges.push({ file, line: i + 1, before: l.lines[i]!, after });
      l.lines[i] = after;
    };
    if (journal) renameJournalLines(l.lines, from, to, onChange);
    else
      l.lines.forEach((raw, i) => {
        const r = renameRulesLine(raw, from, to);
        if (r !== null && r !== raw) onChange(i, r);
      });
    if (fileChanges.length) {
      out[file] = joinLines(l);
      changes.push(...fileChanges);
    }
  }
  return { files: out, changes };
}
