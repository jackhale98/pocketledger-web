// Central app state: the engine, the open vault, its files, and the save pipeline.
//
// Save pipeline (BUILD_PLAN §6.2): plan → apply to a copy → engine.load(copy)
// → if ok, persist + schedule sync; else surface hledger's errors and keep the draft.

import type { AccountInfo, CommodityInfo, EngineError, JournalStats, Txn, VaultSnapshot } from '$lib/contracts/engine';
import type { Patch, TxnDraft } from '$lib/contracts/writer';
import type { VaultRecord, VaultStore } from '$lib/contracts/storage';
import { createEngineClient, EngineCallError, type EngineClient } from '$lib/engine/client';
import { makeSnapshot, guessRootFile, isEngineFile } from '$lib/vault';
import { demoFiles } from '$lib/vault/demo';
import { writer } from '$lib/journal/writer';
import { vaultStore } from '$lib/store';
import { saveLocal } from '$lib/sync';
import { settings } from './settings.svelte';
import { toasts } from './toast.svelte';

export class SaveError extends Error {
  constructor(readonly errors: EngineError[]) {
    super(errors[0]?.message ?? 'Save failed');
    this.name = 'SaveError';
  }
}

interface UndoEntry {
  label: string;
  /** File contents before the change (null = file did not exist). */
  before: Record<string, string | null>;
}

const DEMO_ID = 'demo';

/** Two years either side of today: wide enough to exercise every periodic rule's postings. */
function forecastWindow(today = new Date()) {
  const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
  return `${iso(new Date(today.getFullYear() - 2, today.getMonth(), 1))}..${iso(new Date(today.getFullYear() + 2, today.getMonth(), 1))}`;
}
const LAST_VAULT = 'pl:lastVault';

function payeeOf(t: Txn): string {
  const tag = t.tags.find(([k]) => k === 'payee');
  if (tag) return tag[1];
  const i = t.description.indexOf('|');
  return (i >= 0 ? t.description.slice(0, i) : t.description).trim();
}

export class AppState {
  engine: EngineClient | null = null;
  engineStatus = $state<'starting' | 'ready' | 'error'>('starting');
  engineError = $state('');
  engineMs = $state(0);
  engineMode = $state<'cli' | 'reactor'>('cli');
  timings = $state.raw<{ args: string; ms: number }[]>([]);

  vaults = $state.raw<VaultRecord[]>([]);
  vault = $state.raw<VaultRecord | null>(null);
  files = $state.raw<Record<string, string>>({});
  /** Revision of the last snapshot hledger accepted. Views re-query when it changes. */
  revision = $state('');
  loading = $state(false);
  loadErrors = $state.raw<EngineError[]>([]);
  stats = $state.raw<JournalStats | null>(null);

  txns = $state.raw<Txn[]>([]);
  accounts = $state.raw<AccountInfo[]>([]);
  commodities = $state.raw<CommodityInfo[]>([]);
  payees = $state.raw<string[]>([]);

  undoStack = $state.raw<UndoEntry[]>([]);
  /** Another tab holds the edit lock. */
  readOnly = $state(false);
  /** Called after a successful local save (wired to the sync scheduler). */
  onSaved: ((vault: VaultRecord, paths: string[]) => void) | null = null;

  private store: VaultStore | null = null;

  get snapshot(): VaultSnapshot | null {
    return this.vault ? makeSnapshot(this.files, this.vault.rootFile) : null;
  }
  get isDemo() {
    return this.vault?.provider === 'demo';
  }
  get ready() {
    return this.engineStatus === 'ready' && !!this.revision;
  }

  async start() {
    const base = import.meta.env.BASE_URL.replace(/\/?$/, '/');
    this.engine = createEngineClient({
      wasmUrl: `${base}${__ENGINE__.file}`,
      sha256: __ENGINE__.sha256,
      ...(__ENGINE__.reactor
        ? { reactor: { wasmUrl: `${base}${__ENGINE__.reactor.file}`, jsffiUrl: `${base}${__ENGINE__.reactor.jsffi}`, sha256: __ENGINE__.reactor.sha256 } }
        : {}),
      onTiming: (args, ms) => {
        this.timings = [{ args: args.filter((a, i) => !(i < 2 && (a === '-f' || args[i - 1] === '-f')) && a !== '--no-conf').join(' '), ms }, ...this.timings].slice(0, 40);
      },
    });
    this.engine.ready.then(
      ({ ms, mode }) => {
        this.engineMs = ms;
        this.engineMode = mode;
        this.engineStatus = 'ready';
      },
      (e: Error) => {
        this.engineStatus = 'error';
        this.engineError = e.message;
      },
    );
    try {
      const store = vaultStore();
      this.store = store;
      this.vaults = await store.listVaults();
    } catch {
      this.store = null; // IndexedDB unavailable (private mode): demo only
    }
    let last: string | null = null;
    try {
      last = localStorage.getItem(LAST_VAULT);
    } catch {
      /* ignore */
    }
    const target = this.vaults.find((v) => v.id === last) ?? this.vaults[0];
    if (target) await this.openVault(target.id);
    else await this.openDemo();
  }

