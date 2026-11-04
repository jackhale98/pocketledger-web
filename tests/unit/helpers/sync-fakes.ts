// An in-memory SyncProvider with revisions, and a "device" that edits and
// syncs a vault through the real engine — for the sync tests.

import {
  RemoteConflict,
  RemoteNotFound,
  type ProviderKind,
  type RemoteEntry,
  type SyncProvider,
  type SyncResult,
  type VaultRecord,
} from '$lib/contracts/storage';
import { MemoryVaultStore } from '$lib/store/memory';
import { VaultSyncEngine, type SyncEngineOptions } from '$lib/sync/engine';
import { saveLocal } from '$lib/sync/local';

export class FakeProvider implements SyncProvider {
  readonly kind: ProviderKind = 'dropbox';
  files = new Map<string, { text: string; rev: string }>();
  #rev = 0;
  writes = 0;
  reads = 0;
  lists = 0;
  /** Called before each write (to simulate another device racing it). */
  beforeWrite: ((path: string) => void) | null = null;
  offline = false;

  put(path: string, text: string): string {
    const rev = `r${++this.#rev}`;
    this.files.set(path, { text, rev });
    return rev;
  }
  remove(path: string) {
    this.files.delete(path);
  }
  text(path: string) {
    return this.files.get(path)?.text;
  }
  #net() {
    if (this.offline) throw new TypeError('Failed to fetch');
  }

  async list(): Promise<RemoteEntry[]> {
    this.#net();
    this.lists += 1;
    return [...this.files].map(([path, f]) => ({ path, rev: f.rev }));
  }
  async read(path: string) {
    this.#net();
    this.reads += 1;
    const f = this.files.get(path);
    if (!f) throw new RemoteNotFound(path);
    return { ...f };
  }
  async write(path: string, text: string, rev: string | null) {
    this.#net();
    this.beforeWrite?.(path);
    const f = this.files.get(path);
    if (rev ? f?.rev !== rev : f) throw new RemoteConflict(path);
    this.writes += 1;
    return { rev: this.put(path, text) };
  }
  async delete(path: string, rev: string | null) {
    this.#net();
    const f = this.files.get(path);
    if (!f) return;
    if (rev && f.rev !== rev) throw new RemoteConflict(path);
    this.remove(path);
  }
  async revision() {
    this.#net();
    return [...this.files].map(([p, f]) => `${p}@${f.rev}`).sort().join(',');
  }
}

let clock = 1_000;
export const tick = () => ++clock;

export function vaultRecord(id = 'v1', patch: Partial<VaultRecord> = {}): VaultRecord {
  return {
    id,
    name: 'Test',
    provider: 'dropbox',
    rootFile: 'main.journal',
    createdAt: 1,
    lastOpenedAt: 1,
    remote: { kind: 'dropbox', folder: '/Finance' },
    ...patch,
  };
}

export class Device {
  readonly store = new MemoryVaultStore();
  readonly engine: VaultSyncEngine;
  vault: VaultRecord;

  constructor(
    readonly remote: FakeProvider,
    options: Partial<SyncEngineOptions> = {},
    id = 'v1',
  ) {
    this.vault = vaultRecord(id);
    void this.store.putVault(this.vault);
    this.engine = new VaultSyncEngine({ store: this.store, now: tick, ...options });
  }

  edit(path: string, text: string | null) {
    return saveLocal(this.store, this.vault.id, [{ path, text }], tick);
  }

  async text(path: string): Promise<string | undefined> {
    const f = await this.store.getFile(this.vault.id, path);
    return f && !f.deleted ? f.text : undefined;
  }

  async paths(): Promise<string[]> {
    return (await this.store.listFiles(this.vault.id)).filter((f) => !f.deleted).map((f) => f.path);
  }

  async pending(): Promise<string[]> {
    return (await this.store.listFiles(this.vault.id)).filter((f) => f.dirty).map((f) => f.path);
  }

  sync(): Promise<SyncResult> {
    return this.engine.sync(this.vault, this.remote);
  }
}
