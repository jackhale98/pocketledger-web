<script lang="ts">
  // Grouped vertical bars, one group per period. Hover/tap a group for a tooltip.
  import { niceTicks, compact } from './scale';

  export interface Series {
    name: string;
    color: string;
    values: number[];
  }
  let {
    labels,
    series,
    format = (v: number) => v.toFixed(2),
    prefix = '',
    height = 220,
    title,
  }: { labels: string[]; series: Series[]; format?: (v: number) => string; prefix?: string; height?: number; title: string } = $props();

  let width = $state(600);
  let hover = $state<number | null>(null);
  let showTable = $state(false);

  const pad = { l: 44, r: 8, t: 10, b: 26 };
  const all = $derived(series.flatMap((s) => s.values));
  const ticks = $derived(niceTicks(Math.min(0, ...all), Math.max(0, ...all)));
  const y0 = $derived(ticks[0]!);
  const y1 = $derived(ticks[ticks.length - 1]!);
  const ih = $derived(height - pad.t - pad.b);
  const iw = $derived(Math.max(10, width - pad.l - pad.r));
  const y = (v: number) => pad.t + ih - ((v - y0) / (y1 - y0 || 1)) * ih;
  const group = $derived(iw / Math.max(1, labels.length));
  const barW = $derived(Math.max(3, Math.min(28, (group * 0.72 - 2 * (series.length - 1)) / Math.max(1, series.length))));
  const labelEvery = $derived(Math.ceil(labels.length / Math.max(1, Math.floor(iw / 56))));
</script>

<figure class="chart">
  <div class="legend" aria-hidden="true">
    {#each series as s (s.name)}<span><i style:background={s.color}></i>{s.name}</span>{/each}
    <button class="link" type="button" onclick={() => (showTable = !showTable)}>{showTable ? 'Chart' : 'Table'}</button>
  </div>
  {#if showTable}
    <div class="table-wrap">
      <table>
        <caption class="sr-only">{title}</caption>
        <thead><tr><th scope="col">Period</th>{#each series as s (s.name)}<th scope="col">{s.name}</th>{/each}</tr></thead>
        <tbody>
          {#each labels as l, i (l + i)}
            <tr><th scope="row">{l}</th>{#each series as s (s.name)}<td class="num">{format(s.values[i] ?? 0)}</td>{/each}</tr>
          {/each}
        </tbody>
      </table>
    </div>
  {:else}
    <div class="plot" bind:clientWidth={width}>
      <svg {width} {height} role="img" aria-label={title} onpointerleave={() => (hover = null)}>
        {#each ticks as t (t)}
          <line x1={pad.l} x2={width - pad.r} y1={y(t)} y2={y(t)} class:zero={t === 0} class="grid" />
          <text x={pad.l - 6} y={y(t)} dy="0.32em" text-anchor="end" class="tick">{compact(t, prefix)}</text>
        {/each}
        {#each labels as l, i (l + i)}
          {@const gx = pad.l + i * group}
          {@const inner = series.length * barW + (series.length - 1) * 2}
          {#if hover === i}<rect x={gx} y={pad.t} width={group} height={ih} class="hoverband" />{/if}
          {#each series as s, k (s.name)}
            {@const v = s.values[i] ?? 0}
            {@const top = Math.min(y(v), y(0))}
            {@const h = Math.max(v === 0 ? 0 : 1, Math.abs(y(v) - y(0)))}
            {#if v !== 0}<path
              d={v >= 0
                ? `M${gx + (group - inner) / 2 + k * (barW + 2)},${top + h} v${-Math.max(0, h - 4)} q0,-4 4,-4 h${barW - 8} q4,0 4,4 v${Math.max(0, h - 4)} z`
                : `M${gx + (group - inner) / 2 + k * (barW + 2)},${top} v${Math.max(0, h - 4)} q0,4 4,4 h${barW - 8} q4,0 4,-4 v${-Math.max(0, h - 4)} z`}
              fill={s.color}
            />{/if}
          {/each}
          {#if i % labelEvery === 0}
            <text x={gx + group / 2} y={height - 8} text-anchor="middle" class="tick">{l}</text>
          {/if}
          <rect
            x={gx}
            y={pad.t}
            width={group}
            height={ih + pad.b}
            fill="transparent"
            role="presentation"
            onpointerenter={() => (hover = i)}
            onpointerdown={() => (hover = i)}
          />
        {/each}
      </svg>
      {#if hover !== null}
        {@const left = Math.min(Math.max(pad.l + hover * group + group / 2, 90), width - 90)}
        <div class="tip" style:left="{left}px">
          <strong>{labels[hover]}</strong>
          {#each series as s (s.name)}<div><i style:background={s.color}></i>{s.name}<span class="num">{format(s.values[hover] ?? 0)}</span></div>{/each}
        </div>
      {/if}
    </div>
  {/if}
</figure>

<style>
  .chart { margin: 0; }
  .plot { position: relative; width: 100%; }
  svg { display: block; overflow: visible; touch-action: pan-y; }
  .grid { stroke: var(--border); stroke-width: 1; }
  .grid.zero { stroke: var(--border-strong); }
  .tick { fill: var(--text-3); font-size: 11px; font-variant-numeric: tabular-nums; }
  .hoverband { fill: var(--surface-2); }
  .legend { display: flex; flex-wrap: wrap; gap: 14px; align-items: center; font-size: 0.8rem; color: var(--text-2); margin-bottom: 8px; }
  .legend span { display: inline-flex; align-items: center; gap: 6px; }
  .legend i, .tip i { width: 10px; height: 10px; border-radius: 3px; display: inline-block; }
  .link { margin-left: auto; background: none; border: 0; color: var(--accent); font-size: 0.8rem; font-weight: 600; padding: 4px; }
  .tip {
    position: absolute; top: 4px; transform: translateX(-50%); pointer-events: none; min-width: 160px;
    background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-s); box-shadow: var(--shadow-2);
    padding: 8px 10px; font-size: 0.8rem; display: grid; gap: 3px; z-index: 2;
  }
  .tip div { display: flex; align-items: center; gap: 6px; color: var(--text-2); }
  .tip .num { margin-left: auto; color: var(--text); font-weight: 600; padding-left: 12px; }
  .table-wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
  th, td { padding: 6px 8px; border-bottom: 1px solid var(--border); text-align: right; }
  th:first-child { text-align: left; }
  thead th { color: var(--text-3); font-weight: 600; }
</style>
