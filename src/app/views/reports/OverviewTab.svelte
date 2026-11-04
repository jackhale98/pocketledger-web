<script lang="ts">
  import type { BalanceReport, PeriodicReport, StatementReport } from '$lib/contracts/engine';
  import { EngineCallError } from '$lib/engine/client';
  import { accountQuery } from '$lib/engine/hledger-engine';
  import { app } from '../../state/app.svelte';
  import { router, href } from '../../state/router.svelte';
  import { reportFilters as f } from '../../state/reports.svelte';
  import { columnLabel } from '../../lib/periods';
  import { chartCommodity, fmtIn, numberIn, otherCommodities } from '../../lib/primary';
  import BarChart from '../../components/charts/BarChart.svelte';
  import LineChart from '../../components/charts/LineChart.svelte';
  import RankBars from '../../components/charts/RankBars.svelte';
  import ErrorPanel from '../../components/ErrorPanel.svelte';
  import Icon from '../../components/Icon.svelte';

  let worth = $state.raw<PeriodicReport | null>(null);
  let flows = $state.raw<StatementReport | null>(null);
  let breakdown = $state.raw<BalanceReport | null>(null);
  let error = $state.raw<EngineCallError | null>(null);
  /** Drill-down path below the expense root, e.g. ['food']. */
  let path = $state<string[]>([]);
  let bdScope = $state<'last' | 'period'>('period');

  const commodity = $derived(app.revision ? chartCommodity() : '');
  const fmt = $derived(fmtIn(commodity));
  const fmt0 = $derived(fmtIn(commodity, 0));
  const expenseRoot = $derived(app.accounts.find((a) => a.type === 'X' && !a.name.includes(':'))?.name ?? 'expenses');
  const prefix = $derived([expenseRoot, ...path].join(':'));

  $effect(() => {
    const rev = app.revision;
    const c = commodity;
    const interval = f.chartInterval;
    const range = f.range;
    const words = f.words;
    const fc = f.forecast;
    if (!rev || !app.engine || !c) return;
    const engine = app.engine;
    const base = { valueIn: c, query: words, ...(fc ? { forecast: true } : {}) };
    error = null;
    (async () => {
      try {
        worth = await engine.periodicBalance({ ...base, query: ['type:AL', ...words], period: { ...range, interval }, accumulation: 'historical', depth: 1 });
        flows = await engine.incomeStatement({ ...base, period: { ...range, interval }, depth: 1 });
      } catch (e) {
        error = e instanceof EngineCallError ? e : new EngineCallError([{ kind: 'internal', message: (e as Error).message }]);
      }
    })();
  });

  // Breakdown: children of the current drill prefix, for the whole period or the latest column.
  $effect(() => {
    const rev = app.revision;
    const c = commodity;
    const p = prefix;
    const words = f.words;
    const fc = f.forecast;
    const cols = flows?.columns;
    const scope = bdScope;
    if (!rev || !app.engine || !c) return;
    const last = cols?.[cols.length - 1];
    const period = scope === 'last' && last ? { begin: last.begin, end: last.end } : f.range;
    app.engine
      .balance({ query: [accountQuery(p), ...words], period, valueIn: c, depth: p.split(':').length + 1, ...(fc ? { forecast: true } : {}) })
      .then((r) => (breakdown = r))
      .catch((e) => (error = e));
  });

  const first = $derived(app.stats?.firstDate ?? '');
  const skipW = $derived(worth ? Math.max(0, worth.columns.findIndex((c) => c.end > first)) : 0);
  const worthCols = $derived(worth ? worth.columns.slice(skipW) : []);
  const worthSeries = $derived(worth ? worth.totals.amounts.slice(skipW).map((m) => numberIn(m, commodity)) : []);
  const revenue = $derived(flows?.sections.find((s) => s.increasesTotal) ?? flows?.sections[0]);
  const expense = $derived(flows?.sections.find((s) => !s.increasesTotal) ?? flows?.sections[1]);
  const skipF = $derived(flows ? Math.max(0, flows.columns.findIndex((c) => c.end > first)) : 0);
  const flowCols = $derived(flows ? flows.columns.slice(skipF) : []);
  const incomeVals = $derived(revenue ? revenue.report.totals.amounts.slice(skipF).map((m) => numberIn(m, commodity)) : []);
  const expenseVals = $derived(expense ? expense.report.totals.amounts.slice(skipF).map((m) => numberIn(m, commodity)) : []);

  const depth = $derived(prefix.split(':').length + 1);
  const items = $derived(
    breakdown
      ? breakdown.rows
          .filter((r) => r.account.split(':').length === depth && r.account.startsWith(prefix + ':'))
          .map((r) => ({ name: r.account.slice(prefix.length + 1), value: numberIn(r.amount, commodity) }))
      : [],
  );
  const bdTotal = $derived(breakdown ? numberIn(breakdown.total, commodity) : 0);
  const hasChildren = (full: string) => app.accounts.some((a) => a.name.startsWith(full + ':'));
  function pick(name: string) {
    const full = `${prefix}:${name}`;
    if (hasChildren(full)) path = [...path, name];
    else router.go('account', full);
  }

  const netWorth = $derived(worthSeries[worthSeries.length - 1] ?? 0);
  const netWorthPrev = $derived(worthSeries[worthSeries.length - 2] ?? netWorth);
  const totalIncome = $derived(incomeVals.reduce((a, b) => a + b, 0));
  const totalExpense = $derived(expenseVals.reduce((a, b) => a + b, 0));
  const savingsRate = $derived(totalIncome > 0 ? Math.round(((totalIncome - totalExpense) / totalIncome) * 100) : null);
  const hidden = $derived(worth ? otherCommodities(worth.totals.amounts, commodity) : []);
  const intervalWord = $derived({ daily: 'day', weekly: 'week', monthly: 'month', quarterly: 'quarter', yearly: 'year' }[f.chartInterval]);

  function openStatement(i: number) {
    const c = flowCols[i];
    if (c) router.go('statements', '', { kind: 'is', begin: c.begin, end: c.end });
  }
