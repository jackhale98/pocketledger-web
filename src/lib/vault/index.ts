import type { VaultSnapshot } from '../contracts/engine';

/** Files the engine needs. hledger resolves `include` itself. */
export const ENGINE_EXTENSIONS = ['.journal', '.hledger', '.ledger', '.j', '.rules', '.csv', '.prices', '.timeclock', '.timedot'];
export const JOURNAL_EXTENSIONS = ['.journal', '.hledger', '.ledger', '.j', '.prices'];

export const isEngineFile = (path: string) =>
  ENGINE_EXTENSIONS.some((e) => path.toLowerCase().endsWith(e)) && !path.split('/').some((p) => p.startsWith('.'));
export const isJournalFile = (path: string) => JOURNAL_EXTENSIONS.some((e) => path.toLowerCase().endsWith(e));

/** Fast, stable content hash (FNV-1a 64-bit over paths and contents). */
export function snapshotRevision(files: Record<string, string>, rootFile = ''): string {
  let h1 = 0x811c9dc5 | 0;
  let h2 = 0xcbf29ce4 | 0;
  const feed = (s: string) => {
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 0x01000193);
      h2 = Math.imul(h2 ^ c, 0x01000193) ^ (h1 >>> 15);
    }
  };
  feed(rootFile);
  for (const k of Object.keys(files).sort()) {
    feed('\u0000' + k + '\u0001');
    feed(files[k]!);
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

export function makeSnapshot(files: Record<string, string>, rootFile: string): VaultSnapshot {
  const engineFiles: Record<string, string> = {};
  for (const [p, t] of Object.entries(files)) if (isEngineFile(p)) engineFiles[p] = t;
  return { rootFile, files: engineFiles, revision: snapshotRevision(engineFiles, rootFile) };
}

/** Pick the most likely root journal among a set of files. */
export function guessRootFile(paths: string[]): string | null {
  const journals = paths.filter(isJournalFile);
  const prefer = ['main.journal', 'all.journal', 'ledger.journal', 'hledger.journal', '.hledger.journal'];
  for (const p of prefer) if (journals.includes(p)) return p;
  const top = journals.filter((p) => !p.includes('/'));
  return (top[0] ?? journals[0]) || null;
}
