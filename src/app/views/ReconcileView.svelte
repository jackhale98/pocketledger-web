<script lang="ts">
  // Reconcile an account against a statement: tick the postings on the statement,
  // match the balance, then mark those postings cleared (posting-level `*`, so the
  // other side of a transfer is untouched) and optionally write a balance assertion.
  import type { RegisterRow } from '$lib/contracts/engine';
  import { dec, formatAmount } from '$lib/engine/decimal';
  import { accountQuery } from '$lib/engine/args';
  import { draftFromTxn, writer } from '$lib/journal/writer';
  import { makeSnapshot } from '$lib/vault';
  import { app, SaveError } from '../state/app.svelte';
  import { editor } from '../state/editor.svelte';
  import { router } from '../state/router.svelte';
  import { toasts } from '../state/toast.svelte';
  import { parseAmountInput, todayISO, toJournalNumber } from '../lib/amounts';
  import { styleOf } from '../lib/primary';
  import Icon from '../components/Icon.svelte';
  import Money from '../components/Money.svelte';
  import Autocomplete from '../components/Autocomplete.svelte';
  import ErrorPanel from '../components/ErrorPanel.svelte';

  let account = $state(router.route.query.get('account') ?? '');
  let date = $state(todayISO());
  let target = $state('');
  let commodity = $state('');
  let open = $state.raw<RegisterRow[]>([]);
  let clearedTotal = $state.raw<{ commodity: string; quantity: string }[]>([]);
  /** Ticked postings, keyed by content so ticks survive a reload. */
  let ticked = $state<Set<string>>(new Set());
  let assertion = $state(true);
  let busy = $state(false);
  let errors = $state<SaveError | null>(null);
  let search = $state('');

  const assetAccounts = $derived(app.accounts.filter((a) => ['A', 'C', 'L'].includes(a.type ?? '') || /^(assets|liabilities)/.test(a.name)).map((a) => a.name));
  const known = $derived(app.accounts.some((a) => a.name === account));
  const keyOf = (r: RegisterRow) => `${r.date}|${r.description}|${r.posting.account}|${r.posting.amount.map((a) => a.commodity + a.quantity).join(',')}`;
  const nextDay = (d: string) => {
    const x = new Date(d + 'T00:00:00Z');
    x.setUTCDate(x.getUTCDate() + 1);
    return x.toISOString().slice(0, 10);
  };

  $effect(() => {
    const rev = app.revision;
    const a = account;
    const d = date;
    if (!rev || !app.engine || !known || !d) return;
    const engine = app.engine;
    const end = nextDay(d);
    (async () => {
      // Unmarked + pending postings up to the statement date, and the cleared balance.
      open = await engine.register(a, { period: { end }, unmarked: true, pending: true });
      clearedTotal = (await engine.balance({ query: [accountQuery(a)], period: { end }, cleared: true, depth: 1 })).total;
      const still = new Set(open.map(keyOf));
      ticked = new Set([...ticked].filter((k) => still.has(k)));
    })();
  });

  const commodities = $derived([...new Set([...clearedTotal.map((a) => a.commodity), ...open.flatMap((r) => r.posting.amount.map((a) => a.commodity))])]);
  $effect(() => {
    if (!commodities.includes(commodity) && commodities.length) commodity = commodities[0]!;
  });
  const style = $derived(styleOf(commodity || '$'));
  const qty = (r: RegisterRow) => dec(r.posting.amount.find((a) => a.commodity === commodity)?.quantity ?? '0');
  const cleared = $derived(dec(clearedTotal.find((a) => a.commodity === commodity)?.quantity ?? '0'));
  const shown = $derived(search.trim() ? open.filter((r) => `${r.description} ${r.posting.account}`.toLowerCase().includes(search.toLowerCase())) : open);
  const tickedRows = $derived(open.filter((r) => ticked.has(keyOf(r))));
  const tickedSum = $derived(tickedRows.reduce((s, r) => s.plus(qty(r)), dec(0)));
  const targetQ = $derived(parseAmountInput(target, style.decimalMark).quantity);
  const diff = $derived(targetQ == null ? null : dec(targetQ).minus(cleared.plus(tickedSum)));
  const f = (v: ReturnType<typeof dec>) => formatAmount({ commodity, quantity: v.toString(), style });

  function toggle(r: RegisterRow) {
    const k = keyOf(r);
    const s = new Set(ticked);
    if (s.has(k)) s.delete(k);
    else s.add(k);
    ticked = s;
  }
  function flipSign() {
    const v = target.trim();
    target = v.startsWith('-') ? v.slice(1) : `-${v}`;
  }
  async function edit(r: RegisterRow) {
    const t = await app.findTxn(r.txnIndex, r.date);
    if (t) editor.show(t);
  }

  async function finish() {
    if (!app.vault || tickedRows.length === 0) return;
    const balanced = diff?.isZero() ?? false;
    if (!balanced && !confirm(`The difference is ${diff ? f(diff) : 'unknown'}. Mark the ${tickedRows.length} ticked posting(s) cleared anyway, without a balance assertion?`)) return;
    busy = true;
    errors = null;
    try {
      // Find each ticked posting's transaction, then edit bottom-up so earlier spans stay valid.
      const byTxn = new Map<number, { txn: NonNullable<Awaited<ReturnType<typeof app.findTxn>>>; accounts: string[] }>();
      for (const r of tickedRows) {
        const t = byTxn.get(r.txnIndex)?.txn ?? (await app.findTxn(r.txnIndex, r.date));
        if (!t?.source) continue;
        const entry = byTxn.get(r.txnIndex) ?? { txn: t, accounts: [] };
        entry.accounts.push(r.posting.account);
        byTxn.set(r.txnIndex, entry);
      }
      const ordered = [...byTxn.values()].sort((a, b) =>
        a.txn.source!.file === b.txn.source!.file ? b.txn.source!.startLine - a.txn.source!.startLine : a.txn.source!.file < b.txn.source!.file ? -1 : 1,
      );
      let files = { ...app.files };
      for (const { txn, accounts } of ordered) {
        const snap = makeSnapshot(files, app.vault.rootFile);
        const d = draftFromTxn(txn, snap);
        const want = [...accounts];
        const postings = d.postings.map((p) => {
          const i = want.indexOf(p.account);
          if (i >= 0 && p.status !== '*') {
            want.splice(i, 1);
            return { ...p, status: '*' as const };
          }
          return p;
        });
        files = writer.apply(files, writer.planEdit(snap, txn, { ...d, postings }));
      }
      if (assertion && balanced && targetQ != null) {
        const snap = makeSnapshot(files, app.vault.rootFile);
        files = writer.apply(
          files,
          writer.planAdd(
            snap,
            {
              date,
              status: '*',
              description: 'Reconciled with statement',
              postings: [{ account, amount: '0', commodity, assertion: `= ${formatAmount({ commodity, quantity: toJournalNumber(targetQ, style), style }, { group: false })}` }],
            },
            { targetFile: app.addTargetFile() },
          ),
        );
      }
      await app.commitFiles(files, `reconcile ${account}`);
      toasts.show(`Cleared ${tickedRows.length} posting(s) in ${account}`, { tone: 'ok', action: { label: 'Undo', run: () => void app.undo() } });
      ticked = new Set();
    } catch (e) {
      errors = e instanceof SaveError ? e : new SaveError([{ kind: 'internal', message: (e as Error).message }]);
    } finally {
      busy = false;
    }
  }
