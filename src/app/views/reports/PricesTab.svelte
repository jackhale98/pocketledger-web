<script lang="ts">
  // Market price history from the journal's P directives (`hledger prices`). Never downloaded.
  import { decodePrices, type PricePoint } from '$lib/engine/decode/text';
  import { app } from '../../state/app.svelte';
  import { reportFilters as f } from '../../state/reports.svelte';
  import LineChart from '../../components/charts/LineChart.svelte';
  import Sheet from '../../components/Sheet.svelte';
  import Icon from '../../components/Icon.svelte';
  import ErrorPanel from '../../components/ErrorPanel.svelte';
  import type { EngineError } from '$lib/contracts/engine';
  import { formatAmount } from '$lib/engine/decimal';
  import { app as appState, SaveError } from '../../state/app.svelte';
  import { toasts } from '../../state/toast.svelte';
  import { parseAmountInput, todayISO } from '../../lib/amounts';
  import { chartCommodity, styleOf } from '../../lib/primary';

  // ---- add a market price (a `P` directive), since prices are never downloaded
  let adding = $state(false);
  let pDate = $state(todayISO());
  let pComm = $state('');
  let pPrice = $state('');
  let pIn = $state('');
  let pErrors = $state<EngineError[]>([]);
  let pSaving = $state(false);
  const priced = $derived(appState.commodities.map((c) => c.symbol));
  /** File that already holds P directives (most of them), else the root journal. */
  const priceFile = $derived.by(() => {
    let best = '';
    let n = 0;
    for (const [path, text] of Object.entries(appState.files)) {
      if (!/\.(journal|hledger|ledger|j|prices)$/i.test(path)) continue;
      const k = (text.match(/^P\s/gm) ?? []).length;
      if (k > n) [best, n] = [path, k];
    }
    return best || appState.vault?.rootFile || 'main.journal';
  });
  function openAdd(commodity = '') {
    pDate = todayISO();
    pComm = commodity;
    pPrice = '';
    pIn = chartCommodity();
    pErrors = [];
    adding = true;
  }
  const quote = (c: string) => (/^[^\s\d.,\-+"@;]+$/.test(c) ? c : `"${c}"`);
  async function savePrice() {
    const q = parseAmountInput(pPrice, styleOf(pIn).decimalMark).quantity;
    if (!pComm.trim() || q == null || !pIn.trim()) {
      pErrors = [{ kind: 'internal', message: 'Enter a commodity, a price and the currency it is priced in.' }];
      return;
    }
    const amount = formatAmount({ commodity: pIn.trim(), quantity: q, style: styleOf(pIn.trim()) }, { group: false });
    const line = `P ${pDate} ${quote(pComm.trim())} ${amount}`;
    const text = appState.files[priceFile] ?? '';
    pSaving = true;
    try {
      await appState.applyPatches([{ op: 'append', file: priceFile, text: `${text === '' || text.endsWith('\n') ? '' : '\n'}${line}\n` }], `price ${pComm.trim()}`);
      toasts.show(`Added ${line} to ${priceFile}`, { tone: 'ok', action: { label: 'Undo', run: () => void appState.undo() } });
      adding = false;
    } catch (e) {
      pErrors = e instanceof SaveError ? e.errors : [{ kind: 'internal', message: (e as Error).message }];
    } finally {
      pSaving = false;
    }
  }

  let points = $state.raw<PricePoint[] | null>(null);
  let error = $state('');
  let selected = $state('');

  $effect(() => {
    const rev = app.revision;
    const range = f.range;
    if (!rev || !app.engine) return;
    const args = ['prices', '--infer-market-prices'];
    if (range.begin) args.push('-b', range.begin);
    if (range.end) args.push('-e', range.end);
    app.engine.raw(args).then((r) => {
      if (r.code !== 0) error = r.stderr.replace(/^hledger: Error: /, '');
      else {
        points = decodePrices(r.stdout);
        error = '';
      }
    });
  });

  const series = $derived.by(() => {
    const m = new Map<string, PricePoint[]>();
    for (const p of points ?? []) {
      const k = `${p.commodity}\u0000${p.in}`;
      m.set(k, [...(m.get(k) ?? []), p]);
    }
    return [...m.entries()]
      .map(([k, pts]) => {
        const [commodity, inC] = k.split('\u0000') as [string, string];
        const sorted = [...pts].sort((a, b) => (a.date < b.date ? -1 : 1));
        const first = Number(sorted[0]!.quantity);
        const last = Number(sorted[sorted.length - 1]!.quantity);
        return { key: k, commodity, in: inC, pts: sorted, last: sorted[sorted.length - 1]!, change: first ? ((last - first) / first) * 100 : 0 };
      })
      .sort((a, b) => a.commodity.localeCompare(b.commodity));
  });
  const current = $derived(series.find((s) => s.key === selected) ?? series[0]);
</script>

<div class="addbar">
  <button class="btn small primary" type="button" onclick={() => openAdd(current?.commodity ?? '')} disabled={appState.readOnly}><Icon name="plus" size={16} /> Add price</button>
</div>

{#if error}
  <p class="card card-pad neg">{error}</p>
{:else if !points}
  <div class="card card-pad"><div class="skeleton" style="height:200px"></div></div>
{:else if series.length === 0}
  <div class="card card-pad empty">
    <h3>No prices in this period</h3>
    <p class="muted">PocketLedger never downloads prices. Add market prices to a journal with <code>P</code> directives, e.g. <code>P 2026-11-01 EUR $1.12</code>; costs written with <code>@</code> are used too.</p>
  </div>
{:else}
  <div class="card list">
    <table>
      <caption class="sr-only">Latest prices</caption>
      <thead><tr><th scope="col">Commodity</th><th scope="col">Latest</th><th scope="col">Date</th><th scope="col">Change</th></tr></thead>
      <tbody>
        {#each series as s (s.key)}
          <tr class:sel={current?.key === s.key}>
            <th scope="row"><button type="button" class="link" onclick={() => (selected = s.key)} aria-pressed={current?.key === s.key}>{s.commodity}</button></th>
            <td class="num">{s.last.price}</td>
            <td class="num" class:muted={current?.key !== s.key}>{s.last.date}</td>
            <td class="num" class:pos={s.change > 0} class:neg={s.change < 0}>{s.pts.length > 1 ? `${s.change > 0 ? '+' : ''}${s.change.toFixed(1)}%` : '—'}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
  {#if current}
    <section class="card card-pad" aria-labelledby="ph">
      <h2 id="ph">{current.commodity} in {current.in}</h2>
      <LineChart title="Price of {current.commodity} in {current.in}" labels={current.pts.map((p) => p.date.slice(2))} values={current.pts.map((p) => Number(p.quantity))} format={(v) => `${v.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${current.in}`} />
      <p class="muted small">{current.pts.length} price point{current.pts.length === 1 ? '' : 's'}, from P directives and transaction costs.</p>
    </section>
  {/if}
{/if}

<style>
  .addbar { display: flex; justify-content: flex-end; margin-bottom: 10px; }
  .pform { display: grid; gap: 12px; }
  .two { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .list { overflow-x: auto; margin-bottom: 12px; }
  table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
  th, td { padding: 10px 12px; border-bottom: 1px solid var(--border); text-align: right; white-space: nowrap; }
  th:first-child { text-align: left; }
  thead th { font-size: 0.75rem; color: var(--text-3); font-weight: 650; }
  tr.sel th, tr.sel td { background: var(--accent-soft); }
  .link { background: none; border: 0; padding: 0; font-weight: 650; color: var(--text); }
  section { min-width: 0; }
  h2 { font-size: 1rem; margin-bottom: 10px; }
  .small { font-size: 0.8rem; margin-top: 6px; }
  .empty { display: grid; gap: 8px; }
  code { font-family: var(--mono); font-size: 0.85em; }
</style>

<Sheet bind:open={adding} title="Add a market price">
  {#if pErrors.length}<ErrorPanel title="Not saved" errors={pErrors} compact />{/if}
  <form class="pform" onsubmit={(e) => { e.preventDefault(); void savePrice(); }}>
    <label class="field"><span>Date</span><input class="input" type="date" bind:value={pDate} /></label>
    <label class="field"><span>Commodity</span><input class="input" list="pl-price-comms" bind:value={pComm} placeholder="e.g. VTI, EUR, BTC" autocapitalize="characters" autocomplete="off" /></label>
    <div class="two">
      <label class="field"><span>Price of one unit</span><input class="input num" inputmode="decimal" bind:value={pPrice} placeholder="0.00" autocomplete="off" /></label>
      <label class="field"><span>In currency</span><input class="input" list="pl-price-comms" bind:value={pIn} autocapitalize="characters" autocomplete="off" /></label>
    </div>
    <datalist id="pl-price-comms">{#each priced as c (c)}<option value={c}></option>{/each}</datalist>
    <p class="muted small">Written as a <code>P</code> directive to <span class="mono">{priceFile}</span>. hledger uses it for market value (“Value in”) and gains.</p>
  </form>
  {#snippet footer()}
    <button class="btn" type="button" onclick={() => (adding = false)}>Cancel</button>
    <button class="btn primary" type="button" onclick={savePrice} disabled={pSaving}>{pSaving ? 'Saving…' : 'Add price'}</button>
  {/snippet}
</Sheet>
