// The Engine contract implemented on top of an EngineBackend (real hledger).
// Runs inside the engine worker; also used directly in Node tests.

import type {
  AccountInfo,
  BalanceReport,
  BudgetReport,
  CommodityInfo,
  CsvPreview,
  Engine,
  EngineError,
  EngineVersion,
  LoadResult,
  PeriodicReport,
  QueryOpts,
  RawResult,
  RegisterRow,
  StatementReport,
  Txn,
  VaultSnapshot,
} from '../contracts/engine';
import type { AmountStyle } from '../contracts/amount';
import { queryArgs, isReadOnlyCommand } from './args';
import { VAULT_ROOT, type EngineBackend } from './backend';
import { parseHledgerJson } from './decode/json';
import { decodeErrors } from './decode/errors';
import { decodeRegister, decodeTxn, markInferred, type HRegisterRow, type HTxn } from './decode/txn';
import {
  decodeBalance,
  decodeBudget,
  decodePeriodic,
  decodeStatement,
  type HBalanceReport,
  type HCompoundReport,
  type HPeriodicReport,
} from './decode/reports';
import { decodeAccountTypes, decodeLines, decodeStats } from './decode/text';

export class EngineFailure extends Error {
  constructor(readonly errors: EngineError[]) {
    super(errors.map((e) => e.message).join('\n'));
    this.name = 'EngineFailure';
  }
}

const toVault = (abs: string): string | null => {
  const prefix = VAULT_ROOT + '/';
  return abs.startsWith(prefix) ? abs.slice(prefix.length) : null;
};

/** Regex-escape an account name for an `acct:` query that matches it and its subaccounts. */
export const accountQuery = (name: string) => `acct:^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(:|$)`;

export interface HledgerEngineOptions {
  version?: Partial<EngineVersion>;
  /** Called for every hledger invocation (timings for perf reporting). */
  onRun?: (args: string[], ms: number, code: number) => void;
}

export class HledgerEngine implements Engine {
  private snapshot: VaultSnapshot | null = null;
  private lines = new Map<string, string[]>();
  private cache = new Map<string, Promise<RawResult>>();
  /** Display styles seen in decoded amounts, per commodity. */
  private styles = new Map<string, AmountStyle>();

  constructor(
    private readonly backend: EngineBackend,
    private readonly opts: HledgerEngineOptions = {},
  ) {}

  private rootArgs(snapshot = this.snapshot): string[] {
    if (!snapshot) throw new EngineFailure([{ kind: 'internal', message: 'No journal loaded' }]);
    // --no-conf: a hledger.conf could change report shapes the decoders rely on.
    return ['-f', `${VAULT_ROOT}/${snapshot.rootFile}`, '--no-conf', ...(snapshot.flags ?? [])];
  }

  private async exec(args: string[], useCache = true): Promise<RawResult> {
    const key = `${this.snapshot?.revision ?? ''}\u0000${args.join('\u0001')}`;
    if (useCache) {
      const hit = this.cache.get(key);
      if (hit) return hit;
    }
    const t0 = performance.now();
    const p = this.backend.run(args).then((r) => {
      this.opts.onRun?.(args, performance.now() - t0, r.code);
      return r;
    });
    if (useCache) {
      this.cache.set(key, p);
      p.then((r) => r.code !== 0 && this.cache.delete(key)).catch(() => this.cache.delete(key));
    }
    return p;
  }

  /** Run a command against the loaded vault; throw EngineFailure on a non-zero exit. */
  private async cmd(command: string[], fallback: EngineError['kind'] = 'internal'): Promise<string> {
    const r = await this.exec([...this.rootArgs(), ...command]);
    if (r.code !== 0) throw new EngineFailure(decodeErrors(r.stderr, toVault, fallback));
    return r.stdout;
  }

  private async json<T>(command: string[]): Promise<T> {
    return parseHledgerJson<T>(await this.cmd([...command, '-O', 'json']));
  }

