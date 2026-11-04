<script lang="ts">
  // Vault files: browse, view with line numbers, edit as text (validated by hledger before saving).
  import type { EngineError } from '$lib/contracts/engine';
  import { makeSnapshot, isEngineFile } from '$lib/vault';
  import { app, SaveError } from '../state/app.svelte';
  import { href, router } from '../state/router.svelte';
  import { toasts } from '../state/toast.svelte';
  import Icon from '../components/Icon.svelte';
  import ErrorPanel from '../components/ErrorPanel.svelte';

  const file = $derived(router.route.param);
  const line = $derived(Number(router.route.query.get('line') ?? 0));
  const text = $derived(file ? (app.files[file] ?? null) : null);
  const lines = $derived(text?.split(/\r?\n/) ?? []);
  let editing = $state(false);
  let draft = $state('');
  let errors = $state<EngineError[]>([]);
  let liveErrors = $state<EngineError[]>([]);
  let saving = $state(false);
  let newName = $state('');

  $effect(() => {
    void file;
    editing = false;
    errors = [];
  });
  $effect(() => {
    if (!line || editing) return;
    requestAnimationFrame(() => document.getElementById(`L${line}`)?.scrollIntoView({ block: 'center' }));
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    if (!editing || !app.vault || !app.engine) return;
    const next = { ...app.files, [file]: draft };
    clearTimeout(timer);
    timer = setTimeout(async () => (liveErrors = await app.engine!.check(makeSnapshot(next, app.vault!.rootFile))), 500);
  });

  function startEdit() {
    draft = text ?? '';
    editing = true;
  }
  async function save() {
    saving = true;
    errors = [];
    try {
      const eol = (text ?? '').includes('\r\n') ? '\r\n' : '\n';
      await app.commitFiles({ ...app.files, [file]: draft.replace(/\r?\n/g, eol) }, `edit ${file}`);
      editing = false;
      toasts.show('Saved', { tone: 'ok' });
    } catch (e) {
      errors = e instanceof SaveError ? e.errors : [{ kind: 'internal', message: (e as Error).message }];
    } finally {
      saving = false;
    }
  }
  function download() {
    const blob = new Blob([text ?? ''], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = file.split('/').pop() ?? 'journal';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  async function create() {
    const name = newName.trim().replace(/^\/+/, '');
    if (!name || app.files[name] != null) return;
    if (!isEngineFile(name)) {
      toasts.show('Use a journal, rules or CSV extension (.journal, .rules, .csv…)', { tone: 'error' });
      return;
    }
    try {
      await app.commitFiles({ ...app.files, [name]: `; ${name}\n` }, `create ${name}`);
      newName = '';
      router.go('files', name);
    } catch (e) {
      toasts.show((e as Error).message, { tone: 'error' });
    }
  }
  const files = $derived(Object.keys(app.files).sort());
</script>

{#if !file}
  <ul class="card list">
    {#each files as f (f)}
      <li>
        <a href={href('files', f)}>
          <Icon name={f.endsWith('.csv') ? 'list' : f.endsWith('.rules') ? 'filter' : 'file'} size={18} />
          <span class="mono">{f}</span>
          {#if f === app.vault?.rootFile}<span class="badge ok">root</span>{/if}
          <span class="muted size">{(app.files[f]?.length ?? 0).toLocaleString()} chars</span>
        </a>
      </li>
    {/each}
  </ul>
  <form class="new" onsubmit={(e) => { e.preventDefault(); void create(); }}>
    <label class="sr-only" for="new-file">New file name</label>
    <input id="new-file" class="input mono" placeholder="2027.journal" bind:value={newName} disabled={app.readOnly} />
    <button class="btn" type="submit" disabled={!newName.trim() || app.readOnly}><Icon name="plus" size={18} /> New file</button>
  </form>
  <p class="muted note">New files are only read by hledger once the root journal includes them (for example <code>include 2027.journal</code>).</p>
{:else if text == null}
  <p class="muted">No file named {file}. <a href={href('files')}>All files</a></p>
{:else}
  <div class="bar">
    <a class="btn small ghost" href={href('files')}><Icon name="chevron-left" size={16} /> Files</a>
    <h2 class="mono">{file}</h2>
    <span style="flex:1"></span>
    <button class="btn small" type="button" onclick={download}><Icon name="download" size={16} /> Download</button>
    {#if editing}
      <button class="btn small" type="button" onclick={() => (editing = false)}>Cancel</button>
      <button class="btn small primary" type="button" onclick={save} disabled={saving || liveErrors.length > 0}>{saving ? 'Saving…' : 'Save'}</button>
    {:else}
      <button class="btn small primary" type="button" onclick={startEdit} disabled={app.readOnly}><Icon name="edit" size={16} /> Edit</button>
    {/if}
  </div>
  {#if errors.length}<ErrorPanel title="hledger rejected this change; nothing was saved" {errors} compact />{/if}
  {#if editing}
    <label class="sr-only" for="file-edit">Contents of {file}</label>
    <textarea id="file-edit" class="input editor" bind:value={draft} spellcheck="false" autocapitalize="off"></textarea>
    <p class="live" role="status">
      {#if liveErrors.length}<span class="neg"><Icon name="alert" size={16} /> {liveErrors[0]?.message.split('\n')[0]}{liveErrors[0]?.line ? ` (line ${liveErrors[0].line})` : ''}</span>
      {:else}<span class="pos"><Icon name="check" size={16} /> hledger reads this</span>{/if}
    </p>
  {:else}
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <div class="card code" role="region" aria-label="Contents of {file}" tabindex="0">
      <table>
        <tbody>
          {#each lines as l, i (i)}
            <tr id="L{i + 1}" class:hl={line === i + 1}><td class="ln">{i + 1}</td><td class="tx">{l || ' '}</td></tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
{/if}

<style>
  .list { list-style: none; margin: 0 0 12px; padding: 0; overflow: hidden; }
  li + li { border-top: 1px solid var(--border); }
  li a { display: flex; gap: 10px; align-items: center; padding: 12px 16px; color: var(--text); text-decoration: none; }
  li a:hover { background: var(--surface-2); }
  .size { margin-left: auto; font-size: 0.78rem; }
  .new { display: flex; gap: 8px; }
  .note { font-size: 0.8rem; margin-top: 8px; }
  .bar { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; flex-wrap: wrap; }
  .bar h2 { font-size: 0.95rem; overflow: hidden; text-overflow: ellipsis; }
  .code { overflow: auto; max-height: calc(100dvh - 220px); }
  table { border-collapse: collapse; font-family: var(--mono); font-size: 0.8rem; line-height: 1.55; width: 100%; }
  .ln { color: var(--text-3); text-align: right; padding: 0 10px; user-select: none; position: sticky; left: 0; background: var(--surface-2); width: 1%; }
  .tx { white-space: pre; padding: 0 12px; }
  tr.hl td { background: var(--warn-soft); }
  .editor { min-height: calc(100dvh - 260px); font-size: 0.85rem; white-space: pre; overflow-wrap: normal; overflow-x: auto; }
  .live { font-size: 0.85rem; margin-top: 8px; }
  .live span { display: inline-flex; gap: 6px; align-items: center; }
</style>