  getStore(): VaultStore | null {
    return this.store;
  }

  async refreshVaults() {
    if (this.store) this.vaults = await this.store.listVaults();
  }

  async openDemo() {
    const files = demoFiles();
    const rec: VaultRecord = {
      id: DEMO_ID,
      name: 'Demo',
      provider: 'demo',
      rootFile: 'main.journal',
      createdAt: Date.now(),
      lastOpenedAt: Date.now(),
    };
    await this.setVault(rec, files);
  }

  async openVault(id: string) {
    if (id === DEMO_ID) return this.openDemo();
    if (!this.store) return this.openDemo();
    const rec = await this.store.getVault(id);
    if (!rec) return this.openDemo();
    const stored = await this.store.listFiles(id);
    const files: Record<string, string> = {};
    for (const f of stored) if (!f.deleted) files[f.path] = f.text;
    rec.lastOpenedAt = Date.now();
    await this.store.putVault(rec);
    await this.setVault(rec, files);
  }

  /** Create a vault from files (import, new journal, or a provider's first download). */
  async createVault(init: Omit<VaultRecord, 'id' | 'createdAt' | 'lastOpenedAt' | 'rootFile'> & { rootFile?: string }, files: Record<string, string>, synced = false) {
    if (!this.store) throw new Error('This browser does not allow local storage, so only the demo is available.');
    const rootFile = init.rootFile ?? guessRootFile(Object.keys(files));
    if (!rootFile) throw new Error('No journal file found (.journal, .hledger, .ledger or .j).');
    const rec: VaultRecord = { ...init, rootFile, id: crypto.randomUUID(), createdAt: Date.now(), lastOpenedAt: Date.now() };
    await this.store.putVault(rec);
    await this.store.putFiles(
      Object.entries(files).map(([path, text]) => ({
        vaultId: rec.id,
        path,
        text,
        base: synced ? text : null,
        baseRev: null,
        dirty: !synced,
        modifiedAt: Date.now(),
      })),
    );
    await this.refreshVaults();
    await this.setVault(rec, files);
    return rec;
  }

  async deleteVault(id: string) {
    if (!this.store) return;
    await this.store.deleteVault(id);
    await this.refreshVaults();
    if (this.vault?.id === id) {
      const next = this.vaults[0];
      if (next) await this.openVault(next.id);
      else await this.openDemo();
    }
  }

  async updateVault(patch: Partial<VaultRecord>) {
    if (!this.vault) return;
    const rec = { ...this.vault, ...patch };
    this.vault = rec;
    if (this.store && rec.provider !== 'demo') await this.store.putVault(rec);
    await this.refreshVaults();
  }

  private async setVault(rec: VaultRecord, files: Record<string, string>) {
    this.vault = rec;
    this.files = files;
    this.undoStack = [];
    this.revision = '';
    this.txns = [];
    try {
      localStorage.setItem(LAST_VAULT, rec.id);
    } catch {
      /* ignore */
    }
    await this.reload();
  }

  /** Re-parse the current files with hledger and refresh shared data. */
  async reload() {
    const snap = this.snapshot;
    if (!snap || !this.engine) return;
    this.loading = true;
    try {
      const r = await this.engine.load(snap);
      if (!r.ok) {
        this.loadErrors = r.errors;
        return;
      }
      await this.refreshData(r.stats, snap.revision);
    } catch (e) {
      this.loadErrors = e instanceof EngineCallError ? e.errors : [{ kind: 'internal', message: (e as Error).message }];
    } finally {
      this.loading = false;
    }
  }

  /** After a successful engine.load: pull the shared lists views rely on. */
  private async refreshData(stats: JournalStats, revision: string) {
    const engine = this.engine!;
    this.loadErrors = [];
    this.stats = stats;
    this.txns = await engine.transactions();
    this.revision = revision;
    const seen = new Set<string>();
    const payees: string[] = [];
    for (let i = this.txns.length - 1; i >= 0; i--) {
      const p = payeeOf(this.txns[i]!);
      if (p && !seen.has(p)) {
        seen.add(p);
        payees.push(p);
      }
    }
    this.payees = payees;
    this.accounts = await engine.accounts();
    this.commodities = await engine.commodities();
  }

  // ------------------------------------------------------------------ saving

