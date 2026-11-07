<script lang="ts">
  // One account in depth: balance over time, change per period, postings and investment returns.
  import type { PeriodicReport, RegisterRow } from '$lib/contracts/engine';
  import type { MixedAmount } from '$lib/contracts/amount';
  import { EngineCallError } from '$lib/engine/client';
  import { accountQuery } from '$lib/engine/args';
  import { decodeRoi, type RoiRow } from '$lib/engine/decode/text';
  import { app } from '../../state/app.svelte';
  import { editor } from '../../state/editor.svelte';
  import { href } from '../../state/router.svelte';
  import { reportFilters as f } from '../../state/reports.svelte';
  import { columnLabel } from '../../lib/periods';
  import { chartCommodity, fmtIn, numberIn } from '../../lib/primary';
  import Autocomplete from '../../components/Autocomplete.svelte';
  import LineChart from '../../components/charts/LineChart.svelte';
  import BarChart from '../../components/charts/BarChart.svelte';
  import Money from '../../components/Money.svelte';
  import ErrorPanel from '../../components/ErrorPanel.svelte';

  const names = $derived(app.accounts.map((a) => a.name));
  let input = $state(f.account || '');
  const account = $derived(names.includes(input) ? input : '');
  $effect(() => {
    if (!input && app.accounts.length) input = app.accounts.find((a) => a.type === 'C')?.name ?? app.accounts[0]!.name;
  });
  $effect(() => {
    if (account && account !== f.account) {
      f.account = account;
      f.save();
    }
  });

  let balance = $state.raw<PeriodicReport | null>(null);
  let change = $state.raw<PeriodicReport | null>(null);
  let rows = $state.raw<RegisterRow[] | null>(null);
  let native = $state.raw<MixedAmount>([]);
  let roi = $state.raw<RoiRow | null>(null);
  let roiError = $state('');
  let pnl = $state('type:RX');
  let error = $state.raw<EngineCallError | null>(null);
  let limit = $state(100);

  const commodity = $derived(app.revision ? chartCommodity() : '');
  const fmt = $derived(fmtIn(commodity));

  $effect(() => {
    const rev = app.revision;
    const acct = account;
    const c = commodity;
    const interval = f.chartInterval;
    const range = f.range;
    const words = f.words;
    if (!rev || !app.engine || !acct || !c) return;
    const engine = app.engine;
    const q = [accountQuery(acct), ...words];
    error = null;
    rows = null;
    limit = 100;
    (async () => {
      try {
        balance = await engine.periodicBalance({ query: q, period: { ...range, interval }, accumulation: 'historical', valueIn: c, depth: 1 });
        change = await engine.periodicBalance({ query: q, period: { ...range, interval }, valueIn: c, depth: 1 });
        const nb = await engine.balance({ query: q, period: range, depth: 1, accumulation: 'historical' });
        native = nb.total;
        rows = (await engine.register(acct, f.opts())).reverse();
      } catch (e) {
        error = e instanceof EngineCallError ? e : new EngineCallError([{ kind: 'internal', message: (e as Error).message }]);
      }
    })();
  });

  /** Returns only make sense for accounts holding something whose price moves (a security, a foreign currency). */
  const holdsUnits = $derived(native.some((a) => a.commodity !== commodity && Number(a.quantity) !== 0));

  $effect(() => {
    const acct = account;
    const c = commodity;
    const p = pnl.trim();
    const range = f.range;
    if (!holdsUnits || !app.engine || !acct) {
      roi = null;
      return;
    }
    const args = ['roi', '--inv', accountQuery(acct), ...(p ? ['--pnl', p] : []), `--value=end,${c}`, '--infer-market-prices'];
    if (range.begin) args.push('-b', range.begin);
    if (range.end) args.push('-e', range.end);
    app.engine.raw(args).then((r) => {
      if (r.code !== 0) {
        roi = null;
        roiError = r.stderr.replace(/^hledger: Error: /, '').split('\n')[0] ?? 'roi failed';
      } else {
        const all = decodeRoi(r.stdout);
        roi = all[all.length - 1] ?? null;
        roiError = '';
      }
    });
  });

  // Skip periods that end before the journal's first transaction.
  const firstDate = $derived(app.stats?.firstDate ?? '');
  const skip = $derived(balance ? Math.max(0, balance.columns.findIndex((c) => c.end > firstDate)) : 0);
  const balCols = $derived((balance?.columns ?? []).slice(skip));
  const balVals = $derived(balance ? balance.totals.amounts.slice(skip).map((m) => numberIn(m, commodity)) : []);
  const chgCols = $derived((change?.columns ?? []).slice(skip));
  const chgVals = $derived(change ? change.totals.amounts.slice(skip).map((m) => numberIn(m, commodity)) : []);
  const tone = (s: string) => (s.trim().startsWith('-') ? 'neg' : 'pos');

  async function open(r: RegisterRow) {
    const t = await app.findTxn(r.txnIndex, r.date);
    if (t) editor.show(t);
  }
</script>