</script>

<section class="card card-pad setup">
  <div class="field grow">
    <label class="label" for="rec-acct">Account</label>
    <Autocomplete id="rec-acct" label="Account" bind:value={account} options={assetAccounts} placeholder="assets:checking" />
  </div>
  <label class="field"><span>Statement date</span><input class="input" type="date" bind:value={date} /></label>
  <div class="field">
    <label class="label" for="rec-bal">Statement balance</label>
    <div class="bal">
      <button type="button" class="sign" onclick={flipSign} aria-label="Flip sign of statement balance">±</button>
      <input id="rec-bal" class="input num" inputmode="decimal" autocomplete="off" bind:value={target} placeholder={f(dec(0))} />
      {#if commodities.length > 1}
        <label class="sr-only" for="rec-comm">Currency</label>
        <select id="rec-comm" class="input comm" bind:value={commodity}>{#each commodities as c (c)}<option value={c}>{c}</option>{/each}</select>
      {/if}
    </div>
  </div>
</section>

{#if known}
  <section class="card card-pad status" aria-live="polite">
    <div><p class="label">Cleared</p><p class="v num">{f(cleared)}</p></div>
    <div><p class="label">+ Ticked</p><p class="v num">{f(tickedSum)}</p></div>
    <div><p class="label">Difference</p>
      <p class="v num" class:pos={diff?.isZero()} class:neg={diff != null && !diff.isZero()}>{diff == null ? '—' : diff.isZero() ? 'Balanced' : f(diff)}</p>
    </div>
  </section>

  <section class="card list">
    <div class="lh card-pad">
      <h2>Uncleared up to {date} <span class="muted">({open.length})</span></h2>
      {#if open.length > 8}
        <label class="sr-only" for="rec-search">Search postings</label>
        <input id="rec-search" class="input search" type="search" placeholder="Search" autocomplete="off" autocapitalize="off" bind:value={search} />
      {/if}
    </div>
    {#if open.length === 0}<p class="card-pad muted">Everything up to this date is cleared.</p>{/if}
    <ul>
      {#each shown as r (keyOf(r) + r.txnIndex)}
        <li>
          <label>
            <input type="checkbox" checked={ticked.has(keyOf(r))} onchange={() => toggle(r)} />
            <span class="d num">{r.date}</span>
            <span class="desc">{r.description}{#if r.posting.status === '!'} <span class="badge warn">Pending</span>{/if}{#if r.posting.account !== account}<small>{r.posting.account}</small>{/if}</span>
            <span class="amt"><Money value={r.posting.amount} color /></span>
          </label>
          <button class="icon-btn ed" type="button" onclick={() => edit(r)} aria-label="Open {r.description}"><Icon name="chevron-right" size={18} /></button>
        </li>
      {/each}
    </ul>
    {#if open.length}
      <div class="card-pad acts">
        <button class="btn small ghost" type="button" onclick={() => (ticked = new Set(shown.map(keyOf)))}>Tick all{search ? ' shown' : ''}</button>
        <button class="btn small ghost" type="button" onclick={() => (ticked = new Set())} disabled={ticked.size === 0}>Clear ticks</button>
      </div>
    {/if}
  </section>

  {#if errors}<ErrorPanel title="hledger rejected the reconciliation; nothing was saved" errors={errors.errors} />{/if}
  <section class="card card-pad finish">
    <label class="check"><input type="checkbox" bind:checked={assertion} /> Write a balance assertion when balanced (<code>{account} = {target || '…'}</code> on {date})</label>
    <button class="btn primary" type="button" onclick={finish} disabled={busy || tickedRows.length === 0 || app.readOnly}>
      <Icon name="check-circle" size={18} /> {diff?.isZero() ? `Mark ${tickedRows.length} cleared` : `Finish anyway (${tickedRows.length})`}
    </button>
  </section>
{:else}
  <p class="muted hint">Choose an asset or liability account and enter the closing balance from your statement.</p>
{/if}

<style>
  .setup { display: grid; grid-template-columns: 1fr; gap: 12px; margin-bottom: 12px; }
  @media (min-width: 760px) { .setup { grid-template-columns: 2fr 1fr 1.4fr; } }
  .bal { display: flex; gap: 6px; }
  .bal .input.num { flex: 1; min-width: 0; }
  .sign { width: 40px; flex: none; border: 1px solid var(--border-strong); border-radius: var(--radius-s); background: var(--surface-2); font-weight: 700; }
  .comm { width: auto; flex: none; }
  .status { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-bottom: 12px; text-align: center; }
  .v { font-size: 1.05rem; font-weight: 700; overflow-wrap: anywhere; }
  .list { overflow: clip; margin-bottom: 12px; }
  .lh { display: flex; gap: 10px; align-items: center; justify-content: space-between; flex-wrap: wrap; }
  .search { width: auto; flex: 1 1 160px; min-height: 36px; padding: 6px 10px; }
  h2 { font-size: 1rem; }
  ul { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--border); max-height: 55vh; overflow: auto; }
  li { display: flex; align-items: center; }
  li + li { border-top: 1px solid var(--border); }
  li label { flex: 1; min-width: 0; display: grid; grid-template-columns: auto auto minmax(0, 1fr) auto; gap: 10px; align-items: center; padding: 12px 4px 12px 16px; cursor: pointer; }
  .ed { width: 40px; height: 40px; flex: none; }
  .d { font-size: 0.82rem; color: var(--text-2); }
  .desc { display: grid; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .desc small { color: var(--text-3); overflow: hidden; text-overflow: ellipsis; }
  .amt { font-weight: 650; }
  input[type='checkbox'] { width: 20px; height: 20px; accent-color: var(--accent); }
  .acts { display: flex; gap: 8px; }
  .finish { display: flex; gap: 12px; flex-wrap: wrap; justify-content: space-between; align-items: center; }
  .check { display: flex; gap: 8px; align-items: center; font-size: 0.88rem; }
  code { font-family: var(--mono); font-size: 0.82rem; }
  .hint { padding: 8px; }
  @media (max-width: 520px) { li label { grid-template-columns: auto minmax(0, 1fr) auto; } .d { display: none; } }
</style>
