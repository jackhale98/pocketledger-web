<script lang="ts">
  // Multi-period balance table (hledger balance -W/-M/-Q/-Y), like PocketLedger's Table tab.
  import type { Interval, PeriodicReport } from '$lib/contracts/engine';
  import { EngineCallError } from '$lib/engine/client';
  import { app } from '../../state/app.svelte';
  import { href } from '../../state/router.svelte';
  import { reportFilters as f } from '../../state/reports.svelte';
  import { columnLabel } from '../../lib/periods';
  import Money from '../../components/Money.svelte';
  import ErrorPanel from '../../components/ErrorPanel.svelte';
  import Icon from '../../components/Icon.svelte';
  import { exportCsv } from '../../lib/export';

  const GROUPS: [string, string][] = [['', 'All'], ['AC', 'Assets'], ['L', 'Liabilities'], ['E', 'Equity'], ['R', 'Income'], ['X', 'Expenses']];
  let interval = $state<Interval>('monthly');
  let depth = $state(2);
  let group = $state('X');
  let accumulation = $state<'change' | 'cumulative' | 'historical'>('change');
  /** Rows: account names, or hledger --pivot by payee / a tag. */
  let rows = $state('');
  let tags = $state.raw<string[]>([]);
  $effect(() => {
    const rev = app.revision;
    if (!rev || !app.engine) return;
    app.engine.raw(['tags']).then((r) => (tags = r.code === 0 ? r.stdout.split('\n').map((t) => t.trim()).filter(Boolean) : []));
  });
  const currentOpts = () =>
    f.opts({ period: { interval }, depth, accumulation, query: group ? [`type:${group}`] : [], ...(rows ? { pivot: rows } : {}) });
  let report = $state.raw<PeriodicReport | null>(null);
  let error = $state.raw<EngineCallError | null>(null);

  $effect(() => {
    const rev = app.revision;
    const opts = currentOpts();
    if (!rev || !app.engine) return;
    report = null;
    app.engine
      .periodicBalance(opts)
      .then((r) => {
        report = r;
        error = null;
      })
      .catch((e) => (error = e));
  });
</script>

<div class="controls">
  <div class="chips" role="group" aria-label="Account group">
    {#each GROUPS as [g, l] (g)}<button class="chip" type="button" aria-pressed={group === g} onclick={() => (group = g)}>{l}</button>{/each}
  </div>
  <div class="row">
    <label class="ctl"><span>Rows</span>
      <select class="input" bind:value={rows}>
        <option value="">Accounts</option>
        <option value="payee">Payees</option>
        {#each tags as t (t)}<option value={t}>Tag: {t}</option>{/each}
      </select>
    </label>
    <label class="ctl"><span>Columns</span>
      <select class="input" bind:value={interval}>
        <option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="quarterly">Quarterly</option><option value="yearly">Yearly</option>
      </select>
    </label>
    <label class="ctl"><span>Depth</span>
      <select class="input" bind:value={depth}>{#each [1, 2, 3, 4, 9] as d (d)}<option value={d}>{d === 9 ? 'All' : d}</option>{/each}</select>
    </label>
    <label class="ctl"><span>Show</span>
      <select class="input" bind:value={accumulation}>
        <option value="change">Change per period</option>
        <option value="cumulative">Cumulative in range</option>
        <option value="historical">Balance (historical)</option>
      </select>
    </label>
    <button class="btn small ghost" type="button" onclick={() => exportCsv(['balance', '--flat'], currentOpts(), rows ? `by-${rows}` : 'balances')}><Icon name="download" size={16} /> CSV</button>
  </div>
</div>

{#if error}
  <ErrorPanel title="hledger couldn't produce this table" errors={error.errors} />
{:else if !report}
  <div class="card card-pad"><div class="skeleton" style="height:240px"></div></div>
{:else if report.rows.length === 0}
  <p class="card card-pad muted">Nothing to show for this period and filter.</p>
{:else}
  <div class="card scroll">
    <table>
      <caption class="sr-only">Balances by {interval} period{rows ? `, grouped by ${rows}` : ''}</caption>
      <thead>
        <tr>
          <th scope="col" class="acct">Account</th>
          {#each report.columns as c (c.begin)}<th scope="col">{columnLabel(c.begin, c.end)}</th>{/each}
          {#if accumulation === 'change'}<th scope="col">Total</th><th scope="col">Average</th>{/if}
        </tr>
      </thead>
      <tbody>
        {#each report.rows as r (r.account)}
          <tr>
            <th scope="row" class="acct">{#if rows}{r.account || '(none)'}{:else}<a href={href('account', r.account)}>{r.account}</a>{/if}</th>
            {#each r.amounts as a, i (i)}<td><Money value={a} zero="–" /></td>{/each}
            {#if accumulation === 'change'}<td class="strong"><Money value={r.total} zero="–" /></td><td><Money value={r.average} zero="–" /></td>{/if}
          </tr>
        {/each}
      </tbody>
      <tfoot>
        <tr>
          <th scope="row" class="acct">Total</th>
          {#each report.totals.amounts as a, i (i)}<td><Money value={a} zero="–" /></td>{/each}
          {#if accumulation === 'change'}<td><Money value={report.totals.total} /></td><td><Money value={report.totals.average} /></td>{/if}
        </tr>
      </tfoot>
    </table>
  </div>
{/if}

<style>
  .controls { display: grid; gap: 10px; margin-bottom: 12px; min-width: 0; }
  .chips { display: flex; gap: 6px; overflow-x: auto; scrollbar-width: none; }
  .row { display: flex; gap: 10px; flex-wrap: wrap; }
  .ctl { display: inline-flex; align-items: center; gap: 8px; font-size: 0.82rem; font-weight: 600; color: var(--text-2); }
  .ctl select { min-height: 34px; padding: 4px 8px; width: auto; font-size: 0.85rem; }
  .scroll { overflow-x: auto; min-width: 0; }
  table { border-collapse: collapse; font-size: 0.85rem; min-width: 100%; }
  th, td { padding: 8px 10px; text-align: right; white-space: nowrap; border-bottom: 1px solid var(--border); }
  thead th { font-size: 0.75rem; color: var(--text-3); font-weight: 650; }
  .acct { text-align: left; position: sticky; left: 0; background: var(--surface); font-weight: 500; max-width: 46vw; overflow: hidden; text-overflow: ellipsis; z-index: 1; }
  .acct a { color: var(--text); text-decoration: none; }
  .acct a:hover { color: var(--accent); text-decoration: underline; }
  tfoot th, tfoot td { font-weight: 700; background: var(--surface-2); }
  tfoot .acct { background: var(--surface-2); }
  .strong { font-weight: 600; }
</style>
