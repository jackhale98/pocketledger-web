<script lang="ts">
  // "Value in" commodity picker (hledger -X). Empty = show native commodities.
  import { app } from '../state/app.svelte';
  import { settings } from '../state/settings.svelte';
  const id = `vi-${Math.random().toString(36).slice(2)}`;
</script>

{#if app.commodities.length > 1}
  <label class="vi" for={id}>
    <span>Value in</span>
    <select {id} class="input" value={settings.v.valueIn} onchange={(e) => settings.set('valueIn', (e.currentTarget as HTMLSelectElement).value)}>
      <option value="">Native</option>
      {#each app.commodities as c (c.symbol)}<option value={c.symbol}>{c.symbol}</option>{/each}
    </select>
  </label>
{/if}

<style>
  .vi { display: inline-flex; align-items: center; gap: 8px; font-size: 0.82rem; color: var(--text-2); font-weight: 600; }
  select { min-height: 34px; padding: 4px 8px; width: auto; font-size: 0.85rem; }
</style>
