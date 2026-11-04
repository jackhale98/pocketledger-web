// Parse a transaction's source lines into raw pieces (so unchanged parts can
// be written back byte-for-byte) and into a TxnDraft for the edit form.
// This is a writer-side reading of the text only; hledger stays the parser of
// record for meaning (balances, inferred amounts, tags).

import type { Status, Txn, VaultSnapshot } from '../../contracts/engine';
import { StalePatchError, type PostingDraft, type TxnDraft } from '../../contracts/writer';
import { isIndentedComment, normalizeSpan, splitLines } from '../locate';
import { parseAmount, visualWidth } from './amount';

export type PostingType = NonNullable<PostingDraft['type']>;

export interface HeaderLine {
  raw: string;
  /** Date tokens exactly as written. */
  date: string;
  date2: string | null;
  status: Status;
  code: string | null;
  description: string;
  /** Inline comment text after `;`, trimmed; null when there is no `;`. */
  comment: string | null;
  /** Everything after the description: whitespace and the `; comment`, verbatim. */
  tail: string;
}

export interface PostingLine {
  raw: string;
  indent: string;
  status: Status;
  /** Account name without `()`/`[]`. */
  account: string;
  type: PostingType;
  /** Whitespace between account and amount, verbatim ('' when there is no amount/cost). */
  gap: string;
  /** Amount text as written (no cost/assertion), '' when elided. */
  amount: string;
  /** Lot and cost text as written (`{…}`, `@ …`, `@@ …`), ''. */
  cost: string;
  /** Balance assertion/assignment as written (`= $5`, `==* 0`), ''. */
  assertion: string;
  /** Everything after the amount section: whitespace and `; comment`, verbatim. */
  tail: string;
  comment: string | null;
  /** Visual column where amount+cost ends (hledger aligns these), null with no amount. */
  amountEnd: number | null;
}

export interface ParsedPosting {
  line: PostingLine;
  /** Raw indented `;` lines that follow the posting. */
  commentLines: string[];
}

export interface ParsedTxn {
  header: HeaderLine;
  /** Raw indented `;` lines between the header and the first posting. */
  headerComments: string[];
  postings: ParsedPosting[];
}

const HEADER_DATE_RE = /^(\d{1,4}[-/.]\d{1,2}(?:[-/.]\d{1,2})?)(?:=(\d{1,4}[-/.]\d{1,2}(?:[-/.]\d{1,2})?))?/;

/** Index of the first of `chars` outside double quotes (and outside `{…}` when `braces`). */
function indexOfTopLevel(s: string, chars: string, braces: boolean): number {
  let quoted = false;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === '"') quoted = !quoted;
    else if (!quoted) {
      if (depth === 0 && chars.includes(c)) return i;
      if (braces && c === '{') depth++;
      else if (braces && c === '}' && depth > 0) depth--;
    }
  }
  return -1;
}

export function parseHeaderLine(raw: string): HeaderLine | null {
  const m = HEADER_DATE_RE.exec(raw);
  if (!m) return null;
  const rest = raw.slice(m[0].length);
  const sc = rest.indexOf(';');
  const main = sc < 0 ? rest : rest.slice(0, sc);
  const mainTrim = main.trimEnd();
  const tail = rest.slice(mainTrim.length);
  let s = mainTrim.trimStart();
  let status: Status = '';
  if (s.startsWith('*') || s.startsWith('!')) {
    status = s[0] as Status;
    s = s.slice(1).trimStart();
  }
  let code: string | null = null;
  if (s.startsWith('(')) {
    const close = s.indexOf(')');
    if (close > 0) {
      code = s.slice(1, close);
      s = s.slice(close + 1).trimStart();
    }
  }
  return {
    raw,
    date: m[1]!,
    date2: m[2] ?? null,
    status,
    code,
    description: s,
    comment: sc < 0 ? null : rest.slice(sc + 1).trim(),
    tail,
  };
}

const isSpace = (c: string | undefined): boolean => c === ' ' || c === '\t';

