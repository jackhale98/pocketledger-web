// An in-memory VaultStore: for tests, the demo vault and browsers without
// IndexedDB (private modes that block it). Same semantics as IdbVaultStore.

import type { StoredFile, VaultRecord, VaultStore } from '$lib/contracts/storage';
import { vaultSecretKey, type FileUpdate } from './db';

const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));
const key = (vaultId: string, path: string) => `${vaultId}\u0000${path}`;

export class MemoryVaultStore implements VaultStore {
  readonly vaults = new Map<string, VaultRecord>();
  readonly files = new Map<string, StoredFile>();
  readonly settings = new Map<string, unknown>();
  readonly secrets = new Map<string, string>();

  async listVaults() {
    return [...this.vaults.values()].map(clone).sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
  }
  async getVault(id: string) {
    return clone(this.vaults.get(id));
  }
  async putVault(v: VaultRecord) {
    this.vaults.set(v.id, clone(v));
  }
  async deleteVault(id: string) {
    this.vaults.delete(id);
    for (const [k, f] of this.files) if (f.vaultId === id) this.files.delete(k);
    const prefix = vaultSecretKey(id, '');
    for (const k of this.secrets.keys()) if (k.startsWith(prefix)) this.secrets.delete(k);
  }
  async listFiles(vaultId: string) {
    return [...this.files.values()]
      .filter((f) => f.vaultId === vaultId)
      .map(clone)
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }
  async getFile(vaultId: string, path: string) {
    return clone(this.files.get(key(vaultId, path)));
  }
  async putFiles(files: StoredFile[]) {
    for (const f of files) this.files.set(key(f.vaultId, f.path), clone(f));
  }
  async deleteFile(vaultId: string, path: string) {
    this.files.delete(key(vaultId, path));
  }
  async updateFile(
    vaultId: string,
    path: string,
    fn: (current: StoredFile | undefined) => FileUpdate,
  ): Promise<StoredFile | undefined> {
    const next = fn(clone(this.files.get(key(vaultId, path))));
    if (next === null) this.files.delete(key(vaultId, path));
    else if (next !== undefined) this.files.set(key(vaultId, path), clone(next));
    return clone(this.files.get(key(vaultId, path)));
  }
  async getSetting<T>(k: string) {
    return clone(this.settings.get(k) as T | undefined);
  }
  async setSetting<T>(k: string, value: T) {
    if (value === undefined) this.settings.delete(k);
    else this.settings.set(k, clone(value));
  }
  async getSecret(k: string) {
    return this.secrets.get(k);
  }
  async setSecret(k: string, value: string | null) {
    if (value === null) this.secrets.delete(k);
    else this.secrets.set(k, value);
  }
}
