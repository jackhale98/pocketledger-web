<script lang="ts">
  // Horizontal ranked bars with direct labels (expense breakdown). Top N + "Other".
  let {
    items,
    format,
    max = 7,
    onpick,
  }: { items: { name: string; value: number }[]; format: (v: number) => string; max?: number; onpick?: (name: string) => void } = $props();

  const rows = $derived.by(() => {
    const sorted = [...items].filter((i) => i.value > 0).sort((a, b) => b.value - a.value);
    if (sorted.length <= max) return sorted.map((r, i) => ({ ...r, color: `var(--chart-${(i % 6) + 1})`, other: false }));
    const head = sorted.slice(0, max - 1).map((r, i) => ({ ...r, color: `var(--chart-${(i % 6) + 1})`, other: false }));
    const rest = sorted.slice(max - 1).reduce((s, r) => s + r.value, 0);
    return [...head, { name: `Other (${sorted.length - max + 1})`, value: rest, color: 'var(--chart-other)', other: true }];
  });
  const top = $derived(Math.max(1, ...rows.map((r) => r.value)));
  const total = $derived(rows.reduce((s, r) => s + r.value, 0));
</script>

<ul class="rank">
  {#each rows as r (r.name)}
    <li>
      <button type="button" disabled={!onpick || r.other} onclick={() => onpick?.(r.name)}>
        <span class="name">{r.name}</span>
        <span class="val num">{format(r.value)} <small>{total ? Math.round((r.value / total) * 100) : 0}%</small></span>
        <span class="track"><span class="bar" style:width="{(r.value / top) * 100}%" style:background={r.color}></span></span>
      </button>
    </li>
  {/each}
</ul>

<style>
  .rank { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
  button {
    width: 100%; display: grid; grid-template-columns: 1fr auto; gap: 4px 12px; padding: 8px 6px; border: 0;
    background: none; text-align: left; border-radius: var(--radius-s);
  }
  button:not(:disabled):hover { background: var(--surface-2); }
  button:disabled { cursor: default; color: inherit; }
  .name { font-size: 0.9rem; font-weight: 520; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .val { font-size: 0.9rem; font-weight: 600; }
  .val small { color: var(--text-3); font-weight: 500; margin-left: 4px; }
  .track { grid-column: 1 / -1; height: 8px; background: var(--surface-2); border-radius: 4px; overflow: hidden; }
  .bar { display: block; height: 100%; border-radius: 4px; }
</style>
