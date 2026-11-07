<script lang="ts">
  import type { Interval, StatementReport } from '$lib/contracts/engine';
  import { EngineCallError } from '$lib/engine/client';
  import { app } from '../state/app.svelte';
  import { settings } from '../state/settings.svelte';
  import { href, router } from '../state/router.svelte';
  import { PRESETS, presetRange, columnLabel, type PresetId } from '../lib/periods';
  import Money from '../components/Money.svelte';
  import ValueIn from '../components/ValueIn.svelte';
  import ErrorPanel from '../components/ErrorPanel.svelte';
  import Icon from '../components/Icon.svelte';
  import { exportCsv } from '../lib/export';

  type Kind = 'bs' | 'is' | 'cf';
  const KINDS: { id: Kind; label: string }[] = [
    { id: 'bs', label: 'Balance sheet' },
    { id: 'is', label: 'Income statement' },
    { id: 'cf', label: 'Cash flow' },
  ];
  const q = router.route.query;
  let kind = $state<Kind>((['bs', 'is', 'cf'] as const).find((k) => k === q.get('kind')) ?? 'bs');
  // A specific period from a link (e.g. a tapped bar on the dashboard).
  let fixed = $state<{ begin: string; end: string } | null>(q.get('begin') && q.get('end') ? { begin: q.get('begin')!, end: q.get('end')! } : null);
  let preset = $state<PresetId>('this-year');
  let interval = $state<'' | Interval>('');
  let depth = $state(2);
  let report = $state.raw<StatementReport | null>(null);
  let error = $state.raw<EngineCallError | null>(null);

  $effect(() => {
    const rev = app.revision;
    const opts = {
      period: { ...(fixed ?? presetRange(preset)), ...(interval ? { interval } : {}) },
      depth,
      ...(settings.v.valueIn ? { valueIn: settings.v.valueIn } : {}),
    };
    const k = kind;
    if (!rev || !app.engine) return;
    const e = app.engine;
    report = null;
    (k === 'bs' ? e.balanceSheet(opts) : k === 'is' ? e.incomeStatement(opts) : e.cashFlow(opts))
      .then((r) => {
        report = r;
        error = null;
      })
      .catch((x) => (error = x));
  });

  const multi = $derived((report?.columns.length ?? 0) > 1);
  const netLabel = $derived(kind === 'bs' ? 'Net worth' : kind === 'is' ? 'Net income' : 'Net cash flow');
</script>