</script>

<nav class="links" aria-label="Statements and analyses">
  <a class="card" href="{href('statements')}?kind=bs"><Icon name="scale" size={18} /> Balance sheet</a>
  <a class="card" href="{href('statements')}?kind=is"><Icon name="bars" size={18} /> Income statement</a>
  <a class="card" href="{href('statements')}?kind=cf"><Icon name="sync" size={18} /> Cash flow</a>
  <a class="card" href={href('budget')}><Icon name="target" size={18} /> Budget</a>
  <button class="card" type="button" onclick={() => { f.tab = 'prices'; f.save(); }}><Icon name="trend" size={18} /> Prices</button>
  <button class="card" type="button" onclick={() => { f.tab = 'stats'; f.save(); }}><Icon name="info" size={18} /> Statistics</button>
</nav>

{#if hidden.length}
  <p class="warn" role="status">
    <Icon name="info" size={16} /> Charts are valued in {commodity}. No price is known for {hidden.join(', ')}, so
    {hidden.length === 1 ? 'it is' : 'they are'} left out of chart totals. Add <code>P</code> price directives to include {hidden.length === 1 ? 'it' : 'them'}.
  </p>
{/if}

{#if error}
  <ErrorPanel title="hledger couldn't produce this report" errors={error.errors} />
{:else}
  <section class="tiles" aria-label="Summary">
    <div class="tile card">
      <p class="label">Net worth</p>
      <p class="big num">{worth ? fmt0(netWorth) : '…'}</p>
      {#if worth && worthSeries.length > 1}
        {@const d = netWorth - netWorthPrev}
        <p class="delta" class:pos={d >= 0} class:neg={d < 0}><Icon name={d >= 0 ? 'arrow-up' : 'arrow-down'} size={14} /> {fmt0(Math.abs(d))} this {intervalWord}</p>
      {/if}
    </div>
    <div class="tile card">
      <p class="label">Income</p>
      <p class="big num">{flows ? fmt0(totalIncome) : '…'}</p>
      <p class="delta muted">{flows ? `${fmt0(incomeVals[incomeVals.length - 1] ?? 0)} latest ${intervalWord}` : ''}</p>
    </div>
    <div class="tile card">
      <p class="label">Spending</p>
      <p class="big num">{flows ? fmt0(totalExpense) : '…'}</p>
      <p class="delta muted">{flows ? `${fmt0(expenseVals[expenseVals.length - 1] ?? 0)} latest ${intervalWord}` : ''}</p>
    </div>
    <div class="tile card">
      <p class="label">Savings rate</p>
      <p class="big num">{savingsRate == null ? '—' : `${savingsRate}%`}</p>
      <p class="delta muted">of income kept</p>
    </div>
  </section>

  <div class="grid">
    <section class="card card-pad wide" aria-labelledby="nw-h">
      <header><h2 id="nw-h">Net worth</h2><span class="muted">assets − liabilities, in {commodity}</span></header>
      {#if worth}
        <LineChart title="Net worth by {intervalWord}" labels={worthCols.map((c) => columnLabel(c.begin, c.end))} values={worthSeries} format={fmt} prefix={commodity.length === 1 ? commodity : ''} />
      {:else}<div class="skeleton" style="height:200px"></div>{/if}
    </section>

    <section class="card card-pad wide" aria-labelledby="ie-h">
      <header><h2 id="ie-h">Income vs spending</h2><span class="muted">tap a bar for its income statement</span></header>
      {#if flows}
        <BarChart
          title="Income and spending by {intervalWord}"
          labels={flowCols.map((c) => columnLabel(c.begin, c.end))}
          series={[
            { name: 'Income', color: 'var(--chart-1)', values: incomeVals },
            { name: 'Spending', color: 'var(--chart-2)', values: expenseVals },
          ]}
          format={fmt}
          prefix={commodity.length === 1 ? commodity : ''}
          onpick={openStatement}
        />
      {:else}<div class="skeleton" style="height:220px"></div>{/if}
    </section>

    <section class="card card-pad" aria-labelledby="bd-h">
      <header>
        <h2 id="bd-h">Where the money went</h2>
        <label class="sr-only" for="bd-scope">Breakdown period</label>
        <select id="bd-scope" class="input mini" bind:value={bdScope}>
          <option value="period">Whole period</option>
          <option value="last">Latest {intervalWord}</option>
        </select>
      </header>
      <nav class="crumbs" aria-label="Category path">
        <button type="button" class="crumb" disabled={path.length === 0} onclick={() => (path = [])}>{expenseRoot}</button>
        {#each path as seg, i (i)}
          <span aria-hidden="true">›</span>
          <button type="button" class="crumb" disabled={i === path.length - 1} onclick={() => (path = path.slice(0, i + 1))}>{seg}</button>
        {/each}
        {#if path.length}<a class="reg" href={href('account', prefix)}>Register</a>{/if}
      </nav>
      {#if breakdown}
        <p class="total num">{fmt(bdTotal)}</p>
        {#if items.length}
          <RankBars {items} format={fmt0} onpick={pick} />
          <p class="muted small">Tap a category to drill in; a leaf opens its register.</p>
        {:else}<p class="muted">No spending here in this period.</p>{/if}
      {:else}<div class="skeleton" style="height:220px"></div>{/if}
    </section>
  </div>
{/if}

<style>
  .links { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin-bottom: 12px; }
  .links .card {
    display: flex; align-items: center; justify-content: center; gap: 8px; min-height: 48px; padding: 8px; text-align: center;
    font-size: 0.85rem; font-weight: 600; color: var(--text); text-decoration: none; cursor: pointer;
  }
  .links .card:hover { background: var(--surface-2); }
  .warn { display: flex; gap: 8px; align-items: flex-start; background: var(--warn-soft); color: var(--text); padding: 10px 12px; border-radius: var(--radius-s); font-size: 0.85rem; margin-bottom: 12px; }
  code { font-family: var(--mono); }
  .tiles { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin-bottom: 12px; }
  .tile { padding: 14px 16px; display: grid; gap: 4px; min-width: 0; }
  .big { font-size: 1.4rem; font-weight: 750; letter-spacing: -0.02em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .delta { font-size: 0.8rem; display: flex; align-items: center; gap: 4px; }
  .grid { display: grid; gap: 12px; min-width: 0; }
  .grid > section { min-width: 0; }
  section header { display: flex; justify-content: space-between; align-items: baseline; gap: 6px 10px; margin-bottom: 12px; flex-wrap: wrap; }
  section h2 { font-size: 1rem; }
  section header span { font-size: 0.8rem; }
  .total { font-size: 1.25rem; font-weight: 700; margin-bottom: 8px; }
  .mini { min-height: 32px; padding: 2px 8px; width: auto; font-size: 0.82rem; }
  .crumbs { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; margin-bottom: 6px; font-size: 0.85rem; color: var(--text-3); }
  .crumb { background: none; border: 0; padding: 4px 2px; color: var(--accent); font-weight: 600; }
  .crumb:disabled { color: var(--text); cursor: default; }
  .reg { margin-left: auto; font-size: 0.8rem; }
  .small { font-size: 0.78rem; margin-top: 6px; }
  @media (max-width: 420px) { .links { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  @media (min-width: 760px) { .tiles { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
  @media (min-width: 1100px) {
    .grid { grid-template-columns: 1.4fr 1fr; }
    .wide:first-child { grid-column: 1 / -1; }
  }
</style>
