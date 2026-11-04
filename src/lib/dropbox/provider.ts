// Dropbox as a SyncProvider: paths are vault-relative under
// `DropboxRemote.folder`. The provider keeps the folder's tree in memory and
// follows Dropbox's change cursor, so after the first listing `list()` and
// `revision()` cost one small `list_folder/continue` call.

import type {
  DropboxRemote,
  RemoteEntry,
  SyncProvider,
  VaultRecord,
  VaultStore,
} from '$lib/contracts/storage';
import { normalizePath } from '$lib/sync/paths';
import type { ProviderHints } from '$lib/sync/engine';
import { CursorExpired, DropboxApi, type DropboxEntry } from './api';
import { DropboxSession } from './session';

/** `'/Finance/'` → `'/Finance'`; `'/'` or `''` → `''` (the root / app folder). */
export function normalizeFolder(folder: string): string {
  const p = normalizePath(folder);
  return p ? `/${p}` : '';
}

/** Cheap stable fingerprint of a listing (FNV-1a, hex). */
function fingerprint(entries: Iterable<{ path: string; rev: string }>): string {
  let h = 0x811c9dc5;
  const items = [...entries].map((e) => `${e.path.toLowerCase()}\u0000${e.rev}`).sort();
  for (const s of items) {
    for (let i = 0; i < s.length; i += 1) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    h ^= 0x0a;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${items.length}-${h.toString(16)}`;
}

export class DropboxProvider implements SyncProvider, ProviderHints {
  readonly kind = 'dropbox' as const;
  readonly caseInsensitive = true;
  readonly root: string;
  /** pathLower (absolute) → entry. */
  #tree = new Map<string, { path: string; rev: string }>();
  #cursor: string | null = null;

  constructor(
    readonly api: DropboxApi,
    remote: Pick<DropboxRemote, 'folder'>,
  ) {
    this.root = normalizeFolder(remote.folder);
  }

  /** The provider for a Dropbox vault, with tokens from the store's secrets. */
  static forVault(
    vault: VaultRecord,
    store: VaultStore,
    options: { appKey: string; fetcher?: typeof fetch },
  ): DropboxProvider {
    if (vault.remote?.kind !== 'dropbox') throw new Error('This vault is not a Dropbox vault.');
    const session = new DropboxSession({
      store,
      vaultId: vault.id,
      appKey: options.appKey,
      ...(options.fetcher ? { fetcher: options.fetcher } : {}),
    });
    return new DropboxProvider(new DropboxApi(session.token, options.fetcher), vault.remote);
  }

  abs(path: string): string {
    return `${this.root}/${normalizePath(path)}`;
  }

  /** Vault-relative path of an absolute Dropbox path, or null if outside the folder. */
  rel(path: string, pathLower = path.toLowerCase()): string | null {
    const prefix = `${this.root.toLowerCase()}/`;
    if (!pathLower.startsWith(prefix)) return null;
    return path.slice(prefix.length) || null;
  }

  async #refresh(): Promise<void> {
    if (this.#cursor) {
      try {
        const changes = await this.api.listAll({ cursor: this.#cursor });
        this.#apply(changes.entries);
        this.#cursor = changes.cursor;
        return;
      } catch (e) {
        if (!(e instanceof CursorExpired)) throw e;
      }
    }
    const full = await this.api.listAll({ path: this.root });
    this.#tree.clear();
    this.#apply(full.entries);
    this.#cursor = full.cursor;
  }

  #apply(entries: DropboxEntry[]) {
    for (const e of entries) {
      if (e.tag === 'file' && e.rev) this.#tree.set(e.pathLower, { path: e.path, rev: e.rev });
      else if (e.tag === 'deleted') {
        // A deleted folder takes everything under it.
        const prefix = `${e.pathLower}/`;
        this.#tree.delete(e.pathLower);
        for (const k of [...this.#tree.keys()]) if (k.startsWith(prefix)) this.#tree.delete(k);
      }
    }
  }

  /** Every file under the folder (the engine filters to journal files). */
  async list(): Promise<RemoteEntry[]> {
    await this.#refresh();
    const out: RemoteEntry[] = [];
    for (const [lower, { path, rev }] of this.#tree) {
      const rel = this.rel(path, lower);
      if (rel) out.push({ path: rel, rev });
    }
    return out.sort((a, b) => (a.path < b.path ? -1 : 1));
  }

  async read(path: string): Promise<{ text: string; rev: string }> {
    return this.api.download(this.abs(path));
  }

  async write(path: string, text: string, rev: string | null): Promise<{ rev: string }> {
    const r = await this.api.upload(this.abs(path), text, rev);
    this.#tree.set(r.path.toLowerCase(), { path: r.path, rev: r.rev });
    return { rev: r.rev };
  }

  async delete(path: string, rev: string | null): Promise<void> {
    await this.api.delete(this.abs(path), rev);
    this.#tree.delete(this.abs(path).toLowerCase());
  }

  async revision(): Promise<string> {
    await this.#refresh();
    return fingerprint(this.#tree.values());
  }

  /** The current change cursor (persist it as `DropboxRemote.cursor` if you like; informational). */
  get cursor(): string | null {
    return this.#cursor;
  }
}
