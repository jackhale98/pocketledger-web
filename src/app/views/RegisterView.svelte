<script lang="ts">
  import type { RegisterRow } from '$lib/contracts/engine';
  import { EngineCallError } from '$lib/engine/client';
  import { app } from '../state/app.svelte';
  import { settings } from '../state/settings.svelte';
  import { editor } from '../state/editor.svelte';
  import { href, router } from '../state/router.svelte';
  import Money from '../components/Money.svelte';
  import Icon from '../components/Icon.svelte';
  import ValueIn from '../components/ValueIn.svelte';
  import ErrorPanel from '../components/ErrorPanel.svelte';

  let { account }: { account: string } = $props();
  let rows = $state.raw<RegisterRow[] | null>(null);
  let error = $state.raw<EngineCallError | null>(null);
  let limit = $state(200);

  $effect(() => {
    const rev = app.revision;
    const valueIn = settings.v.valueIn;
    const acct = account;
    if (!rev || !app.engine) return;
    rows = null;
    app.engine
      .register(acct, valueIn ? { valueIn } : {})
      .then((r) => {
        rows = r;
        error = null;
      })
      .catch((e) => (error = e));
  });
  const shown = $derived(rows ? [...rows].reverse().slice(0, limit) : []);
  const crumbs = $derived(account.split(':').map((part, i, all) => ({ part, full: all.slice(0, i + 1).join(':') })));
  const current = $derived(rows?.length ? rows[rows.length - 1]!.balance : []);

  function open(r: RegisterRow) {
    const t = app.txns.find((x) => x.index === r.txnIndex);
    if (t) editor.show(t);
  }
</script>

<nav class="crumbs" aria-label="Account path">
  <button class="icon-btn" type="button" onclick={() => router.back('accounts')} aria-label="Back"><Icon name="chevron-left" /></button>
  {#each crumbs as c, i (c.full)}
    {#if i > 0}<span class="muted">:</span>{/if}
    {#if i === crumbs.length - 1}<strong>{c.part}</strong>{:else}<a href={href('account', c.full)}>{c.part}</a>{/if}
  {/each}
</nav>

<div class="summary card card-pad">
  <div>
    <p class="label">Balance</p>
    <p class="big"><Money value={current} /></p>
  </div>
  <div class="actions">
    <ValueIn />
    <a class="btn small" href="{href('reconcile')}?account={encodeURIComponent(account)}"><Icon name="check-circle" size={16} /> Reconcile</a>
  </div>
</div>

{#if error}
  <ErrorPanel title="hledger couldn't produce a register" errors={error.errors} />
{:else if !rows}
  <div class="card">{#each Array(6) as _, i (i)}<div class="sk"><div class="skeleton" style="width:60%;height:14px"></div></div>{/each}</div>
{:else if rows.length === 0}
  <div class="card card-pad muted">No postings to this account.</div>
{:else}
  <div class="card table-wrap">
    <table>
      <caption class="sr-only">Register for {account}, newest first</caption>
      <thead><tr><th scope="col">Date</th><th scope="col">Description</th><th scope="col" class="r">Amount</th><th scope="col" class="r">Balance</th></tr></thead>
      <tbody>
        {#each shown as r, i (i)}
          <tr class:click={r.txnIndex > 0}>
            <td class="date num">{r.date}</td>
            <td class="desc">
              <button type="button" class="link" onclick={(e) => { e.stopPropagation(); open(r); }} disabled={!r.txnIndex}>{r.description}</button>
              {#if r.posting.account !== account}<span class="sub">{r.posting.account}</span>{/if}
              {#if r.posting.status === '*'}<span class="sr-only">cleared</span>{/if}
            </td>
            <td class="r"><Money value={r.posting.amount} color /></td>
            <td class="r bal"><Money value={r.balance} /></td>
          </tr>
        {/each}
      </tbody>
    </table>
    {#if rows.length > limit}<button class="btn small ghost more" type="button" onclick={() => (limit += 300)}>Show more</button>{/if}
  </div>
{/if}

<style>
  .crumbs { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; margin: -4px 0 10px -8px; font-size: 0.95rem; }
  .crumbs a { color: var(--text-2); }
  .summary { display: flex; justify-content: space-between; align-items: flex-end; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
  .big { font-size: 1.6rem; font-weight: 750; }
  .actions { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  .table-wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
  th { text-align: left; font-size: 0.75rem; color: var(--text-3); font-weight: 650; padding: 10px 12px; border-bottom: 1px solid var(--border); }
  td { padding: 10px 12px; border-bottom: 1px solid var(--border); vertical-align: top; }
  .r { text-align: right; }
  .date { white-space: nowrap; color: var(--text-2); }
  .desc { min-width: 160px; }
  .link { background: none; border: 0; padding: 0; text-align: left; font-weight: 560; color: var(--text); }
  .link:hover:not(:disabled) { color: var(--accent); text-decoration: underline; }
  .sub { display: block; font-size: 0.78rem; color: var(--text-3); }
  .bal { color: var(--text-2); }
  tr.click:hover td { background: var(--surface-2); }
  .more { margin: 8px auto; display: flex; }
  .sk { padding: 18px 16px; border-bottom: 1px solid var(--border); }
  @media (max-width: 560px) { .date { font-size: 0.8rem; } td, th { padding: 9px 8px; } }
</style>
