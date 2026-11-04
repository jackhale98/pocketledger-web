<script lang="ts">
  import type { FileConflict } from '$lib/contracts/storage';
  import { app } from '../state/app.svelte';
  import { syncState, syncNow, gitCommit, gitPull, gitPush, refreshGit, resolveConflict } from '../state/sync.svelte';
  import Icon from './Icon.svelte';
  import Sheet from './Sheet.svelte';

  const v = $derived(app.vault);
  let message = $state('Update journal');
  let busy = $state(false);
  let resolving = $state<FileConflict | null>(null);
  let resolvedText = $state('');
  let resolveOpen = $state(false);

  const when = (t: number | null) => (t ? new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : 'never');
  async function run(fn: () => Promise<void>) {
    busy = true;
    try {
      await fn();
    } finally {
      busy = false;
    }
  }
  function openResolver(c: FileConflict) {
    resolving = c;
    resolvedText = c.merged;
    resolveOpen = true;
  }
  const hasMarkers = $derived(/^(<{7}|={7}|>{7})/m.test(resolvedText));
</script>

<section class="card sec" aria-labelledby="sync-h">
  <header>
    <h2 id="sync-h">Sync</h2>
    {#if syncState.status === 'syncing'}<span class="badge">Syncing…</span>
    {:else if syncState.status === 'offline'}<span class="badge warn"><Icon name="cloud-off" size={12} /> Offline</span>
    {:else if syncState.status === 'error'}<span class="badge err">Error</span>
    {:else if v?.provider === 'dropbox' || v?.provider === 'github'}<span class="badge ok">Connected</span>{/if}
  </header>

  {#if v?.provider === 'local'}
    <p class="muted">This journal lives only in this browser. Download files from <a href="#/files">Files</a>, or add it again from Dropbox or GitHub to sync between devices.</p>
  {:else if v?.provider === 'fsa'}
    <p class="muted">Saved straight back to the folder you opened. The browser may ask again for permission after a restart.</p>
  {:else if v?.remote?.kind === 'dropbox' || (v?.remote?.kind === 'github' && v.remote.transport === 'rest')}
    <dl class="kv">
      <dt>Where</dt><dd class="mono small">{v.remote.kind === 'dropbox' ? `Dropbox${v.remote.folder || '/'}` : `${v.remote.url} @ ${v.remote.branch}`}</dd>
      <dt>Last sync</dt><dd>{when(syncState.lastSync)}</dd>
      <dt>Waiting to upload</dt><dd>{syncState.pending} file(s)</dd>
    </dl>
    {#if syncState.message}<p class="neg small">{syncState.message}</p>{/if}
    <button class="btn small" type="button" onclick={() => run(syncNow)} disabled={busy || syncState.status === 'syncing'}><Icon name="sync" size={16} /> Sync now</button>
  {:else if v?.remote?.kind === 'github'}
    <dl class="kv">
      <dt>Repository</dt><dd class="mono small">{v.remote.url} @ {v.remote.branch}</dd>
      <dt>Ahead / behind</dt><dd>{syncState.git ? `${syncState.git.ahead} / ${syncState.git.behind}` : '…'}</dd>
    </dl>
    {#if syncState.git?.changed.length}
      <ul class="changes">{#each syncState.git.changed as c (c.path)}<li><span class="badge">{c.status}</span> <span class="mono small">{c.path}</span></li>{/each}</ul>
      <div class="row">
        <label class="sr-only" for="commit-msg">Commit message</label>
        <input id="commit-msg" class="input" bind:value={message} />
        <button class="btn small primary" type="button" onclick={() => run(() => gitCommit(message))} disabled={busy || !message.trim()}>Commit</button>
      </div>
    {:else}<p class="muted small">No uncommitted changes.</p>{/if}
    {#if syncState.message}<p class="neg small">{syncState.message}</p>{/if}
    <div class="row">
      <button class="btn small" type="button" onclick={() => run(gitPull)} disabled={busy}><Icon name="download" size={16} /> Pull</button>
      <button class="btn small" type="button" onclick={() => run(gitPush)} disabled={busy || !syncState.git?.ahead}><Icon name="upload" size={16} /> Push</button>
      <button class="btn small ghost" type="button" onclick={() => run(refreshGit)} disabled={busy}><Icon name="refresh" size={16} /> Refresh</button>
    </div>
  {/if}

  {#if syncState.invalid.length}
    <div class="warnbox" role="alert">
      <strong>Merged changes don't pass hledger, so uploads are paused.</strong>
      {#each syncState.invalid as i, k (k)}<pre>{i.path}: {i.message}</pre>{/each}
      <p class="small">Fix the journal (Files or the transaction editor); the next sync uploads once hledger accepts it.</p>
    </div>
  {/if}
  {#if syncState.conflicts.length}
    <div class="warnbox" role="alert">
      <strong>Changed on both sides</strong>
      <ul>{#each syncState.conflicts as c (c.path)}<li><span class="mono small">{c.path}</span> <button class="btn small" type="button" onclick={() => openResolver(c)}>Resolve</button></li>{/each}</ul>
    </div>
  {/if}
</section>

<Sheet bind:open={resolveOpen} title="Resolve {resolving?.path ?? ''}" wide>
  {#if resolving}
    <p class="small muted">Edit the merged text: keep what's right between the <code>&lt;&lt;&lt;&lt;&lt;&lt;&lt;</code>, <code>=======</code> and <code>&gt;&gt;&gt;&gt;&gt;&gt;&gt;</code> markers and delete the markers. hledger checks the result before it is uploaded.</p>
    <div class="row">
      <button class="btn small" type="button" onclick={() => (resolvedText = resolving!.local)}>Use this device's version</button>
      <button class="btn small" type="button" onclick={() => (resolvedText = resolving!.remote)}>Use the other version</button>
    </div>
    <label class="sr-only" for="resolve-text">Merged text</label>
    <textarea id="resolve-text" class="input" rows="16" bind:value={resolvedText} spellcheck="false"></textarea>
  {/if}
  {#snippet footer()}
    <button class="btn" type="button" onclick={() => (resolveOpen = false)}>Cancel</button>
    <button class="btn primary" type="button" disabled={hasMarkers} onclick={async () => { if (resolving) await resolveConflict(resolving, resolvedText); resolveOpen = false; }}>
      {hasMarkers ? 'Remove conflict markers first' : 'Save resolution'}
    </button>
  {/snippet}
</Sheet>

<style>
  .sec { padding: 16px; margin-bottom: 12px; display: grid; gap: 12px; }
  header { display: flex; gap: 10px; align-items: center; }
  h2 { font-size: 1rem; }
  .kv { display: grid; grid-template-columns: auto 1fr; gap: 6px 16px; margin: 0; font-size: 0.9rem; }
  .kv dt { color: var(--text-3); }
  .kv dd { margin: 0; overflow-wrap: anywhere; }
  .small { font-size: 0.82rem; }
  .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .row .input { flex: 1; min-width: 160px; }
  .changes { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
  .warnbox { background: var(--warn-soft); color: var(--text); border-radius: var(--radius-s); padding: 12px; display: grid; gap: 8px; }
  .warnbox ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 6px; }
  .warnbox li { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
  pre { margin: 0; white-space: pre-wrap; font-family: var(--mono); font-size: 0.78rem; }
  code { font-family: var(--mono); }
</style>
