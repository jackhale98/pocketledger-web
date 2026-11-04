// VaultStore over IndexedDB (database `pocketledger`). Ported from
// mycelium-web src/lib/store/db.ts, minus Dexie and the org-specific caches.
//
// Object stores (schema v1):
//   vaults    keyPath "id"                    VaultRecord
//   files     keyPath ["vaultId","path"]      StoredFile   (index "vaultId")
//   settings  out-of-line string keys         any structured-cloneable value
//   secrets   out-of-line string keys         string (tokens) — never exported or synced

import type { StoredFile, VaultRecord, VaultStore } from '$lib/contracts/storage';
import { openDatabase, transact } from './idb';

export const DB_NAME = 'pocketledger';
export const DB_VERSION = 1;

const VAULTS = 'vaults';
const FILES = 'files';
const SETTINGS = 'settings';
const SECRETS = 'secrets';

/** Secret key for something belonging to one vault; `deleteVault` removes all of them. */
export const vaultSecretKey = (vaultId: string, name: string) => `vault:${vaultId}:${name}`;

export interface IdbStoreOptions {
  name?: string;
  /** Defaults to `globalThis.indexedDB` (pass fake-indexeddb in tests). */
  indexedDB?: IDBFactory;
}

/** What `updateFile`'s callback returns: a record to write, `null` to delete, `undefined` to leave as is. */
export type FileUpdate = StoredFile | null | undefined;

export class IdbVaultStore implements VaultStore {
  readonly name: string;
  readonly #factory: IDBFactory;
  #db: Promise<IDBDatabase> | null = null;

  constructor(options: IdbStoreOptions = {}) {
    this.name = options.name ?? DB_NAME;
    const factory = options.indexedDB ?? (globalThis as { indexedDB?: IDBFactory }).indexedDB;
    if (!factory) throw new Error('IndexedDB is not available in this browser');
    this.#factory = factory;
  }

