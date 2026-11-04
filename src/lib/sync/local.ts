// The local side of sync: how the app records edits so they upload later.
//
// Every save goes through `saveLocal`, which keeps the three-way merge base
// (`base`/`baseRev`) and sets the pending-upload flag (`dirty`). Because the
// flag lives in IndexedDB with the text, pending uploads survive going
// offline, closing the tab and reloading.

import type { StoredFile, VaultStore } from '$lib/contracts/storage';
import type { FileUpdate } from '$lib/store/db';

export interface LocalChange {
  path: string;
  /** New text, or `null` to delete the file. */
  text: string | null;
}

/** A store that can do an atomic read-modify-write (IdbVaultStore, MemoryVaultStore). */
export interface AtomicStore extends VaultStore {
  updateFile(
    vaultId: string,
    path: string,
    fn: (current: StoredFile | undefined) => FileUpdate,
  ): Promise<StoredFile | undefined>;
}

export function isAtomic(store: VaultStore): store is AtomicStore {
  return typeof (store as Partial<AtomicStore>).updateFile === 'function';
}

/** Read-modify-write one file, atomically when the store supports it. */
export async function updateFile(
  store: VaultStore,
  vaultId: string,
  path: string,
  fn: (current: StoredFile | undefined) => FileUpdate,
): Promise<StoredFile | undefined> {
  if (isAtomic(store)) return store.updateFile(vaultId, path, fn);
  const current = await store.getFile(vaultId, path);
  const next = fn(current);
  if (next === null) {
    await store.deleteFile(vaultId, path);
    return undefined;
  }
  if (next === undefined) return current;
  await store.putFiles([next]);
  return next;
}

/** The record after a local edit (pure; exported for tests). */
export function applyLocalEdit(
  current: StoredFile | undefined,
  vaultId: string,
  change: LocalChange,
  now: number,
): FileUpdate {
  if (change.text === null) {
    if (!current) return undefined;
    // Never synced: nothing to delete remotely, just forget it.
    if (current.baseRev === null) return null;
    return { ...current, text: '', deleted: true, dirty: true, modifiedAt: now };
  }
  if (!current) {
    return {
      vaultId,
      path: change.path,
      text: change.text,
      base: null,
      baseRev: null,
      dirty: true,
      modifiedAt: now,
    };
  }
  if (!current.deleted && current.text === change.text) return undefined;
  // Edited back to exactly what was last synced: nothing to upload.
  const dirty = current.baseRev === null || current.base !== change.text;
  const { deleted: _deleted, ...rest } = current;
  return { ...rest, text: change.text, dirty, modifiedAt: now };
}

/** Save edits from the app (autosave, new transactions, deletes). */
export async function saveLocal(
  store: VaultStore,
  vaultId: string,
  changes: LocalChange[],
  now: () => number = Date.now,
): Promise<void> {
  for (const change of changes) {
    await updateFile(store, vaultId, change.path, (cur) =>
      applyLocalEdit(cur, vaultId, change, now()),
    );
  }
}

/** The vault's current texts (tombstones left out), e.g. for an engine snapshot. */
export async function localTexts(store: VaultStore, vaultId: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const f of await store.listFiles(vaultId)) if (!f.deleted) out[f.path] = f.text;
  return out;
}

/** How many files wait to be uploaded (or deleted remotely). */
export async function pendingCount(
  store: VaultStore,
  vaultId: string,
  include: (path: string) => boolean = () => true,
): Promise<number> {
  return (await store.listFiles(vaultId)).filter((f) => f.dirty && include(f.path)).length;
}
