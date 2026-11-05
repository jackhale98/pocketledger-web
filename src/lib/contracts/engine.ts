// Lead-owned contract. Changes require lead review (BUILD_PLAN §6.1, §15.3).
//
// The UI talks to hledger only through `Engine`. It is implemented in the
// engine worker (src/worker/engine.worker.ts) and proxied over postMessage by
// src/lib/engine/client.ts. Every report is produced by real hledger
// (`-O json` where hledger offers it) and decoded by src/lib/engine/decode/.

import type { Amount, AmountStyle, MixedAmount } from './amount';
export type { Amount, AmountStyle, MixedAmount };

export interface VaultSnapshot {
  /** e.g. "main.journal", relative to the vault root. */
  rootFile: string;
  /** path (relative, '/'-separated) -> UTF-8 text (journals, rules, csv, prices). */
  files: Record<string, string>;
  /** Content hash; the engine caches by this. Use `snapshotRevision()` from src/lib/vault. */
  revision: string;
}

export interface EngineError {
  kind: 'parse' | 'balance' | 'assertion' | 'check' | 'internal';
  /** hledger's own message, verbatim (the "hledger: Error: " prefix is stripped). */
  message: string;
  /** Vault-relative path. */
  file?: string;
  line?: number;
  column?: number;
}

export type Interval = 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'yearly';

/** begin inclusive, end exclusive; YYYY-MM-DD or any hledger period expression part. */
export type Period = { begin?: string; end?: string; interval?: Interval };

export interface QueryOpts {
  /** hledger query terms, e.g. ["expenses", "date:2026"]. Each element is one argv word. */
  query?: string[];
  period?: Period;
  /** Commodity for -X (convert to). */
  valueIn?: string;
  depth?: number;
  /** Status filters; when several are set they are OR'd, as in hledger (-C/-P/-U). */
  cleared?: boolean;
  pending?: boolean;
  unmarked?: boolean;
  /** Include --forecast transactions from periodic rules. `true` = hledger's default horizon; a string is a period expression, e.g. "2026-11-04..2027-05-01". */
  forecast?: boolean | string;
  /** Apply auto postings (--auto). */
  auto?: boolean;
  /** Use secondary dates (--date2). */
  date2?: boolean;
  /** Show accounts with zero balances too (-E). */
  empty?: boolean;
  /** Balance accumulation for multi-period reports. */
  accumulation?: 'change' | 'cumulative' | 'historical';
}

export type Status = '' | '!' | '*';

export interface SourceSpan {
  /** Vault-relative path. */
  file: string;
  /** 1-based, inclusive: the line holding the transaction's date. */
  startLine: number;
  /** 1-based, inclusive: the last line belonging to the transaction (last posting or its comment). */
  endLine: number;
}

export interface BalanceAssertion {
  amount: Amount;
  /** `=` (false) or `==` (true). */
  total: boolean;
  /** `=*`/`==*`: inclusive of subaccounts. */
  inclusive: boolean;
}

export interface Posting {
  account: string;
  /** Always filled in by hledger, even when omitted in the file (see `inferred`). */
  amount: MixedAmount;
  /** True if the amount was not written in the file (hledger inferred it). */
  inferred: boolean;
  status: Status;
  comment: string;
  tags: [string, string][];
  type: 'regular' | 'virtual' | 'balanced-virtual';
  date?: string | null;
  date2?: string | null;
  assertion?: BalanceAssertion | null;
  /** True for postings added by auto posting rules (`=`). */
  generated?: boolean;
}

export interface Txn {
  /** hledger's tindex: 1-based position in parse order. */
  index: number;
  date: string;
  date2?: string | null;
  status: Status;
  code: string;
  description: string;
  comment: string;
  tags: [string, string][];
  postings: Posting[];
  /** Where the transaction's text lives. Absent for forecast/generated transactions. */
  source?: SourceSpan;
  /** True for forecast (periodic) transactions that are not in any file. */
  generated?: boolean;
}

export interface RegisterRow {
  date: string;
  date2?: string | null;
  description: string;
  posting: Posting;
  /** Running total after this posting. */
  balance: MixedAmount;
  /** tindex of the owning transaction (0 for generated). */
  txnIndex: number;
}

export interface BalanceRow {
  /** Full account name. */
  account: string;
  /** Name as displayed in tree mode (may elide boring parents). */
  displayName: string;
  /** Indentation level in tree mode (0 = top). */
  indent: number;
  amount: MixedAmount;
}

export interface BalanceReport {
  rows: BalanceRow[];
  total: MixedAmount;
}

/** Date span of one column: begin inclusive, end exclusive. */
export interface ReportColumn {
  begin: string;
  end: string;
}