<div class="pick">
  <div class="field grow">
    <label class="label" for="acct-pick">Account</label>
    <Autocomplete id="acct-pick" label="Account" bind:value={input} options={names} placeholder="assets:checking" />
  </div>
  {#if account}<a class="btn small" href={href('account', account)}>Full register</a>{/if}
</div>

{#if !account}
  <p class="muted">Choose an account to analyse.</p>
{:else if error}
  <ErrorPanel title="hledger couldn't analyse this account" errors={error.errors} />
{:else}
  <section class="card card-pad sum">
    <div><p class="label">Balance at end</p><p class="big num"><Money value={native} /></p></div>
    {#if holdsUnits && balVals.length}<div class="r"><p class="label">Valued in {commodity}</p><p class="mid num">{fmt(balVals[balVals.length - 1] ?? 0)}</p></div>{/if}
  </section>

  {#if roi}
    <section class="card card-pad" aria-labelledby="roi-h">
      <h2 id="roi-h">Return</h2>
      <div class="stats">
        <div><p class="label">IRR (annual)</p><p class="v num {tone(roi.irr)}">{roi.irr}</p></div>
        <div><p class="label">TWR (annual)</p><p class="v num {tone(roi.twrYear)}">{roi.twrYear}</p></div>
        <div><p class="label">Gain</p><p class="v num {tone(roi.pnl)}">{roi.pnl}</p></div>
        <div><p class="label">Net invested</p><p class="v num">{roi.cashflow}</p></div>
        <div><p class="label">Value at start</p><p class="v num">{roi.valueBegin}</p></div>
        <div><p class="label">Value at end</p><p class="v num">{roi.valueEnd}</p></div>
      </div>
      <details>
        <summary>Settings</summary>
        <label class="field"><span>Profit & loss accounts (hledger query for <code>roi --pnl</code>)</span><input class="input mono" bind:value={pnl} /></label>
        <p class="muted small">By default gains and costs come from revenue and expense accounts (<code>type:RX</code>). {roi.begin} – {roi.end}, valued at period end in {commodity} by hledger <code>roi</code>.</p>
      </details>
    </section>
  {:else if holdsUnits && roiError}
    <p class="muted small">Returns unavailable: {roiError}</p>
  {/if}

  <section class="card card-pad" aria-labelledby="bal-h">
    <h2 id="bal-h">Balance over time</h2>
    {#if balance}
      <LineChart title="Balance of {account}" labels={balCols.map((c) => columnLabel(c.begin, c.end))} values={balVals} format={fmt} prefix={commodity.length === 1 ? commodity : ''} />
    {:else}<div class="skeleton" style="height:200px"></div>{/if}
  </section>

  <section class="card card-pad" aria-labelledby="chg-h">
    <h2 id="chg-h">Change per period</h2>
    {#if change}
      <BarChart title="Change in {account} per period" labels={chgCols.map((c) => columnLabel(c.begin, c.end))} series={[{ name: 'Change', color: 'var(--chart-3)', values: chgVals }]} format={fmt} prefix={commodity.length === 1 ? commodity : ''} />
    {:else}<div class="skeleton" style="height:220px"></div>{/if}
  </section>

  <section class="card list" aria-labelledby="post-h">
    <h2 id="post-h" class="card-pad">Postings {#if rows}<span class="muted">({rows.length})</span>{/if}</h2>
    {#if !rows}<div class="card-pad"><div class="skeleton" style="height:120px"></div></div>
    {:else if rows.length === 0}<p class="card-pad muted">No postings in this period.</p>
    {:else}
      <ul>
        {#each rows.slice(0, limit) as r, i (i)}
          <li>
            <button type="button" onclick={() => open(r)} disabled={!r.txnIndex}>
              <span class="d num">{r.date}</span>
              <span class="desc">{r.description}{#if r.posting.account !== account}<small>{r.posting.account}</small>{/if}</span>
              <span class="a"><Money value={r.posting.amount} color /><small><Money value={r.balance} /></small></span>
            </button>
          </li>
        {/each}
      </ul>
      {#if rows.length > limit}<div class="card-pad"><button class="btn small ghost" type="button" onclick={() => (limit += 200)}>Show more</button></div>{/if}
    {/if}
  </section>
{/if}

<style>
  .pick { display: flex; gap: 10px; align-items: flex-end; margin-bottom: 12px; flex-wrap: wrap; }
  .grow { flex: 1; min-width: 200px; }
  section { margin-bottom: 12px; min-width: 0; }
  h2 { font-size: 1rem; margin-bottom: 10px; }
  .sum { display: flex; justify-content: space-between; align-items: flex-end; gap: 12px; flex-wrap: wrap; }
  .r { text-align: right; }
  .big { font-size: 1.45rem; font-weight: 750; }
  .mid { font-size: 1.05rem; font-weight: 650; color: var(--text-2); }
  .stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px 12px; margin-bottom: 8px; }
  .v { font-weight: 700; font-size: 1.02rem; }
  details summary { cursor: pointer; font-size: 0.85rem; font-weight: 600; color: var(--accent); padding: 4px 0; }
  details .field { margin-top: 8px; }
  .small { font-size: 0.8rem; }
  code { font-family: var(--mono); font-size: 0.85em; }
  .list { overflow: clip; }
  .list h2 { margin: 0; }
  ul { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--border); }
  li + li { border-top: 1px solid var(--border); }
  li button { width: 100%; display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 10px; align-items: center; padding: 10px 16px; border: 0; background: none; text-align: left; }
  li button:hover:not(:disabled) { background: var(--surface-2); }
  .d { font-size: 0.8rem; color: var(--text-2); }
  .desc { display: grid; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-weight: 560; }
  .desc small { color: var(--text-3); font-weight: 400; overflow: hidden; text-overflow: ellipsis; }
  .a { display: grid; justify-items: end; font-weight: 650; }
  .a small { font-weight: 400; font-size: 0.75rem; color: var(--text-3); }
  @media (max-width: 480px) { .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
</style>
