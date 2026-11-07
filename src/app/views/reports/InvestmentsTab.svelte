<script lang="ts">
  // Investments: holdings (units, cost, market value, unrealized gain, latest price), allocation,
  // value vs cost over time and returns per account. Every number is hledger's (see lib/holdings.ts).
  import type { MixedAmount, PeriodicReport } from '$lib/contracts/engine';
  import type { RoiRow } from '$lib/engine/decode/text';
  import { EngineCallError } from '$lib/engine/client';
  import { formatAmount } from '$lib/engine/decimal';
  import { app } from '../../state/app.svelte';
  import { href } from '../../state/router.svelte';
  import { reportFilters as f } from '../../state/reports.svelte';
  import { columnLabel } from '../../lib/periods';
  import { chartCommodity, fmtIn, numberIn, styleOf } from '../../lib/primary';
  import { allocation, fetchHoldings, fetchReturns, historyQuery, totals, type Holding } from '../../lib/holdings';
  import LineChart from '../../components/charts/LineChart.svelte';
  import RankBars from '../../components/charts/RankBars.svelte';
  import Money from '../../components/Money.svelte';
  import ErrorPanel from '../../components/ErrorPanel.svelte';

  let holdings = $state.raw<Holding[] | null>(null);
  let returns = $state.raw<Map<string, RoiRow | { error: string }>>(new Map());
  let error = $state.raw<EngineCallError | null>(null);
  let selected = $state('');
  let allocBy = $state<'commodity' | 'account'>('commodity');
  let value = $state.raw<PeriodicReport | null>(null);
  let cost = $state.raw<PeriodicReport | null>(null);

  const C = $derived(app.revision ? chartCommodity() : '');
  const fmt = $derived(fmtIn(C));
  const fmt0 = $derived(fmtIn(C, 0));
  const units = (h: Holding) => formatAmount({ commodity: h.commodity, quantity: h.units, style: h.style });
  const pct = (p: string | null) => (p == null ? '—' : `${p.startsWith('-') ? '' : '+'}${p}%`);
  const tone = (q: string | null) => (q == null || /^-?0*(\.0*)?$/.test(q) ? '' : q.startsWith('-') ? 'neg' : 'pos');
  const keyOf = (h: Holding) => `${h.account}\u0000${h.commodity}`;

  // Wide screens get a table; phones get one card per holding (same numbers).
  let wide = $state(typeof matchMedia !== 'undefined' && matchMedia('(min-width: 720px)').matches);
  $effect(() => {
    const mq = matchMedia('(min-width: 720px)');
    const on = () => (wide = mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  });

  $effect(() => {
    const rev = app.revision;
    const c = C;
    const range = f.range;
    const words = f.words;
    if (!rev || !app.engine || !c) return;
    const engine = app.engine;
    let stale = false;
    error = null;
    holdings = null;
    (async () => {
      try {
        const r = await fetchHoldings(engine, { currency: c, query: words, period: range });
        if (stale) return;
        holdings = r.holdings;
        // Returns are for investments: skip cash accounts (type C, e.g. a foreign-currency
        // wallet), where hledger's IRR is usually unsolvable and not meaningful.
        const cashTypes = new Map(app.accounts.map((x) => [x.name, x.type]));
        const isCash = (acct: string) => {
          for (let n = acct; n; n = n.includes(':') ? n.slice(0, n.lastIndexOf(':')) : '') {
            const t = cashTypes.get(n);
            if (t) return t === 'C';
          }
          return false;
        };
        const accounts = [...new Set(r.holdings.map((h) => h.account))].filter((a) => !isCash(a));
        const ret = await fetchReturns(engine, accounts, c, range);
        if (!stale) returns = ret;
      } catch (e) {
        if (!stale) error = e instanceof EngineCallError ? e : new EngineCallError([{ kind: 'internal', message: (e as Error).message }]);
      }
    })();
    return () => {
      stale = true;
    };
  });

  const current = $derived(holdings?.find((h) => keyOf(h) === selected) ?? null);

  // Value vs cost, monthly: balance -M --historical, once with -X C and once with -B.
  $effect(() => {
    const hs = holdings;
    const c = C;
    const range = f.range;
    const words = f.words;
    const h = current;
    if (!hs?.length || !app.engine || !c) return;
    const engine = app.engine;
    const query = historyQuery(hs, h, words);
    const base = { query, period: { ...range, interval: 'monthly' as const }, accumulation: 'historical' as const };
    let stale = false;
    value = null;
    Promise.all([engine.periodicBalance({ ...base, valuation: 'value', valueIn: c }), engine.periodicBalance({ ...base, valuation: 'cost' })])
      .then(([v, k]) => {
        if (stale) return;
        value = v;
        cost = k;
      })
      .catch((e) => !stale && (error = e));
    return () => {
      stale = true;
    };
  });

  const first = $derived(app.stats?.firstDate ?? '');
  const skip = $derived(value ? Math.max(0, value.columns.findIndex((col) => col.end > first)) : 0);
  const cols = $derived((value?.columns ?? []).slice(skip));
  const valueSeries = $derived(value ? value.totals.amounts.slice(skip).map((m) => numberIn(m, C)) : []);
  const costSeries = $derived(cost ? cost.totals.amounts.slice(skip).map((m) => numberIn(m, C)) : []);

  const total = $derived(holdings ? totals(holdings, C) : null);
  const alloc = $derived(holdings ? allocation(holdings, allocBy).map((a) => ({ name: a.name, value: Number(a.value) })) : []);
  const returnRows = $derived([...returns.entries()].sort((a, b) => a[0].localeCompare(b[0])));
  // hledger values a report at its last day (the day before the exclusive end), or today.
  const asOf = $derived.by(() => {
    const e = f.range.end;
    if (!e) return 'today';
    const d = new Date(e + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  });
</script>

<!-- An amount in the valuation currency when hledger's result is entirely in it, else hledger's mixed amount. -->
{#snippet amount(q: string | null, ma: MixedAmount, signed = false)}
  {#if q != null}{formatAmount({ commodity: C, quantity: q, style: styleOf(C) }, { signed })}{:else}<Money value={ma} {signed} />{/if}
{/snippet}

{#if error}
  <ErrorPanel title="hledger couldn't value these investments" errors={error.errors} />
{:else if !holdings}
  <div class="card card-pad"><div class="skeleton" style="height:220px"></div></div>
{:else if holdings.length === 0}
  <section class="card card-pad empty" aria-labelledby="inv-empty">
    <h2 id="inv-empty">No investments yet</h2>
    <p class="muted">
      Holdings are asset-account balances in a commodity other than {C || 'your main currency'} — shares, funds, crypto or foreign cash. Record a purchase as units
      with their cost after <code>@</code> (per unit) or <code>@@</code> (total), and add market prices with <code>P</code> directives so hledger can value them:
    </p>
    <pre class="mono">2026-01-10 Buy index fund
    assets:brokerage    10 VTI @ $200.00
    assets:checking

P 2026-02-01 VTI $205.00</pre>
    <p class="muted small">PocketLedger never downloads prices; the Prices tab lists the ones in your journal.</p>
  </section>
{:else}
  {#if total}
    <section class="tiles" aria-label="Investment totals">
      <div class="tile card"><p class="label">Market value</p><p class="big num">{@render amount(total.valueIn, total.value)}</p></div>
      <div class="tile card"><p class="label">Cost basis</p><p class="big num">{@render amount(total.costIn, total.cost)}</p></div>
      <div class="tile card">
        <p class="label">Unrealized gain</p>
        <p class="big num {tone(total.gainIn)}">{@render amount(total.gainIn, total.gain, true)}</p>
        <p class="delta muted">{pct(total.gainPct)} on cost</p>
      </div>
    </section>
  {/if}

  <section class="card holdings" aria-labelledby="hold-h">
    <header class="card-pad"><h2 id="hold-h">Holdings</h2><span class="muted">valued in {C} {asOf === 'today' ? 'today' : `on ${asOf}`}</span></header>
    {#if wide}
      <table>
        <caption class="sr-only">Holdings by account and commodity</caption>
        <thead>
          <tr><th scope="col">Holding</th><th scope="col">Units</th><th scope="col">Latest price</th><th scope="col">Cost</th><th scope="col">Value</th><th scope="col">Gain</th><th scope="col">Gain %</th></tr>
        </thead>
        <tbody>
          {#each holdings as h (keyOf(h))}
            <tr>
              <th scope="row"><span class="cm">{h.commodity}</span><a class="acct" href={href('account', h.account)}>{h.account}</a></th>
              <td class="num">{units(h)}</td>
              <td class="num">{#if h.price}{h.price.price}<small>{h.price.date}</small>{:else}<span class="muted">none</span>{/if}</td>
              <td class="num">{@render amount(h.costIn, h.cost)}</td>
              <td class="num">{@render amount(h.valueIn, h.value)}</td>
              <td class="num {tone(h.gainIn)}">{@render amount(h.gainIn, h.gain, true)}</td>
              <td class="num {tone(h.gainPct)}">{pct(h.gainPct)}</td>
            </tr>
          {/each}
        </tbody>
        {#if total}
          <tfoot>
            <tr>
              <th scope="row">Total</th><td></td><td></td>
              <td class="num">{@render amount(total.costIn, total.cost)}</td>
              <td class="num">{@render amount(total.valueIn, total.value)}</td>
              <td class="num {tone(total.gainIn)}">{@render amount(total.gainIn, total.gain, true)}</td>
              <td class="num {tone(total.gainPct)}">{pct(total.gainPct)}</td>
            </tr>
          </tfoot>
        {/if}
      </table>
    {:else}
      <ul class="cards">
        {#each holdings as h (keyOf(h))}
          <li>
            <div class="top">
              <span class="name"><span class="cm">{h.commodity}</span><a class="acct" href={href('account', h.account)}>{h.account}</a></span>
              <span class="num strong">{@render amount(h.valueIn, h.value)}</span>
            </div>
            <dl>
              <div><dt>Units</dt><dd class="num">{units(h)}</dd></div>
              <div><dt>Price</dt><dd class="num">{#if h.price}{h.price.price}<small>{h.price.date}</small>{:else}none{/if}</dd></div>
              <div><dt>Cost</dt><dd class="num">{@render amount(h.costIn, h.cost)}</dd></div>
              <div><dt>Gain</dt><dd class="num {tone(h.gainIn)}">{@render amount(h.gainIn, h.gain, true)}<small>{pct(h.gainPct)}</small></dd></div>
            </dl>
          </li>
        {/each}
      </ul>
    {/if}
    <p class="card-pad muted small">
      Units from <code>balance</code>; cost from <code>balance -B</code> (recorded costs: a sale lowers it by its sale price); value from <code>balance -X {C}</code>
      and gain from <code>balance --gain -X {C}</code>, using the latest <code>P</code> price on or before the valuation date.
    </p>
  </section>

  {#if returnRows.length}
    <section class="card returns" aria-labelledby="ret-h">
      <header class="card-pad"><h2 id="ret-h">Returns</h2><span class="muted">hledger roi, {C}, this period</span></header>
      <ul>
        {#each returnRows as [acct, r] (acct)}
          <li>
            <a class="acct" href={href('account', acct)}>{acct}</a>
            {#if 'error' in r}<span class="muted small">{r.error}</span>
            {:else}
              <dl>
                <div><dt>IRR</dt><dd class="num {tone(r.irr)}">{r.irr}</dd></div>
                <div><dt>TWR / yr</dt><dd class="num {tone(r.twrYear)}">{r.twrYear}</dd></div>
                <div><dt>Profit</dt><dd class="num {tone(r.pnl)}">{r.pnl}</dd></div>
              </dl>
            {/if}
          </li>
        {/each}
      </ul>
      <p class="card-pad muted small">Annualised internal rate of return and time-weighted return from <code>roi --inv &lt;account&gt; --pnl type:RX --value=end,{C}</code>; gains and costs come from revenue and expense accounts.</p>
    </section>
  {/if}

  <div class="grid">
    <section class="card card-pad" aria-labelledby="alloc-h">
      <header>
        <h2 id="alloc-h">Allocation</h2>
        <div class="seg" role="group" aria-label="Allocate by">
          <button type="button" aria-pressed={allocBy === 'commodity'} onclick={() => (allocBy = 'commodity')}>Commodity</button>
          <button type="button" aria-pressed={allocBy === 'account'} onclick={() => (allocBy = 'account')}>Account</button>
        </div>
      </header>
      {#if alloc.length}
        <RankBars items={alloc} format={fmt0} />
        <p class="muted small">Share of market value in {C}; positions with no {C} value or a negative balance are left out.</p>
      {:else}<p class="muted">Nothing here has a market value in {C} yet. Add <code>P</code> prices for these commodities.</p>{/if}
    </section>

    <section class="card card-pad" aria-labelledby="vc-h">
      <header>
        <h2 id="vc-h">Value vs cost</h2>
        <label class="sr-only" for="vc-pick">Holding</label>
        <select id="vc-pick" class="input mini" bind:value={selected}>
          <option value="">All holdings</option>
          {#each holdings as h (keyOf(h))}<option value={keyOf(h)}>{h.commodity} · {h.account}</option>{/each}
        </select>
      </header>
      {#if value && cost}
        <LineChart
          title="Market value and cost of {current ? `${current.commodity} in ${current.account}` : 'all holdings'} by month"
          labels={cols.map((col) => columnLabel(col.begin, col.end))}
          values={valueSeries}
          name="Market value"
          compare={{ name: 'Cost', values: costSeries }}
          format={fmt}
          prefix={C.length === 1 ? C : ''}
        />
        <p class="muted small">Month-end balances: <code>balance -M --historical -X {C}</code> and <code>-B</code>. Charts always show market value in {C}, whatever the Amounts setting.</p>
      {:else}<div class="skeleton" style="height:200px"></div>{/if}
    </section>
  </div>
{/if}

<style>
  section { margin-bottom: 12px; min-width: 0; }
  h2 { font-size: 1rem; }
  section header { display: flex; justify-content: space-between; align-items: center; gap: 6px 10px; flex-wrap: wrap; }
  section.card-pad header { margin-bottom: 10px; }
  header span { font-size: 0.8rem; }
  .tiles { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
  .tiles .tile:last-child { grid-column: 1 / -1; }
  .tile { padding: 14px 16px; display: grid; gap: 4px; min-width: 0; }
  .big :global(.money) { text-align: left; }
  .big { font-size: 1.3rem; font-weight: 750; letter-spacing: -0.02em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .delta { font-size: 0.8rem; }
  .holdings, .returns { overflow: clip; }
  table { width: 100%; border-collapse: collapse; font-size: 0.88rem; }
  th, td { padding: 10px 12px; border-top: 1px solid var(--border); text-align: right; white-space: nowrap; }
  th:first-child { text-align: left; }
  thead th { font-size: 0.75rem; color: var(--text-3); font-weight: 650; }
  tbody th { font-weight: 600; }
  tfoot th, tfoot td { font-weight: 700; border-top: 2px solid var(--border-strong); }
  td small { display: block; color: var(--text-3); font-size: 0.72rem; }
  .cm { font-weight: 700; margin-right: 8px; }
  .acct { color: var(--text-2); font-weight: 500; font-size: 0.85em; overflow-wrap: anywhere; }
  ul { list-style: none; margin: 0; padding: 0; }
  .cards li, .returns li { border-top: 1px solid var(--border); padding: 12px 16px; display: grid; gap: 8px; min-width: 0; }
  .top { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; min-width: 0; }
  .name { min-width: 0; overflow-wrap: anywhere; }
  .strong { font-weight: 700; white-space: nowrap; }
  dl { margin: 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px 12px; }
  .returns dl { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  dl div { min-width: 0; }
  dt { font-size: 0.72rem; color: var(--text-3); font-weight: 600; }
  dd { margin: 0; font-size: 0.88rem; font-weight: 600; overflow-wrap: anywhere; }
  dd small { display: block; color: var(--text-3); font-weight: 500; font-size: 0.75rem; }
  .small { font-size: 0.78rem; }
  code { font-family: var(--mono); font-size: 0.85em; }
  .empty { display: grid; gap: 10px; }
  .empty pre { margin: 0; padding: 10px 12px; background: var(--surface-2); border-radius: var(--radius-s); font-size: 0.8rem; overflow-x: auto; }
  .grid { display: grid; gap: 12px; min-width: 0; align-items: start; }
  .grid > section { margin-bottom: 0; }
  .mini { min-height: 32px; padding: 2px 8px; width: auto; max-width: 100%; font-size: 0.82rem; }
  .seg { display: inline-flex; border: 1px solid var(--border-strong); border-radius: var(--radius-s); overflow: hidden; }
  .seg button { border: 0; background: var(--surface); padding: 6px 10px; font-size: 0.8rem; font-weight: 600; color: var(--text-2); min-height: 34px; }
  .seg button + button { border-left: 1px solid var(--border); }
  .seg button[aria-pressed='true'] { background: var(--accent-soft); color: var(--accent-strong); }
  @media (min-width: 720px) {
    .tiles { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .tiles .tile:last-child { grid-column: auto; }
  }
  @media (min-width: 1100px) { .grid { grid-template-columns: 1fr 1.4fr; } }
</style>
