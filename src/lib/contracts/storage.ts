// Lead-owned contract. Changes require lead review (BUILD_PLAN §6.3, §8, §15.3).
//
// Ported from mycelium-web (src/lib/sync/remote.ts, src/lib/store/db.ts,
// src/lib/sync/engine.ts) with renames recorded in docs/DECISIONS.md (D-006).

export type ProviderKind = 'demo' | 'local' | 'fsa' | 'dropbox' | 'github';

export interface VaultRecord {
  id: string;
  name: string;
  provider: ProviderKind;
  /** Vault-relative path of the root journal. */
  rootFile: string;
  createdAt: number;
  lastOpenedAt: number;
  /** Provider-specific settings (Dropbox folder, git url/branch, …). Never holds tokens in plaintext logs. */
  remote?: DropboxRemote | GitRemote | null;
  /** Default target for new transactions (vault-relative); null = rootFile. */
  addTarget?: string | null;
  /** Vault is in a conflicted state after a merge that failed `check`. */
  conflicted?: boolean;
}

export interface DropboxRemote {
  kind: 'dropbox';
  /** Folder in Dropbox, e.g. "/Finance". */
  folder: string;
  cursor?: string | null;
  account?: { name: string; email: string } | null;
}

export interface GitRemote {
  kind: 'github';
  /** https clone URL. */
  url: string;
  branch: string;
  /** CORS proxy base URL (isomorphic-git `corsProxy`). */
  proxy: string;
  author: { name: string; email: string };
  /** 'git' = isomorphic-git; 'rest' = GitHub Contents API (no proxy). */
  transport: 'git' | 'rest';
}

/** One file as stored locally. */
export interface StoredFile {
  vaultId: string;
  path: string;
  text: string;
  /** Text at the last successful sync (three-way merge base); null if never synced. */
  base: string | null;
  /** Provider revision of `base` (Dropbox rev, git blob oid). */
  baseRev: string | null;
  /** Locally changed since the last sync (pending upload). */
  dirty: boolean;
  /** Pending deletion (tombstone). */
  deleted?: boolean;
  modifiedAt: number;
}

/** Local persistence (IndexedDB). */
export interface VaultStore {
  listVaults(): Promise<VaultRecord[]>;
  getVault(id: string): Promise<VaultRecord | undefined>;
  putVault(v: VaultRecord): Promise<void>;
  deleteVault(id: string): Promise<void>;
  listFiles(vaultId: string): Promise<StoredFile[]>;
  getFile(vaultId: string, path: string): Promise<StoredFile | undefined>;
  putFiles(files: StoredFile[]): Promise<void>;
  deleteFile(vaultId: string, path: string): Promise<void>;
  getSetting<T>(key: string): Promise<T | undefined>;
  setSetting<T>(key: string, value: T): Promise<void>;
  /** Secrets (tokens) live in their own store; never synced, never exported. */
  getSecret(key: string): Promise<string | undefined>;
  setSecret(key: string, value: string | null): Promise<void>;
}

export interface RemoteEntry {
  /** Vault-relative path. */
  path: string;
  rev: string;
}

/** A remote file service, as seen by the sync engine. Paths are vault-relative. */
export interface SyncProvider {
  readonly kind: ProviderKind;
  list(): Promise<RemoteEntry[]>;
  read(path: string): Promise<{ text: string; rev: string }>;
  /** With `rev`: only if the remote still has that revision (else throws RemoteConflict). Without: only if absent. */
  write(path: string, text: string, rev: string | null): Promise<{ rev: string }>;
  delete(path: string, rev: string | null): Promise<void>;
  /** Opaque token that changes whenever anything under the vault changes (cheap change check). */
  revision(): Promise<string>;
}

export class RemoteConflict extends Error {
  constructor(readonly path: string) {
    super(`${path} changed elsewhere`);
    this.name = 'RemoteConflict';
  }
}
export class RemoteNotFound extends Error {
  constructor(readonly path: string) {
    super(`${path} not found`);
    this.name = 'RemoteNotFound';
  }
}
export class RemoteAuthError extends Error {
  override name = 'RemoteAuthError';
}
export class RemoteError extends Error {
  constructor(
    readonly status: number,
    readonly summary: string,
    service = 'The server',
  ) {
    super(`${service}: ${summary || `HTTP ${status}`}`);
    this.name = 'RemoteError';
  }
}

export interface FileConflict {
  path: string;
  base: string | null;
  local: string;
  remote: string;
  /** diff3 merge with conflict markers, for the resolver. */
  merged: string;
}

export interface SyncResult {
  pulled: string[];
  pushed: string[];
  deleted: string[];
  conflicts: FileConflict[];
  /** Merged text that applied cleanly but failed engine.check → vault marked conflicted. */
  invalid: { path: string; message: string }[];
}

export interface SyncEngine {
  /** Three-way merge of every file using the stored base; uploads pending changes. */
  sync(vault: VaultRecord, provider: SyncProvider): Promise<SyncResult>;
}

export interface GitStatusEntry {
  path: string;
  status: 'added' | 'modified' | 'deleted';
}

export interface GitWorkspace {
  clone(onProgress?: (p: { phase: string; loaded: number; total?: number }) => void): Promise<void>;
  readFiles(): Promise<Record<string, string>>;
  writeFiles(changes: { path: string; text: string | null }[]): Promise<void>;
  status(): Promise<GitStatusEntry[]>;
  diff(path: string): Promise<{ before: string | null; after: string | null }>;
  commit(paths: string[], message: string): Promise<string>;
  pull(): Promise<{ updated: string[]; conflicts: FileConflict[] }>;
  push(): Promise<{ ok: boolean; message?: string }>;
  aheadBehind(): Promise<{ ahead: number; behind: number }>;
}
