<script lang="ts">
  // Period, query and valuation filters shared by every Reports tab.
  import { reportFilters as f } from '../../state/reports.svelte';
  import ValueIn from '../../components/ValueIn.svelte';
  import Icon from '../../components/Icon.svelte';
  import type { PresetId } from '../../lib/periods';

  let { interval = false, forecast = false, period = true }: { interval?: boolean; forecast?: boolean; period?: boolean } = $props();
  let showQuery = $state(f.query !== '');
  let draft = $state(f.query);
  let t: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    const q = draft;
    clearTimeout(t);
    t = setTimeout(() => {
      f.query = q;
      f.save();
    }, 400);
  });
  const PRESETS: [PresetId, string][] = [
    ['this-month', 'This month'],
    ['last-month', 'Last month'],
    ['last-3', '3 months'],
    ['last-6', '6 months'],
    ['last-12', '12 months'],
    ['this-year', 'This year'],
    ['last-year', 'Last year'],
    ['all', 'All'],
    ['custom', 'Custom'],
  ];
  const set = (p: PresetId) => {
    f.preset = p;
    f.save();
  };
</script>

<div class="bar">
  {#if period}
    <div class="chips" role="group" aria-label="Report period">
      {#each PRESETS as [id, label] (id)}
        <button class="chip" type="button" aria-pressed={f.preset === id} onclick={() => set(id)}>{label}</button>
      {/each}
    </div>
    {#if f.preset === 'custom'}
      <div class="custom">
        <label class="field"><span>From</span><input class="input" type="date" bind:value={f.begin} onchange={() => f.save()} /></label>
        <label class="field"><span>To (exclusive)</span><input class="input" type="date" bind:value={f.end} onchange={() => f.save()} /></label>
      </div>
    {/if}
  {/if}
  <div class="row">
    {#if showQuery}
      <div class="q">
        <Icon name="filter" size={16} />
        <label class="sr-only" for="report-query">Filter every report with an hledger query</label>
        <input id="report-query" class="mono" bind:value={draft} placeholder="e.g. not:acct:transfers tag:trip" autocomplete="off" spellcheck="false" />
        <button class="icon-btn small" type="button" aria-label="Clear filter" onclick={() => { draft = ''; showQuery = false; }}><Icon name="x" size={16} /></button>
      </div>
    {:else}
      <button class="link" type="button" onclick={() => (showQuery = true)}><Icon name="filter" size={14} /> Filter…</button>
    {/if}
    <span class="grow"></span>
    {#if forecast}
      <label class="check"><input type="checkbox" bind:checked={f.forecast} onchange={() => f.save()} /> Forecast</label>
    {/if}
    {#if interval}
      <div class="seg" role="group" aria-label="Chart interval">
        {#each [['auto', 'Auto'], ['daily', 'D'], ['weekly', 'W'], ['monthly', 'M'], ['quarterly', 'Q']] as [v, l] (v)}
          <button type="button" aria-pressed={f.interval === v} aria-label={v === 'auto' ? undefined : v} title={v === 'auto' ? 'Choose from the period length' : v} onclick={() => { f.interval = v as typeof f.interval; f.save(); }}>{l}</button>
        {/each}
      </div>
    {/if}
    <ValueIn />
  </div>
</div>

<style>
  .bar { display: grid; gap: 8px; margin-bottom: 12px; min-width: 0; }
  .chips { display: flex; gap: 6px; overflow-x: auto; scrollbar-width: none; padding-bottom: 2px; }
  .chips::-webkit-scrollbar { display: none; }
  .custom { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; min-width: 0; }
  .grow { flex: 1; }
  .q { display: flex; align-items: center; gap: 8px; flex: 1 1 260px; min-width: 0; padding: 0 4px 0 10px; height: 38px; border: 1px solid var(--border-strong); border-radius: var(--radius-s); background: var(--surface); color: var(--text-3); }
  .q input { flex: 1; min-width: 0; border: 0; background: none; outline: none; color: var(--text); font-size: 0.85rem; }
  .q:focus-within { border-color: var(--accent); }
  .icon-btn.small { width: 30px; height: 30px; }
  .link { display: inline-flex; align-items: center; gap: 4px; background: none; border: 0; color: var(--accent); font-weight: 600; font-size: 0.85rem; padding: 8px 2px; }
  .check { display: inline-flex; align-items: center; gap: 6px; font-size: 0.85rem; font-weight: 600; color: var(--text-2); }
  .check input { accent-color: var(--accent); width: 16px; height: 16px; }
  .seg { display: inline-flex; border: 1px solid var(--border-strong); border-radius: var(--radius-s); overflow: hidden; }
  .seg button { border: 0; background: var(--surface); padding: 6px 10px; font-size: 0.8rem; font-weight: 600; color: var(--text-2); min-height: 34px; }
  .seg button + button { border-left: 1px solid var(--border); }
  .seg button[aria-pressed='true'] { background: var(--accent-soft); color: var(--accent-strong); }
</style>