<div class="tabs" role="tablist" aria-label="Statement">
  {#each KINDS as k (k.id)}
    <button role="tab" type="button" aria-selected={kind === k.id} onclick={() => (kind = k.id)}>{k.label}</button>
  {/each}
</div>

<div class="controls">
  {#if fixed}
    <span class="badge ok">{fixed.begin} – {fixed.end}</span>
    <button class="btn small ghost" type="button" onclick={() => (fixed = null)}>Clear</button>
  {/if}
  <label class="ctl"><span>Period</span>
    <select class="input" bind:value={preset} onchange={() => (fixed = null)}>{#each PRESETS as p (p.id)}<option value={p.id}>{p.label}</option>{/each}</select>
  </label>
  <label class="ctl"><span>Columns</span>
    <select class="input" bind:value={interval}>
      <option value="">Single</option><option value="monthly">Monthly</option><option value="quarterly">Quarterly</option><option value="yearly">Yearly</option>
    </select>
  </label>
  <label class="ctl"><span>Depth</span>
    <select class="input" bind:value={depth}>{#each [1, 2, 3, 4, 9] as d (d)}<option value={d}>{d === 9 ? 'All' : d}</option>{/each}</select>
  </label>
  <ValueIn />
  <button class="btn small ghost" type="button" onclick={() => exportCsv([kind, '--flat'], { period: { ...(fixed ?? presetRange(preset)), ...(interval ? { interval } : {}) }, depth, ...(settings.v.valueIn ? { valueIn: settings.v.valueIn } : {}) }, { bs: 'balance-sheet', is: 'income-statement', cf: 'cash-flow' }[kind])}><Icon name="download" size={16} /> CSV</button>
</div>

{#if error}
  <ErrorPanel title="hledger couldn't produce this statement" errors={error.errors} />
{:else if !report}
  <div class="card card-pad"><div class="skeleton" style="height:240px"></div></div>
{:else}
  <div class="card stmt">
    <p class="title muted">{report.title}</p>
    <div class="scroll">
      <table>
        <caption class="sr-only">{report.title}</caption>
        {#if multi}
          <thead><tr><th scope="col" class="acct">Account</th>{#each report.columns as c (c.begin)}<th scope="col">{columnLabel(c.begin, c.end)}</th>{/each}{#if kind !== 'bs'}<th scope="col">Total</th>{/if}</tr></thead>
        {/if}
        {#each report.sections as s (s.title)}
          <tbody>
            <tr class="sec"><th scope="rowgroup" class="acct" colspan={multi ? report.columns.length + (kind !== 'bs' ? 2 : 1) : 2}>{s.title}</th></tr>
            {#each s.report.rows as r (r.account)}
              <tr>
                <th scope="row" class="acct" style:padding-left="{12 + (r.depth - 1) * 14}px"><a href={href('account', r.account)}>{r.account.split(':').slice(-1)[0]}</a></th>
                {#if multi}
                  {#each r.amounts as a, i (i)}<td><Money value={a} zero="–" /></td>{/each}
                  {#if kind !== 'bs'}<td class="strong"><Money value={r.total} zero="–" /></td>{/if}
                {:else}<td><Money value={r.amounts[0] ?? []} /></td>{/if}
              </tr>
            {/each}
            <tr class="subtotal">
              <th scope="row" class="acct">Total {s.title.toLowerCase()}</th>
              {#if multi}
                {#each s.report.totals.amounts as a, i (i)}<td><Money value={a} zero="–" /></td>{/each}
                {#if kind !== 'bs'}<td><Money value={s.report.totals.total} /></td>{/if}
              {:else}<td><Money value={s.report.totals.amounts[0] ?? []} /></td>{/if}
            </tr>
          </tbody>
        {/each}
        <tfoot>
          <tr class="net">
            <th scope="row" class="acct">{netLabel}</th>
            {#if multi}
              {#each report.totals.amounts as a, i (i)}<td><Money value={a} color /></td>{/each}
              {#if kind !== 'bs'}<td><Money value={report.totals.total} color /></td>{/if}
            {:else}<td><Money value={report.totals.amounts[0] ?? []} color /></td>{/if}
          </tr>
        </tfoot>
      </table>
    </div>
  </div>
{/if}

<style>
  .tabs { display: flex; gap: 4px; padding: 4px; background: var(--surface-2); border-radius: var(--radius); margin-bottom: 12px; overflow-x: auto; }
  .tabs button { flex: 1; min-height: 40px; border: 0; background: none; border-radius: var(--radius-s); font-weight: 600; font-size: 0.88rem; color: var(--text-2); white-space: nowrap; padding: 0 12px; }
  .tabs button[aria-selected='true'] { background: var(--surface); color: var(--text); box-shadow: var(--shadow-1); }
  .controls { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-bottom: 12px; }
  .ctl { display: inline-flex; align-items: center; gap: 8px; font-size: 0.82rem; font-weight: 600; color: var(--text-2); }
  .ctl select { min-height: 34px; padding: 4px 8px; width: auto; font-size: 0.85rem; }
  .stmt { overflow: hidden; }
  .title { padding: 12px 16px 0; font-size: 0.82rem; }
  .scroll { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
  th, td { padding: 9px 12px; text-align: right; white-space: nowrap; }
  thead th { font-size: 0.75rem; color: var(--text-3); font-weight: 650; border-bottom: 1px solid var(--border); }
  .acct { text-align: left; position: sticky; left: 0; background: var(--surface); font-weight: 500; }
  .acct a { color: var(--text); text-decoration: none; }
  .acct a:hover { color: var(--accent); text-decoration: underline; }
  .sec th { font-weight: 700; padding-top: 18px; font-size: 0.82rem; color: var(--text-2); text-transform: uppercase; letter-spacing: 0.05em; }
  .subtotal th, .subtotal td { font-weight: 650; border-top: 1px solid var(--border); }
  .net th, .net td { font-weight: 750; border-top: 2px solid var(--border-strong); background: var(--surface-2); }
  .net .acct { background: var(--surface-2); }
  .strong { font-weight: 600; }
</style>