/** Parse a posting line. The account ends at two or more spaces/tabs (any mix), as in hledger; a single tab does not end it. */
export function parsePostingLine(raw: string): PostingLine | null {
  const im = /^[ \t]+/.exec(raw);
  if (!im || im[0].length === raw.length) return null;
  const indent = im[0];
  let p = indent.length;
  let status: Status = '';
  if (raw[p] === '*' || raw[p] === '!') {
    status = raw[p] as Status;
    p++;
    while (raw[p] === ' ' || raw[p] === '\t') p++;
  }
  const accStart = p;
  let accEnd = raw.length;
  for (let i = p; i < raw.length; i++) {
    if (isSpace(raw[i]) && isSpace(raw[i + 1])) {
      accEnd = i;
      break;
    }
  }
  accEnd = accStart + raw.slice(accStart, accEnd).trimEnd().length;
  let account = raw.slice(accStart, accEnd);
  let type: PostingType = 'regular';
  if (account.length >= 2 && account.startsWith('(') && account.endsWith(')')) {
    type = 'virtual';
    account = account.slice(1, -1);
  } else if (account.length >= 2 && account.startsWith('[') && account.endsWith(']')) {
    type = 'balanced-virtual';
    account = account.slice(1, -1);
  }
  const afterAcc = raw.slice(accEnd);
  const gapLen = /^[ \t]*/.exec(afterAcc)![0].length;
  const bodyStart = accEnd + gapLen;
  const body = raw.slice(bodyStart);
  const sc = indexOfTopLevel(body, ';', false);
  const section = (sc < 0 ? body : body.slice(0, sc)).trimEnd();
  const comment = sc < 0 ? null : body.slice(sc + 1).trim();
  if (section === '') {
    return { raw, indent, status, account, type, gap: '', amount: '', cost: '', assertion: '', tail: afterAcc, comment, amountEnd: null };
  }
  const ai = indexOfTopLevel(section, '=', true);
  const amountCost = ai < 0 ? section : section.slice(0, ai).trimEnd();
  const assertion = ai < 0 ? '' : section.slice(ai);
  const ci = indexOfTopLevel(amountCost, '@{', false);
  const amount = ci < 0 ? amountCost : amountCost.slice(0, ci).trimEnd();
  const cost = ci < 0 ? '' : amountCost.slice(ci);
  return {
    raw,
    indent,
    status,
    account,
    type,
    gap: raw.slice(accEnd, bodyStart),
    amount,
    cost,
    assertion,
    tail: raw.slice(bodyStart + section.length),
    comment,
    amountEnd: amountCost ? visualWidth(raw.slice(0, bodyStart + amountCost.length)) : null,
  };
}

/** Text of an indented `;` comment line. */
export function commentLineText(raw: string): string {
  return raw.trimStart().slice(1).trim();
}

/** Parse a transaction's lines (header first). Returns null when line 1 is not a header. */
export function parseTxnLines(lines: readonly string[]): ParsedTxn | null {
  const header = lines[0] === undefined ? null : parseHeaderLine(lines[0]);
  if (!header) return null;
  const headerComments: string[] = [];
  const postings: ParsedPosting[] = [];
  for (const raw of lines.slice(1)) {
    if (isIndentedComment(raw)) {
      const last = postings[postings.length - 1];
      (last ? last.commentLines : headerComments).push(raw);
      continue;
    }
    const line = parsePostingLine(raw);
    if (line) postings.push({ line, commentLines: [] });
  }
  return { header, headerComments, postings };
}

/** "2024/1/5" -> "2024-01-05"; anything without a 4-digit year is kept as written. */
export function normalizeDate(raw: string): string {
  const m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(raw);
  return m ? `${m[1]}-${m[2]!.padStart(2, '0')}-${m[3]!.padStart(2, '0')}` : raw;
}

function joinComment(inline: string | null, rest: string[]): string | undefined {
  if (inline === null && rest.length === 0) return undefined;
  return [inline ?? '', ...rest].join('\n');
}

export function postingDraftFromLine(p: ParsedPosting): PostingDraft {
  const l = p.line;
  const d: PostingDraft = { account: l.account };
  if (l.type !== 'regular') d.type = l.type;
  if (l.status) d.status = l.status;
  if (l.amount) {
    const a = parseAmount(l.amount);
    if (a) {
      d.amount = `${a.sign}${a.number}`;
      d.commodity = a.commodity;
    } else {
      d.amount = l.amount;
      d.commodity = '';
    }
  }
  if (l.cost) d.cost = l.cost;
  if (l.assertion) d.assertion = l.assertion;
  const comment = joinComment(l.comment, p.commentLines.map(commentLineText));
  if (comment !== undefined) d.comment = comment;
  return d;
}

export function draftFromParsed(t: ParsedTxn): TxnDraft {
  const h = t.header;
  const d: TxnDraft = { date: normalizeDate(h.date), description: h.description, postings: t.postings.map(postingDraftFromLine) };
  if (h.date2 !== null) d.date2 = normalizeDate(h.date2);
  if (h.status) d.status = h.status;
  if (h.code !== null && h.code !== '') d.code = h.code;
  const comment = joinComment(h.comment, t.headerComments.map(commentLineText));
  if (comment !== undefined) d.comment = comment;
  return d;
}

/** Build a draft from a transaction's own text (header line first). */
export function draftFromText(text: string): TxnDraft {
  const lines = splitLines(text).lines;
  const parsed = parseTxnLines(lines);
  if (!parsed) throw new Error('Not a transaction: the first line must start with a date');
  return draftFromParsed(parsed);
}

/**
 * Build the edit form's draft from the transaction's source text. `text` is
 * the text of the file holding it (or the whole snapshot). Costs, lots and
 * assertions come back as the raw strings written in the file; the date is
 * normalised to YYYY-MM-DD when it has a year.
 */
export function draftFromTxn(txn: Txn, text: string | VaultSnapshot): TxnDraft {
  const src = txn.source;
  if (!src) throw new Error('This transaction is not in any file (generated)');
  const fileText = typeof text === 'string' ? text : text.files[src.file];
  if (fileText === undefined) throw new StalePatchError(src.file, src.startLine);
  const l = splitLines(fileText);
  const span = normalizeSpan(l, src);
  if (!span) throw new StalePatchError(src.file, src.startLine);
  const parsed = parseTxnLines(l.lines.slice(span.startLine - 1, span.endLine))!;
  return draftFromParsed(parsed);
}
