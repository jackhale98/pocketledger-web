<script lang="ts">
  // hledger's checks (`hledger check NAME`). Basic checks always run on load and save.
  import type { EngineError } from '$lib/contracts/engine';
  import { app } from '../state/app.svelte';
  import { settings } from '../state/settings.svelte';
  import { href } from '../state/router.svelte';
  import Icon from '../components/Icon.svelte';

  const CHECKS = [
    { id: 'accounts', label: 'Accounts declared', desc: 'Every account used has an account directive.' },
    { id: 'commodities', label: 'Commodities declared', desc: 'Every commodity has a commodity directive.' },
    { id: 'payees', label: 'Payees declared', desc: 'Every payee has a payee directive.' },
    { id: 'ordereddates', label: 'Dates in order', desc: 'Transactions in each file are in date order.' },
    { id: 'uniqueleafnames', label: 'Unique leaf names', desc: 'No two accounts share a last name part.' },
    { id: 'balancednoautoconversion', label: 'No auto conversion', desc: 'Multi-commodity transactions state their costs.' },
    { id: 'tags', label: 'Tags declared', desc: 'Every tag has a tag directive.' },
    { id: 'recentassertions', label: 'Recent assertions', desc: 'Balance-asserted accounts were asserted recently.' },
  ];
  let results = $state<Record<string, EngineError[] | 'running' | undefined>>({});

  async function run(id: string) {
    if (!app.snapshot || !app.engine) return;
    results[id] = 'running';
    results[id] = await app.engine.check(app.snapshot, [id]);
  }
  async function runAll() {
    for (const c of CHECKS) await run(c.id);
  }
  function toggleStrict(id: string, on: boolean) {
    const cur = new Set(settings.v.strictChecks);
    if (on) cur.add(id);
    else cur.delete(id);
    settings.set('strictChecks', [...cur]);
  }
</script>

<div class="head">
  <p class="muted">Parsing, balancing and balance assertions are always checked. Enforced checks also block saving.</p>
  <button class="btn primary small" type="button" onclick={runAll} disabled={!app.ready}><Icon name="shield" size={16} /> Run all</button>
</div>
<ul class="card list">
  {#each CHECKS as c (c.id)}
    {@const r = results[c.id]}
    <li>
      <div class="row">
        <span class="st" aria-hidden="true">
          {#if r === 'running'}<span class="spin"></span>{:else if r && r.length === 0}<span class="pos"><Icon name="check-circle" /></span>{:else if r}<span class="neg"><Icon name="alert" /></span>{:else}<span class="muted"><Icon name="info" /></span>{/if}
        </span>
        <div class="t"><strong>{c.label}</strong><small class="muted">{c.desc} <code>{c.id}</code></small></div>
        <button class="btn small" type="button" onclick={() => run(c.id)} disabled={!app.ready}>Check</button>
      </div>
      <label class="enf"><input type="checkbox" checked={settings.v.strictChecks.includes(c.id)} onchange={(e) => toggleStrict(c.id, (e.currentTarget as HTMLInputElement).checked)} /> Enforce when saving</label>
      {#if r && r !== 'running' && r.length}
        {#each r as e, i (i)}
          {#if e.file}<a class="loc mono" href="{href('files', e.file)}?line={e.line ?? 1}">{e.file}:{e.line}</a>{/if}
          <pre>{e.message}</pre>
        {/each}
      {/if}
      <span class="sr-only" role="status">{r === 'running' ? 'Running' : r ? (r.length ? 'Failed' : 'Passed') : ''}</span>
    </li>
  {/each}
</ul>

<style>
  .head { display: flex; justify-content: space-between; gap: 12px; align-items: center; margin-bottom: 12px; flex-wrap: wrap; font-size: 0.88rem; }
  .list { list-style: none; margin: 0; padding: 0; overflow: hidden; }
  li { padding: 12px 16px; }
  li + li { border-top: 1px solid var(--border); }
  .row { display: flex; gap: 12px; align-items: center; }
  .t { flex: 1; display: grid; }
  code { font-family: var(--mono); font-size: 0.78rem; }
  .enf { display: flex; gap: 8px; align-items: center; font-size: 0.82rem; color: var(--text-2); margin: 6px 0 0 36px; }
  .loc { display: block; margin: 8px 0 4px 36px; font-size: 0.8rem; }
  pre { margin: 4px 0 0 36px; padding: 10px; background: var(--neg-soft); border-radius: var(--radius-s); font-family: var(--mono); font-size: 0.78rem; white-space: pre-wrap; }
  .spin { width: 18px; height: 18px; border-radius: 50%; border: 2px solid var(--border-strong); border-top-color: var(--accent); display: inline-block; animation: s 0.8s linear infinite; }
  @keyframes s { to { transform: rotate(360deg); } }
</style>
