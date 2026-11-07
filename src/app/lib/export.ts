// Export a report as CSV, produced by hledger itself (`-O csv`) for exactly the
// options the screen is showing.
import type { QueryOpts } from '$lib/contracts/engine';
import { queryArgs } from '$lib/engine/args';
import { app } from '../state/app.svelte';
import { toasts } from '../state/toast.svelte';

export function saveFile(name: string, text: string, type = 'text/csv') {
  const blob = new Blob([text], { type: `${type};charset=utf-8` });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** e.g. exportCsv(['balance', '--flat'], opts, 'balances') */
export async function exportCsv(command: string[], opts: QueryOpts, name: string) {
  if (!app.engine) return;
  const r = await app.engine.raw([...command, ...queryArgs(opts), '-O', 'csv']);
  if (r.code !== 0) {
    toasts.show(r.stderr.replace(/^hledger: Error: /, '').split('\n')[0] ?? 'Export failed', { tone: 'error' });
    return;
  }
  const stamp = new Date().toISOString().slice(0, 10);
  saveFile(`${name}-${stamp}.csv`, r.stdout);
}
