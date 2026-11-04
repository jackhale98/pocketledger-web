<script lang="ts">
  // Reconcile an account against a statement: tick the postings on the statement,
  // match the balance, then mark them cleared (and optionally write a balance assertion).
  import type { RegisterRow, Txn } from '$lib/contracts/engine';
  import { dec, formatAmount } from '$lib/engine/decimal';
  import { draftFromTxn, writer } from '$lib/journal/writer';
  import { makeSnapshot } from '$lib/vault';
  import { app, SaveError } from '../state/app.svelte';
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
  let rows = $state.raw<RegisterRow[]>([]);
  let ticked = $state<Set<number>>(new Set());
  let assertion = $state(true);
  let busy = $state(false);
  let errors = $state<SaveError | null>(null);

  const assetAccounts = $derived(app.accounts.filter((a) => ['A', 'C', 'L'].includes(a.type ?? '') || /^(assets|liabilities)/.test(a.name)).map((a) => a.name));
  const known = $derived(app.accounts.some((a) => a.name === account));

  const nextDay = (d: string) => {
    const x = new Date(d + 'T00:00:00');
    x.setDate(x.getDate() + 1);
    return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  };

  $effect(() => {
    const rev = app.revision;
    const a = account;
    const d = date;
    if (!rev || !app.engine || !known || !d) return;
    app.engine.register(a, { period: { end: nextDay(d) } }).then((r) => {
      rows = r;
      ticked = new Set();
    });
  });

  const commodity = $derived(rows[0]?.posting.amount[0]?.commodity ?? '$');
  const style = $derived(styleOf(commodity));
  const qty = (r: RegisterRow) => dec(r.posting.amount.find((a) => a.commodity === commodity)?.quantity ?? '0');
  const txnOf = (r: RegisterRow) => app.txns.find((t) => t.index === r.txnIndex);
  const isCleared = (r: RegisterRow) => r.posting.status === '*' || txnOf(r)?.status === '*';
  const cleared = $derived(rows.filter(isCleared).reduce((s, r) => s.plus(qty(r)), dec(0)));
  const open = $derived(rows.map((r, i) => ({ r, i })).filter(({ r }) => !isCleared(r)));
  const tickedSum = $derived(open.filter(({ i }) => ticked.has(i)).reduce((s, { r }) => s.plus(qty(r)), dec(0)));
  const targetQ = $derived(parseAmountInput(target, style.decimalMark).quantity);
  const diff = $derived(targetQ == null ? null : dec(targetQ).minus(cleared.plus(tickedSum)));
  const f = (v: ReturnType<typeof dec>) => formatAmount({ commodity, quantity: v.toString(), style });

  function toggle(i: number) {
    const s = new Set(ticked);
    if (s.has(i)) s.delete(i);
    else s.add(i);
    ticked = s;
  }

  async function finish() {
    if (!app.vault || targetQ == null) return;
    busy = true;
    errors = null;
    try {
      const txns = new Map<number, Txn>();
      for (const { r, i } of open) if (ticked.has(i)) { const t = txnOf(r); if (t?.source) txns.set(t.index, t); }
      // Edit bottom-up so earlier spans stay valid.
      const ordered = [...txns.values()].sort((a, b) => (a.source!.file === b.source!.file ? b.source!.startLine - a.source!.startLine : a.source!.file < b.source!.file ? -1 : 1));
      let files = { ...app.files };
      for (const t of ordered) {
        const snap = makeSnapshot(files, app.vault.rootFile);
        const d = draftFromTxn(t, snap);
        files = writer.apply(files, writer.planEdit(snap, t, { ...d, status: '*' }));
      }
      if (assertion) {
        const snap = makeSnapshot(files, app.vault.rootFile);
        const target = app.addTargetFile();
        files = writer.apply(
          files,
          writer.planAdd(snap, {
            date,
            status: '*',
            description: 'Reconciled with statement',
            postings: [{ account, amount: '0', commodity, assertion: `= ${formatAmount({ commodity, quantity: toJournalNumber(targetQ, style), style }, { group: false })}` }],
          }, { targetFile: target }),
        );
      }
      await app.commitFiles(files, `reconcile ${account}`);
      toasts.show(`Reconciled ${account}: ${txns.size} cleared`, { tone: 'ok', action: { label: 'Undo', run: () => void app.undo() } });
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
  <label class="field"><span>Statement balance</span><input class="input num" inputmode="decimal" bind:value={target} placeholder={f(dec(0))} /></label>
</section>

{#if known && rows.length}
  <section class="card card-pad status" aria-live="polite">
    <div><p class="label">Cleared</p><p class="v num">{f(cleared)}</p></div>
    <div><p class="label">+ Ticked</p><p class="v num">{f(tickedSum)}</p></div>
    <div><p class="label">Difference</p>
      <p class="v num" class:pos={diff?.isZero()} class:neg={diff != null && !diff.isZero()}>{diff == null ? '—' : diff.isZero() ? 'Balanced' : f(diff)}</p>
    </div>
  </section>

  <section class="card list">
    <h2 class="card-pad">Uncleared up to {date} <span class="muted">({open.length})</span></h2>
    {#if open.length === 0}<p class="card-pad muted">Everything up to this date is cleared.</p>{/if}
    <ul>
      {#each open as { r, i } (i)}
        <li>
          <label>
            <input type="checkbox" checked={ticked.has(i)} onchange={() => toggle(i)} />
            <span class="d num">{r.date}</span>
            <span class="desc">{r.description}{#if r.posting.status === '!' || txnOf(r)?.status === '!'} <span class="badge warn">Pending</span>{/if}</span>
            <span class="amt"><Money value={r.posting.amount} color /></span>
          </label>
        </li>
      {/each}
    </ul>
    {#if open.length}<div class="card-pad"><button class="btn small ghost" type="button" onclick={() => (ticked = new Set(open.map((o) => o.i)))}>Tick all</button></div>{/if}
  </section>

  {#if errors}<ErrorPanel title="hledger rejected the reconciliation; nothing was saved" errors={errors.errors} />{/if}
  <section class="card card-pad finish">
    <label class="check"><input type="checkbox" bind:checked={assertion} /> Also write a balance assertion (<code>{account} = {target || '…'}</code> on {date})</label>
    <button class="btn primary" type="button" onclick={finish} disabled={busy || targetQ == null || !diff?.isZero() || app.readOnly}>
      <Icon name="check-circle" size={18} /> Mark {ticked.size} cleared
    </button>
  </section>
{:else if known}
  <p class="card card-pad muted">No postings to {account} up to {date}.</p>
{:else}
  <p class="muted hint">Choose an asset or liability account and enter the closing balance from your statement.</p>
{/if}

<style>
  .setup { display: grid; grid-template-columns: 1fr; gap: 12px; margin-bottom: 12px; }
  @media (min-width: 700px) { .setup { grid-template-columns: 2fr 1fr 1fr; } }
  .status { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-bottom: 12px; text-align: center; }
  .v { font-size: 1.1rem; font-weight: 700; }
  .list { overflow: hidden; margin-bottom: 12px; }
  h2 { font-size: 1rem; }
  ul { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--border); max-height: 50vh; overflow: auto; }
  li + li { border-top: 1px solid var(--border); }
  li label { display: grid; grid-template-columns: auto auto minmax(0, 1fr) auto; gap: 10px; align-items: center; padding: 12px 16px; cursor: pointer; }
  .d { font-size: 0.82rem; color: var(--text-2); }
  .desc { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .amt { font-weight: 650; }
  input[type='checkbox'] { width: 20px; height: 20px; accent-color: var(--accent); }
  .finish { display: flex; gap: 12px; flex-wrap: wrap; justify-content: space-between; align-items: center; }
  .check { display: flex; gap: 8px; align-items: center; font-size: 0.88rem; }
  code { font-family: var(--mono); font-size: 0.82rem; }
  .hint { padding: 8px; }
</style>
