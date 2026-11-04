// Two-way sync between a vault's local copy (VaultStore) and a remote file
// service (SyncProvider). Ported from mycelium-web src/lib/sync/engine.ts.
//
// Every stored file remembers the text and provider revision it last agreed
// on with the remote (`base`, `baseRev`) and whether it changed here since
// (`dirty`). A sync lists the remote, and for each file:
//
//   remote unchanged (rev = baseRev)  → upload the local edit, if any
//   remote changed, local clean       → take the remote text
//   remote changed, local edited      → three-way merge against `base`
//                                        clean → upload the merge
//                                        not   → FileConflict (nothing written)
//   remote gone, local clean          → delete locally
//   remote gone, local edited         → keep the edit, upload it as new
//   local deleted, remote unchanged   → delete remotely
//   local deleted, remote edited      → keep the remote edit
//   deleted on both sides             → forget it
//
// Uploads are conditional on `baseRev`, so a write racing another device
// fails with RemoteConflict instead of overwriting it; the engine then runs
// another round, which merges it.
//
// Post-merge validation: when any three-way merge happened (or the vault is
// already `conflicted`), the would-be vault is passed to `validate`
// (engine.check). If it reports errors, nothing is uploaded this round, the
// merged text is kept locally (still pending), the errors come back in
// `SyncResult.invalid` and `vault.conflicted` is set. Uploads stay held until
// the vault validates again (the person fixes it), then the flag clears.

import {
  RemoteConflict,
  RemoteNotFound,
  type FileConflict,
  type StoredFile,
  type SyncEngine,
  type SyncProvider,
  type SyncResult,
  type VaultRecord,
  type VaultStore,
} from '$lib/contracts/storage';
import { updateFile } from './local';
import { hasConflictMarkers, merge3 } from './merge';
import { pool, syncable } from './paths';

export type ValidateHook = (
  files: Record<string, string>,
  vault: VaultRecord,
) => Promise<{ path: string; message: string }[]>;

export interface SyncProgress {
  vaultId: string;
  phase: 'listing' | 'downloading' | 'validating' | 'uploading' | 'done';
  /** 0–1 when known. */
  ratio: number | null;
}

export interface SyncEngineOptions {
  store: VaultStore;
  /** Wire to `engine.check` (with the vault's rootFile). Empty array = valid. */
  validate?: ValidateHook | undefined;
  onProgress?: ((p: SyncProgress) => void) | undefined;
  /** Which vault-relative paths take part (default `syncable`). */
  include?: ((path: string) => boolean) | undefined;
  /** Keep both sides of same-place insertions (default true; see merge.ts). */
  unionInsertions?: boolean | undefined;
  /** Parallel downloads (default 6). */
  concurrency?: number | undefined;
  /** Extra rounds after a RemoteConflict race (default 2). */
  maxRetries?: number | undefined;
  now?: (() => number) | undefined;
}

/** Optional hints a provider may expose (not part of the SyncProvider contract). */
export interface ProviderHints {
  /** Dropbox: paths differ only by case are the same file. */
  readonly caseInsensitive?: boolean;
  /** GitHub REST: every write is a commit on one branch, so write one at a time. */
  readonly maxConcurrentWrites?: number;
}

/** A conflict as returned by this engine: also carries the remote revision it saw. */
export interface SyncConflict extends FileConflict {
  remoteRev: string;
}

type Remote = { text: string; rev: string };

type Action =
  /** Remote changed and local is clean (or deleted with remote edited): take theirs. */
  | { kind: 'take'; remote: Remote }
  /** Both changed, merged cleanly. */
  | { kind: 'merge'; remote: Remote; text: string }
  | { kind: 'conflict'; remote: Remote; merged: string }
  /** Upload local text against `rev` (null = create). */
  | { kind: 'upload'; text: string; rev: string | null }
  /** Local edit that equals the base again: just clear the flag. */
  | { kind: 'clean' }
  | { kind: 'deleteRemote'; rev: string | null }
  /** Remote deleted it and it's clean here. */
  | { kind: 'dropLocal' }
  /** Deleted on both sides (or a tombstone that never reached the remote). */
  | { kind: 'purge' };

interface Plan {
  path: string;
  snap: StoredFile | undefined;
  action: Action;
}

const emptyResult = (): SyncResult => ({
  pulled: [],
  pushed: [],
  deleted: [],
  conflicts: [],
  invalid: [],
});

const REVISION_KEY = (vaultId: string) => `sync:revision:${vaultId}`;

export class VaultSyncEngine implements SyncEngine {
  readonly store: VaultStore;
  readonly #opts: SyncEngineOptions;
  readonly #include: (path: string) => boolean;
  readonly #now: () => number;
  /** One sync per vault at a time (later calls wait for the running one). */
  readonly #queue = new Map<string, Promise<unknown>>();

