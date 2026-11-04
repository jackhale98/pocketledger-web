import { describe, expect, it } from 'vitest';
import type { StoredFile } from '$lib/contracts/storage';
import { MemoryVaultStore } from '$lib/store/memory';
import { applyLocalEdit, localTexts, pendingCount, saveLocal } from '$lib/sync/local';

const synced: StoredFile = {
  vaultId: 'v',
  path: 'main.journal',
  text: 'a\n',
  base: 'a\n',
  baseRev: 'r1',
  dirty: false,
  modifiedAt: 1,
};

describe('local edits', () => {
  it('marks edits dirty and keeps the merge base', () => {
    expect(applyLocalEdit(synced, 'v', { path: 'main.journal', text: 'b\n' }, 2)).toEqual({
      ...synced,
      text: 'b\n',
      dirty: true,
      modifiedAt: 2,
    });
  });

  it('creates new files as pending with no base', () => {
    expect(applyLocalEdit(undefined, 'v', { path: 'n.journal', text: 'n\n' }, 2)).toEqual({
      vaultId: 'v',
      path: 'n.journal',
      text: 'n\n',
      base: null,
      baseRev: null,
      dirty: true,
      modifiedAt: 2,
    });
  });

  it('tombstones synced files and forgets unsynced ones', () => {
    expect(applyLocalEdit(synced, 'v', { path: 'main.journal', text: null }, 2)).toMatchObject({
      deleted: true,
      dirty: true,
      baseRev: 'r1',
    });
    expect(
      applyLocalEdit({ ...synced, baseRev: null, base: null }, 'v', { path: 'main.journal', text: null }, 2),
    ).toBeNull();
    expect(applyLocalEdit(undefined, 'v', { path: 'x', text: null }, 2)).toBeUndefined();
  });

  it('un-deletes a tombstone when the file is written again', () => {
    const tomb = { ...synced, text: '', deleted: true, dirty: true };
    const next = applyLocalEdit(tomb, 'v', { path: 'main.journal', text: 'c\n' }, 3);
    expect(next).toMatchObject({ text: 'c\n', dirty: true });
    expect(next && 'deleted' in next).toBe(false);
  });

  it('saveLocal, localTexts and pendingCount work together', async () => {
    const store = new MemoryVaultStore();
    await store.putFiles([synced]);
    await saveLocal(store, 'v', [
      { path: 'main.journal', text: 'a\nb\n' },
      { path: 'other.journal', text: 'o\n' },
    ]);
    expect(await pendingCount(store, 'v')).toBe(2);
    await saveLocal(store, 'v', [{ path: 'main.journal', text: null }]);
    expect(await localTexts(store, 'v')).toEqual({ 'other.journal': 'o\n' });
  });
});
