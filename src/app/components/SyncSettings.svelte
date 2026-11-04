<script lang="ts">
  import { app } from '../state/app.svelte';
  import { syncState } from '../state/sync.svelte';
</script>

<section class="card sec" aria-labelledby="sync-h">
  <header><h2 id="sync-h">Sync</h2></header>
  <p class="muted">{app.vault?.provider === 'local' ? 'This journal lives only in this browser.' : `Status: ${syncState.status}`}</p>
</section>

<style>
  .sec { padding: 16px; margin-bottom: 12px; display: grid; gap: 12px; }
  h2 { font-size: 1rem; }
</style>
