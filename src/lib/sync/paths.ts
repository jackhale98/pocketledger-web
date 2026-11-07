// Which files take part in sync, and small path helpers shared by providers.

/** Extensions hledger journals and their companions use. */
export const SYNC_EXTENSIONS = ['.journal', '.hledger', '.ledger', '.j', '.rules', '.csv', '.prices'];

const EXT = new RegExp(`(?:${SYNC_EXTENSIONS.map((e) => e.replace('.', '\\.')).join('|')})$`, 'i');

/**
 * A vault-relative path is synced when it has a journal-ish extension and no
 * folder on the way is hidden (`.git/`, `.trash/`, …). Hidden *files* such as
 * `.private.journal` are allowed: only folders are excluded.
 */
export function syncable(path: string): boolean {
  if (!EXT.test(path) && path !== 'hledger.conf' && path !== '.hledger.conf') return false;
  const parts = path.split('/');
  return !parts.slice(0, -1).some((part) => part.startsWith('.'));
}

/** Normalise a vault-relative path: forward slashes, no leading `./` or `/`, no empty segments. */
export function normalizePath(path: string): string {
  return path
    .replace(/\\/g, '/')
    .split('/')
    .filter((p) => p !== '' && p !== '.')
    .join('/');
}

/** Reject paths that try to leave the vault. */
export function assertVaultPath(path: string): string {
  const p = normalizePath(path);
  if (!p || p.split('/').includes('..')) throw new Error(`Invalid vault path: ${path}`);
  return p;
}

/** Run `task` over `items`, `size` at a time. */
export async function pool<T>(items: readonly T[], size: number, task: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(size, items.length)) }, async () => {
      while (next < items.length) await task(items[next++]!);
    }),
  );
}
