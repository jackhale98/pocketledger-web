import { describe, expect, it } from 'vitest';
import { RemoteNotFound, type SyncProvider } from '$lib/contracts/storage';
import type { SyncConflict } from '$lib/sync/engine';
import { Device, FakeProvider } from './helpers/sync-fakes';

const J = (s: string) => `${s}\n`;

describe('VaultSyncEngine: basics', () => {
  it('downloads the remote on first sync, ignoring non-journal files and hidden folders', async () => {
    const remote = new FakeProvider();
    remote.put('main.journal', J('include 2026.journal'));
    remote.put('2026.journal', J('2026-01-01 x'));
    remote.put('notes.md', 'hi');
    remote.put('.git/HEAD', 'ref');
    const dev = new Device(remote);
    const r = await dev.sync();
    expect(r.pulled).toEqual(['2026.journal', 'main.journal']);
    expect(await dev.paths()).toEqual(['2026.journal', 'main.journal']);
    expect(await dev.pending()).toEqual([]);
    const f = await dev.store.getFile('v1', 'main.journal');
    expect(f).toMatchObject({ base: 'include 2026.journal\n', dirty: false });
    expect(f?.baseRev).toBe(remote.files.get('main.journal')?.rev);
  });

  it('uploads local edits and new files, then has nothing to do', async () => {
    const remote = new FakeProvider();
    remote.put('main.journal', J('a'));
    const dev = new Device(remote);
    await dev.sync();
    await dev.edit('main.journal', J('a\nb'));
    await dev.edit('new.journal', J('n'));
    expect(await dev.pending()).toEqual(['main.journal', 'new.journal']);
    const r = await dev.sync();
    expect(r.pushed).toEqual(['main.journal', 'new.journal']);
    expect(remote.text('main.journal')).toBe('a\nb\n');
    expect(remote.text('new.journal')).toBe('n\n');
    expect(await dev.pending()).toEqual([]);
    const reads = remote.reads;
    const again = await dev.sync();
    expect(again).toEqual({ pulled: [], pushed: [], deleted: [], conflicts: [], invalid: [] });
    // Our own uploads are not downloaded again.
    expect(remote.reads).toBe(reads);
  });

  it('does not upload a file edited back to its synced text', async () => {
    const remote = new FakeProvider();
    remote.put('main.journal', J('a'));
    const dev = new Device(remote);
    await dev.sync();
    await dev.edit('main.journal', J('b'));
    await dev.edit('main.journal', J('a'));
    expect(await dev.pending()).toEqual([]);
    expect((await dev.sync()).pushed).toEqual([]);
    expect(remote.writes).toBe(0);
  });

  it('carries edits from one device to another', async () => {
    const remote = new FakeProvider();
    remote.put('main.journal', J('a'));
    const phone = new Device(remote);
    const laptop = new Device(remote);
    await phone.sync();
    await laptop.sync();
    await laptop.edit('main.journal', J('a\nlaptop'));
    await laptop.sync();
    const r = await phone.sync();
    expect(r.pulled).toEqual(['main.journal']);
    expect(await phone.text('main.journal')).toBe('a\nlaptop\n');
  });

  it('merges edits to different lines made on two devices', async () => {
    const base = '2026-01-01 one\n    a  1\n    b\n\n2026-01-02 two\n    a  2\n    b\n';
    const remote = new FakeProvider();
    remote.put('main.journal', base);
    const phone = new Device(remote);
    const laptop = new Device(remote);
    await phone.sync();
    await laptop.sync();
    await laptop.edit('main.journal', base.replace('a  1', 'a  10'));
    await laptop.sync();
    await phone.edit('main.journal', base.replace('a  2', 'a  20'));
    const r = await phone.sync();
    expect(r.conflicts).toEqual([]);
    const merged = base.replace('a  1', 'a  10').replace('a  2', 'a  20');
    expect(await phone.text('main.journal')).toBe(merged);
    expect(remote.text('main.journal')).toBe(merged);
    expect(r.pulled).toEqual(['main.journal']);
    expect(r.pushed).toEqual(['main.journal']);
    await laptop.sync();
    expect(await laptop.text('main.journal')).toBe(merged);
  });

  it('keeps both devices’ appended transactions', async () => {
    const base = '2026-01-01 open\n    a  1\n    b\n';
    const remote = new FakeProvider();
    remote.put('main.journal', base);
    const phone = new Device(remote);
    const laptop = new Device(remote);
    await phone.sync();
    await laptop.sync();
    await laptop.edit('main.journal', `${base}\n2026-01-02 laptop\n    a  2\n    b\n`);
    await laptop.sync();
    await phone.edit('main.journal', `${base}\n2026-01-03 phone\n    a  3\n    b\n`);
    const r = await phone.sync();
    expect(r.conflicts).toEqual([]);
    const text = remote.text('main.journal')!;
    expect(text).toContain('laptop');
    expect(text).toContain('phone');
  });

  it('reports overlapping edits as conflicts (with markers) until resolved', async () => {
    const remote = new FakeProvider();
    remote.put('main.journal', J('2026-01-01 title'));
    const phone = new Device(remote);
    const laptop = new Device(remote);
    await phone.sync();
    await laptop.sync();
    await laptop.edit('main.journal', J('2026-01-01 laptop title'));
    await laptop.sync();
    await phone.edit('main.journal', J('2026-01-01 phone title'));
    const r = await phone.sync();
    expect(r.conflicts).toHaveLength(1);
    const c = r.conflicts[0]! as SyncConflict;
    expect(c).toMatchObject({
      path: 'main.journal',
      base: '2026-01-01 title\n',
      local: '2026-01-01 phone title\n',
      remote: '2026-01-01 laptop title\n',
    });
    expect(c.merged).toContain('<<<<<<< local');
    expect(c.merged).toContain('>>>>>>> remote');
    expect(c.remoteRev).toBe(remote.files.get('main.journal')?.rev);
    // Nothing uploaded or overwritten while it is open, and the next sync still reports it.
    expect(remote.text('main.journal')).toBe('2026-01-01 laptop title\n');
    expect(await phone.text('main.journal')).toBe('2026-01-01 phone title\n');
    expect((await phone.sync()).conflicts).toHaveLength(1);
    expect(await phone.pending()).toEqual(['main.journal']);

    await expect(phone.engine.resolve('v1', c, c.merged)).rejects.toThrow(/conflict markers/);
    await phone.engine.resolve('v1', c, J('2026-01-01 both titles'));
    const resolved = await phone.sync();
    expect(resolved.conflicts).toEqual([]);
    expect(resolved.pushed).toEqual(['main.journal']);
    expect(remote.text('main.journal')).toBe('2026-01-01 both titles\n');
    await laptop.sync();
    expect(await laptop.text('main.journal')).toBe('2026-01-01 both titles\n');
  });

  it('a resolution still merges if the remote moved on after the conflict', async () => {
    const remote = new FakeProvider();
    remote.put('main.journal', 'a\nb\nc\nd\ne\n');
    const phone = new Device(remote);
    await phone.sync();
    remote.put('main.journal', 'A1\nb\nc\nd\ne\n');
    await phone.edit('main.journal', 'A2\nb\nc\nd\ne\n');
    const c = (await phone.sync()).conflicts[0]!;
    await phone.engine.resolve('v1', c, 'A\nb\nc\nd\ne\n');
    remote.put('main.journal', 'A1\nb\nc\nd\nE\n');
    const r = await phone.sync();
    expect(r.conflicts).toEqual([]);
    expect(remote.text('main.journal')).toBe('A\nb\nc\nd\nE\n');
  });

  it('merges a change that lands remotely while uploading (RemoteConflict → another round)', async () => {
    const remote = new FakeProvider();
    remote.put('main.journal', 'one\ntwo\nthree\nfour\nfive\n');
    const dev = new Device(remote);
    await dev.sync();
    await dev.edit('main.journal', 'ONE\ntwo\nthree\nfour\nfive\n');
    remote.beforeWrite = () => {
      remote.beforeWrite = null;
      remote.put('main.journal', 'one\ntwo\nthree\nfour\nFIVE\n');
    };
    const r = await dev.sync();
    expect(r.conflicts).toEqual([]);
    expect(await dev.pending()).toEqual([]);
    expect(remote.text('main.journal')).toBe('ONE\ntwo\nthree\nfour\nFIVE\n');
    expect(await dev.text('main.journal')).toBe('ONE\ntwo\nthree\nfour\nFIVE\n');
  });

  it('two devices creating the same new file differently is a conflict, not a concatenation', async () => {
    const remote = new FakeProvider();
    const phone = new Device(remote);
    await phone.edit('2027.journal', J('phone'));
    remote.put('2027.journal', J('laptop'));
    const r = await phone.sync();
    expect(r.conflicts.map((c) => c.path)).toEqual(['2027.journal']);
    expect(r.conflicts[0]!.base).toBeNull();
  });

  it('matches remote paths case-insensitively when the provider says so', async () => {
    const remote = new FakeProvider();
    remote.put('Main.journal', J('a'));
    const dev = new Device(remote);
    await dev.sync();
    const p = remote as FakeProvider & { caseInsensitive: boolean };
    p.caseInsensitive = true;
    const rev = remote.files.get('Main.journal')!;
    remote.files.delete('Main.journal');
    remote.files.set('main.journal', { text: J('b'), rev: `${rev.rev}x` });
    await dev.sync();
    expect(await dev.paths()).toEqual(['Main.journal']);
    expect(await dev.text('Main.journal')).toBe('b\n');
  });

  it('reports progress phases', async () => {
    const remote = new FakeProvider();
    remote.put('main.journal', J('a'));
    const phases: string[] = [];
    const dev = new Device(remote, { onProgress: (p) => phases.push(p.phase) });
    await dev.sync();
    expect(phases[0]).toBe('listing');
    expect(phases).toContain('downloading');
    expect(phases.at(-1)).toBe('done');
  });

  it('serialises concurrent syncs of one vault', async () => {
    const remote = new FakeProvider();
    remote.put('main.journal', J('a'));
    const dev = new Device(remote);
    const [a, b] = await Promise.all([dev.sync(), dev.sync()]);
    expect(a.pulled).toEqual(['main.journal']);
    expect(b.pulled).toEqual([]);
    expect(remote.reads).toBe(1);
  });

  it('retries a download that vanished between listing and reading', async () => {
    const remote = new FakeProvider();
    remote.put('main.journal', J('a'));
    remote.put('gone.journal', J('g'));
    const flaky: SyncProvider = {
      kind: 'dropbox',
      list: () => remote.list(),
      read: async (path: string) => {
        if (path === 'gone.journal') {
          remote.remove('gone.journal');
          throw new RemoteNotFound(path);
        }
        return remote.read(path);
      },
      write: (p, t, r) => remote.write(p, t, r),
      delete: (p, r) => remote.delete(p, r),
      revision: () => remote.revision(),
    };
    const dev = new Device(remote);
    const r = await dev.engine.sync(dev.vault, flaky);
    expect(r.pulled).toEqual(['main.journal']);
    expect(await dev.paths()).toEqual(['main.journal']);
  });
});