  #open(): Promise<IDBDatabase> {
    this.#db ??= openDatabase(this.#factory, this.name, DB_VERSION, (db, oldVersion) => {
      if (oldVersion < 1) {
        db.createObjectStore(VAULTS, { keyPath: 'id' });
        const files = db.createObjectStore(FILES, { keyPath: ['vaultId', 'path'] });
        files.createIndex('vaultId', 'vaultId', { unique: false });
        db.createObjectStore(SETTINGS);
        db.createObjectStore(SECRETS);
      }
    }).catch((e: unknown) => {
      this.#db = null;
      throw e;
    });
    return this.#db;
  }

  async close(): Promise<void> {
    const db = await this.#db?.catch(() => null);
    db?.close();
    this.#db = null;
  }

  /** One request in its own transaction; resolves with its result once committed. */
  async #one<T>(
    store: string,
    mode: IDBTransactionMode,
    fn: (os: IDBObjectStore) => IDBRequest,
  ): Promise<T> {
    const db = await this.#open();
    const req = await transact(db, store, mode, (tx) => fn(tx.objectStore(store)));
    return req.result as T;
  }

  // ------------------------------------------------------------------ vaults

  async listVaults(): Promise<VaultRecord[]> {
    const all = await this.#one<VaultRecord[]>(VAULTS, 'readonly', (os) => os.getAll());
    return all.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
  }

  getVault(id: string): Promise<VaultRecord | undefined> {
    return this.#one(VAULTS, 'readonly', (os) => os.get(id));
  }

  async putVault(v: VaultRecord): Promise<void> {
    await this.#one(VAULTS, 'readwrite', (os) => os.put(plain(v)));
  }

  /** Deletes the vault record, all of its files and every `vaultSecretKey(id, …)` secret. */
  async deleteVault(id: string): Promise<void> {
    const db = await this.#open();
    const prefix = vaultSecretKey(id, '');
    await transact(db, [VAULTS, FILES, SECRETS], 'readwrite', (tx) => {
      tx.objectStore(VAULTS).delete(id);
      const files = tx.objectStore(FILES);
      const cursor = files.index('vaultId').openKeyCursor(id);
      cursor.onsuccess = () => {
        const c = cursor.result;
        if (!c) return;
        files.delete(c.primaryKey);
        c.continue();
      };
      const secrets = tx.objectStore(SECRETS);
      const keys = secrets.openKeyCursor();
      keys.onsuccess = () => {
        const c = keys.result;
        if (!c) return;
        if (typeof c.key === 'string' && c.key.startsWith(prefix)) secrets.delete(c.key);
        c.continue();
      };
    });
  }

  // ------------------------------------------------------------------- files

  async listFiles(vaultId: string): Promise<StoredFile[]> {
    const files = await this.#one<StoredFile[]>(FILES, 'readonly', (os) =>
      os.index('vaultId').getAll(vaultId),
    );
    return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  getFile(vaultId: string, path: string): Promise<StoredFile | undefined> {
    return this.#one(FILES, 'readonly', (os) => os.get([vaultId, path]));
  }

  /** Writes all files in one transaction (all or nothing). */
  async putFiles(files: StoredFile[]): Promise<void> {
    if (files.length === 0) return;
    const db = await this.#open();
    await transact(db, FILES, 'readwrite', (tx) => {
      const store = tx.objectStore(FILES);
      for (const f of files) store.put(plain(f));
    });
  }

  async deleteFile(vaultId: string, path: string): Promise<void> {
    await this.#one(FILES, 'readwrite', (os) => os.delete([vaultId, path]));
  }

  /**
   * Atomic read-modify-write of one file (one transaction): `fn` sees the
   * current record and returns the new one, `null` to delete, or `undefined`
   * to leave it. Resolves with what is stored afterwards. Not part of the
   * VaultStore contract; the sync engine uses it when present so an edit made
   * while a sync runs is never overwritten.
   */
  async updateFile(
    vaultId: string,
    path: string,
    fn: (current: StoredFile | undefined) => FileUpdate,
  ): Promise<StoredFile | undefined> {
    const db = await this.#open();
    const holder: { value: StoredFile | undefined; error?: unknown } = { value: undefined };
    try {
      await transact(db, FILES, 'readwrite', (tx) => {
        const store = tx.objectStore(FILES);
        const get = store.get([vaultId, path]) as IDBRequest<StoredFile | undefined>;
        get.onsuccess = () => {
          holder.value = get.result;
          let next: FileUpdate;
          try {
            next = fn(get.result);
          } catch (e) {
            holder.error = e;
            tx.abort();
            return;
          }
          if (next === null) {
            store.delete([vaultId, path]);
            holder.value = undefined;
          } else if (next !== undefined) {
            store.put(plain(next));
            holder.value = next;
          }
        };
      });
    } catch (e) {
      throw holder.error ?? e;
    }
    return holder.value;
  }

  // ---------------------------------------------------------------- settings

  getSetting<T>(key: string): Promise<T | undefined> {
    return this.#one(SETTINGS, 'readonly', (os) => os.get(key));
  }

  /** Values must be structured-cloneable (pass `$state.snapshot(...)`, not a Svelte proxy). */
  async setSetting<T>(key: string, value: T): Promise<void> {
    await this.#one(SETTINGS, 'readwrite', (os) =>
      value === undefined ? os.delete(key) : os.put(value, key),
    );
  }

  // ----------------------------------------------------------------- secrets

  getSecret(key: string): Promise<string | undefined> {
    return this.#one(SECRETS, 'readonly', (os) => os.get(key));
  }

  async setSecret(key: string, value: string | null): Promise<void> {
    await this.#one(SECRETS, 'readwrite', (os) =>
      value === null ? os.delete(key) : os.put(value, key),
    );
  }
}

/**
 * Structured clone rejects Svelte 5 `$state` proxies; a JSON round trip turns
 * them into plain data. Vault and file records hold only JSON values.
 */
function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

let shared: IdbVaultStore | null = null;

/** The app's store (one per page). */
export function vaultStore(): IdbVaultStore {
  shared ??= new IdbVaultStore();
  return shared;
}

/** Keep this origin's storage from being evicted under pressure (best effort). */
export async function requestPersistence(): Promise<boolean> {
  try {
    const storage = (globalThis.navigator as Navigator | undefined)?.storage;
    if (!storage) return false;
    if (await storage.persisted?.()) return true;
    return (await storage.persist?.()) ?? false;
  } catch {
    return false;
  }
}
