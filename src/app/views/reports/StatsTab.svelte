<script lang="ts">
  // Journal statistics: hledger's own `stats`, plus activity and busiest accounts.
  import { app } from '../../state/app.svelte';
  import { router } from '../../state/router.svelte';
  import { reportFilters as f } from '../../state/reports.svelte';
  import BarChart from '../../components/charts/BarChart.svelte';
  import RankBars from '../../components/charts/RankBars.svelte';

  let text = $state('');
  $effect(() => {
    const rev = app.revision;
    const range = f.range;
    const words = f.words;
    if (!rev || !app.engine) return;
    const args = ['stats', ...words];
    if (range.begin) args.push('-b', range.begin);
    if (range.end) args.push('-e', range.end);
    app.engine.raw(args).then((r) => (text = r.code === 0 ? r.stdout.replace(/^Runtime stats.*$/m, '').trim() : r.stderr));
  });

  const txns = $derived.by(() => {
    const { begin, end } = f.range;
    return app.txns.filter((t) => (!begin || t.date >= begin) && (!end || t.date < end));
  });
  const months = $derived.by(() => {
    const m = new Map<string, number>();
    for (const t of txns) m.set(t.date.slice(0, 7), (m.get(t.date.slice(0, 7)) ?? 0) + 1);
    return [...m.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
  });
  const busiest = $derived.by(() => {
    const m = new Map<string, number>();
    for (const t of txns) for (const p of t.postings) m.set(p.account, (m.get(p.account) ?? 0) + 1);
    return [...m.entries()].map(([name, value]) => ({ name, value }));
  });
  const postings = $derived(txns.reduce((n, t) => n + t.postings.length, 0));
  const first = $derived(txns[0]?.date ?? '—');
  const last = $derived(txns[txns.length - 1]?.date ?? '—');
  const perMonth = $derived(months.length ? (txns.length / months.length).toFixed(1) : '0');
</script>

<section class="tiles" aria-label="Summary">
  <div class="tile card"><p class="label">Transactions</p><p class="big num">{txns.length}</p></div>
  <div class="tile card"><p class="label">Postings</p><p class="big num">{postings}</p></div>
  <div class="tile card"><p class="label">Per month</p><p class="big num">{perMonth}</p></div>
  <div class="tile card"><p class="label">Span</p><p class="mid num">{first} → {last}</p></div>
</section>

<section class="card card-pad" aria-labelledby="act-h">
  <h2 id="act-h">Activity</h2>
  {#if months.length}
    <BarChart title="Transactions per month" labels={months.map(([m]) => m.slice(2))} series={[{ name: 'Transactions', color: 'var(--chart-1)', values: months.map(([, n]) => n) }]} format={(v) => `${v} transactions`} />
  {:else}<p class="muted">No transactions in this period.</p>{/if}
</section>

<section class="card card-pad" aria-labelledby="busy-h">
  <h2 id="busy-h">Busiest accounts</h2>
  <RankBars items={busiest} format={(v) => `${v} postings`} max={8} onpick={(n) => router.go('account', n)} />
</section>

<section class="card card-pad" aria-labelledby="hs-h">
  <h2 id="hs-h">hledger stats</h2>
  <pre>{text || '…'}</pre>
</section>

<style>
  .tiles { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin-bottom: 12px; }
  .tile { padding: 14px 16px; display: grid; gap: 4px; min-width: 0; }
  .big { font-size: 1.4rem; font-weight: 750; }
  .mid { font-size: 0.95rem; font-weight: 650; }
  section { margin-bottom: 12px; min-width: 0; }
  h2 { font-size: 1rem; margin-bottom: 10px; }
  pre { margin: 0; font-family: var(--mono); font-size: 0.78rem; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--text-2); }
  @media (min-width: 760px) { .tiles { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
</style>
