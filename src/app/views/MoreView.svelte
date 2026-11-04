<script lang="ts">
  import { href } from '../state/router.svelte';
  import { app } from '../state/app.svelte';
  import Icon from '../components/Icon.svelte';
  let { items }: { items: readonly { view: string; label: string; icon: string }[] } = $props();
  const DESC: Record<string, string> = {
    statements: 'Balance sheet, income statement, cash flow',
    import: 'Bring in bank CSVs with hledger rules',
    reconcile: 'Match an account against a statement',
    files: 'View and edit journal files as text',
    check: 'Run hledger’s strict checks',
    console: 'Run read-only hledger commands',
    settings: 'Journals, sync, appearance, engine',
  };
</script>

<ul class="card more">
  {#each items as n (n.view)}
    <li>
      <a href={href(n.view)}>
        <span class="ic"><Icon name={n.icon} /></span>
        <span class="t"><strong>{n.label}</strong><small>{DESC[n.view] ?? ''}</small></span>
        <Icon name="chevron-right" size={18} />
      </a>
    </li>
  {/each}
</ul>
<p class="foot muted">PocketLedger {__APP_VERSION__} · hledger {__ENGINE__.hledger} running locally {app.engineMs ? `(started in ${Math.round(app.engineMs)} ms)` : ''}</p>

<style>
  .more { list-style: none; margin: 0; padding: 0; overflow: hidden; }
  li + li { border-top: 1px solid var(--border); }
  a { display: flex; align-items: center; gap: 14px; padding: 14px 16px; color: var(--text); text-decoration: none; }
  a:hover { background: var(--surface-2); }
  .ic { width: 38px; height: 38px; border-radius: 10px; display: grid; place-items: center; background: var(--accent-soft); color: var(--accent-strong); }
  .t { flex: 1; display: grid; }
  small { color: var(--text-3); font-size: 0.82rem; }
  .foot { font-size: 0.78rem; text-align: center; margin-top: 16px; }
</style>
