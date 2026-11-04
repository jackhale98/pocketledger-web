<script lang="ts">
  import type { BalanceReport, PeriodicReport, StatementReport } from '$lib/contracts/engine';
  import { EngineCallError } from '$lib/engine/client';
  import { app } from '../state/app.svelte';
  import { router, href } from '../state/router.svelte';
  import { columnLabel, presetRange } from '../lib/periods';
  import { chartCommodity, fmtIn, numberIn, otherCommodities } from '../lib/primary';
  import BarChart from '../components/charts/BarChart.svelte';
  import LineChart from '../components/charts/LineChart.svelte';
  import RankBars from '../components/charts/RankBars.svelte';
  import ValueIn from '../components/ValueIn.svelte';
  import ErrorPanel from '../components/ErrorPanel.svelte';
  import Icon from '../components/Icon.svelte';

  type Span = 'last-3' | 'last-12' | 'this-year' | 'last-year';
  let span = $state<Span>('last-12');
  let breakdownMonth = $state<'this-month' | 'last-month' | 'span'>('this-month');

  let worth = $state.raw<PeriodicReport | null>(null);
  let flows = $state.raw<StatementReport | null>(null);
  let breakdown = $state.raw<BalanceReport | null>(null);
  let error = $state.raw<EngineCallError | null>(null);

  const commodity = $derived(app.revision ? chartCommodity() : '');
  const fmt = $derived(fmtIn(commodity));
  const fmt0 = $derived(fmtIn(commodity, 0));

  $effect(() => {
    const rev = app.revision;
    const c = commodity;
    const range = presetRange(span);
    const bRange = breakdownMonth === 'span' ? range : presetRange(breakdownMonth);
    if (!rev || !app.engine || !c) return;
    const engine = app.engine;
    const valueIn = c;
    error = null;
    (async () => {
      try {
        worth = await engine.periodicBalance({ query: ['type:AL'], period: { ...range, interval: 'monthly' }, accumulation: 'historical', valueIn, depth: 1 });
        flows = await engine.incomeStatement({ period: { ...range, interval: 'monthly' }, valueIn, depth: 1 });
        breakdown = await engine.balance({ query: ['type:X'], period: bRange, valueIn, depth: 2 });
      } catch (e) {
        error = e instanceof EngineCallError ? e : new EngineCallError([{ kind: 'internal', message: (e as Error).message }]);
      }
    })();
  });

  const worthSeries = $derived(worth ? worth.totals.amounts.map((m) => numberIn(m, commodity)) : []);
  const worthLabels = $derived(worth ? worth.columns.map((c) => columnLabel(c.begin, c.end)) : []);
  const revenue = $derived(flows?.sections.find((s) => s.increasesTotal) ?? flows?.sections[0]);
  const expense = $derived(flows?.sections.find((s) => !s.increasesTotal) ?? flows?.sections[1]);
  const incomeVals = $derived(revenue ? revenue.report.totals.amounts.map((m) => numberIn(m, commodity)) : []);
  const expenseVals = $derived(expense ? expense.report.totals.amounts.map((m) => numberIn(m, commodity)) : []);
  const flowLabels = $derived(flows ? flows.columns.map((c) => columnLabel(c.begin, c.end)) : []);
  const breakdownItems = $derived(
    breakdown
      ? breakdown.rows
          .filter((r) => r.account.split(':').length === 2 || !breakdown!.rows.some((x) => x.account.startsWith(r.account + ':')))
          .filter((r) => r.account.includes(':'))
          .map((r) => ({ name: r.account.split(':').slice(1).join(':'), value: numberIn(r.amount, commodity), full: r.account }))
      : [],
  );
  const breakdownTotal = $derived(breakdown ? numberIn(breakdown.total, commodity) : 0);

  const netWorth = $derived(worthSeries[worthSeries.length - 1] ?? 0);
  const netWorthPrev = $derived(worthSeries[worthSeries.length - 2] ?? netWorth);
  const lastIncome = $derived(incomeVals[incomeVals.length - 1] ?? 0);
  const lastExpense = $derived(expenseVals[expenseVals.length - 1] ?? 0);
  const totalIncome = $derived(incomeVals.reduce((a, b) => a + b, 0));
  const totalExpense = $derived(expenseVals.reduce((a, b) => a + b, 0));
  const savingsRate = $derived(totalIncome > 0 ? Math.round(((totalIncome - totalExpense) / totalIncome) * 100) : null);
  const hidden = $derived(worth ? otherCommodities(worth.totals.amounts, commodity) : []);
</script>