  constructor(options: SyncEngineOptions) {
    this.store = options.store;
    this.#opts = options;
    this.#include = options.include ?? syncable;
    this.#now = options.now ?? Date.now;
  }

  /** Three-way merge every file against its stored base and upload pending changes. */
  sync(vault: VaultRecord, provider: SyncProvider): Promise<SyncResult> {
    return this.#serial(vault.id, () => this.#syncRounds(vault, provider));
  }

  /**
   * Cheap periodic check: skips the full listing when nothing is pending
   * here and `provider.revision()` is unchanged since the last sync.
   * Resolves `null` when it skipped.
   */
  syncIfChanged(vault: VaultRecord, provider: SyncProvider): Promise<SyncResult | null> {
    return this.#serial(vault.id, async () => {
      const files = await this.store.listFiles(vault.id);
      const pending = files.some((f) => f.dirty && this.#include(f.path));
      const token = await provider.revision();
      const known = await this.store.getSetting<string>(REVISION_KEY(vault.id));
      if (!pending && !vault.conflicted && known !== undefined && token === known) return null;
      const result = await this.#syncRounds(vault, provider);
      // Our own uploads change the revision: check once more next time.
      const wrote = result.pushed.length > 0 || result.deleted.length > 0;
      await this.store.setSetting(REVISION_KEY(vault.id), wrote ? undefined : token);
      return result;
    });
  }

  /**
   * Record the person's resolution of a conflict: `text` becomes the local
   * version and the remote text they saw becomes the merge base, so the next
   * sync uploads it (or merges it again if the remote moved on meanwhile).
   */
  async resolve(vaultId: string, conflict: FileConflict, text: string): Promise<void> {
    if (hasConflictMarkers(text)) throw new Error(`${conflict.path} still has conflict markers`);
    const remoteRev = (conflict as Partial<SyncConflict>).remoteRev;
    await updateFile(this.store, vaultId, conflict.path, (cur) => {
      const { deleted: _deleted, ...rest } = cur ?? {
        vaultId,
        path: conflict.path,
        text,
        base: null,
        baseRev: null,
        dirty: true,
        modifiedAt: 0,
      };
      return {
        ...rest,
        text,
        base: conflict.remote,
        baseRev: remoteRev ?? rest.baseRev,
        dirty: true,
        modifiedAt: this.#now(),
      };
    });
  }

  async #serial<T>(vaultId: string, run: () => Promise<T>): Promise<T> {
    const prior = this.#queue.get(vaultId) ?? Promise.resolve();
    const next = prior.catch(() => undefined).then(run);
    this.#queue.set(vaultId, next);
    try {
      return await next;
    } finally {
      if (this.#queue.get(vaultId) === next) this.#queue.delete(vaultId);
    }
  }

  #progress(vaultId: string, phase: SyncProgress['phase'], ratio: number | null = null) {
    this.#opts.onProgress?.({ vaultId, phase, ratio });
  }

  async #syncRounds(vault: VaultRecord, provider: SyncProvider): Promise<SyncResult> {
    const total = emptyResult();
    const retries = this.#opts.maxRetries ?? 2;
    for (let round = 0; ; round += 1) {
      const { result, again } = await this.#round(vault, provider);
      // Conflicts and validation are about the latest state only.
      total.conflicts = result.conflicts;
      total.invalid = result.invalid;
      for (const k of ['pulled', 'pushed', 'deleted'] as const)
        for (const p of result[k]) if (!total[k].includes(p)) total[k].push(p);
      if (!again || round >= retries) break;
    }
    this.#progress(vault.id, 'done', 1);
    return total;
  }

  /** One pass: plan from a listing, download, merge, validate, apply, upload. */
  async #round(
    vault: VaultRecord,
    provider: SyncProvider,
  ): Promise<{ result: SyncResult; again: boolean }> {
    const result = emptyResult();
    const hints = provider as Partial<ProviderHints>;
    let again = false;

    this.#progress(vault.id, 'listing');
    const [stored, listing] = await Promise.all([
      this.store.listFiles(vault.id),
      provider.list(),
    ]);
    const local = new Map(stored.filter((f) => this.#include(f.path)).map((f) => [f.path, f]));

    // Remote paths, spelled the way this vault already spells them (Dropbox ignores case).
    const spelling = new Map<string, string>();
    if (hints.caseInsensitive) for (const p of local.keys()) spelling.set(p.toLowerCase(), p);
    const remote = new Map<string, string>();
    /** Local spelling → the remote's own spelling, for downloads. */
    const remoteName = new Map<string, string>();
    for (const e of listing) {
      const path = hints.caseInsensitive ? (spelling.get(e.path.toLowerCase()) ?? e.path) : e.path;
      if (!this.#include(path)) continue;
      remote.set(path, e.rev);
      remoteName.set(path, e.path);
    }

    // ------------------------------------------------------------ download
    const paths = [...new Set([...local.keys(), ...remote.keys()])].sort();
    const needs = paths.filter((p) => remote.has(p) && remote.get(p) !== local.get(p)?.baseRev);
    const downloaded = new Map<string, Remote>();
    let done = 0;
    this.#progress(vault.id, 'downloading', needs.length ? 0 : 1);
    await pool(needs, this.#opts.concurrency ?? 6, async (path) => {
      try {
        const r = await provider.read(remoteName.get(path) ?? path);
        downloaded.set(path, { text: r.text, rev: r.rev || remote.get(path)! });
      } catch (e) {
        // Deleted between the listing and the download: look again next round.
        if (!(e instanceof RemoteNotFound)) throw e;
        again = true;
      }
      done += 1;
      this.#progress(vault.id, 'downloading', done / needs.length);
    });

    // ---------------------------------------------------------------- plan
    const plans: Plan[] = [];
    let merged = false;
    for (const path of paths) {
      const snap = local.get(path);
      const rev = remote.get(path);
      if (rev !== undefined && rev !== snap?.baseRev && !downloaded.has(path)) continue;
      const action = this.#decide(snap, rev, downloaded.get(path));
      if (!action) continue;
      if (action.kind === 'merge') merged = true;
      plans.push({ path, snap, action });
    }

    // ------------------------------------------------------------ validate
    let hold = false;
    if (this.#opts.validate && (merged || vault.conflicted)) {
      this.#progress(vault.id, 'validating');
      const files: Record<string, string> = {};
      for (const f of stored) if (!f.deleted) files[f.path] = f.text;
      for (const { path, action } of plans) {
        if (action.kind === 'take' || action.kind === 'merge')
          files[path] = action.kind === 'take' ? action.remote.text : action.text;
        else if (action.kind === 'dropLocal' || action.kind === 'purge') delete files[path];
      }
      const errors = await this.#opts.validate(files, vault);
      if (errors.length) {
        hold = true;
        result.invalid = errors.map(({ path, message }) => ({ path, message }));
      }
      if (hold !== !!vault.conflicted) await this.#setConflicted(vault, hold);
    }

    // --------------------------------------------------------------- apply
    const writes = Math.max(1, hints.maxConcurrentWrites ?? 4);
    const uploads: Plan[] = [];
    for (const plan of plans) {
      const { path, snap, action } = plan;
      switch (action.kind) {
        case 'take': {
          const changed = !snap || !!snap.deleted || snap.text !== action.remote.text;
          await this.#commit(path, snap, vault.id, {
            text: action.remote.text,
            base: action.remote.text,
            baseRev: action.remote.rev,
            dirty: false,
          });
          if (changed) result.pulled.push(path);
          break;
        }
        case 'merge':
          if (action.text === action.remote.text) {
            await this.#commit(path, snap, vault.id, {
              text: action.text,
              base: action.text,
              baseRev: action.remote.rev,
              dirty: false,
            });
            if (action.text !== snap?.text) result.pulled.push(path);
            break;
          }
          if (hold) {
            // Keep the merge here (the person fixes it); upload once it validates.
            await this.#commit(path, snap, vault.id, {
              text: action.text,
              base: action.remote.text,
              baseRev: action.remote.rev,
              dirty: true,
            });
            if (action.text !== snap?.text) result.pulled.push(path);
          } else uploads.push(plan);
          break;
        case 'conflict': {
          const conflict: SyncConflict = {
            path,
            base: snap?.base ?? null,
            local: snap?.text ?? '',
            remote: action.remote.text,
            merged: action.merged,
            remoteRev: action.remote.rev,
          };
          result.conflicts.push(conflict);
          break;
        }
        case 'clean':
          await this.#commit(path, snap, vault.id, {
            text: snap!.text,
            base: snap!.base,
            baseRev: snap!.baseRev,
            dirty: false,
          });
          break;
        case 'dropLocal':
        case 'purge':
          await this.#commit(path, snap, vault.id, null);
          result.deleted.push(path);
          break;
        case 'upload':
        case 'deleteRemote':
          if (!hold) uploads.push(plan);
          break;
      }
    }

    // -------------------------------------------------------------- upload
    done = 0;
    this.#progress(vault.id, 'uploading', uploads.length ? 0 : 1);
    await pool(uploads, writes, async ({ path, snap, action }) => {
      try {
        if (action.kind === 'deleteRemote') {
          try {
            await provider.delete(path, action.rev);
          } catch (e) {
            if (!(e instanceof RemoteNotFound)) throw e;
          }
          await this.#commit(path, snap, vault.id, null);
          result.deleted.push(path);
        } else if (action.kind === 'upload' || action.kind === 'merge') {
          const rev = action.kind === 'upload' ? action.rev : action.remote.rev;
          const { rev: newRev } = await provider.write(path, action.text, rev);
          await this.#commit(path, snap, vault.id, {
            text: action.text,
            base: action.text,
            baseRev: newRev,
            dirty: false,
          });
          result.pushed.push(path);
          if (action.kind === 'merge' && action.text !== snap?.text) result.pulled.push(path);
        }
      } catch (e) {
        if (!(e instanceof RemoteConflict) && !(e instanceof RemoteNotFound)) throw e;
        // Another device got there first: keep the merge locally (still pending
        // against the remote version it was based on) and merge again next round.
        if (action.kind === 'merge')
          await this.#commit(path, snap, vault.id, {
            text: action.text,
            base: action.remote.text,
            baseRev: action.remote.rev,
            dirty: true,
          });
        again = true;
      }
      done += 1;
      this.#progress(vault.id, 'uploading', done / uploads.length);
    });

    result.pulled.sort();
    result.pushed.sort();
    result.deleted.sort();
    return { result, again };
  }

  /** What to do with one path. `remote` is the downloaded text when the remote changed. */
  #decide(
    snap: StoredFile | undefined,
    rev: string | undefined,
    remote: Remote | undefined,
  ): Action | null {
    const synced = snap?.baseRev != null;
    if (rev === undefined) {
      // ---- not on the remote
      if (!snap) return null;
      if (snap.deleted) return { kind: 'purge' };
      if (!synced) return { kind: 'upload', text: snap.text, rev: null };
      if (!snap.dirty) return { kind: 'dropLocal' };
      // Edited here, deleted there: keep the edit (uploads as a new file).
      return { kind: 'upload', text: snap.text, rev: null };
    }
    if (rev === snap?.baseRev) {
      // ---- remote unchanged since the last sync
      if (!snap.dirty) return null;
      if (snap.deleted) return { kind: 'deleteRemote', rev };
      if (snap.text === snap.base) return { kind: 'clean' };
      return { kind: 'upload', text: snap.text, rev };
    }
    // ---- remote changed (or new to us)
    if (!remote) return null;
    if (!snap || !snap.dirty) return { kind: 'take', remote };
    if (snap.deleted) {
      // Deleted here: a real remote edit wins; an unchanged text means the delete stands.
      if (snap.base !== null && remote.text === snap.base)
        return { kind: 'deleteRemote', rev: remote.rev };
      return { kind: 'take', remote };
    }
    const result = merge3(snap.base ?? '', snap.text, remote.text, {
      // Two independently created files: let the person decide instead of concatenating.
      unionInsertions: snap.base !== null && (this.#opts.unionInsertions ?? true),
    });
    if (!result.clean) return { kind: 'conflict', remote, merged: result.text };
    return { kind: 'merge', remote, text: result.text };
  }

  /**
   * Store the outcome for one path, unless the person edited it while the
   * sync ran: then their edit is kept and rebased onto the outcome when that
   * merges cleanly (still pending), or left alone for the next sync.
   */
  async #commit(
    path: string,
    snap: StoredFile | undefined,
    vaultId: string,
    next: Pick<StoredFile, 'text' | 'base' | 'baseRev' | 'dirty'> | null,
  ): Promise<void> {
    const now = this.#now();
    await updateFile(this.store, vaultId, path, (cur) => {
      if (!changedSince(cur, snap)) {
        if (next === null) return cur ? null : undefined;
        const { deleted: _deleted, ...rest } = cur ?? { vaultId, path, modifiedAt: now };
        const textChanged = !cur || !!cur.deleted || cur.text !== next.text;
        return { ...rest, ...next, modifiedAt: textChanged ? now : (cur?.modifiedAt ?? now) };
      }
      // Edited during the sync.
      if (!cur || cur.deleted) return undefined;
      if (next === null) return { ...cur, base: null, baseRev: null, dirty: true };
      const from = snap && !snap.deleted ? snap.text : '';
      const rebased = merge3(from, cur.text, next.text, { unionInsertions: !!snap });
      if (!rebased.clean) return undefined;
      return { ...cur, text: rebased.text, base: next.base, baseRev: next.baseRev, dirty: true };
    });
  }

  async #setConflicted(vault: VaultRecord, conflicted: boolean) {
    vault.conflicted = conflicted;
    const current = (await this.store.getVault(vault.id)) ?? vault;
    await this.store.putVault({ ...current, conflicted });
  }
}

function changedSince(cur: StoredFile | undefined, snap: StoredFile | undefined): boolean {
  if (!cur || !snap) return !!cur !== !!snap;
  return (
    cur.modifiedAt !== snap.modifiedAt ||
    cur.text !== snap.text ||
    !!cur.deleted !== !!snap.deleted ||
    cur.dirty !== snap.dirty
  );
}