  /**
   * Mount and validate a snapshot. Uses `hledger stats`, which parses the whole
   * journal with hledger's standard checks (balancing, assertions) but prints
   * almost nothing: printing every transaction as JSON costs far more than the
   * parse on large journals (see docs/ENGINE.md, "Large journals"). Callers fetch
   * the transactions they show with transactions({ period }).
   */
  async load(snapshot: VaultSnapshot): Promise<LoadResult> {
    const previous = this.snapshot;
    this.backend.mount(snapshot.files);
    this.snapshot = snapshot;
    this.cache.clear();
    this.lines.clear();
    const r = await this.exec([...this.rootArgs(snapshot), 'stats'], false);
    if (r.code !== 0) {
      const errors = decodeErrors(r.stderr, toVault, 'parse');
      // Keep serving the previous good snapshot.
      this.snapshot = previous;
      if (previous) this.backend.mount(previous.files);
      return { ok: false, errors };
    }
    const st = decodeStats(r.stdout);
    return { ok: true, stats: { ...st, files: Object.keys(snapshot.files) } };
  }

  private sourceLines(file: string): string[] | undefined {
    let l = this.lines.get(file);
    if (!l) {
      const text = this.snapshot?.files[file];
      if (text == null) return undefined;
      l = text.split(/\r?\n/);
      this.lines.set(file, l);
    }
    return l;
  }

  private decodeTxns(stdout: string): Txn[] {
    const raw = parseHledgerJson<HTxn[]>(stdout);
    return raw.map((h) => {
      const t = decodeTxn(h, toVault);
      for (const p of t.postings) for (const a of p.amount) if (!this.styles.has(a.commodity)) this.styles.set(a.commodity, a.style);
      return t.source ? markInferred(t, this.sourceLines(t.source.file)) : t;
    });
  }

  async check(snapshot: VaultSnapshot, checks: string[] = []): Promise<EngineError[]> {
    const previous = this.snapshot;
    this.backend.mount(snapshot.files);
    try {
      // `run` captures the mounted tree synchronously, so restoring afterwards is safe.
      const pending = this.backend.run([...this.rootArgs(snapshot), 'check', ...checks]);
      if (previous) this.backend.mount(previous.files);
      const r = await pending;
      return r.code === 0 ? [] : decodeErrors(r.stderr, toVault, checks.length ? 'check' : 'parse');
    } finally {
      if (previous) this.backend.mount(previous.files);
    }
  }

  async transactions(opts: QueryOpts = {}): Promise<Txn[]> {
    const args = queryArgs(opts);
    const out = await this.cmd(['print', '-O', 'json', ...args]);
    return this.decodeTxns(out);
  }

  async register(account: string, opts: QueryOpts = {}): Promise<RegisterRow[]> {
    const q = account ? [accountQuery(account)] : [];
    return decodeRegister(await this.json<HRegisterRow[]>(['register', ...q, ...queryArgs(opts)]));
  }

  async balance(opts: QueryOpts & { tree?: boolean } = {}): Promise<BalanceReport> {
    const mode = opts.tree ? ['--tree', '--no-elide'] : ['--flat'];
    return decodeBalance(await this.json<HBalanceReport>(['balance', ...mode, ...queryArgs(opts)]));
  }

  async periodicBalance(opts: QueryOpts & { tree?: boolean }): Promise<PeriodicReport> {
    const mode = opts.tree ? ['--tree', '--no-elide'] : ['--flat'];
    return decodePeriodic(await this.json<HPeriodicReport>(['balance', ...mode, ...queryArgs(opts)]));
  }

  private statement(cmd: 'bs' | 'is' | 'cf', opts: QueryOpts): Promise<StatementReport> {
    return this.json<HCompoundReport>([cmd, '--flat', ...queryArgs(opts)]).then(decodeStatement);
  }
  balanceSheet(opts: QueryOpts = {}) {
    return this.statement('bs', opts);
  }
  incomeStatement(opts: QueryOpts = {}) {
    return this.statement('is', opts);
  }
  cashFlow(opts: QueryOpts = {}) {
    return this.statement('cf', opts);
  }

