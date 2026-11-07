<script lang="ts">
  // Valuation control: amounts as written, at cost (hledger -B), at market value (-X C, or -V
  // for each commodity's own price currency) or as unrealized gain (--gain -X C).
  import { app } from '../state/app.svelte';
  import { settings, type Valuation } from '../state/settings.svelte';
  const id = `vi-${Math.random().toString(36).slice(2)}`;
  const MODES: [Valuation, string][] = [
    ['', 'As written'],
    ['cost', 'Cost'],
    ['value', 'Market value'],
    ['gain', 'Unrealized gain'],
  ];
  const priced = $derived(settings.v.valuation === 'value' || settings.v.valuation === 'gain');
</script>

{#if app.commodities.length > 1}
  <div class="vi" role="group" aria-label="Valuation">
    <label for={id}>Amounts</label>
    <select {id} class="input" value={settings.v.valuation} onchange={(e) => settings.set('valuation', (e.currentTarget as HTMLSelectElement).value as Valuation)}>
      {#each MODES as [v, l] (v)}<option value={v}>{l}</option>{/each}
    </select>
    {#if priced}
      <span class="cur">
        <label for="{id}-c">in<span class="sr-only"> currency</span></label>
        <select id="{id}-c" class="input" value={settings.v.valueIn} onchange={(e) => settings.set('valueIn', (e.currentTarget as HTMLSelectElement).value)}>
          <option value="">Price currency</option>
          {#each app.commodities as c (c.symbol)}<option value={c.symbol}>{c.symbol}</option>{/each}
        </select>
      </span>
    {/if}
  </div>
{/if}

<style>
  .vi { display: inline-flex; align-items: center; gap: 6px; font-size: 0.82rem; color: var(--text-2); font-weight: 600; flex-wrap: wrap; min-width: 0; }
  .cur { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
  select { min-height: 34px; padding: 4px 8px; width: auto; max-width: 11rem; font-size: 0.85rem; }
</style>
