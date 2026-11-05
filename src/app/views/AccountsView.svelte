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
  import { accountsView } from '../state/accounts.svelte';

  const FILTERS: { id: string; label: string; types: AccountType[] }[] = [
    { id: 'all', label: 'All', types: [] },
    { id: 'A', label: 'Assets', types: ['A', 'C'] },
    { id: 'L', label: 'Liabilities', types: ['L'] },
    { id: 'E', label: 'Equity', types: ['E'] },
    { id: 'R', label: 'Income', types: ['R'] },
    { id: 'X', label: 'Expenses', types: ['X'] },
  ];
  const v = accountsView;
  let report = $state.raw<BalanceReport | null>(null);
  let error = $state.raw<EngineCallError | null>(null);
  let attempt = $state(0);

  $effect(() => {
    const rev = app.revision;
    const valueIn = settings.v.valueIn;
    const f = FILTERS.find((x) => x.id === v.filter)!;
    const empty = v.showZero;
    void attempt;
    if (!rev || !app.engine) return;
    const query = f.types.length ? [`type:${f.types.join('')}`] : [];
    app.engine
      .balance({ tree: true, query, ...(valueIn ? { valueIn } : {}), ...(empty ? { empty: true } : {}) })
      .then((r) => {
        report = r;
        error = null;
      })
      .catch((e) => (error = e));
  });

  const parents = $derived.by(() => {
    const p = new Set<string>();
    for (const r of report?.rows ?? []) {
      const i = r.account.lastIndexOf(':');
      if (i > 0) p.add(r.account.slice(0, i));
    }
    return p;
  });
  // Default: only the top level expanded (as PocketLedger did).
  const collapsed = $derived(v.collapsed ?? new Set([...parents].filter((p) => p.includes(':'))));
  const rows = $derived.by(() => {
    if (!report) return [];
    const q = v.search.trim().toLowerCase();
    if (q) {
      // Searching shows matching accounts and their parents, fully expanded.
      const hits = report.rows.filter((r) => r.account.toLowerCase().includes(q));
      const keep = new Set(hits.flatMap((r) => r.account.split(':').map((_, i, a) => a.slice(0, i + 1).join(':'))));
      return report.rows.filter((r) => keep.has(r.account)).map((r) => ({ ...r, parent: parents.has(r.account) }));
    }
    return report.rows
      .filter((r) => ![...collapsed].some((c) => r.account.startsWith(c + ':')))
      .map((r) => ({ ...r, parent: parents.has(r.account) }));
  });
  const typeOf = $derived(new Map(app.accounts.map((a) => [a.name, a.type])));

  function toggle(a: string) {
    const next = new Set(collapsed);
    if (next.has(a)) next.delete(a);
    else next.add(a);
    v.collapsed = next;
  }
  const TYPE_LABEL: Record<string, string> = { A: 'Asset', C: 'Cash', L: 'Liability', E: 'Equity', R: 'Revenue', X: 'Expense', V: 'Conversion' };
</script>

<div class="bar">
  <div class="chips" role="group" aria-label="Account type">
    {#each FILTERS as f (f.id)}
      <button class="chip" type="button" aria-pressed={v.filter === f.id} onclick={() => (v.filter = f.id)}>{f.label}</button>
    {/each}
  </div>
  <ValueIn />
</div>
<div class="bar tools">
  <div class="search">
    <Icon name="search" size={16} />
    <label class="sr-only" for="acct-search">Search accounts</label>
    <input id="acct-search" type="search" placeholder="Search accounts" bind:value={v.search} autocomplete="off" autocapitalize="off" spellcheck="false" />
  </div>
  <button class="btn small ghost" type="button" onclick={() => (v.collapsed = new Set())}>Expand all</button>
  <button class="btn small ghost" type="button" onclick={() => (v.collapsed = new Set(parents))}>Collapse all</button>
  <label class="zero"><input type="checkbox" bind:checked={v.showZero} /> Show zero</label>
</div>

{#if error}
  <ErrorPanel title="hledger couldn't produce balances" errors={error.errors} />
  <button class="btn small" type="button" onclick={() => { error = null; attempt++; }}><Icon name="refresh" size={16} /> Retry</button>
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
  .tools { justify-content: flex-start; }
  .search { flex: 1 1 180px; min-width: 0; display: flex; align-items: center; gap: 8px; height: 38px; padding: 0 10px; border: 1px solid var(--border); border-radius: var(--radius-s); background: var(--surface); color: var(--text-3); }
  .search input { flex: 1; min-width: 0; border: 0; background: none; outline: none; color: var(--text); }
  .zero { display: inline-flex; gap: 6px; align-items: center; font-size: 0.85rem; color: var(--text-2); font-weight: 600; }
  .zero input { accent-color: var(--accent); }
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