export interface PeriodicRow {
  account: string;
  /** Depth in the account tree (1 = top-level). */
  depth: number;
  /** One cell per column. */
  amounts: MixedAmount[];
  total: MixedAmount;
  average: MixedAmount;
}

/** A multi-period balance report (`balance -M` etc.), or a single column. */
export interface PeriodicReport {
  columns: ReportColumn[];
  rows: PeriodicRow[];
  totals: { amounts: MixedAmount[]; total: MixedAmount; average: MixedAmount };
}

export interface StatementSection {
  /** e.g. "Assets", "Liabilities", "Revenues", "Expenses". */
  title: string;
  /** hledger's flag: this section is added to (true) or subtracted from (false) the net total.
   *  bs: Assets true, Liabilities false. is: Revenues true, Expenses false. Amounts are shown in normal sign. */
  increasesTotal: boolean;
  report: PeriodicReport;
}

/** bs / is / cf */
export interface StatementReport {
  title: string;
  columns: ReportColumn[];
  sections: StatementSection[];
  /** Net: the grand total row. */
  totals: { amounts: MixedAmount[]; total: MixedAmount; average: MixedAmount };
}

export interface BudgetCell {
  actual: MixedAmount;
  /** null when the account has no budget goal in this period. */
  budget: MixedAmount | null;
}

export interface BudgetRow {
  /** Account name, or "<unbudgeted>" for hledger's catch-all. */
  account: string;
  depth: number;
  cells: BudgetCell[];
  total: BudgetCell;
  average: BudgetCell;
}

export interface BudgetReport {
  columns: ReportColumn[];
  rows: BudgetRow[];
  totals: { cells: BudgetCell[]; total: BudgetCell; average: BudgetCell };
}

/** hledger account types: Asset, Liability, Equity, Revenue, Expense, Cash, Conversion. */
export type AccountType = 'A' | 'L' | 'E' | 'R' | 'X' | 'C' | 'V';

export interface AccountInfo {
  name: string;
  type: AccountType | null;
  declared: boolean;
  used: boolean;
}

export interface CommodityInfo {
  symbol: string;
  declared: boolean;
  /** Display style hledger infers or that the `commodity` directive declares. */
  style?: AmountStyle;
}

export interface JournalStats {
  transactions: number;
  accounts: number;
  commodities: number;
  firstDate: string | null;
  lastDate: string | null;
  files: string[];
}

export interface CsvPreview {
  txns: Txn[];
  errors: EngineError[];
}

export interface EngineVersion {
  hledger: string;
  engine: 'hledger-wasm' | 'rust-fallback';
  /** Which invocation strategy: 'cli' (Option A) or 'reactor' (Option B). */
  mode?: 'cli' | 'reactor';
  sha256?: string;
}

/** Raw output of a read-only hledger command (console, §9.2). */
export interface RawResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type LoadResult = { ok: true; stats: JournalStats } | { ok: false; errors: EngineError[] };

export interface Engine {
  /** Mount a snapshot and parse it. Subsequent report calls use the last successfully loaded snapshot. */
  load(snapshot: VaultSnapshot): Promise<LoadResult>;
  /** Parse and run `hledger check` on a snapshot WITHOUT replacing the loaded one. Empty array = valid. */
  check(snapshot: VaultSnapshot, checks?: string[]): Promise<EngineError[]>;
  transactions(opts?: QueryOpts): Promise<Txn[]>;
  register(account: string, opts?: QueryOpts): Promise<RegisterRow[]>;
  balance(opts?: QueryOpts & { tree?: boolean }): Promise<BalanceReport>;
  /** Multi-period balance (`bal -M` etc.) — needs `period.interval`. */
  periodicBalance(opts: QueryOpts & { tree?: boolean }): Promise<PeriodicReport>;
  balanceSheet(opts?: QueryOpts): Promise<StatementReport>;
  incomeStatement(opts?: QueryOpts): Promise<StatementReport>;
  cashFlow(opts?: QueryOpts): Promise<StatementReport>;
  budget(opts?: QueryOpts): Promise<BudgetReport>;
  accounts(): Promise<AccountInfo[]>;
  commodities(): Promise<CommodityInfo[]>;
  payees(): Promise<string[]>;
  /** Paths are vault-relative and must exist in the loaded snapshot (or `extraFiles`). */
  csvPreview(csvPath: string, rulesPath: string, extraFiles?: Record<string, string>): Promise<CsvPreview>;
  /** Read-only escape hatch: run an arbitrary hledger command against the loaded vault. Write commands are refused. */
  raw(args: string[]): Promise<RawResult>;
  version(): Promise<EngineVersion>;
}