  /** Validate patched files with hledger, then persist. Throws SaveError with hledger's messages. */
  async applyPatches(patches: Patch[], label: string, opts: { allowUndo?: boolean } = {}) {
    if (this.readOnly) throw new SaveError([{ kind: 'internal', message: 'Another tab is editing this vault. Choose “Edit here” to edit in this tab.' }]);
    const next = writer.apply(this.files, patches);
    await this.commitFiles(next, label, opts);
  }

  /** Replace whole files (new journal, imports, conflict resolution). Validates like applyPatches. */
  async commitFiles(next: Record<string, string>, label: string, opts: { allowUndo?: boolean; skipValidation?: boolean } = {}) {
    if (!this.vault || !this.engine) throw new Error('No vault open');
    const changed = Object.keys({ ...this.files, ...next }).filter((p) => this.files[p] !== next[p]);
    if (changed.length === 0) return;
    const snap = makeSnapshot(next, this.vault.rootFile);
    let stats: JournalStats | null = null;
    if (!opts.skipValidation) {
      const r = await this.engine.load(snap);
      if (!r.ok) {
        // engine.load keeps serving the previous snapshot on failure.
        throw new SaveError(r.errors);
      }
      stats = r.stats;
      // Periodic (~) rules are only checked by hledger when it generates from them,
      // so validate them over a window around today whenever any file has one.
      const forecastErrs = Object.values(snap.files).some((t) => /^~/m.test(t)) ? await this.engine.check(snap, ['-I', `--forecast=${forecastWindow()}`]) : [];
      if (forecastErrs.length) {
        await this.engine.load(makeSnapshot(this.files, this.vault.rootFile));
        throw new SaveError(forecastErrs);
      }
      const strict = settings.v.strictChecks;
      if (strict.length) {
        const errs = await this.engine.check(snap, strict);
        if (errs.length) {
          await this.engine.load(makeSnapshot(this.files, this.vault.rootFile));
          throw new SaveError(errs);
        }
      }
    }
    const before: Record<string, string | null> = {};
    for (const p of changed) before[p] = this.files[p] ?? null;
    await this.persist(next, changed);
    if (opts.allowUndo !== false) this.undoStack = [...this.undoStack.slice(-19), { label, before }];
    this.files = next;
    if (stats) await this.refreshData(stats, snap.revision);
    else await this.reload();
    if (this.vault.provider !== 'demo') this.onSaved?.(this.vault, changed);
  }

  private async persist(next: Record<string, string>, changed: string[]) {
    if (!this.store || !this.vault || this.vault.provider === 'demo') return;
    // saveLocal keeps the three-way-merge base, sets dirty flags and tombstones.
    await saveLocal(this.store, this.vault.id, changed.map((path) => ({ path, text: next[path] ?? null })));
  }

  async undo() {
    const entry = this.undoStack[this.undoStack.length - 1];
    if (!entry) return;
    const next = { ...this.files };
    for (const [p, t] of Object.entries(entry.before)) {
      if (t == null) delete next[p];
      else next[p] = t;
    }
    this.undoStack = this.undoStack.slice(0, -1);
    await this.commitFiles(next, `Undo ${entry.label}`, { allowUndo: false });
    toasts.show(`Undid: ${entry.label}`, { tone: 'ok' });
  }

  // ------------------------------------------------------------------ transactions

  addTargetFile(): string {
    const v = this.vault;
    if (!v) return 'main.journal';
    if (v.addTarget && this.files[v.addTarget] != null) return v.addTarget;
    return v.rootFile;
  }

  async addTxn(draft: TxnDraft, targetFile = this.addTargetFile()) {
    const snap = this.snapshot!;
    const patches = writer.planAdd(snap, draft, {
      targetFile,
      dateOrder: settings.v.dateOrder,
      txns: this.txns.filter((t) => t.source?.file === targetFile),
    });
    await this.applyPatches(patches, `add “${draft.description}”`);
  }

  async editTxn(txn: Txn, draft: TxnDraft) {
    await this.applyPatches(writer.planEdit(this.snapshot!, txn, draft), `edit “${draft.description}”`);
  }

  async replaceTxnText(txn: Txn, text: string) {
    await this.applyPatches(writer.planReplaceText(this.snapshot!, txn, text), `edit “${txn.description}”`);
  }

  async deleteTxn(txn: Txn) {
    await this.applyPatches(writer.planDelete(this.snapshot!, txn), `delete “${txn.description}”`);
    toasts.show(`Deleted “${txn.description}”`, { action: { label: 'Undo', run: () => void this.undo() } });
  }

  /** Text of a transaction's source span. */
  sourceText(txn: Txn): string | null {
    if (!txn.source) return null;
    const text = this.files[txn.source.file];
    if (text == null) return null;
    return text.split(/\r?\n/).slice(txn.source.startLine - 1, txn.source.endLine).join('\n');
  }

  engineFiles(): string[] {
    return Object.keys(this.files).filter(isEngineFile).sort();
  }
}

export const app = new AppState();
