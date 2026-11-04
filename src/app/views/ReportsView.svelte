<script lang="ts">
  // Reports hub: Overview, Table, Account, Forecast, Prices, Stats — one filter bar for all.
  import { reportFilters as f, type ReportTab } from '../state/reports.svelte';
  import FilterBar from './reports/FilterBar.svelte';
  import OverviewTab from './reports/OverviewTab.svelte';
  import TableTab from './reports/TableTab.svelte';
  import AccountTab from './reports/AccountTab.svelte';
  import PricesTab from './reports/PricesTab.svelte';
  import StatsTab from './reports/StatsTab.svelte';
  import ForecastTab from './reports/ForecastTab.svelte';

  const TABS: [ReportTab, string][] = [
    ['overview', 'Overview'],
    ['table', 'Table'],
    ['account', 'Account'],
    ['forecast', 'Forecast'],
    ['prices', 'Prices'],
    ['stats', 'Stats'],
  ];
  const select = (t: ReportTab) => {
    f.tab = t;
    f.save();
  };
</script>

<div class="tabs" role="tablist" aria-label="Report">
  {#each TABS as [t, label] (t)}
    <button role="tab" type="button" id="rt-{t}" aria-controls="rp" aria-selected={f.tab === t} onclick={() => select(t)}>{label}</button>
  {/each}
</div>

<!-- Forecast has its own horizon; a date filter would clip the projection. -->
<FilterBar interval={f.tab === 'overview' || f.tab === 'account'} forecast={f.tab === 'overview'} period={f.tab !== 'forecast'} />

<div id="rp" role="tabpanel" aria-labelledby="rt-{f.tab}" class="panel">
  {#if f.tab === 'table'}<TableTab />
  {:else if f.tab === 'account'}<AccountTab />
  {:else if f.tab === 'forecast'}<ForecastTab query={f.words} />
  {:else if f.tab === 'prices'}<PricesTab />
  {:else if f.tab === 'stats'}<StatsTab />
  {:else}<OverviewTab />{/if}
</div>

<style>
  .tabs { display: flex; gap: 4px; padding: 4px; background: var(--surface-2); border-radius: var(--radius); margin-bottom: 12px; overflow-x: auto; scrollbar-width: none; }
  .tabs::-webkit-scrollbar { display: none; }
  .tabs button { flex: 1 0 auto; min-height: 40px; border: 0; background: none; border-radius: var(--radius-s); font-weight: 600; font-size: 0.88rem; color: var(--text-2); white-space: nowrap; padding: 0 12px; }
  .tabs button[aria-selected='true'] { background: var(--surface); color: var(--text); box-shadow: var(--shadow-1); }
  .panel { min-width: 0; }
</style>
