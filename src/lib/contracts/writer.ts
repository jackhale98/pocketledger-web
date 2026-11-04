// Lead-owned contract. Changes require lead review (BUILD_PLAN §6.2, §7, §15.3).
//
// The writer is the ONLY code that mutates journal text. Every edit is a
// minimal line-span patch against the original text; everything outside the
// span is byte-identical (comments, alignment, line endings, BOM, unknown syntax).

import type { Status, Txn, VaultSnapshot } from './engine';

export interface PostingDraft {
  account: string;
  /** Number as typed, e.g. "-12.50" or "1,234.50" (decimal mark per style). Empty/undefined = let hledger infer. */
  amount?: string;
  /** Commodity symbol, e.g. "$", "EUR". `undefined` = the style's default commodity; `''` = explicitly no commodity. */
  commodity?: string;
  /** Lot and cost text as written after the amount, e.g. "@ $1.10", "@@ 110 EUR", "{$50} [2024-01-01] @ $55". */
  cost?: string;
  /** Balance assertion as written, e.g. "= $500" or "== 0". */
  assertion?: string;
  comment?: string;
  status?: Status;
  /** `(acct)` virtual or `[acct]` balanced-virtual. Default regular. */
  type?: 'regular' | 'virtual' | 'balanced-virtual';
}

export interface TxnDraft {
  date: string;
  date2?: string;
  status?: Status;
  code?: string;
  description: string;
  /** Same-line comment after the description (without the leading `;`). Multi-line comments use '\n'. */
  comment?: string;
  postings: PostingDraft[];
}

export type Patch =
  /** `text` is appended verbatim (EOLs normalised to the file's), including its own separating blank line. */
  | { op: 'append'; file: string; text: string }
  /** `text` has no trailing EOL; `apply` adds the file's EOL. */
  | { op: 'insert'; file: string; beforeLine: number; text: string }
  /** startLine/endLine are 1-based and inclusive; `expected` is the exact current text of those lines (joined with the file's EOL, no trailing EOL). */
  | { op: 'replace'; file: string; startLine: number; endLine: number; expected: string; text: string }
  | { op: 'delete'; file: string; startLine: number; endLine: number; expected: string };

export interface JournalStyle {
  /** Posting indent, e.g. "    " or "\t". */
  indent: string;
  /** Column (0-based) at which amounts should end (right-aligned) — hledger's own convention; null = two spaces after the account. */
  amountColumn: number | null;
  /** Commodity placement and spacing for new amounts without an existing style. */
  commoditySide: 'L' | 'R';
  commoditySpaced: boolean;
  decimalMark: '.' | ',';
  thousandsSeparator: string | null;
  /** '-' or '/' or '.' */
  dateSeparator: '-' | '/' | '.';
  eol: '\n' | '\r\n';
  bom: boolean;
  /** Whether the file ends with an EOL. */
  finalNewline: boolean;
  /** Default commodity from a `D` directive or the most common commodity. */
  defaultCommodity: string | null;
  /** Per-commodity display styles inferred from the file (side, spacing, marks, usual precision). */
  commodities?: Record<string, { side: 'L' | 'R'; spaced: boolean; decimalMark: '.' | ','; groupMark: string | null; precision: number | null }>;
}

/** Thrown by `apply` when a patch's `expected` text no longer matches: reload and re-plan. */
export class StalePatchError extends Error {
  constructor(
    readonly file: string,
    readonly startLine: number,
  ) {
    super(`${file} changed at line ${startLine}; reload and try again`);
    this.name = 'StalePatchError';
  }
}

export interface Writer {
  /** Render a draft (no trailing EOL) in the given style. */
  formatTxn(draft: TxnDraft, style: JournalStyle): string;
  /** Add a transaction: appended to `targetFile` (default: snapshot.rootFile), or in date order if `dateOrder`. */
  planAdd(snapshot: VaultSnapshot, draft: TxnDraft, opts?: { targetFile?: string; dateOrder?: boolean; txns?: Txn[] }): Patch[];
  /** Returns `[]` when the draft equals the transaction (no-op edits never touch the file). */
  planEdit(snapshot: VaultSnapshot, txn: Txn, draft: TxnDraft): Patch[];
  /** Replace a transaction's text verbatim (source view editing). */
  planReplaceText(snapshot: VaultSnapshot, txn: Txn, text: string): Patch[];
  planDelete(snapshot: VaultSnapshot, txn: Txn): Patch[];
  /** Pure: returns new file map. Throws StalePatchError if `expected` mismatches. */
  apply(files: Record<string, string>, patches: Patch[]): Record<string, string>;
  inferStyle(text: string): JournalStyle;
}
