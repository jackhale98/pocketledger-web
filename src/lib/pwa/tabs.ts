// Several tabs on the same vault: one edits, the others follow (ported from
// mycelium-web src/app/tabs.ts + the follower logic in its app state).
//
// Every tab keeps the vault in memory and a save writes a whole file, so two
// tabs editing the same journal would overwrite each other. The tab that
// opened the vault last — or the one where the person pressed "Edit here" —
// claims it over a BroadcastChannel; the others become read-only followers
// and reload from IndexedDB whenever the editing tab says it saved.
//
// Sync additionally runs under a Web Lock (`navigator.locks`) per vault, so
// two tabs never sync the same vault at once even during a hand-over.

export type TabRole = 'editor' | 'follower';

export type TabMessage =
  /** A tab now edits this vault; any other tab on it follows. */
  | { type: 'claim'; vault: string; tab: string }
  /** The editing tab wrote to this vault (files, sync, settings). */
  | { type: 'changed'; vault: string; tab: string; paths?: string[] };

export const TAB_CHANNEL = 'pocketledger-tabs';

export interface TabCoordinatorOptions {
  /** Role changes for the open vault (e.g. show the "Edit here" banner for 'follower'). */
  onRole?: (role: TabRole, vaultId: string) => void;
  /**
   * The editing tab saved: reload from storage. Called at most every
   * `reloadMs` while a burst of saves continues (default 400 ms after the
   * last, and at least every 2 s).
   */
  onChanged?: (vaultId: string, paths: string[] | null) => void;
  channelName?: string;
  reloadMs?: number;
  /** `null` disables cross-tab messages (for tests / non-browser hosts). */
  BroadcastChannel?: typeof BroadcastChannel | null;
  /** Defaults to `navigator.locks`. */
  locks?: LockManager | undefined;
  id?: string;
}

export class TabCoordinator {
  readonly id: string;
  readonly #o: TabCoordinatorOptions;
  #channel: BroadcastChannel | null = null;
  #vault: string | null = null;
  #role: TabRole = 'editor';
  #timer: ReturnType<typeof setTimeout> | null = null;
  #since = 0;
  #paths: Set<string> | null = new Set();

  constructor(options: TabCoordinatorOptions = {}) {
    this.#o = options;
    this.id = options.id ?? globalThis.crypto?.randomUUID?.() ?? String(Math.random()).slice(2);
    const BC =
      options.BroadcastChannel !== undefined
        ? options.BroadcastChannel
        : (globalThis as { BroadcastChannel?: typeof BroadcastChannel }).BroadcastChannel;
    if (!BC) return;
    this.#channel = new BC(options.channelName ?? TAB_CHANNEL);
    this.#channel.onmessage = (e: MessageEvent<TabMessage>) => {
      if (e.data && e.data.tab !== this.id) this.#receive(e.data);
    };
  }

  get vault(): string | null {
    return this.#vault;
  }

  get role(): TabRole {
    return this.#role;
  }

  /** May this tab write to the open vault? Check before every save. */
  get canEdit(): boolean {
    return this.#role === 'editor';
  }

  /** This tab opened a vault: it becomes the editor, others on it follow. */
  open(vaultId: string): void {
    this.#vault = vaultId;
    this.#setRole('editor');
    this.#post({ type: 'claim', vault: vaultId, tab: this.id });
  }

  /** "Edit here": take the vault over. Reload from storage first if you were following. */
  editHere(): void {
    if (this.#vault) this.open(this.#vault);
  }

  /** The vault was closed in this tab. */
  leave(): void {
    this.#vault = null;
    this.#clearTimer();
    this.#setRole('editor');
  }

  /** Tell followers this tab saved (call after every write to storage). */
  changed(paths?: string[]): void {
    if (!this.#vault || this.#role !== 'editor') return;
    this.#post({
      type: 'changed',
      vault: this.#vault,
      tab: this.id,
      ...(paths ? { paths } : {}),
    });
  }

  /**
   * Run `fn` holding this vault's sync lock (exclusive across tabs). Without
   * Web Locks it just runs. With `ifAvailable`, resolves `null` instead of
   * waiting when another tab is syncing.
   */
  async withSyncLock<T>(
    vaultId: string,
    fn: () => Promise<T>,
    options: { ifAvailable?: boolean } = {},
  ): Promise<T | null> {
    const locks =
      this.#o.locks ?? (globalThis.navigator as { locks?: LockManager } | undefined)?.locks;
    if (!locks) return fn();
    return locks.request(
      `pocketledger-sync-${vaultId}`,
      { mode: 'exclusive', ifAvailable: !!options.ifAvailable },
      async (lock) => (lock ? fn() : null),
    ) as Promise<T | null>;
  }

  close(): void {
    this.#clearTimer();
    this.#channel?.close();
    this.#channel = null;
  }

  #receive(m: TabMessage) {
    if (m.vault !== this.#vault) return;
    if (m.type === 'claim') {
      this.#setRole('follower');
      return;
    }
    // Coalesce a burst of saves into one reload.
    const now = Date.now();
    if (this.#paths) {
      if (m.paths) for (const p of m.paths) this.#paths.add(p);
      else this.#paths = null;
    }
    if (!this.#timer) this.#since = now;
    this.#clearTimer();
    const quiet = this.#o.reloadMs ?? 400;
    const wait = Math.max(0, Math.min(quiet, this.#since + 5 * quiet - now));
    this.#timer = setTimeout(() => {
      this.#timer = null;
      const paths = this.#paths ? [...this.#paths].sort() : null;
      this.#paths = new Set();
      if (this.#vault === m.vault) this.#o.onChanged?.(m.vault, paths);
    }, wait);
  }

  #clearTimer() {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  #setRole(role: TabRole) {
    if (role === this.#role) return;
    this.#role = role;
    if (this.#vault) this.#o.onRole?.(role, this.#vault);
  }

  #post(message: TabMessage) {
    try {
      this.#channel?.postMessage(message);
    } catch {
      // Closed (the page is going away): nothing to tell.
    }
  }
}
