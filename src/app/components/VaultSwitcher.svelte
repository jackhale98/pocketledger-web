<script lang="ts">
  import { app } from '../state/app.svelte';
  import { router } from '../state/router.svelte';
  import { syncState } from '../state/sync.svelte';
  import Icon from './Icon.svelte';

  let { compact = false }: { compact?: boolean } = $props();
  let open = $state(false);

  const providerIcon: Record<string, string> = { demo: 'book', local: 'folder', fsa: 'folder', dropbox: 'cloud', github: 'git' };
  async function choose(id: string) {
    open = false;
    await app.openVault(id);
  }
</script>

<div class="vs" class:compact>
  <button class={compact ? 'icon-btn' : 'current'} type="button" aria-haspopup="menu" aria-expanded={open} onclick={() => (open = !open)} aria-label={compact ? `Switch journal (current: ${app.vault?.name ?? 'none'})` : undefined} title="Switch journal">
    <Icon name={providerIcon[app.vault?.provider ?? 'demo'] ?? 'folder'} />
    {#if !compact}
      <span class="name">{app.vault?.name ?? '—'}</span>
      {#if syncState.status === 'syncing'}<span class="badge">Syncing</span>
      {:else if syncState.pending > 0}<span class="badge warn">{syncState.pending} unsynced</span>{/if}
      <Icon name="chevron-down" size={16} />
    {/if}
  </button>
  {#if open}
    <div class="menu" role="menu">
      {#each app.vaults as v (v.id)}
        <button role="menuitemradio" aria-checked={v.id === app.vault?.id} type="button" onclick={() => choose(v.id)}>
          <Icon name={providerIcon[v.provider] ?? 'folder'} size={18} /> {v.name}
          {#if v.id === app.vault?.id}<Icon name="check" size={16} />{/if}
        </button>
      {/each}
      <button role="menuitemradio" aria-checked={app.vault?.id === 'demo'} type="button" onclick={() => choose('demo')}>
        <Icon name="book" size={18} /> Demo journal {#if app.vault?.id === 'demo'}<Icon name="check" size={16} />{/if}
      </button>
      <div class="sep"></div>
      <button role="menuitem" type="button" onclick={() => { open = false; router.go('settings', '', { add: '1' }); }}>
        <Icon name="plus" size={18} /> Open or connect a journal…
      </button>
    </div>
  {/if}
</div>

<style>
  .vs { position: relative; }
  .current {
    width: 100%; display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: var(--radius-s);
    border: 1px solid var(--border); background: var(--surface-2); text-align: left; font-weight: 600; font-size: 0.92rem;
  }
  .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .menu {
    position: absolute; z-index: 40; top: calc(100% + 6px); left: 0; min-width: 240px; padding: 6px;
    background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow-2);
  }
  .compact .menu { left: auto; right: 0; }
  .menu button {
    width: 100%; display: flex; align-items: center; gap: 10px; padding: 10px; border: 0; background: none; border-radius: 6px;
    text-align: left; font-size: 0.92rem;
  }
  .menu button:hover { background: var(--surface-2); }
  .menu button :global(svg:last-child:not(:first-child)) { margin-left: auto; color: var(--accent); }
  .sep { height: 1px; background: var(--border); margin: 4px; }
</style>
