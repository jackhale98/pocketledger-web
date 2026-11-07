<script lang="ts">
  // When hledger can't find an included file, offer to upload it into the vault
  // at the path the include directive expects.
  import type { EngineError } from '$lib/contracts/engine';
  import { isVaultFile } from '$lib/vault';
  import { app } from '../state/app.svelte';
  import { toasts } from '../state/toast.svelte';
  import Icon from './Icon.svelte';

  let { errors }: { errors: EngineError[] } = $props();

  /** Missing include targets as vault paths ("2025/*.journal" stays a pattern). */
  const missing = $derived(
    errors.flatMap((e) => {
      const m = /No files were matched by: (.+)/.exec(e.message);
      if (!m) return [];
      const dir = e.file?.includes('/') ? e.file.slice(0, e.file.lastIndexOf('/') + 1) : '';
      return [{ pattern: (dir + m[1]!.trim()).replace(/^\.\//, ''), from: e.file ?? '' }];
    }),
  );

  const isGlob = (p: string) => /[*?[]/.test(p);

  async function upload(pattern: string, input: HTMLInputElement) {
    const list = [...(input.files ?? [])];
    input.value = '';
    if (!list.length) return;
    const glob = isGlob(pattern);
    const dir = pattern.includes('/') ? pattern.slice(0, pattern.lastIndexOf('/') + 1) : '';
    const next = { ...app.files };
    for (const f of list) {
      const path = glob || list.length > 1 ? dir + f.name : pattern;
      if (!isVaultFile(path)) continue;
      next[path] = await f.text();
    }
    try {
      // The journal doesn't load yet, so this can't make it worse: save, then re-check.
      await app.commitFiles(next, `add ${list.map((f) => f.name).join(', ')}`, { skipValidation: true });
      toasts.show(app.loadErrors.length ? 'Added. hledger still reports a problem (see above).' : 'Added; the journal loads now.', { tone: app.loadErrors.length ? 'info' : 'ok' });
    } catch (e) {
      toasts.show((e as Error).message, { tone: 'error' });
    }
  }
</script>

{#if missing.length}
  <section class="card card-pad miss" aria-labelledby="miss-h">
    <h2 id="miss-h"><Icon name="file" size={18} /> Missing included files</h2>
    <p class="muted">Your journal includes files that aren't in this vault yet. Add them from your device:</p>
    <ul>
      {#each missing as m (m.pattern)}
        <li>
          <span class="mono">{m.pattern}</span>{#if m.from}<small class="muted"> (included by {m.from})</small>{/if}
          <label class="btn small"><Icon name="upload" size={16} /> Choose file{isGlob(m.pattern) ? 's' : ''}
            <input class="sr-only" type="file" multiple={isGlob(m.pattern)} onchange={(e) => upload(m.pattern, e.currentTarget)} />
          </label>
        </li>
      {/each}
    </ul>
  </section>
{/if}

<style>
  .miss { margin-bottom: 16px; display: grid; gap: 8px; }
  h2 { display: flex; gap: 8px; align-items: center; font-size: 1rem; }
  ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
  li { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  li .btn { margin-left: auto; }
  small { font-size: 0.8rem; }
</style>