<div class="bar">
  <div class="chips" role="group" aria-label="Report period">
    {#each [['last-3', '3 months'], ['last-12', '12 months'], ['this-year', 'This year'], ['last-year', 'Last year']] as [v, l] (v)}
      <button class="chip" type="button" aria-pressed={span === v} onclick={() => (span = v as Span)}>{l}</button>
    {/each}
  </div>
  <ValueIn />
</div>

{#if error}
  <ErrorPanel title="hledger couldn't produce this report" errors={error.errors} />
{:else}
  <section class="tiles" aria-label="Summary">
    <div class="tile card">
      <p class="label">Net worth</p>
      <p class="big num">{worth ? fmt0(netWorth) : '…'}</p>
      {#if worth && worthSeries.length > 1}
        {@const d = netWorth - netWorthPrev}
        <p class="delta" class:pos={d >= 0} class:neg={d < 0}><Icon name={d >= 0 ? 'arrow-up' : 'arrow-down'} size={14} /> {fmt0(Math.abs(d))} this month</p>
      {/if}
    </div>
    <div class="tile card">
      <p class="label">Income · latest month</p>
      <p class="big num">{flows ? fmt0(lastIncome) : '…'}</p>
      <p class="delta muted">{flows ? `${fmt0(totalIncome)} in period` : ''}</p>
    </div>
    <div class="tile card">
      <p class="label">Spending · latest month</p>
      <p class="big num">{flows ? fmt0(lastExpense) : '…'}</p>
      <p class="delta muted">{flows ? `${fmt0(totalExpense)} in period` : ''}</p>
    </div>
    <div class="tile card">
      <p class="label">Savings rate</p>
      <p class="big num">{savingsRate == null ? '—' : `${savingsRate}%`}</p>
      <p class="delta muted">income kept, over the period</p>
    </div>
  </section>

  <div class="grid">
    <section class="card card-pad wide" aria-labelledby="nw-h">
      <header><h2 id="nw-h">Net worth</h2><span class="muted">assets − liabilities, month end, in {commodity}</span></header>
      {#if worth}
        <LineChart title="Net worth by month" labels={worthLabels} values={worthSeries} format={fmt} prefix={commodity.length === 1 ? commodity : ''} />
        {#if hidden.length}<p class="note muted">Not convertible to {commodity} (no P price): {hidden.join(', ')}.</p>{/if}
      {:else}<div class="skeleton" style="height:200px"></div>{/if}
    </section>

    <section class="card card-pad wide" aria-labelledby="ie-h">
      <header><h2 id="ie-h">Income vs spending</h2><a href={href('statements')}>Income statement</a></header>
      {#if flows}
        <BarChart
          title="Income and spending by month"
          labels={flowLabels}
          series={[
            { name: 'Income', color: 'var(--chart-1)', values: incomeVals },
            { name: 'Spending', color: 'var(--chart-2)', values: expenseVals },
          ]}
          format={fmt}
          prefix={commodity.length === 1 ? commodity : ''}
        />
      {:else}<div class="skeleton" style="height:220px"></div>{/if}
    </section>

    <section class="card card-pad" aria-labelledby="bd-h">
      <header>
        <h2 id="bd-h">Where the money went</h2>
        <label class="sr-only" for="bd-range">Breakdown period</label>
        <select id="bd-range" class="input mini" bind:value={breakdownMonth}>
          <option value="this-month">This month</option>
          <option value="last-month">Last month</option>
          <option value="span">Whole period</option>
        </select>
      </header>
      {#if breakdown}
        <p class="total num">{fmt(breakdownTotal)}</p>
        {#if breakdownItems.length}
          <RankBars items={breakdownItems} format={fmt0} onpick={(n) => router.go('account', `expenses:${n}`)} />
        {:else}<p class="muted">No spending in this period.</p>{/if}
      {:else}<div class="skeleton" style="height:220px"></div>{/if}
    </section>
  </div>
{/if}

<style>
  .bar { display: flex; gap: 10px; align-items: center; justify-content: space-between; flex-wrap: wrap; margin-bottom: 12px; }
  .chips { display: flex; gap: 6px; overflow-x: auto; scrollbar-width: none; }
  .tiles { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin-bottom: 12px; }
  .tile { padding: 14px 16px; display: grid; gap: 4px; }
  .big { font-size: 1.45rem; font-weight: 750; letter-spacing: -0.02em; overflow: hidden; text-overflow: ellipsis; }
  .delta { font-size: 0.8rem; display: flex; align-items: center; gap: 4px; }
  .grid { display: grid; gap: 12px; }
  section header { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; margin-bottom: 12px; flex-wrap: wrap; }
  section h2 { font-size: 1rem; }
  section header span, section header a { font-size: 0.8rem; }
  .note { font-size: 0.8rem; margin-top: 8px; }
  .total { font-size: 1.25rem; font-weight: 700; margin-bottom: 8px; }
  .mini { min-height: 32px; padding: 2px 8px; width: auto; font-size: 0.82rem; }
  @media (min-width: 760px) {
    .tiles { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  }
  @media (min-width: 1100px) {
    .grid { grid-template-columns: 1.4fr 1fr; }
    .wide:first-child { grid-column: 1 / -1; }
  }
</style>
