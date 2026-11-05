<script lang="ts">
  // Journal statistics, all from hledger (no full transaction list needed):
  // `stats` for the summary, `balance --count` for activity and busiest accounts.
  import { parseHledgerJson } from '$lib/engine/decode/json';
  import { decodeBalance, decodePeriodic, type HBalanceReport, type HPeriodicReport } from '$lib/engine/decode/reports';
  import { decodeStats } from '$lib/engine/decode/text';
  import { app } from '../../state/app.svelte';
  import { router } from '../../state/router.svelte';
  import { reportFilters as f } from '../../state/reports.svelte';
  import { columnLabel } from '../../lib/periods';
  import BarChart from '../../components/charts/BarChart.svelte';
  import RankBars from '../../components/charts/RankBars.svelte';

  let text = $state('');
  let summary = $state.raw<ReturnType<typeof decodeStats> | null>(null);
  let months = $state.raw<{ label: string; n: number }[]>([]);
  let busiest = $state.raw<{ name: string; value: number }[]>([]);

  $effect(() => {
    const rev = app.revision;
    const range = f.range;
    const words = f.words;
    if (!rev || !app.engine) return;
    const engine = app.engine;
    const period = [...(range.begin ? ['-b', range.begin] : []), ...(range.end ? ['-e', range.end] : [])];
    (async () => {
      const st = await engine.raw(['stats', ...period, ...words]);
      text = st.code === 0 ? st.stdout.replace(/^Runtime stats.*$/m, '').trim() : st.stderr;
      summary = st.code === 0 ? decodeStats(st.stdout) : null;
      const act = await engine.raw(['balance', '--count', '-M', '--depth', '1', ...period, ...words, '-O', 'json']);
      if (act.code === 0) {
        const r = decodePeriodic(parseHledgerJson<HPeriodicReport>(act.stdout));
        months = r.columns.map((c, i) => ({ label: columnLabel(c.begin, c.end), n: Number(r.totals.amounts[i]?.[0]?.quantity ?? 0) }));
      }
      const acc = await engine.raw(['balance', '--count', '--flat', ...period, ...words, '-O', 'json']);
      if (acc.code === 0) busiest = decodeBalance(parseHledgerJson<HBalanceReport>(acc.stdout)).rows.map((r) => ({ name: r.account, value: Number(r.amount[0]?.quantity ?? 0) }));
    })();
  });

  const postings = $derived(months.reduce((n, m) => n + m.n, 0));
  const perMonth = $derived(summary && months.length ? (summary.transactions / months.length).toFixed(1) : '0');
</script>

<section class="tiles" aria-label="Summary">
  <div class="tile card"><p class="label">Transactions</p><p class="big num">{summary?.transactions ?? '…'}</p></div>
  <div class="tile card"><p class="label">Postings</p><p class="big num">{postings}</p></div>
  <div class="tile card"><p class="label">Per month</p><p class="big num">{perMonth}</p></div>
  <div class="tile card"><p class="label">Span</p><p class="mid num">{summary?.firstDate ?? '—'} → {summary?.lastDate ?? '—'}</p></div>
</section>

<section class="card card-pad" aria-labelledby="act-h">
  <h2 id="act-h">Postings per month</h2>
  {#if months.length}
    <BarChart title="Postings per month" labels={months.map((m) => m.label)} series={[{ name: 'Postings', color: 'var(--chart-1)', values: months.map((m) => m.n) }]} format={(v) => `${v} postings`} />
  {:else}<p class="muted">No activity in this period.</p>{/if}
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
