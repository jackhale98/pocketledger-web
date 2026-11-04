<script lang="ts">
  import type { AccountType, BalanceReport } from '$lib/contracts/engine';
  import { EngineCallError } from '$lib/engine/client';
  import { app } from '../state/app.svelte';
  import { settings } from '../state/settings.svelte';
  import { href } from '../state/router.svelte';
  import Money from '../components/Money.svelte';
  import Icon from '../components/Icon.svelte';
  import ValueIn from '../components/ValueIn.svelte';
  import ErrorPanel from '../components/ErrorPanel.svelte';

  const FILTERS: { id: string; label: string; types: AccountType[] }[] = [
    { id: 'all', label: 'All', types: [] },
    { id: 'A', label: 'Assets', types: ['A', 'C'] },
    { id: 'L', label: 'Liabilities', types: ['L'] },
    { id: 'E', label: 'Equity', types: ['E'] },
    { id: 'R', label: 'Income', types: ['R'] },
    { id: 'X', label: 'Expenses', types: ['X'] },
  ];
  let filter = $state('all');
  let report = $state.raw<BalanceReport | null>(null);
  let error = $state.raw<EngineCallError | null>(null);
  let collapsed = $state<Set<string>>(new Set());
  let showZero = $state(false);

  $effect(() => {
    const rev = app.revision;
    const valueIn = settings.v.valueIn;
    const f = FILTERS.find((x) => x.id === filter)!;
    if (!rev || !app.engine) return;
    const query = f.types.length ? [`type:${f.types.join('')}`] : [];
    app.engine
      .balance({ tree: true, query, ...(valueIn ? { valueIn } : {}), ...(showZero ? {} : {}) })
      .then((r) => {
        report = r;
        error = null;
      })
      .catch((e) => (error = e));
  });

  const rows = $derived.by(() => {
    if (!report) return [];
    const hasKids = new Set<string>();
    for (const r of report.rows) {
      const i = r.account.lastIndexOf(':');
      if (i > 0) hasKids.add(r.account.slice(0, i));
    }
    return report.rows
      .filter((r) => ![...collapsed].some((c) => r.account.startsWith(c + ':')))
      .map((r) => ({ ...r, parent: hasKids.has(r.account) }));
  });
  const typeOf = $derived(new Map(app.accounts.map((a) => [a.name, a.type])));

  function toggle(a: string) {
    const next = new Set(collapsed);
    if (next.has(a)) next.delete(a);
    else next.add(a);
    collapsed = next;
  }
  const TYPE_LABEL: Record<string, string> = { A: 'Asset', C: 'Cash', L: 'Liability', E: 'Equity', R: 'Revenue', X: 'Expense', V: 'Conversion' };
</script>

<div class="bar">
  <div class="chips" role="group" aria-label="Account type">
    {#each FILTERS as f (f.id)}
      <button class="chip" type="button" aria-pressed={filter === f.id} onclick={() => (filter = f.id)}>{f.label}</button>
    {/each}
  </div>
  <ValueIn />
</div>

{#if error}
  <ErrorPanel title="hledger couldn't produce balances" errors={error.errors} />
{:else if !report}
  <div class="card">{#each Array(6) as _, i (i)}<div class="sk"><div class="skeleton" style="width:40%;height:14px"></div></div>{/each}</div>
{:else if report.rows.length === 0}
  <div class="card card-pad muted">No accounts with balances.</div>
{:else}
  <div class="card tree" role="treegrid" aria-label="Account balances">
    {#each rows as r (r.account)}
      <div class="node" role="row" aria-level={r.indent + 1} aria-expanded={r.parent ? !collapsed.has(r.account) : undefined} style:--indent={r.indent}>
        <span role="gridcell" class="name">
          {#if r.parent}
            <button class="twist" type="button" onclick={() => toggle(r.account)} aria-label="{collapsed.has(r.account) ? 'Expand' : 'Collapse'} {r.account}">
              <Icon name={collapsed.has(r.account) ? 'chevron-right' : 'chevron-down'} size={16} />
            </button>
          {:else}<span class="twist"></span>{/if}
          <a href={href('account', r.account)} class:top={r.indent === 0}>{r.displayName}</a>
          {#if r.indent === 0 && typeOf.get(r.account)}<span class="badge">{TYPE_LABEL[typeOf.get(r.account)!]}</span>{/if}
        </span>
        <span role="gridcell" class="val" class:top={r.indent === 0}><Money value={r.amount} /></span>
      </div>
    {/each}
    <div class="node total" role="row">
      <span role="gridcell" class="name"><span class="twist"></span>Total</span>
      <span role="gridcell" class="val"><Money value={report.total} /></span>
    </div>
  </div>
{/if}

<style>
  .bar { display: flex; gap: 10px; align-items: center; justify-content: space-between; margin-bottom: 12px; flex-wrap: wrap; }
  .chips { display: flex; gap: 6px; overflow-x: auto; scrollbar-width: none; }
  .tree { overflow: hidden; }
  .node { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 48px; padding: 4px 16px 4px calc(8px + var(--indent, 0) * 18px); }
  .node + .node { border-top: 1px solid var(--border); }
  .name { display: flex; align-items: center; gap: 4px; min-width: 0; }
  .name a { color: var(--text); text-decoration: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 8px 0; }
  .name a:hover { color: var(--accent); text-decoration: underline; }
  .name a.top { font-weight: 650; }
  .name .badge { margin-left: 6px; }
  .twist { width: 28px; height: 28px; flex: none; display: grid; place-items: center; border: 0; background: none; color: var(--text-3); border-radius: 6px; }
  button.twist:hover { background: var(--surface-2); }
  .val { font-weight: 520; }
  .val.top { font-weight: 700; }
  .total { background: var(--surface-2); font-weight: 700; }
  .sk { padding: 18px 16px; border-bottom: 1px solid var(--border); }
</style>
