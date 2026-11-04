// When to sync: shortly after a save (debounced), as soon as the device comes
// back online or the app returns to the foreground, and periodically while it
// is open. Periodic checks stretch out while nothing changes (or the remote
// can't be reached), so an idle app open on a phone costs little; any change
// or edit starts over. Ported from mycelium-web src/lib/sync/schedule.ts
// (nextCheckDelay) plus the timer wiring that lived in its app state.

const MINUTE = 60_000;
/** The longest wait between checks normally… */
export const MAX_WAIT = 5 * MINUTE;
/** …and when the device asks to save data. */
export const SAVE_DATA_WAIT = 10 * MINUTE;
export const SAVE_DATA_MAX_WAIT = 15 * MINUTE;

export interface CheckPace {
  /** The usual interval (e.g. 1 minute for Dropbox). */
  base: number;
  /** Checks in a row that found nothing new, or failed. */
  quiet: number;
  /** The browser asked to save data (`navigator.connection.saveData`). */
  saveData: boolean;
}

export function nextCheckDelay({ base, quiet, saveData }: CheckPace): number {
  const start = saveData ? Math.max(base, SAVE_DATA_WAIT) : base;
  const cap = Math.max(start, saveData ? SAVE_DATA_MAX_WAIT : MAX_WAIT);
  return Math.min(cap, start * 2 ** Math.min(quiet, 8));
}

/** Whether the browser reports Data Saver (Chrome on Android; not Safari). */
export function saveDataOn(): boolean {
  const c = (globalThis.navigator as { connection?: { saveData?: boolean } } | undefined)
    ?.connection;
  return !!c?.saveData;
}

function onlineNow(): boolean {
  const n = globalThis.navigator as { onLine?: boolean } | undefined;
  return n?.onLine ?? true;
}

/** What one scheduled sync reports back: did anything change (pulled/pushed)? */
export type RunOutcome = boolean | { changed: boolean } | null | void;

export interface SchedulerOptions {
  /** Do one sync. Resolve `true` (or `{changed: true}`) when something changed. */
  run: () => Promise<RunOutcome>;
  /** Wait after the last save before syncing (default 2 s). */
  debounceMs?: number;
  /** Periodic check interval while things change (default 1 min). */
  intervalMs?: number;
  /**
   * Where `online` and `visibilitychange` are listened for. Default: `online`
   * on `window`, `visibilitychange` on `document` (when present).
   */
  target?: EventTarget | null;
  /** Defaults to `navigator.onLine`. */
  isOnline?: () => boolean;
  saveData?: () => boolean;
  /** Defaults to `document.visibilityState !== 'hidden'`. */
  isVisible?: () => boolean;
  onError?: (e: unknown) => void;
}

export class SyncScheduler {
  readonly #o: SchedulerOptions;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #debounce: ReturnType<typeof setTimeout> | null = null;
  #quiet = 0;
  #running: Promise<void> | null = null;
  #again = false;
  #started = false;
  readonly #onOnline = () => void this.syncNow();
  readonly #onVisible = () => {
    if (this.#visible()) {
      this.#quiet = 0;
      void this.syncNow();
    }
  };

  constructor(options: SchedulerOptions) {
    this.#o = options;
  }

  get started(): boolean {
    return this.#started;
  }

  get busy(): boolean {
    return this.#running !== null;
  }

  /** Start: sync now, then periodically; listen for `online` / foreground. */
  start(): void {
    if (this.#started) return;
    this.#started = true;
    const { online, visibility } = this.#targets();
    online?.addEventListener('online', this.#onOnline);
    visibility?.addEventListener('visibilitychange', this.#onVisible);
    void this.syncNow();
  }

  stop(): void {
    this.#started = false;
    const { online, visibility } = this.#targets();
    online?.removeEventListener('online', this.#onOnline);
    visibility?.removeEventListener('visibilitychange', this.#onVisible);
    if (this.#timer) clearTimeout(this.#timer);
    if (this.#debounce) clearTimeout(this.#debounce);
    this.#timer = this.#debounce = null;
  }

  /** Call after every local save: syncs once the edits pause. */
  saved(): void {
    if (!this.#started) return;
    this.#quiet = 0;
    if (this.#debounce) clearTimeout(this.#debounce);
    this.#debounce = setTimeout(() => {
      this.#debounce = null;
      void this.syncNow();
    }, this.#o.debounceMs ?? 2000);
  }

  /** Sync now (joins a running sync, then runs once more). Resolves when done. */
  syncNow(): Promise<void> {
    if (this.#running) {
      this.#again = true;
      return this.#running;
    }
    this.#running = this.#loop().finally(() => {
      this.#running = null;
      this.#schedule();
    });
    return this.#running;
  }

  async #loop(): Promise<void> {
    do {
      this.#again = false;
      if (!(this.#o.isOnline ?? onlineNow)()) return; // the `online` event brings us back
      try {
        const outcome = await this.#o.run();
        const changed = typeof outcome === 'boolean' ? outcome : !!outcome?.changed;
        this.#quiet = changed ? 0 : this.#quiet + 1;
      } catch (e) {
        this.#quiet += 1;
        this.#o.onError?.(e);
      }
    } while (this.#again && this.#started);
  }

  #schedule() {
    if (!this.#started) return;
    if (this.#timer) clearTimeout(this.#timer);
    const delay = nextCheckDelay({
      base: this.#o.intervalMs ?? MINUTE,
      quiet: Math.max(0, this.#quiet - 1),
      saveData: (this.#o.saveData ?? saveDataOn)(),
    });
    this.#timer = setTimeout(() => {
      this.#timer = null;
      // Hidden tabs wait for the visibilitychange instead of polling.
      if (this.#visible()) void this.syncNow();
      else this.#schedule();
    }, delay);
  }

  #visible(): boolean {
    if (this.#o.isVisible) return this.#o.isVisible();
    const d = (globalThis as { document?: { visibilityState?: string } }).document;
    return d?.visibilityState !== 'hidden';
  }

  #targets(): { online: EventTarget | null; visibility: EventTarget | null } {
    if (this.#o.target !== undefined) return { online: this.#o.target, visibility: this.#o.target };
    const g = globalThis as { window?: EventTarget; document?: EventTarget };
    return { online: g.window ?? null, visibility: g.document ?? null };
  }
}
