<script lang="ts">
  // hledger's own error text, verbatim, with file/line and a jump to the source.
  import type { EngineError } from '$lib/contracts/engine';
  import { href } from '../state/router.svelte';
  import Icon from './Icon.svelte';

  let { title, errors, compact = false }: { title: string; errors: EngineError[]; compact?: boolean } = $props();
</script>

<section class="err card" class:compact role="alert">
  <h2><Icon name="alert" size={18} /> {title}</h2>
  {#each errors as e, i (i)}
    {#if e.file}
      <p class="loc">
        <span class="mono">{e.file}{e.line ? `:${e.line}` : ''}{e.column ? `:${e.column}` : ''}</span>
        <a href="{href('files', e.file)}?line={e.line ?? 1}">View source</a>
      </p>
    {/if}
    <pre>{e.message}</pre>
  {/each}
</section>

<style>
  .err { border-color: color-mix(in srgb, var(--neg) 40%, var(--border)); padding: 16px; margin-bottom: 16px; }
  h2 { display: flex; align-items: center; gap: 8px; font-size: 1rem; color: var(--neg); margin-bottom: 8px; }
  .loc { display: flex; gap: 12px; align-items: center; font-size: 0.85rem; margin: 6px 0; flex-wrap: wrap; }
  pre {
    margin: 0; padding: 12px; background: var(--surface-2); border-radius: var(--radius-s); overflow-x: auto;
    font-family: var(--mono); font-size: 0.8rem; line-height: 1.5; white-space: pre-wrap; word-break: break-word;
  }
  .compact pre { max-height: 160px; }
</style>
