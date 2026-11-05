// The transaction window: which recent transactions the app loads up front.
import type { JournalStats } from '../contracts/engine';

/** Aim for this many transactions in the initial window. */
export const WINDOW_TXNS = 500;

/** Start of a window holding about `count` of the latest transactions, or null for all. */
export function windowStart(stats: JournalStats, count: number): string | null {
  if (!stats.firstDate || !stats.lastDate || stats.transactions <= count) return null;
  const first = Date.parse(stats.firstDate);
  const last = Date.parse(stats.lastDate);
  const days = Math.max(1, (last - first) / 86400000);
  const span = Math.max(31, Math.ceil((days * count) / stats.transactions));
  const start = new Date(last - span * 86400000);
  const iso = `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, '0')}-01`;
  return iso <= stats.firstDate ? null : iso;
}
