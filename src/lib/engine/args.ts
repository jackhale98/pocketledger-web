import type { QueryOpts } from '../contracts/engine';

const INTERVAL_FLAG = { daily: '-D', weekly: '-W', monthly: '-M', quarterly: '-Q', yearly: '-Y' } as const;

/** Translate QueryOpts into hledger CLI flags (appended after the command name). */
export function queryArgs(opts: QueryOpts = {}): string[] {
  const a: string[] = [];
  const p = opts.period;
  if (p?.begin) a.push('-b', p.begin);
  if (p?.end) a.push('-e', p.end);
  if (p?.interval) a.push(INTERVAL_FLAG[p.interval]);
  if (opts.valueIn) a.push('-X', opts.valueIn);
  if (opts.depth != null) a.push('--depth', String(opts.depth));
  if (opts.cleared) a.push('-C');
  if (opts.pending) a.push('-P');
  if (opts.unmarked) a.push('-U');
  if (opts.forecast) a.push('--forecast');
  if (opts.auto) a.push('--auto');
  if (opts.date2) a.push('--date2');
  if (opts.accumulation === 'cumulative') a.push('--cumulative');
  if (opts.accumulation === 'historical') a.push('--historical');
  if (opts.query?.length) a.push(...opts.query.filter((q) => q.trim() !== ''));
  return a;
}

/** Split a raw hledger query string into argv words, honouring quotes ("a b", 'a b'). */
export function splitQuery(q: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  let has = false;
  for (const ch of q) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (cur || has) out.push(cur);
      cur = '';
      has = false;
    } else cur += ch;
  }
  if (cur || has) out.push(cur);
  return out;
}

/** Commands that may write files or reach the network are never run from the console. */
const WRITE_COMMANDS = new Set(['add', 'import', 'rewrite', 'close', 'web', 'ui', 'setup', 'iadd', 'run', 'repl']);
export function isReadOnlyCommand(args: string[]): boolean {
  const cmd = args.find((a) => !a.startsWith('-'));
  if (!cmd) return true;
  if (WRITE_COMMANDS.has(cmd)) return false;
  if (args.some((a) => a === '-o' || a.startsWith('--output-file') || a.startsWith('-o'))) return false;
  return true;
}