  async budget(opts: QueryOpts = {}): Promise<BudgetReport> {
    const raw = await this.json<HPeriodicReport<[never, never]>>(['balance', '--budget', '--flat', ...queryArgs(opts)]);
    return decodeBudget(raw as never);
  }

  async accounts(): Promise<AccountInfo[]> {
    const typed = decodeAccountTypes(await this.cmd(['accounts', '--types']));
    const declared = new Set<string>();
    for (const text of Object.values(this.snapshot?.files ?? {}))
      for (const m of text.matchAll(/^account[ \t]+(\S(?:.*?\S)?)(?=[ \t]{2,}|\t|[ \t]*;|[ \t]*$)/gm)) declared.add(m[1]!);
    const used = new Set(decodeLines(await this.cmd(['accounts', '--used'])));
    return typed.map(({ name, type }) => ({
      name,
      type,
      declared: declared.has(name),
      used: used.has(name) || [...used].some((u) => u.startsWith(name + ':')),
    }));
  }

  async commodities(): Promise<CommodityInfo[]> {
    const symbols = decodeLines(await this.cmd(['commodities']));
    const styles = this.styles;
    if (symbols.some((c) => !styles.has(c))) {
      // One small report carries a styled amount for every commodity in use.
      const bal = decodeBalance(await this.json<HBalanceReport>(['balance', '--flat', '--empty', '-N']));
      for (const row of bal.rows) for (const a of row.amount) if (!styles.has(a.commodity)) styles.set(a.commodity, a.style);
    }
    const declared = new Set<string>();
    for (const text of Object.values(this.snapshot?.files ?? {}))
      for (const m of text.matchAll(/^commodity[ \t]+(?:"([^"]+)"|([^\s\d.,\-+]+)(?=[\s\d.,\-+]|$)|[\d.,\-+ ]*([^\s\d.,\-+]+))/gm)) declared.add(m[1] ?? m[2] ?? m[3]!);
    return symbols.map((s) => {
      const style = styles.get(s);
      return { symbol: s, declared: declared.has(s), ...(style ? { style } : {}) };
    });
  }

  async payees(): Promise<string[]> {
    return decodeLines(await this.cmd(['payees']));
  }

  async csvPreview(csvPath: string, rulesPath: string, extraFiles: Record<string, string> = {}): Promise<CsvPreview> {
    if (!this.snapshot) throw new EngineFailure([{ kind: 'internal', message: 'No journal loaded' }]);
    const files = { ...this.snapshot.files, ...extraFiles };
    const previous = this.snapshot;
    this.backend.mount(files);
    const pending = this.backend.run(['-f', `${VAULT_ROOT}/${csvPath}`, '--no-conf', '--rules', `${VAULT_ROOT}/${rulesPath}`, 'print', '-O', 'json']);
    this.backend.mount(previous.files);
    const r = await pending;
    if (r.code !== 0) return { txns: [], errors: decodeErrors(r.stderr, toVault, 'parse') };
    const txns = parseHledgerJson<HTxn[]>(r.stdout).map((h) => decodeTxn(h, toVault));
    return { txns, errors: [] };
  }

  async raw(args: string[]): Promise<RawResult> {
    const cleaned = args[0] === 'hledger' ? args.slice(1) : args;
    if (!isReadOnlyCommand(cleaned))
      return { code: 2, stdout: '', stderr: 'This command can change files or reach the network, so it is not available here.' };
    if (cleaned.some((a) => a === '-f' || a.startsWith('--file')))
      return { code: 2, stdout: '', stderr: 'The console always reads the open vault; -f is not needed.' };
    return this.exec([...this.rootArgs(), ...cleaned]);
  }

  async version(): Promise<EngineVersion> {
    const r = await this.backend.run(['--version']);
    const m = /hledger\s+([\d.]+)/.exec(r.stdout);
    return { hledger: m?.[1] ?? 'unknown', engine: 'hledger-wasm', mode: this.backend.mode, ...this.opts.version };
  }
}
