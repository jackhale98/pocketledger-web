// Pending uploads survive going offline and reloading; edits made while a
// sync runs are never overwritten.

import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import type { SyncProvider } from '$lib/contracts/storage';
import { IdbVaultStore } from '$lib/store/db';
import { VaultSyncEngine } from '$lib/sync/engine';
import { pendingCount, saveLocal } from '$lib/sync/local';
import { Device, FakeProvider, tick, vaultRecord } from './helpers/sync-fakes';

describe('offline queue', () => {
  it('keeps edits pending through an offline sync and a reload, then uploads them', async () => {
    const remote = new FakeProvider();
    remote.put('main.journal', 'a\n');
    const idb = new IDBFactory();
    const vault = vaultRecord();
    let store = new IdbVaultStore({ indexedDB: idb });
    await store.putVault(vault);
    let engine = new VaultSyncEngine({ store, now: tick });
    await engine.sync(vault, remote);

    remote.offline = true;
    await saveLocal(store, vault.id, [{ path: 'main.journal', text: 'a\nb\n' }], tick);
    await saveLocal(store, vault.id, [{ path: 'new.journal', text: 'n\n' }], tick);
    await expect(engine.sync(vault, remote)).rejects.toThrow(TypeError);
    expect(await pendingCount(store, vault.id)).toBe(2);

    // "Reload": a fresh store and engine over the same database.
    await store.close();
    store = new IdbVaultStore({ indexedDB: idb });
    engine = new VaultSyncEngine({ store, now: tick });
    expect(await pendingCount(store, vault.id)).toBe(2);

    remote.offline = false;
    const r = await engine.sync(vault, remote);
    expect(r.pushed).toEqual(['main.journal', 'new.journal']);
    expect(remote.text('main.journal')).toBe('a\nb\n');
    expect(await pendingCount(store, vault.id)).toBe(0);
    await store.close();
  });

  it('an upload that fails half way leaves the rest pending', async () => {
    const remote = new FakeProvider();
    const dev = new Device(remote, { concurrency: 1 });
    await dev.edit('a.journal', 'a\n');
    await dev.edit('b.journal', 'b\n');
    let n = 0;
    remote.beforeWrite = () => {
      if (++n === 2) remote.offline = true;
    };
    const flaky: SyncProvider = {
      kind: 'dropbox',
      list: () => remote.list(),
      read: (p) => remote.read(p),
      write: async (p, t, r) => {
        remote.beforeWrite?.(p);
        if (remote.offline) throw new TypeError('Failed to fetch');
        return remote.write(p, t, r);
      },
      delete: (p, r) => remote.delete(p, r),
      revision: () => remote.revision(),
    };
    const engine = new VaultSyncEngine({ store: dev.store, now: tick });
    // Writes run with up to 4 in parallel; the second fails.
    await expect(engine.sync(dev.vault, flaky)).rejects.toThrow(TypeError);
    expect((await dev.pending()).length).toBeGreaterThanOrEqual(1);
    remote.offline = false;
    remote.beforeWrite = null;
    await dev.sync();
    expect(await dev.pending()).toEqual([]);
    expect(remote.text('a.journal')).toBe('a\n');
    expect(remote.text('b.journal')).toBe('b\n');
  });
});

describe('edits during a sync', () => {
  it('keeps an edit made while the file was being uploaded (and uploads it next time)', async () => {
    const remote = new FakeProvider();
    remote.put('main.journal', 'a\n');
    const dev = new Device(remote);
    await dev.sync();
    await dev.edit('main.journal', 'a\nb\n');
    remote.beforeWrite = () => {
      remote.beforeWrite = null;
      void dev.edit('main.journal', 'a\nb\nc\n');
    };
    await dev.sync();
    expect(remote.text('main.journal')).toBe('a\nb\n');
    expect(await dev.text('main.journal')).toBe('a\nb\nc\n');
    expect(await dev.pending()).toEqual(['main.journal']);
    const f = await dev.store.getFile('v1', 'main.journal');
    expect(f?.base).toBe('a\nb\n');
    await dev.sync();
    expect(remote.text('main.journal')).toBe('a\nb\nc\n');
    expect(await dev.pending()).toEqual([]);
  });

  it('rebases an edit made while a remote change was being pulled', async () => {
    const remote = new FakeProvider();
    remote.put('main.journal', 'a\nb\nc\nd\n');
    const dev = new Device(remote);
    await dev.sync();
    remote.put('main.journal', 'A\nb\nc\nd\n');
    const slow: SyncProvider = {
      kind: 'dropbox',
      list: () => remote.list(),
      read: async (p) => {
        const r = await remote.read(p);
        await dev.edit('main.journal', 'a\nb\nc\nD\n');
        return r;
      },
      write: (p, t, r) => remote.write(p, t, r),
      delete: (p, r) => remote.delete(p, r),
      revision: () => remote.revision(),
    };
    await dev.engine.sync(dev.vault, slow);
    expect(await dev.text('main.journal')).toBe('A\nb\nc\nD\n');
    expect(await dev.pending()).toEqual(['main.journal']);
    await dev.sync();
    expect(remote.text('main.journal')).toBe('A\nb\nc\nD\n');
  });
});

describe('syncIfChanged', () => {
  it('skips the listing when nothing is pending and the revision is unchanged', async () => {
    const remote = new FakeProvider();
    remote.put('main.journal', 'a\n');
    const dev = new Device(remote);
    expect(await dev.engine.syncIfChanged(dev.vault, remote)).not.toBeNull();
    const lists = remote.lists;
    expect(await dev.engine.syncIfChanged(dev.vault, remote)).toBeNull();
    expect(remote.lists).toBe(lists);

    await dev.edit('main.journal', 'b\n');
    expect((await dev.engine.syncIfChanged(dev.vault, remote))?.pushed).toEqual(['main.journal']);
    // After our own upload it checks once more, then goes quiet.
    expect(await dev.engine.syncIfChanged(dev.vault, remote)).not.toBeNull();
    expect(await dev.engine.syncIfChanged(dev.vault, remote)).toBeNull();

    remote.put('main.journal', 'c\n');
    expect((await dev.engine.syncIfChanged(dev.vault, remote))?.pulled).toEqual(['main.journal']);
  });
});
