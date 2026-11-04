import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_WAIT, nextCheckDelay, SAVE_DATA_WAIT, SyncScheduler } from '$lib/sync/schedule';

describe('nextCheckDelay', () => {
  it('backs off while quiet, capped', () => {
    expect(nextCheckDelay({ base: 60_000, quiet: 0, saveData: false })).toBe(60_000);
    expect(nextCheckDelay({ base: 60_000, quiet: 1, saveData: false })).toBe(120_000);
    expect(nextCheckDelay({ base: 60_000, quiet: 10, saveData: false })).toBe(MAX_WAIT);
    expect(nextCheckDelay({ base: 60_000, quiet: 0, saveData: true })).toBe(SAVE_DATA_WAIT);
  });
});

describe('SyncScheduler', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const flush = () => vi.advanceTimersByTimeAsync(0);

  it('syncs on start, debounced after saves, on online, and periodically', async () => {
    const target = new EventTarget();
    let online = true;
    const run = vi.fn(async () => false);
    const s = new SyncScheduler({
      run,
      target,
      debounceMs: 1000,
      intervalMs: 60_000,
      isOnline: () => online,
      isVisible: () => true,
      saveData: () => false,
    });
    s.start();
    await flush();
    expect(run).toHaveBeenCalledTimes(1);

    // A burst of saves syncs once, after the pause.
    s.saved();
    await vi.advanceTimersByTimeAsync(500);
    s.saved();
    await vi.advanceTimersByTimeAsync(999);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);

    // Offline: the periodic check doesn't call run; coming online does.
    online = false;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    const calls = run.mock.calls.length;
    online = true;
    target.dispatchEvent(new Event('online'));
    await flush();
    expect(run).toHaveBeenCalledTimes(calls + 1);

    s.stop();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(run).toHaveBeenCalledTimes(calls + 1);
  });

  it('stretches the interval while nothing changes and resets after a change', async () => {
    const changes = [false, false, false, true, false];
    const times: number[] = [];
    const run = vi.fn(async () => {
      times.push(Date.now());
      return changes.shift() ?? false;
    });
    const s = new SyncScheduler({
      run,
      target: null,
      intervalMs: 60_000,
      isOnline: () => true,
      isVisible: () => true,
      saveData: () => false,
    });
    const t0 = Date.now();
    s.start();
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    s.stop();
    const gaps = times.slice(1).map((t, i) => t - times[i]!);
    expect(times[0]).toBe(t0);
    // quiet 1 → 1 min, quiet 2 → 2 min, quiet 3 → 4 min; after the change back to 1 min.
    expect(gaps.slice(0, 4)).toEqual([60_000, 120_000, 240_000, 60_000]);
  });

  it('joins a running sync and runs once more afterwards', async () => {
    let release!: () => void;
    const run = vi.fn(
      () =>
        new Promise<boolean>((r) => {
          release = () => r(true);
        }),
    );
    const s = new SyncScheduler({ run, target: null, isOnline: () => true, isVisible: () => true });
    s.start();
    await flush();
    void s.syncNow();
    void s.syncNow();
    expect(run).toHaveBeenCalledTimes(1);
    release();
    await flush();
    expect(run).toHaveBeenCalledTimes(2);
    release();
    await flush();
    expect(run).toHaveBeenCalledTimes(2);
    s.stop();
  });

  it('reports errors and keeps going', async () => {
    const onError = vi.fn();
    const run = vi.fn(async () => {
      throw new Error('boom');
    });
    const s = new SyncScheduler({ run, onError, target: null, isOnline: () => true, isVisible: () => true });
    s.start();
    await flush();
    expect(onError).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run).toHaveBeenCalledTimes(2);
    s.stop();
  });
});
