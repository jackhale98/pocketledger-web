// The app's real engine traffic on large journals, timed per call:
// engine time (hledger in wasm), output size, and JS decode time.
//   PERF=1 ENGINE=reactor npx vitest run tests/perf
//   SIZES=example,5000,20000 (default)
import { describe, it } from 'vitest';
import { appendFileSync, readFileSync } from 'node:fs';
import { makeBackend, hasWasm } from '../helpers/engine';
import { HledgerEngine } from '../../src/lib/engine/hledger-engine';
import type { EngineBackend } from '../../src/lib/engine/backend';
import { makeSnapshot } from '../../src/lib/vault';
import { makeJournal } from './make-journal';
import { windowStart, WINDOW_TXNS } from '../../src/lib/vault/window';

const SIZES = (process.env.SIZES ?? 'example,5000,20000').split(',');

async function bench(label: string, text: string) {
  const inner = await makeBackend();
  const runs: { ms: number; bytes: number }[] = [];
  const backend: EngineBackend = {
    mode: inner.mode,
    mount: (f) => inner.mount(f),
    run: async (args) => {
      const t = performance.now();
      const r = await inner.run(args);
      runs.push({ ms: performance.now() - t, bytes: r.stdout.length });
      return r;
    },
  };
  const e = new HledgerEngine(backend);
  const snap = makeSnapshot({ 'main.journal': text }, 'main.journal');
  const step = async (name: string, fn: () => Promise<unknown>) => {
    const before = runs.length;
    const t = performance.now();
    await fn();
    const total = performance.now() - t;
    const eng = runs.slice(before).reduce((s, r) => s + r.ms, 0);
    const kb = runs.slice(before).reduce((s, r) => s + r.bytes, 0) / 1024;
    const line =
      `${label.padEnd(8)} ${name.padEnd(34)} total ${total.toFixed(0).padStart(6)} ms  engine ${eng.toFixed(0).padStart(6)} ms  js ${(total - eng).toFixed(0).padStart(5)} ms  out ${kb.toFixed(0).padStart(6)} KB`;
    console.log(line);
    if (process.env.PERF_OUT) appendFileSync(process.env.PERF_OUT, line + '\n');
  };
  const year = { begin: '2025-01-01', end: '2026-01-01' };
  let begin: string | null = null;
  await step('load (stats: parse + checks)', async () => {
    const r = await e.load(snap);
    if (r.ok) begin = windowStart(r.stats, WINDOW_TXNS);
  });
  await step(`window print (since ${begin ?? 'start'})`, () => e.transactions(begin ? { period: { begin } } : {}));
  await step('payees', () => e.payees());
  await step('accounts --types', () => e.accounts());
  await step('commodities', () => e.commodities());
  await step('accounts tree', () => e.balance({ tree: true }));
  await step('overview: net worth -M -H', () =>
    e.periodicBalance({ query: ['type:AL'], period: { ...year, interval: 'monthly' }, accumulation: 'historical', valueIn: '$', depth: 1 }),
  );
  await step('overview: is -M depth 1', () => e.incomeStatement({ period: { ...year, interval: 'monthly' }, valueIn: '$', depth: 1 }));
  await step('overview: breakdown', () => e.balance({ query: ['acct:^expenses(:|$)'], period: year, valueIn: '$', depth: 2 }));
  await step('statements: bs depth 2', () => e.balanceSheet({ period: year, depth: 2 }));
  await step('budget one month', () => e.budget({ period: { begin: '2025-06-01', end: '2025-07-01', interval: 'monthly' } }));
  await step('register checking (12 months, -H)', () => e.register('assets:checking', { period: { begin: '2025-01-01' }, accumulation: 'historical' }));
  await step('search "coffee" (expr query)', () => e.transactions({ query: ['expr:desc:coffee or acct:coffee or note:coffee or code:coffee'] }));
  await step('print acct:dining', () => e.transactions({ query: ['acct:dining'] }));
  const snap2 = makeSnapshot({ 'main.journal': text + '\n2025-12-31 Saved\n    expenses:coffee  $3\n    assets:cash\n' }, 'main.journal');
  await step('SAVE: load+window+payees+accts+comm', async () => {
    const r = await e.load(snap2);
    const b = r.ok ? windowStart(r.stats, WINDOW_TXNS) : null;
    await e.transactions(b ? { period: { begin: b } } : {});
    await e.payees();
    await e.accounts();
    await e.commodities();
  });
}

describe.skipIf(!hasWasm || !process.env.PERF)('app engine traffic on large journals', () => {
  for (const s of SIZES)
    it(`journal: ${s}`, async () => {
      const text = s === 'example' ? readFileSync('tests/fixtures/example.hledger', 'utf8') : makeJournal(Number(s));
      await bench(s, text);
    }, 600_000);
});
