<script lang="ts">
  // Read-only hledger command console. Commands run against the open vault (no -f needed).
  import { splitQuery } from '$lib/engine/args';
  import { app } from '../state/app.svelte';

  interface Entry { cmd: string; out: string; err: string; code: number; ms: number }
  let cmd = $state('balance --tree');
  let history = $state<Entry[]>([]);
  let busy = $state(false);
  const EXAMPLES = ['balance --tree -M', 'register checking', 'stats', 'is -Q', 'bs -V', 'print desc:coffee', 'roi', 'activity -M', 'prices', 'accounts --tree', 'tags', 'check ordereddates'];

  async function run(c = cmd) {
    if (!app.engine || !c.trim()) return;
    busy = true;
    const t0 = performance.now();
    const args = splitQuery(c.trim().replace(/^hledger\s+/, ''));
    const r = await app.engine.raw(args);
    history = [{ cmd: c, out: r.stdout, err: r.stderr, code: r.code, ms: performance.now() - t0 }, ...history].slice(0, 30);
    busy = false;
  }
</script>

<form class="cons card" onsubmit={(e) => { e.preventDefault(); void run(); }}>
  <span class="prompt mono" aria-hidden="true">hledger</span>
  <label class="sr-only" for="cons-in">hledger command</label>
  <input id="cons-in" class="mono" bind:value={cmd} autocomplete="off" autocapitalize="off" spellcheck="false" />
  <button class="btn primary small" type="submit" disabled={busy || !app.ready}>{busy ? 'Running…' : 'Run'}</button>
</form>
<div class="ex" role="group" aria-label="Examples">
  {#each EXAMPLES as e (e)}<button class="chip mono" type="button" onclick={() => { cmd = e; void run(e); }}>{e}</button>{/each}
</div>
<p class="muted note">Runs the real hledger {__ENGINE__.hledger} on the open journal. Commands that write files or use the network are disabled.</p>
{#each history as h, i (i)}
  <section class="card out" aria-label="Output of {h.cmd}">
    <header class="mono"><span>$ hledger {h.cmd}</span><span class="muted">{h.code === 0 ? '' : `exit ${h.code} · `}{Math.round(h.ms)} ms</span></header>
    {#if h.out}<pre>{h.out}</pre>{/if}
    {#if h.err}<pre class="err">{h.err}</pre>{/if}
  </section>
{/each}

<style>
  .cons { display: flex; align-items: center; gap: 8px; padding: 6px 6px 6px 14px; }
  .prompt { color: var(--accent); font-weight: 700; }
  input { flex: 1; min-width: 0; border: 0; background: none; outline: none; height: 40px; font-size: 0.95rem; }
  .ex { display: flex; gap: 6px; flex-wrap: wrap; margin: 10px 0; }
  .ex .chip { font-size: 0.78rem; height: 28px; }
  .note { font-size: 0.8rem; margin-bottom: 12px; }
  .out { margin-bottom: 10px; overflow: hidden; }
  header { display: flex; justify-content: space-between; gap: 10px; padding: 8px 12px; font-size: 0.8rem; border-bottom: 1px solid var(--border); background: var(--surface-2); }
  pre { margin: 0; padding: 12px; overflow-x: auto; font-family: var(--mono); font-size: 0.8rem; line-height: 1.45; }
  .err { color: var(--neg); white-space: pre-wrap; }
</style>
