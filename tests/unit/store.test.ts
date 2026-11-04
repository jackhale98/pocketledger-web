import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoredFile, VaultRecord } from '$lib/contracts/storage';
import { DB_NAME, IdbVaultStore, requestPersistence, vaultSecretKey } from '$lib/store/db';
import { MemoryVaultStore } from '$lib/store/memory';

const vault = (id: string, lastOpenedAt = 1): VaultRecord => ({
  id,
  name: `Vault ${id}`,
  provider: 'dropbox',
  rootFile: 'main.journal',
  createdAt: 1,
  lastOpenedAt,
  remote: { kind: 'dropbox', folder: '/Finance', cursor: null },
});

const file = (vaultId: string, path: string, text = 'x\n'): StoredFile => ({
  vaultId,
  path,
  text,
  base: null,
  baseRev: null,
  dirty: true,
  modifiedAt: 1,
});

for (const [name, make] of [
  ['IdbVaultStore (fake-indexeddb)', () => new IdbVaultStore({ indexedDB: new IDBFactory() })],
  ['MemoryVaultStore', () => new MemoryVaultStore()],
] as const) {
  describe(name, () => {
    let store: IdbVaultStore | MemoryVaultStore;
    beforeEach(() => {
      store = make();
    });
    afterEach(async () => {
      if (store instanceof IdbVaultStore) await store.close();
    });

    it('stores vaults, most recently opened first', async () => {
      await store.putVault(vault('a', 1));
      await store.putVault(vault('b', 5));
      expect((await store.listVaults()).map((v) => v.id)).toEqual(['b', 'a']);
      expect(await store.getVault('a')).toEqual(vault('a', 1));
      await store.putVault({ ...vault('a', 9), conflicted: true });
      expect((await store.getVault('a'))?.conflicted).toBe(true);
      expect(await store.getVault('nope')).toBeUndefined();
    });

    it('stores files per vault', async () => {
      await store.putFiles([file('a', 'z.journal'), file('a', 'b/a.journal'), file('b', 'main.journal')]);
      expect((await store.listFiles('a')).map((f) => f.path)).toEqual(['b/a.journal', 'z.journal']);
      expect(await store.getFile('b', 'main.journal')).toEqual(file('b', 'main.journal'));
      await store.deleteFile('a', 'z.journal');
      expect((await store.listFiles('a')).map((f) => f.path)).toEqual(['b/a.journal']);
      await store.putFiles([{ ...file('a', 'b/a.journal', 'y\n'), dirty: false, base: 'y\n', baseRev: 'r1' }]);
      expect(await store.getFile('a', 'b/a.journal')).toMatchObject({ text: 'y\n', baseRev: 'r1' });
    });

    it('deleting a vault removes its files and secrets only', async () => {
      await store.putVault(vault('a'));
      await store.putVault(vault('b'));
      await store.putFiles([file('a', 'main.journal'), file('b', 'main.journal')]);
      await store.setSecret(vaultSecretKey('a', 'dropbox'), 'tok-a');
      await store.setSecret(vaultSecretKey('b', 'dropbox'), 'tok-b');
      await store.setSecret('global', 'g');
      await store.deleteVault('a');
      expect(await store.getVault('a')).toBeUndefined();
      expect(await store.listFiles('a')).toEqual([]);
      expect(await store.listFiles('b')).toHaveLength(1);
      expect(await store.getSecret(vaultSecretKey('a', 'dropbox'))).toBeUndefined();
      expect(await store.getSecret(vaultSecretKey('b', 'dropbox'))).toBe('tok-b');
      expect(await store.getSecret('global')).toBe('g');
    });

    it('keeps settings and secrets apart', async () => {
      await store.setSetting('theme', { dark: true });
      expect(await store.getSetting('theme')).toEqual({ dark: true });
      expect(await store.getSecret('theme')).toBeUndefined();
      await store.setSecret('tok', 'abc');
      expect(await store.getSetting('tok')).toBeUndefined();
      expect(await store.getSecret('tok')).toBe('abc');
      await store.setSecret('tok', null);
      expect(await store.getSecret('tok')).toBeUndefined();
      await store.setSetting('theme', undefined);
      expect(await store.getSetting('theme')).toBeUndefined();
    });

    it('updateFile reads and writes atomically', async () => {
      await store.putFiles([file('a', 'main.journal', 'one\n')]);
      const out = await store.updateFile('a', 'main.journal', (cur) => ({ ...cur!, text: `${cur!.text}two\n` }));
      expect(out?.text).toBe('one\ntwo\n');
      expect(await store.updateFile('a', 'main.journal', () => undefined)).toMatchObject({ text: 'one\ntwo\n' });
      expect(await store.updateFile('a', 'main.journal', () => null)).toBeUndefined();
      expect(await store.getFile('a', 'main.journal')).toBeUndefined();
      await expect(
        store.updateFile('a', 'x.journal', () => {
          throw new Error('nope');
        }),
      ).rejects.toThrow('nope');
    });

    it('stores plain copies (callers can keep mutating their objects)', async () => {
      const v = vault('a');
      await store.putVault(v);
      v.name = 'changed';
      expect((await store.getVault('a'))?.name).toBe('Vault a');
    });
  });
}

describe('IdbVaultStore', () => {
  it('uses the pocketledger database and persists across instances', async () => {
    const idb = new IDBFactory();
    const a = new IdbVaultStore({ indexedDB: idb });
    expect(a.name).toBe(DB_NAME);
    await a.putVault(vault('a'));
    await a.close();
    const b = new IdbVaultStore({ indexedDB: idb });
    expect(await b.getVault('a')).toEqual(vault('a'));
    const names = (await idb.databases()).map((d) => d.name);
    expect(names).toContain('pocketledger');
    await b.close();
  });

  it('fails clearly without IndexedDB', () => {
    vi.stubGlobal('indexedDB', undefined);
    try {
      expect(() => new IdbVaultStore()).toThrow(/IndexedDB/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('requestPersistence', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('asks for persistent storage once', async () => {
    const persist = vi.fn(async () => true);
    vi.stubGlobal('navigator', { storage: { persisted: async () => false, persist } });
    expect(await requestPersistence()).toBe(true);
    expect(persist).toHaveBeenCalledTimes(1);
  });
  it('is false where unsupported or refused', async () => {
    vi.stubGlobal('navigator', {});
    expect(await requestPersistence()).toBe(false);
    vi.stubGlobal('navigator', {
      storage: {
        persisted: async () => {
          throw new Error('no');
        },
      },
    });
    expect(await requestPersistence()).toBe(false);
  });
});
