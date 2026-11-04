<script lang="ts">
  import { onMount } from 'svelte';
  import { app } from './state/app.svelte';
  import { router, href } from './state/router.svelte';
  import { editor } from './state/editor.svelte';
  import Icon from './components/Icon.svelte';
  import Toasts from './components/Toasts.svelte';
  import ErrorPanel from './components/ErrorPanel.svelte';
  import TxnEditor from './components/TxnEditor.svelte';
  import TxnDetail from './components/TxnDetail.svelte';
  import VaultSwitcher from './components/VaultSwitcher.svelte';
  import TransactionsView from './views/TransactionsView.svelte';
  import AccountsView from './views/AccountsView.svelte';
  import RegisterView from './views/RegisterView.svelte';
  import ReportsView from './views/ReportsView.svelte';
  import StatementsView from './views/StatementsView.svelte';
  import BudgetView from './views/BudgetView.svelte';
  import MoreView from './views/MoreView.svelte';
  import SettingsView from './views/SettingsView.svelte';
  import ImportView from './views/ImportView.svelte';
  import ReconcileView from './views/ReconcileView.svelte';
  import ConsoleView from './views/ConsoleView.svelte';
  import CheckView from './views/CheckView.svelte';
  import FilesView from './views/FilesView.svelte';
  import { startPwa } from '$lib/pwa/register';
  import { startSync } from './state/sync.svelte';

  const NAV = [
    { view: 'transactions', label: 'Transactions', icon: 'list' },
    { view: 'accounts', label: 'Accounts', icon: 'wallet' },
    { view: 'reports', label: 'Reports', icon: 'chart' },
    { view: 'budget', label: 'Budget', icon: 'target' },
  ] as const;
  const SECONDARY = [
    { view: 'statements', label: 'Statements', icon: 'scale' },
    { view: 'import', label: 'Import CSV', icon: 'upload' },
    { view: 'reconcile', label: 'Reconcile', icon: 'check-circle' },
    { view: 'files', label: 'Files', icon: 'file' },
    { view: 'check', label: 'Check', icon: 'shield' },
    { view: 'console', label: 'Console', icon: 'terminal' },
    { view: 'settings', label: 'Settings', icon: 'settings' },
  ] as const;

  const view = $derived(router.route.view);
  const moreActive = $derived(['more', ...SECONDARY.map((s) => s.view)].includes(view as never));
  const title = $derived(
    [...NAV, ...SECONDARY, { view: 'more', label: 'More' }, { view: 'account', label: 'Register' }].find((n) => n.view === view)?.label ?? 'PocketLedger',
  );

  onMount(() => {
    void app.start().then(() => document.getElementById('pl-loader')?.remove());
    startPwa();
    startSync();
    // Opened from the OS with .journal / .csv files (PWA file handler).
    const lq = (window as unknown as { launchQueue?: { setConsumer(f: (p: { files: FileSystemFileHandle[] }) => void): void } }).launchQueue;
    lq?.setConsumer(async ({ files }) => {
      if (!files.length) return;
      const texts: Record<string, string> = {};
      for (const h of files) texts[h.name] = await (await h.getFile()).text();
      const journals = Object.keys(texts).filter((n) => !n.endsWith('.csv'));
      if (journals.length) await app.createVault({ name: journals[0]!.replace(/\.[^.]+$/, ''), provider: 'local' }, texts).catch(() => {});
      else router.go('import');
    });
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, select, [contenteditable], dialog')) return;
      if (e.key === 'n' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        editor.openNew();
      } else if (e.key === '/') {
        e.preventDefault();
        router.go('transactions');
        setTimeout(() => document.getElementById('txn-search')?.focus(), 30);
      } else if ((e.metaKey || e.ctrlKey) && e.key === 'z' && app.undoStack.length) {
        e.preventDefault();
        void app.undo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
</script>

<a class="skip" href="#main">Skip to content</a>
<div class="shell">
  <aside class="sidebar" aria-label="Main navigation">
    <div class="brand">
      <svg viewBox="0 0 32 32" width="28" height="28" aria-hidden="true"><rect width="32" height="32" rx="8" fill="var(--accent)" /><path d="M9 10h14M9 16h14M9 22h8" stroke="var(--accent-text)" stroke-width="2.6" stroke-linecap="round" /></svg>
      <span>PocketLedger</span>
    </div>
    <VaultSwitcher />
    <button class="btn primary add" type="button" onclick={() => editor.openNew()} disabled={!app.ready || app.readOnly}>
      <Icon name="plus" /> New transaction
    </button>
    <nav>
      {#each NAV as n (n.view)}
        <a href={href(n.view)} aria-current={view === n.view || (n.view === 'accounts' && view === 'account') ? 'page' : undefined}><Icon name={n.icon} />{n.label}</a>
      {/each}
      <div class="sep" role="separator"></div>
      {#each SECONDARY as n (n.view)}
        <a href={href(n.view)} aria-current={view === n.view ? 'page' : undefined}><Icon name={n.icon} />{n.label}</a>
      {/each}
    </nav>
    <div class="engine-foot">
      {#if app.engineStatus === 'starting'}<span class="dot busy"></span> Starting hledger…
      {:else if app.engineStatus === 'error'}<span class="dot err"></span> Engine failed
      {:else}<span class="dot ok"></span> hledger {__ENGINE__.hledger} · WASM{/if}
    </div>
  </aside>

  <div class="main-col">
    <header class="topbar">
      <h1>{title}</h1>
      <div class="top-actions">
        {#if app.loading}<span class="updating" role="status">Updating…</span>{/if}
        {#if app.undoStack.length}
          <button class="icon-btn" type="button" onclick={() => app.undo()} aria-label="Undo {app.undoStack[app.undoStack.length - 1]?.label}" title="Undo"><Icon name="undo" /></button>
        {/if}
        <div class="mobile-only"><VaultSwitcher compact /></div>
      </div>
    </header>

    {#if app.readOnly}
      <div class="banner warn" role="status">
        <Icon name="lock" /> This vault is open for editing in another tab. This tab is read-only.
        <button class="btn small" type="button" onclick={() => window.dispatchEvent(new CustomEvent('pl:edit-here'))}>Edit here</button>
      </div>
    {/if}
    {#if app.vault?.conflicted}
      <div class="banner err" role="alert">
        <Icon name="alert" /> Sync produced a journal hledger can't read. Your local copy is unchanged; resolve it in
        <a href={href('settings')}>Settings → Sync</a>.
      </div>
    {/if}

    <main id="main" tabindex="-1">
      {#if app.engineStatus === 'error'}
        <ErrorPanel title="The hledger engine could not start" errors={[{ kind: 'internal', message: app.engineError }]} />
      {:else if app.loadErrors.length && !app.revision}
        <ErrorPanel title="hledger could not read this journal" errors={app.loadErrors} />
      {:else}
        {#if app.loadErrors.length}
          <ErrorPanel title="The latest change could not be read; showing the last good version" errors={app.loadErrors} compact />
        {/if}
        {#if view === 'transactions'}<TransactionsView />
        {:else if view === 'accounts'}<AccountsView />
        {:else if view === 'account'}<RegisterView account={router.route.param} />
        {:else if view === 'reports'}<ReportsView />
        {:else if view === 'statements'}<StatementsView />
        {:else if view === 'budget'}<BudgetView />
        {:else if view === 'import'}<ImportView />
        {:else if view === 'reconcile'}<ReconcileView />
        {:else if view === 'console'}<ConsoleView />
        {:else if view === 'check'}<CheckView />
        {:else if view === 'files'}<FilesView />
        {:else if view === 'settings'}<SettingsView />
        {:else if view === 'more'}<MoreView items={SECONDARY} />
        {:else}<TransactionsView />{/if}
      {/if}
    </main>
  </div>

  {#if !['settings', 'console', 'files', 'more', 'check'].includes(view)}
    <button class="fab" type="button" onclick={() => editor.openNew()} disabled={!app.ready || app.readOnly} aria-label="New transaction">
      <Icon name="plus" size={26} />
    </button>
  {/if}

  <nav class="tabbar" aria-label="Main navigation">
    {#each NAV as n (n.view)}
      <a href={href(n.view)} aria-current={view === n.view || (n.view === 'accounts' && view === 'account') ? 'page' : undefined}><Icon name={n.icon} /><span>{n.label}</span></a>
    {/each}
    <a href={href('more')} aria-current={moreActive ? 'page' : undefined}><Icon name="more" /><span>More</span></a>
  </nav>
</div>

<TxnEditor />
<TxnDetail />
<Toasts />

<style>
  .skip { position: absolute; left: -999px; top: 8px; z-index: 100; background: var(--surface); padding: 8px 12px; border-radius: 8px; }
  .skip:focus { left: 8px; }
  .shell { min-height: 100dvh; display: flex; }
  .main-col { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .topbar {
    position: sticky; top: 0; z-index: 10; display: flex; align-items: center; justify-content: space-between;
    padding: calc(8px + var(--safe-t)) 12px 8px 16px; min-height: 56px;
    background: color-mix(in srgb, var(--bg) 88%, transparent); backdrop-filter: saturate(1.4) blur(12px);
    border-bottom: 1px solid var(--border);
  }
  .topbar h1 { font-size: 1.15rem; font-weight: 700; }
  .top-actions { display: flex; align-items: center; gap: 4px; }
  .updating { font-size: 0.78rem; color: var(--text-3); margin-right: 6px; }
  main { flex: 1; padding: 12px 12px calc(var(--nav-h) + 88px + var(--safe-b)); width: 100%; max-width: 1180px; margin: 0 auto; outline: none; }
  .banner { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin: 10px 12px 0; padding: 10px 14px; border-radius: var(--radius); font-size: 0.9rem; }
  .banner.warn { background: var(--warn-soft); color: var(--warn); }
  .banner.err { background: var(--neg-soft); color: var(--neg); }

  .sidebar { display: none; }
  .tabbar {
    position: fixed; z-index: 20; left: 0; right: 0; bottom: 0; display: grid; grid-template-columns: repeat(5, 1fr);
    height: calc(var(--nav-h) + var(--safe-b)); padding-bottom: var(--safe-b);
    background: color-mix(in srgb, var(--surface) 92%, transparent); backdrop-filter: saturate(1.4) blur(14px);
    border-top: 1px solid var(--border);
  }
  .tabbar a {
    display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px;
    color: var(--text-3); text-decoration: none; font-size: 0.7rem; font-weight: 600;
  }
  .tabbar a[aria-current='page'] { color: var(--accent); }
  .fab {
    position: fixed; z-index: 21; right: 18px; bottom: calc(var(--nav-h) + 18px + var(--safe-b));
    width: 58px; height: 58px; border-radius: 18px; border: 0; background: var(--accent); color: var(--accent-text);
    display: grid; place-items: center; box-shadow: var(--shadow-2); transition: transform 120ms var(--ease);
  }
  .fab:active { transform: scale(0.94); }
  .fab:disabled { opacity: 0.5; }

  @media (min-width: 960px) {
    .tabbar, .fab, .mobile-only { display: none; }
    main { padding: 20px 28px 48px; }
    .topbar { padding: 12px 28px; }
    .sidebar {
      display: flex; flex-direction: column; gap: 12px; position: sticky; top: 0; height: 100dvh; width: 252px; flex: none;
      padding: 16px 12px; border-right: 1px solid var(--border); background: var(--surface);
    }
    .brand { display: flex; align-items: center; gap: 10px; font-weight: 750; font-size: 1.05rem; padding: 4px 8px; }
    .add { width: 100%; }
    nav { display: grid; gap: 2px; overflow: auto; }
    nav a {
      display: flex; align-items: center; gap: 12px; padding: 9px 12px; border-radius: var(--radius-s);
      color: var(--text-2); text-decoration: none; font-weight: 560; font-size: 0.93rem;
    }
    nav a:hover { background: var(--surface-2); color: var(--text); }
    nav a[aria-current='page'] { background: var(--accent-soft); color: var(--accent-strong); }
    .sep { height: 1px; background: var(--border); margin: 8px 6px; }
    .engine-foot { margin-top: auto; font-size: 0.78rem; color: var(--text-3); display: flex; align-items: center; gap: 8px; padding: 4px 8px; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--text-3); }
    .dot.ok { background: var(--pos); }
    .dot.err { background: var(--neg); }
    .dot.busy { background: var(--warn); animation: pulse 1s infinite alternate; }
  }
  @keyframes pulse { to { opacity: 0.35; } }
</style>
