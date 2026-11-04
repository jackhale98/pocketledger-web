import { afterEach, describe, expect, it, vi } from 'vitest';
import { TabCoordinator, type TabRole } from '$lib/pwa/tabs';

const wait = (ms = 20) => new Promise((r) => setTimeout(r, ms));

describe('TabCoordinator', () => {
  const tabs: TabCoordinator[] = [];
  afterEach(() => {
    for (const t of tabs.splice(0)) t.close();
  });

  function tab(name: string, log: string[], reloadMs = 10) {
    const t = new TabCoordinator({
      id: name,
      channelName: `test-${Math.random()}`,
      reloadMs,
      onRole: (role: TabRole, vault) => log.push(`${name} ${role} ${vault}`),
      onChanged: (vault, paths) => log.push(`${name} reload ${vault} ${paths?.join(',') ?? '*'}`),
    });
    tabs.push(t);
    return t;
  }

  it('the tab that opens a vault last edits; the other follows until "Edit here"', async () => {
    const log: string[] = [];
    const channelName = `tabs-${Math.random()}`;
    const mk = (id: string) => {
      const t = new TabCoordinator({
        id,
        channelName,
        reloadMs: 10,
        onRole: (role, vault) => log.push(`${id} ${role} ${vault}`),
        onChanged: (vault, paths) => log.push(`${id} reload ${vault} ${paths?.join(',') ?? '*'}`),
      });
      tabs.push(t);
      return t;
    };
    const a = mk('A');
    const b = mk('B');
    a.open('v1');
    await wait();
    expect(a.canEdit).toBe(true);
    b.open('v1');
    await wait();
    expect(b.canEdit).toBe(true);
    expect(a.canEdit).toBe(false);
    expect(a.role).toBe('follower');
    expect(log).toEqual(['A follower v1']);

    // Saves in the editing tab make the follower reload once per burst.
    b.changed(['main.journal']);
    b.changed(['2026.journal']);
    await wait(60);
    expect(log.at(-1)).toBe('A reload v1 2026.journal,main.journal');
    // A follower's own "changed" is ignored (it must not write).
    a.changed(['x.journal']);
    await wait(60);
    expect(log.filter((l) => l.startsWith('B reload'))).toEqual([]);

    a.editHere();
    await wait();
    expect(a.canEdit).toBe(true);
    expect(b.canEdit).toBe(false);
    expect(log.slice(-2)).toEqual(['A editor v1', 'B follower v1']);
  });

  it('ignores other vaults and works without BroadcastChannel', async () => {
    const log: string[] = [];
    const a = tab('A', log);
    a.open('v1');
    expect(a.canEdit).toBe(true);
    const lonely = new TabCoordinator({ BroadcastChannel: null });
    tabs.push(lonely);
    lonely.open('v1');
    lonely.changed();
    expect(lonely.canEdit).toBe(true);
    lonely.leave();
    expect(lonely.vault).toBeNull();
  });

  it('runs sync under an exclusive Web Lock when available', async () => {
    const order: string[] = [];
    let held = Promise.resolve();
    const locks = {
      request: vi.fn(async (_name: string, opts: { ifAvailable?: boolean }, cb: (l: unknown) => Promise<unknown>) => {
        const prev = held;
        let release!: () => void;
        held = new Promise<void>((r) => (release = r));
        await prev;
        try {
          return await cb(opts.ifAvailable ? {} : {});
        } finally {
          release();
        }
      }),
    } as unknown as LockManager;
    const t = new TabCoordinator({ locks, BroadcastChannel: null });
    tabs.push(t);
    await Promise.all([
      t.withSyncLock('v1', async () => {
        order.push('a start');
        await wait(5);
        order.push('a end');
      }),
      t.withSyncLock('v1', async () => {
        order.push('b');
      }),
    ]);
    expect(order).toEqual(['a start', 'a end', 'b']);
    expect(locks.request).toHaveBeenCalledWith(
      'pocketledger-sync-v1',
      { mode: 'exclusive', ifAvailable: false },
      expect.any(Function),
    );
    const none = new TabCoordinator({ BroadcastChannel: null, locks: undefined });
    tabs.push(none);
    expect(await none.withSyncLock('v1', async () => 42)).toBe(42);
  });
});
