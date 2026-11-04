<script lang="ts">
  import { app } from '../state/app.svelte';
  import { settings } from '../state/settings.svelte';
  import { router } from '../state/router.svelte';
  import { toasts } from '../state/toast.svelte';
  import { syncState } from '../state/sync.svelte';
  import { persistStorage, isIOS, isStandalone } from '$lib/pwa/register';
  import { isEngineFile } from '$lib/vault';
  import { newJournalTemplate } from '../lib/template';
  import Icon from '../components/Icon.svelte';
  import Sheet from '../components/Sheet.svelte';
  import SyncSettings from '../components/SyncSettings.svelte';

  let addOpen = $state(router.route.query.get('add') === '1');
  let newOpen = $state(false);
  let newName = $state('Personal');
  let newCommodity = $state('$');
  let persisted = $state<boolean | null>(null);
  let usage = $state('');
  const canFsa = typeof window !== 'undefined' && 'showDirectoryPicker' in window;

  $effect(() => {
    navigator.storage?.persisted?.().then((p) => (persisted = p)).catch(() => {});
    navigator.storage?.estimate?.().then((e) => (usage = e.usage ? `${(e.usage / 1048576).toFixed(1)} MB used` : '')).catch(() => {});
  });

  async function createNew() {
    try {
      await app.createVault({ name: newName.trim() || 'Journal', provider: 'local', rootFile: 'main.journal' }, { 'main.journal': newJournalTemplate(newCommodity.trim() || '$') });
      newOpen = false;
      addOpen = false;
      persisted = await persistStorage();
      toasts.show('Journal created', { tone: 'ok' });
      router.go('transactions');
    } catch (e) {
      toasts.show((e as Error).message, { tone: 'error' });
    }
  }

  async function importFiles(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const list = [...(input.files ?? [])];
    const files: Record<string, string> = {};
    for (const f of list) {
      const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
      const path = rel.includes('/') && input.hasAttribute('webkitdirectory') ? rel.split('/').slice(1).join('/') : rel;
      if (isEngineFile(path)) files[path] = await f.text();
    }
    input.value = '';
    if (!Object.keys(files).length) return toasts.show('No journal, rules or CSV files found', { tone: 'error' });
    try {
      const name = list[0]?.name.replace(/\.[^.]+$/, '') ?? 'Imported';
      await app.createVault({ name, provider: 'local' }, files);
      addOpen = false;
      persisted = await persistStorage();
      toasts.show(`Imported ${Object.keys(files).length} file(s)`, { tone: 'ok' });
      router.go('transactions');
    } catch (err) {
      toasts.show((err as Error).message, { tone: 'error' });
    }
  }

  async function openFolder() {
    try {
      const dir = await (window as unknown as { showDirectoryPicker: (o: object) => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker({ mode: 'readwrite' });
      const files: Record<string, string> = {};
      async function walk(h: FileSystemDirectoryHandle, prefix: string) {
        for await (const [name, entry] of (h as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
          if (name.startsWith('.')) continue;
          const path = prefix + name;
          if (entry.kind === 'directory') await walk(entry as FileSystemDirectoryHandle, path + '/');
          else if (isEngineFile(path)) files[path] = await (await (entry as FileSystemFileHandle).getFile()).text();
        }
      }
      await walk(dir, '');
      const rec = await app.createVault({ name: dir.name, provider: 'fsa' }, files, true);
      await app.getStore()?.setSetting(`fsa:${rec.id}`, dir);
      addOpen = false;
      toasts.show(`Opened ${dir.name}: edits are saved back to the folder`, { tone: 'ok' });
      router.go('transactions');
    } catch (e) {
      if ((e as Error).name !== 'AbortError') toasts.show((e as Error).message, { tone: 'error' });
    }
  }

  async function remove(id: string, name: string) {
    if (!confirm(`Remove “${name}” from this device? Files in Dropbox, GitHub or your folder are not touched.`)) return;
    await app.deleteVault(id);
  }
  async function rename(id: string, current: string) {
    const name = prompt('Rename journal', current)?.trim();
    if (!name || !app.vault) return;
    if (app.vault.id === id) await app.updateVault({ name });
    else {
      const store = app.getStore();
      const rec = await store?.getVault(id);
      if (rec) await store!.putVault({ ...rec, name });
      await app.refreshVaults();
    }
  }
  const PROVIDER: Record<string, string> = { local: 'This device', fsa: 'Folder on disk', dropbox: 'Dropbox', github: 'GitHub', demo: 'Demo' };
</script>

<section class="card sec" aria-labelledby="j-h">
  <header><h2 id="j-h">Journals</h2><button class="btn small primary" type="button" onclick={() => (addOpen = true)}><Icon name="plus" size={16} /> Add</button></header>
  <ul class="vaults">
    {#each app.vaults as v (v.id)}
      <li>
        <button class="open" type="button" onclick={() => app.openVault(v.id)} aria-current={v.id === app.vault?.id ? 'true' : undefined}>
          <strong>{v.name}</strong><small>{PROVIDER[v.provider]} · {v.rootFile}</small>
        </button>
        {#if v.id === app.vault?.id}<span class="badge ok">Open</span>{/if}
        <button class="icon-btn" type="button" onclick={() => rename(v.id, v.name)} aria-label="Rename {v.name}"><Icon name="edit" size={18} /></button>
        <button class="icon-btn" type="button" onclick={() => remove(v.id, v.name)} aria-label="Remove {v.name}"><Icon name="trash" size={18} /></button>
      </li>
    {/each}
    <li>
      <button class="open" type="button" onclick={() => app.openDemo()} aria-current={app.isDemo ? 'true' : undefined}><strong>Demo journal</strong><small>Sample data, dated to this month. Changes are not kept.</small></button>
      {#if app.isDemo}<span class="badge ok">Open</span>{/if}
    </li>
  </ul>
  {#if app.vault && !app.isDemo}
    <div class="row">
      <label class="field grow"><span>Root journal</span>
        <select class="input" value={app.vault.rootFile} onchange={(e) => app.updateVault({ rootFile: (e.currentTarget as HTMLSelectElement).value }).then(() => app.reload())}>
          {#each app.engineFiles().filter((f) => /\.(journal|hledger|ledger|j)$/i.test(f)) as f (f)}<option value={f}>{f}</option>{/each}
        </select>
      </label>
      <label class="field grow"><span>New transactions go to</span>
        <select class="input" value={app.vault.addTarget ?? ''} onchange={(e) => app.updateVault({ addTarget: (e.currentTarget as HTMLSelectElement).value || null })}>
          <option value="">Root journal</option>
          {#each app.engineFiles().filter((f) => /\.(journal|hledger|ledger|j)$/i.test(f) && f !== app.vault?.rootFile) as f (f)}<option value={f}>{f}</option>{/each}
        </select>
      </label>
    </div>
  {/if}
</section>

{#if app.vault && !app.isDemo}
  <SyncSettings />
{/if}

<section class="card sec" aria-labelledby="a-h">
  <header><h2 id="a-h">Appearance & entry</h2></header>
  <div class="opts">
    <fieldset class="seg-f">
      <legend class="label">Theme</legend>
      <div class="seg" role="radiogroup" aria-label="Theme">
        {#each [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']] as [v, l] (v)}
          <button type="button" role="radio" aria-checked={settings.v.theme === v} onclick={() => settings.set('theme', v as 'system')}>{l}</button>
        {/each}
      </div>
    </fieldset>
    <label class="check"><input type="checkbox" checked={settings.v.dateOrder} onchange={(e) => settings.set('dateOrder', (e.currentTarget as HTMLInputElement).checked)} /> Insert new transactions in date order (instead of at the end of the file)</label>
  </div>
</section>

<section class="card sec" aria-labelledby="s-h">
  <header><h2 id="s-h">Storage & privacy</h2></header>
  <p>Your journals stay in this browser{app.vault?.provider === 'dropbox' || app.vault?.provider === 'github' ? ' and the service you connected' : ''}. PocketLedger has no server, no analytics, and never downloads prices.</p>
  <p class="muted small">
    {persisted ? 'Storage is persistent: the browser will not clear it automatically.' : 'Storage may be cleared by the browser when space is low.'} {usage}
  </p>
  {#if !persisted}<button class="btn small" type="button" onclick={async () => (persisted = await persistStorage())}>Make storage persistent</button>{/if}
  {#if isIOS() && !isStandalone()}
    <p class="warn small"><Icon name="info" size={16} /> On iPhone and iPad, add PocketLedger to your Home Screen (Share → Add to Home Screen). Safari may delete data for sites that aren't installed, so connect Dropbox or GitHub too.</p>
  {/if}
</section>

<section class="card sec" aria-labelledby="e-h">
  <header><h2 id="e-h">Engine</h2></header>
  <dl class="kv">
    <dt>hledger</dt><dd>{__ENGINE__.hledger} ({__ENGINE__.flavor}, WebAssembly)</dd>
    <dt>Engine checksum</dt><dd class="mono small">{__ENGINE__.sha256.slice(0, 16)}…</dd>
    <dt>Start-up</dt><dd>{app.engineMs ? `${Math.round(app.engineMs)} ms to compile` : app.engineStatus}</dd>
    <dt>App</dt><dd>PocketLedger {__APP_VERSION__} · {syncState.status}</dd>
  </dl>
  {#if app.timings.length}
    <details>
      <summary>Recent hledger runs</summary>
      <ul class="timings mono">{#each app.timings as t, i (i)}<li><span>{t.args}</span><span>{Math.round(t.ms)} ms</span></li>{/each}</ul>
    </details>
  {/if}
  <p class="muted small">PocketLedger is free software (GPL-3.0-or-later) and bundles hledger by Simon Michael and contributors. <a href="https://github.com/jackhale98/pocketledger-web">Source code</a></p>
</section>

<Sheet bind:open={addOpen} title="Add a journal">
  <div class="choices">
    <button class="choice" type="button" onclick={() => (newOpen = true)}><Icon name="plus" /><span><strong>New journal</strong><small>Start fresh with account declarations</small></span></button>
    <label class="choice"><Icon name="upload" /><span><strong>Import files</strong><small>Copy .journal / .rules / .csv files into this browser</small></span>
      <input class="sr-only" type="file" multiple accept=".journal,.hledger,.ledger,.j,.rules,.csv,.prices,text/plain" onchange={importFiles} /></label>
    <label class="choice"><Icon name="folder" /><span><strong>Import a folder</strong><small>Keeps include paths intact</small></span>
      <input class="sr-only" type="file" webkitdirectory multiple onchange={importFiles} /></label>
    {#if canFsa}
      <button class="choice" type="button" onclick={openFolder}><Icon name="folder" /><span><strong>Open a folder on disk</strong><small>Edit files in place (Chrome, Edge)</small></span></button>
    {/if}
    <button class="choice" type="button" onclick={() => { addOpen = false; router.go('settings', '', { connect: 'dropbox' }); }}><Icon name="cloud" /><span><strong>Dropbox</strong><small>Sync a folder automatically</small></span></button>
    <button class="choice" type="button" onclick={() => { addOpen = false; router.go('settings', '', { connect: 'github' }); }}><Icon name="git" /><span><strong>GitHub</strong><small>Clone a repository; commit and push</small></span></button>
  </div>
</Sheet>

<Sheet bind:open={newOpen} title="New journal">
  <form class="form" onsubmit={(e) => { e.preventDefault(); void createNew(); }}>
    <label class="field"><span>Name</span><input class="input" bind:value={newName} required /></label>
    <label class="field"><span>Main currency</span><input class="input" bind:value={newCommodity} placeholder="$, EUR, £…" /></label>
    <p class="muted small">Creates <code>main.journal</code> with common accounts and hledger account types, ready to use.</p>
  </form>
  {#snippet footer()}
    <button class="btn" type="button" onclick={() => (newOpen = false)}>Cancel</button>
    <button class="btn primary" type="button" onclick={createNew}>Create</button>
  {/snippet}
</Sheet>

<style>
  .sec { padding: 16px; margin-bottom: 12px; display: grid; gap: 12px; }
  .sec header { display: flex; justify-content: space-between; align-items: center; }
  .sec h2 { font-size: 1rem; }
  .vaults { list-style: none; margin: 0; padding: 0; border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
  .vaults li { display: flex; align-items: center; gap: 4px; padding-right: 6px; }
  .vaults li + li { border-top: 1px solid var(--border); }
  .open { flex: 1; display: grid; text-align: left; padding: 12px 14px; border: 0; background: none; min-width: 0; }
  .open:hover { background: var(--surface-2); }
  .open small { color: var(--text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .row { display: flex; gap: 12px; flex-wrap: wrap; }
  .grow { flex: 1; min-width: 200px; }
  .opts { display: grid; gap: 12px; }
  .seg-f { border: 0; margin: 0; padding: 0; }
  .seg { display: inline-grid; grid-template-columns: repeat(3, 1fr); border: 1px solid var(--border-strong); border-radius: var(--radius-s); overflow: hidden; margin-top: 6px; }
  .seg button { border: 0; background: var(--surface); padding: 8px 18px; font-weight: 560; }
  .seg button + button { border-left: 1px solid var(--border); }
  .seg button[aria-checked='true'] { background: var(--accent-soft); color: var(--accent-strong); }
  .check { display: flex; gap: 10px; align-items: flex-start; font-size: 0.9rem; }
  .check input { margin-top: 3px; accent-color: var(--accent); }
  .small { font-size: 0.82rem; }
  .warn { color: var(--warn); display: flex; gap: 6px; align-items: flex-start; }
  .kv { display: grid; grid-template-columns: auto 1fr; gap: 6px 16px; margin: 0; font-size: 0.9rem; }
  .kv dt { color: var(--text-3); }
  .kv dd { margin: 0; }
  details summary { cursor: pointer; font-size: 0.88rem; font-weight: 600; }
  .timings { list-style: none; padding: 0; margin: 8px 0 0; font-size: 0.75rem; }
  .timings li { display: flex; justify-content: space-between; gap: 12px; padding: 3px 0; border-bottom: 1px solid var(--border); }
  .timings li span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .choices { display: grid; gap: 8px; }
  .choice { display: flex; gap: 14px; align-items: center; padding: 14px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); text-align: left; cursor: pointer; }
  .choice:hover { background: var(--surface-2); border-color: var(--border-strong); }
  .choice:focus-within { outline: 2px solid var(--focus); }
  .choice span { display: grid; }
  .choice small { color: var(--text-3); }
  .form { display: grid; gap: 12px; }
  code { font-family: var(--mono); font-size: 0.85em; }
</style>