describe('VaultSyncEngine: deletions', () => {
  it('deletes locally what was deleted remotely, unless it was edited here', async () => {
    const remote = new FakeProvider();
    remote.put('a.journal', J('a'));
    remote.put('b.journal', J('b'));
    const dev = new Device(remote);
    await dev.sync();
    remote.remove('a.journal');
    remote.remove('b.journal');
    await dev.edit('b.journal', J('b edited'));
    const r = await dev.sync();
    expect(r.deleted).toEqual(['a.journal']);
    expect(await dev.paths()).toEqual(['b.journal']);
    expect(remote.text('b.journal')).toBe('b edited\n');
  });

  it('deletes remotely what was deleted here', async () => {
    const remote = new FakeProvider();
    remote.put('a.journal', J('a'));
    const dev = new Device(remote);
    await dev.sync();
    await dev.edit('a.journal', null);
    expect(await dev.pending()).toEqual(['a.journal']);
    const r = await dev.sync();
    expect(r.deleted).toEqual(['a.journal']);
    expect(remote.text('a.journal')).toBeUndefined();
    expect(await dev.store.listFiles('v1')).toEqual([]);
  });

  it('forgets a file deleted on both sides', async () => {
    const remote = new FakeProvider();
    remote.put('a.journal', J('a'));
    const dev = new Device(remote);
    await dev.sync();
    remote.remove('a.journal');
    await dev.edit('a.journal', null);
    const r = await dev.sync();
    expect(r.deleted).toEqual(['a.journal']);
    expect(r.pushed).toEqual([]);
    expect(await dev.store.listFiles('v1')).toEqual([]);
    expect(remote.writes).toBe(0);
  });

  it('keeps a remote edit over a local delete', async () => {
    const remote = new FakeProvider();
    remote.put('a.journal', J('a'));
    const dev = new Device(remote);
    await dev.sync();
    remote.put('a.journal', J('a edited elsewhere'));
    await dev.edit('a.journal', null);
    const r = await dev.sync();
    expect(r.pulled).toEqual(['a.journal']);
    expect(await dev.text('a.journal')).toBe('a edited elsewhere\n');
    expect(remote.text('a.journal')).toBe('a edited elsewhere\n');
  });

  it('a new file deleted before it was ever synced just disappears', async () => {
    const remote = new FakeProvider();
    const dev = new Device(remote);
    await dev.edit('tmp.journal', J('x'));
    await dev.edit('tmp.journal', null);
    expect(await dev.store.listFiles('v1')).toEqual([]);
    await dev.sync();
    expect(remote.files.size).toBe(0);
  });
});
