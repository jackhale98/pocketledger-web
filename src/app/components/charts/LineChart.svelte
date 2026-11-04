<script lang="ts">
  // Single-series line with a soft area and a crosshair tooltip.
  import { niceTicks, compact } from './scale';

  let {
    labels,
    values,
    color = 'var(--chart-1)',
    format = (v: number) => v.toFixed(2),
    prefix = '',
    height = 200,
    title,
  }: { labels: string[]; values: number[]; color?: string; format?: (v: number) => string; prefix?: string; height?: number; title: string } = $props();

  let width = $state(600);
  let hover = $state<number | null>(null);
  let showTable = $state(false);
  const pad = { l: 48, r: 12, t: 12, b: 26 };
  const ticks = $derived.by(() => {
    const lo = Math.min(...values);
    const hi = Math.max(...values);
    // Keep zero in range unless the values sit far from it (a net worth line shouldn't be flattened).
    const far = lo > 0 && lo > (hi - lo) * 1.5;
    return niceTicks(lo, hi, 4, !far);
  });
  const y0 = $derived(ticks[0]!);
  const y1 = $derived(ticks[ticks.length - 1]!);
  const ih = $derived(height - pad.t - pad.b);
  const iw = $derived(Math.max(10, width - pad.l - pad.r));
  const x = (i: number) => pad.l + (values.length <= 1 ? iw / 2 : (i / (values.length - 1)) * iw);
  const y = (v: number) => pad.t + ih - ((v - y0) / (y1 - y0 || 1)) * ih;
  const line = $derived(values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(''));
  const base = $derived(y0 > 0 ? y0 : y1 < 0 ? y1 : 0);
  const area = $derived(values.length ? `${line}L${x(values.length - 1)},${y(base)}L${x(0)},${y(base)}Z` : '');
  const labelEvery = $derived(Math.ceil(labels.length / Math.max(1, Math.floor(iw / 60))));
  const gid = `g${Math.random().toString(36).slice(2)}`;

  function move(e: PointerEvent) {
    const r = (e.currentTarget as SVGElement).getBoundingClientRect();
    const px = e.clientX - r.left;
    hover = Math.max(0, Math.min(values.length - 1, Math.round(((px - pad.l) / iw) * (values.length - 1))));
  }
</script>

<figure class="chart">
  <div class="legend" aria-hidden="true">
    <button class="link" type="button" onclick={() => (showTable = !showTable)}>{showTable ? 'Chart' : 'Table'}</button>
  </div>
  {#if showTable}
    <div class="table-wrap">
      <table>
        <caption class="sr-only">{title}</caption>
        <thead><tr><th scope="col">Period</th><th scope="col">Value</th></tr></thead>
        <tbody>{#each labels as l, i (l + i)}<tr><th scope="row">{l}</th><td class="num">{format(values[i] ?? 0)}</td></tr>{/each}</tbody>
      </table>
    </div>
  {:else}
    <div class="plot" bind:clientWidth={width}>
      <svg {width} {height} role="img" aria-label={title} onpointermove={move} onpointerdown={move} onpointerleave={() => (hover = null)}>
        <defs>
          <linearGradient id={gid} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stop-color={color} stop-opacity="0.22" />
            <stop offset="100%" stop-color={color} stop-opacity="0" />
          </linearGradient>
        </defs>
        {#each ticks as t (t)}
          <line x1={pad.l} x2={width - pad.r} y1={y(t)} y2={y(t)} class="grid" />
          <text x={pad.l - 6} y={y(t)} dy="0.32em" text-anchor="end" class="tick">{compact(t, prefix)}</text>
        {/each}
        {#each labels as l, i (l + i)}
          {#if i % labelEvery === 0}<text x={x(i)} y={height - 8} text-anchor="middle" class="tick">{l}</text>{/if}
        {/each}
        <path d={area} fill="url(#{gid})" />
        <path d={line} fill="none" stroke={color} stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
        {#if values.length}
          <circle cx={x(values.length - 1)} cy={y(values[values.length - 1]!)} r="4" fill={color} stroke="var(--surface)" stroke-width="2" />
        {/if}
        {#if hover !== null}
          <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={pad.t + ih} class="cross" />
          <circle cx={x(hover)} cy={y(values[hover]!)} r="5" fill={color} stroke="var(--surface)" stroke-width="2" />
        {/if}
      </svg>
      {#if hover !== null}
        <div class="tip" style:left="{Math.min(Math.max(x(hover), 80), width - 80)}px">
          <strong>{labels[hover]}</strong><span class="num">{format(values[hover] ?? 0)}</span>
        </div>
      {/if}
    </div>
  {/if}
</figure>

<style>
  .chart { margin: 0; }
  .plot { position: relative; width: 100%; }
  svg { display: block; overflow: visible; touch-action: pan-y; }
  .grid { stroke: var(--border); }
  .cross { stroke: var(--border-strong); stroke-dasharray: 3 3; }
  .tick { fill: var(--text-3); font-size: 11px; font-variant-numeric: tabular-nums; }
  .legend { display: flex; justify-content: flex-end; margin-bottom: 4px; }
  .link { background: none; border: 0; color: var(--accent); font-size: 0.8rem; font-weight: 600; padding: 4px; }
  .tip {
    position: absolute; top: 0; transform: translateX(-50%); pointer-events: none; background: var(--surface);
    border: 1px solid var(--border); border-radius: var(--radius-s); box-shadow: var(--shadow-2); padding: 6px 10px;
    font-size: 0.8rem; display: grid; gap: 2px; text-align: center; z-index: 2;
  }
  .tip .num { font-weight: 650; }
  .table-wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
  th, td { padding: 6px 8px; border-bottom: 1px solid var(--border); text-align: right; }
  th:first-child { text-align: left; }
</style>
