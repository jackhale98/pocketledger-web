<script lang="ts">
  // Market price history from the journal's P directives (`hledger prices`). Never downloaded.
  import { decodePrices, type PricePoint } from '$lib/engine/decode/text';
  import { app } from '../../state/app.svelte';
  import { reportFilters as f } from '../../state/reports.svelte';
  import LineChart from '../../components/charts/LineChart.svelte';

  let points = $state.raw<PricePoint[] | null>(null);
  let error = $state('');
  let selected = $state('');

  $effect(() => {
    const rev = app.revision;
    const range = f.range;
    if (!rev || !app.engine) return;
    const args = ['prices', '--infer-market-prices'];
    if (range.begin) args.push('-b', range.begin);
    if (range.end) args.push('-e', range.end);
    app.engine.raw(args).then((r) => {
      if (r.code !== 0) error = r.stderr.replace(/^hledger: Error: /, '');
      else {
        points = decodePrices(r.stdout);
        error = '';
      }
    });
  });

  const series = $derived.by(() => {
    const m = new Map<string, PricePoint[]>();
    for (const p of points ?? []) {
      const k = `${p.commodity}\u0000${p.in}`;
      m.set(k, [...(m.get(k) ?? []), p]);
    }
    return [...m.entries()]
      .map(([k, pts]) => {
        const [commodity, inC] = k.split('\u0000') as [string, string];
        const sorted = [...pts].sort((a, b) => (a.date < b.date ? -1 : 1));
        const first = Number(sorted[0]!.quantity);
        const last = Number(sorted[sorted.length - 1]!.quantity);
        return { key: k, commodity, in: inC, pts: sorted, last: sorted[sorted.length - 1]!, change: first ? ((last - first) / first) * 100 : 0 };
      })
      .sort((a, b) => a.commodity.localeCompare(b.commodity));
  });
  const current = $derived(series.find((s) => s.key === selected) ?? series[0]);
</script>

{#if error}
  <p class="card card-pad neg">{error}</p>
{:else if !points}
  <div class="card card-pad"><div class="skeleton" style="height:200px"></div></div>
{:else if series.length === 0}
  <div class="card card-pad empty">
    <h3>No prices in this period</h3>
    <p class="muted">PocketLedger never downloads prices. Add market prices to a journal with <code>P</code> directives, e.g. <code>P 2026-11-01 EUR $1.12</code>; costs written with <code>@</code> are used too.</p>
  </div>
{:else}
  <div class="card list">
    <table>
      <caption class="sr-only">Latest prices</caption>
      <thead><tr><th scope="col">Commodity</th><th scope="col">Latest</th><th scope="col">Date</th><th scope="col">Change</th></tr></thead>
      <tbody>
        {#each series as s (s.key)}
          <tr class:sel={current?.key === s.key}>
            <th scope="row"><button type="button" class="link" onclick={() => (selected = s.key)} aria-pressed={current?.key === s.key}>{s.commodity}</button></th>
            <td class="num">{s.last.price}</td>
            <td class="num" class:muted={current?.key !== s.key}>{s.last.date}</td>
            <td class="num" class:pos={s.change > 0} class:neg={s.change < 0}>{s.pts.length > 1 ? `${s.change > 0 ? '+' : ''}${s.change.toFixed(1)}%` : '—'}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
  {#if current}
    <section class="card card-pad" aria-labelledby="ph">
      <h2 id="ph">{current.commodity} in {current.in}</h2>
      <LineChart title="Price of {current.commodity} in {current.in}" labels={current.pts.map((p) => p.date.slice(2))} values={current.pts.map((p) => Number(p.quantity))} format={(v) => `${v.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${current.in}`} />
      <p class="muted small">{current.pts.length} price point{current.pts.length === 1 ? '' : 's'}, from P directives and transaction costs.</p>
    </section>
  {/if}
{/if}

<style>
  .list { overflow-x: auto; margin-bottom: 12px; }
  table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
  th, td { padding: 10px 12px; border-bottom: 1px solid var(--border); text-align: right; white-space: nowrap; }
  th:first-child { text-align: left; }
  thead th { font-size: 0.75rem; color: var(--text-3); font-weight: 650; }
  tr.sel th, tr.sel td { background: var(--accent-soft); }
  .link { background: none; border: 0; padding: 0; font-weight: 650; color: var(--text); }
  section { min-width: 0; }
  h2 { font-size: 1rem; margin-bottom: 10px; }
  .small { font-size: 0.8rem; margin-top: 6px; }
  .empty { display: grid; gap: 8px; }
  code { font-family: var(--mono); font-size: 0.85em; }
</style>
