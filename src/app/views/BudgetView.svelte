<script lang="ts">
  import type { BudgetReport } from '$lib/contracts/engine';
  import type { MixedAmount } from '$lib/contracts/amount';
  import { EngineCallError } from '$lib/engine/client';
  import { dec, formatAmount } from '$lib/engine/decimal';
  import { app } from '../state/app.svelte';
  import { settings, valuationOpts } from '../state/settings.svelte';
  import { href, router } from '../state/router.svelte';
  import { reportFilters } from '../state/reports.svelte';
  import { styleOf } from '../lib/primary';
  import Icon from '../components/Icon.svelte';
  import BarChart from '../components/charts/BarChart.svelte';
  import { columnLabel } from '../lib/periods';
  import { chartCommodity, fmtIn, numberIn } from '../lib/primary';
  import ErrorPanel from '../components/ErrorPanel.svelte';

  const now = new Date();
  let offset = $state(0); // months from the current month
  let report = $state.raw<BudgetReport | null>(null);
  let error = $state.raw<EngineCallError | null>(null);

  const month = $derived.by(() => {
    const d = new Date(now.getFullYear(), now.getMonth() + offset, 1);
    const e = new Date(d.getFullYear(), d.getMonth() + 1, 1);
    const iso = (x: Date) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-01`;
    return { begin: iso(d), end: iso(e), label: d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) };
  });
  const elapsed = $derived.by(() => {
    if (offset !== 0) return offset < 0 ? 1 : 0;
    const days = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    return now.getDate() / days;
  });

  $effect(() => {
    const rev = app.revision;
    const { begin, end } = month;
    if (!rev || !app.engine) return;
    report = null;
    app.engine
      .budget({ period: { begin, end, interval: 'monthly' }, ...valuationOpts(settings.v, { gain: false }) })
      .then((r) => {
        report = r;
        error = null;
      })
      .catch((e) => (error = e));
  });

  // Budget vs actual over the six months ending with the shown month (expense goals).
  let history = $state.raw<BudgetReport | null>(null);
  const histCommodity = $derived(app.revision ? chartCommodity() : '');
  $effect(() => {
    const rev = app.revision;
    const { end } = month;
    const c = histCommodity;
    if (!rev || !app.engine || !c) return;
    const e = new Date(end + 'T00:00:00');
    const b = new Date(e.getFullYear(), e.getMonth() - 6, 1);
    const begin = `${b.getFullYear()}-${String(b.getMonth() + 1).padStart(2, '0')}-01`;
    app.engine
      .budget({ query: ['type:X'], period: { begin, end, interval: 'monthly' }, valueIn: c })
      .then((r) => (history = r))
      .catch(() => (history = null));
  });
  const histFmt = $derived(fmtIn(histCommodity, 0));
  const histBudget = $derived(history ? history.totals.cells.map((cl) => numberIn(cl.budget ?? [], histCommodity)) : []);
  const histActual = $derived(history ? history.totals.cells.map((cl) => numberIn(cl.actual, histCommodity)) : []);

  // One commodity per budget line: the budget's own.
  const q = (ma: MixedAmount | null | undefined, c: string) => dec(ma?.find((a) => a.commodity === c)?.quantity ?? '0');
  const lines = $derived.by(() => {
    if (!report) return [];
    const out = [];
    for (const r of report.rows) {
      const cell = r.cells[0];
      if (!cell?.budget || cell.budget.length === 0 || r.account === '<unbudgeted>') continue;
      // Skip parents whose budget is only the sum of budgeted children (hledger shows both).
      const c = cell.budget[0]!.commodity;
      const budget = q(cell.budget, c);
      const actual = q(cell.actual, c);
      const income = budget.isNegative();
      const b = budget.abs();
      const a = income ? actual.neg() : actual;
      const pct = b.isZero() ? 0 : a.div(b).times(100).toNumber();
      out.push({ account: r.account, commodity: c, budget: b, actual: a, remaining: b.minus(a), pct, income, depth: r.depth });
    }
    return out;
  });
  const leaves = $derived(lines.filter((l) => !lines.some((x) => x.account.startsWith(l.account + ':'))));
  // Goals are classified by account type (inherited from parents), not by sign: the
  // balancing posting of a budget rule (e.g. assets:checking) is not a goal.
  const types = $derived(new Map(app.accounts.map((a) => [a.name, a.type])));
  function typeOf(name: string) {
    for (let n = name; n; n = n.includes(':') ? n.slice(0, n.lastIndexOf(':')) : '') {
      const t = types.get(n);
      if (t) return t;
    }
    return /^expenses?\b/i.test(name) ? 'X' : /^(income|revenues?)\b/i.test(name) ? 'R' : null;
  }
  const expenseLines = $derived(leaves.filter((l) => typeOf(l.account) === 'X'));
  const incomeLines = $derived(leaves.filter((l) => typeOf(l.account) === 'R'));
  const unbudgeted = $derived(report?.rows.find((r) => r.account === '<unbudgeted>'));
  const totals = $derived.by(() => {
    const by = new Map<string, { budget: ReturnType<typeof dec>; actual: ReturnType<typeof dec> }>();
    for (const l of expenseLines) {
      const t = by.get(l.commodity) ?? { budget: dec(0), actual: dec(0) };
      t.budget = t.budget.plus(l.budget);
      t.actual = t.actual.plus(l.actual);
      by.set(l.commodity, t);
    }
    return [...by.entries()];
  });
  const f = (c: string, v: ReturnType<typeof dec>) => formatAmount({ commodity: c, quantity: v.toString(), style: styleOf(c) });
</script>

<div class="month">
  <button class="icon-btn" type="button" onclick={() => offset--} aria-label="Previous month"><Icon name="chevron-left" /></button>
  <h2 aria-live="polite">{month.label}</h2>
  <button class="icon-btn" type="button" onclick={() => offset++} aria-label="Next month"><Icon name="chevron-right" /></button>
  {#if offset !== 0}<button class="chip" type="button" onclick={() => (offset = 0)}>Today</button>{/if}
</div>

{#if error}
  <ErrorPanel title="hledger couldn't produce the budget report" errors={error.errors} />
{:else if !report}
  <div class="card card-pad"><div class="skeleton" style="height:200px"></div></div>
{:else if lines.length === 0}
  <div class="card card-pad empty">
    <Icon name="target" size={28} />
    <h3>No budget for this month</h3>
    <p class="muted">Budgets are periodic transactions in your journal, for example:</p>
    <pre>~ monthly
    expenses:groceries   $500
    expenses:dining      $200
    assets:checking</pre>
    <a class="btn primary" href={href('reports')} onclick={() => { reportFilters.tab = 'forecast'; reportFilters.save(); }}><Icon name="repeat" size={18} /> Add a budget rule</a>
    <p class="muted">Budgets and forecasts share the same recurring rules (Reports → Forecast → Recurring rules).</p>
  </div>
{:else}
  {#each totals as [c, t] (c)}
    {@const pct = t.budget.isZero() ? 0 : t.actual.div(t.budget).times(100).toNumber()}
    <section class="card card-pad summary" aria-label="Budget summary">
      <div class="sum-row">
        <div><p class="label">Spent</p><p class="big num">{f(c, t.actual)}</p></div>
        <div class="r"><p class="label">of budget</p><p class="mid num">{f(c, t.budget)}</p></div>
      </div>
      <div class="track lg" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round(pct)} aria-label="Spent of total budget">
        <span class="fill" class:over={pct > 100} style:width="{Math.min(100, pct)}%"></span>
        {#if elapsed > 0 && elapsed < 1}<span class="today" style:left="{elapsed * 100}%" title="Today"></span>{/if}
      </div>
      <p class="muted small">{t.budget.minus(t.actual).isNegative() ? `${f(c, t.actual.minus(t.budget))} over budget` : `${f(c, t.budget.minus(t.actual))} left`}{elapsed > 0 && elapsed < 1 ? ` · ${Math.round(elapsed * 100)}% of the month gone` : ''}</p>
    </section>
  {/each}

  <section class="card list" aria-labelledby="exp-h">
    <h3 id="exp-h" class="list-h">Spending goals</h3>
    {#each expenseLines as l (l.account)}
      <button class="line" type="button" onclick={() => router.go('account', l.account)}>
        <span class="name">{l.account.replace(/^expenses?:/i, '')}</span>
        <span class="vals num"><strong class:neg={l.pct > 100}>{f(l.commodity, l.actual)}</strong> <span class="muted">/ {f(l.commodity, l.budget)}</span></span>
        <span class="track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round(l.pct)} aria-label="{l.account}: {Math.round(l.pct)}% of budget">
          <span class="fill" class:warn={l.pct > 85 && l.pct < 100} class:over={l.pct > 100} style:width="{Math.min(100, l.pct)}%"></span>
          {#if elapsed > 0 && elapsed < 1}<span class="today" style:left="{elapsed * 100}%"></span>{/if}
        </span>
        <span class="state small">
          {#if l.pct > 100}<span class="neg"><Icon name="alert" size={13} /> {f(l.commodity, l.remaining.abs())} over</span>
          {:else}<span class="muted">{f(l.commodity, l.remaining)} left · {Math.round(l.pct)}%</span>{/if}
        </span>
      </button>
    {/each}
  </section>

  {#if incomeLines.length}
    <section class="card list" aria-labelledby="inc-h">
      <h3 id="inc-h" class="list-h">Income goals</h3>
      {#each incomeLines as l (l.account)}
        <div class="line">
          <span class="name">{l.account}</span>
          <span class="vals num"><strong>{f(l.commodity, l.actual)}</strong> <span class="muted">/ {f(l.commodity, l.budget)}</span></span>
          <span class="track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round(l.pct)} aria-label="{l.account}: {Math.round(l.pct)}% of goal"><span class="fill" style:width="{Math.min(100, l.pct)}%"></span></span>
        </div>
      {/each}
    </section>
  {/if}

  {#if history && histBudget.some((v) => v > 0)}
    <section class="card card-pad hist" aria-labelledby="hist-h">
      <h3 id="hist-h" class="list-h flush">Budget vs actual over time</h3>
      <BarChart
        title="Spending budget and actual by month"
        labels={history.columns.map((c) => columnLabel(c.begin, c.end))}
        series={[
          { name: 'Budget', color: 'var(--chart-3)', values: histBudget },
          { name: 'Actual', color: 'var(--chart-2)', values: histActual },
        ]}
        format={histFmt}
        prefix={histCommodity.length === 1 ? histCommodity : ''}
      />
    </section>
  {/if}

  {#if unbudgeted?.cells[0]?.actual.length}
    <p class="muted small unb">Unbudgeted activity this month: {unbudgeted.cells[0].actual.map((a) => formatAmount(a)).join(', ')} · <a href={href('statements')}>See statements</a></p>
  {/if}
{/if}

<style>
  .month { display: flex; align-items: center; gap: 6px; margin-bottom: 12px; }
  .month h2 { font-size: 1.1rem; min-width: 170px; text-align: center; }
  .summary { margin-bottom: 12px; display: grid; gap: 10px; }
  .sum-row { display: flex; justify-content: space-between; align-items: flex-end; }
  .r { text-align: right; }
  .big { font-size: 1.6rem; font-weight: 750; }
  .mid { font-size: 1.05rem; font-weight: 600; color: var(--text-2); }
  .small { font-size: 0.8rem; }
  .list { overflow: hidden; margin-bottom: 12px; }
  .list-h { font-size: 0.82rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-2); padding: 14px 16px 6px; }
  .line {
    width: 100%; display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 6px 12px; padding: 12px 16px;
    border: 0; border-top: 1px solid var(--border); background: none; text-align: left;
  }
  button.line:hover { background: var(--surface-2); }
  .name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .vals { font-size: 0.9rem; }
  .track { grid-column: 1 / -1; position: relative; height: 10px; border-radius: 5px; background: var(--surface-3); overflow: visible; }
  .track.lg { height: 14px; border-radius: 7px; }
  .fill { position: absolute; inset: 0 auto 0 0; border-radius: inherit; background: var(--accent); transition: width 300ms var(--ease); }
  .fill.warn { background: var(--warn); }
  .fill.over { background: var(--neg); }
  .today { position: absolute; top: -3px; bottom: -3px; width: 2px; background: var(--text); opacity: 0.55; border-radius: 1px; }
  .state { grid-column: 1 / -1; }
  .state span { display: inline-flex; align-items: center; gap: 4px; }
  .empty { display: grid; gap: 10px; justify-items: start; }
  .empty pre { background: var(--surface-2); padding: 12px; border-radius: var(--radius-s); font-family: var(--mono); font-size: 0.85rem; width: 100%; overflow-x: auto; }
  .unb { margin: 4px; }
  .hist { margin-bottom: 12px; min-width: 0; }
  .flush { padding: 0 0 10px; }
</style>
