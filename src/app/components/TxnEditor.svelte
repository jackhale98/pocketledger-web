<script lang="ts">
  import { untrack } from 'svelte';
  import type { EngineError, Status } from '$lib/contracts/engine';
  import type { PostingDraft, TxnDraft } from '$lib/contracts/writer';
  import type { AmountStyle } from '$lib/contracts/amount';
  import { draftFromTxn, writer } from '$lib/journal/writer';
  import { formatAmount, styleFor } from '$lib/engine/decimal';
  import { makeSnapshot } from '$lib/vault';
  import { app, SaveError } from '../state/app.svelte';
  import { editor } from '../state/editor.svelte';
  import { toasts } from '../state/toast.svelte';
  import { balanceOf, parseAmountInput, todayISO, toJournalNumber } from '../lib/amounts';
  import Sheet from './Sheet.svelte';
  import Icon from './Icon.svelte';
  import Autocomplete from './Autocomplete.svelte';
  import ErrorPanel from './ErrorPanel.svelte';

  interface Row {
    key: number;
    account: string;
    amount: string;
    commodity: string;
    /** Untouched parts of an existing posting, kept verbatim. */
    keep: Omit<PostingDraft, 'account' | 'amount' | 'commodity'>;
  }

  let key = 0;
  let date = $state(todayISO());
  let status = $state<Status>('');
  let description = $state('');
  let code = $state('');
  let comment = $state('');
  let rows = $state<Row[]>([]);
  let showMore = $state(false);
  let raw = $state(false);
  let rawText = $state('');
  let rawErrors = $state<EngineError[]>([]);
  let errors = $state<EngineError[]>([]);
  let saving = $state(false);
  let targetFile = $state('');
  let autofilled = $state(false);

  const isEdit = $derived(!!editor.txn);
  const accountNames = $derived(app.accounts.map((a) => a.name));
  const commodityNames = $derived(app.commodities.map((c) => c.symbol));
  const defaultCommodity = $derived.by(() => {
    const count = new Map<string, number>();
    for (const t of app.txns.slice(-300)) for (const p of t.postings) for (const a of p.amount) count.set(a.commodity, (count.get(a.commodity) ?? 0) + 1);
    return [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '$';
  });
  const styles = $derived(new Map<string, AmountStyle>(app.commodities.filter((c) => c.style).map((c) => [c.symbol, c.style!])));
  const styleOf = (c: string) => styles.get(c) ?? styleFor(c);
  const journalFiles = $derived(app.engineFiles().filter((f) => /\.(journal|hledger|ledger|j)$/i.test(f)));

  const blank = (account = '', amount = '', commodity = ''): Row => ({ key: key++, account, amount, commodity, keep: {} });

  // Initialise each time the sheet opens.
  $effect(() => {
    if (!editor.open) return;
    void editor.txn;
    void editor.initial;
    untrack(init);
  });

  function init() {
    errors = [];
    rawErrors = [];
    autofilled = false;
    targetFile = app.addTargetFile();
    raw = editor.rawMode;
    let d: TxnDraft | null = editor.initial;
    if (editor.txn && app.snapshot) {
      try {
        d = draftFromTxn(editor.txn, app.snapshot);
      } catch (e) {
        errors = [{ kind: 'internal', message: (e as Error).message }];
      }
      rawText = app.sourceText(editor.txn) ?? '';
    }
    if (d) {
      date = d.date;
      status = d.status ?? '';
      description = d.description;
      code = d.code ?? '';
      comment = d.comment ?? '';
      rows = d.postings.map((p) => {
        const { account, amount, commodity, ...keep } = p;
        return { key: key++, account, amount: amount ?? '', commodity: commodity ?? '', keep };
      });
      showMore = !!(code || comment);
      if (!editor.txn) rawText = writer.formatTxn(d, writer.inferStyle(app.files[targetFile] ?? ''));
    } else {
      date = todayISO();
      status = '';
      description = '';
      code = '';
      comment = '';
      rows = [blank(), blank()];
      showMore = false;
      rawText = '';
    }
    while (rows.length < 2) rows.push(blank());
  }

  // Autofill postings from the most recent transaction with the same payee (like `hledger add`).
  function autofill(payee: string) {
    if (isEdit || autofilled) return;
    const prev = [...app.txns].reverse().find((t) => t.description === payee || t.description.split('|')[0]!.trim() === payee);
    if (!prev) return;
    if (rows.some((r) => r.account || r.amount)) return;
    description = prev.description;
    rows = prev.postings.map((p, i) => {
      const a = p.amount[0];
      const show = a && !(p.inferred || (i === prev.postings.length - 1 && prev.postings.length === 2));
      return blank(p.account, show ? toJournalNumber(a.quantity, a.style) : '', show ? a.commodity : '');
    });
    autofilled = true;
  }

  const parsed = $derived(
    rows.map((r) => {
      const c0 = r.commodity || defaultCommodity;
      const p = parseAmountInput(r.amount, styleOf(c0).decimalMark);
      return { ...p, commodity: p.commodity ?? c0 };
    }),
  );
  const balance = $derived(
    balanceOf(parsed.map((p, i) => ({ quantity: p.quantity, commodity: p.commodity, hasCost: !!rows[i]?.keep.cost }))),
  );
  const inferred = $derived.by(() => {
    if (balance.status !== 'ok' || balance.blanks !== 1) return null;
    const [c, v] = [...balance.sums.entries()][0] ?? [defaultCommodity, null];
    if (!v) return null;
    return formatAmount({ commodity: c, quantity: v.neg().toString(), style: styleOf(c) });
  });
  const unbalancedBy = $derived.by(() => {
    if (balance.status !== 'unbalanced') return '';
    if (balance.blanks > 1) return 'Leave at most one amount blank';
    return [...balance.sums.entries()]
      .filter(([, v]) => !v.isZero())
      .map(([c, v]) => formatAmount({ commodity: c, quantity: v.toString(), style: styleOf(c) }))
      .join(', ');
  });
  const amountErrors = $derived(parsed.map((p) => p.error));
  const filledRows = $derived(rows.filter((r) => r.account.trim()));
  const canSave = $derived(
    !saving &&
      !!date &&
      description.trim() !== '' &&
      filledRows.length >= 1 &&
      (filledRows.length >= 2 || filledRows.some((r) => r.keep.type === 'virtual')) &&
      !amountErrors.some(Boolean) &&
      balance.status !== 'unbalanced',
  );

  function toDraft(): TxnDraft {
    const postings: PostingDraft[] = [];
    rows.forEach((r, i) => {
      if (!r.account.trim()) return;
      const p = parsed[i]!;
      const pd: PostingDraft = { ...r.keep, account: r.account.trim() };
      if (p.quantity != null) {
        pd.amount = toJournalNumber(p.quantity, styleOf(p.commodity));
        pd.commodity = p.commodity;
      }
      postings.push(pd);
    });
    const d: TxnDraft = { date, description: description.trim(), postings };
    if (status) d.status = status;
    if (code.trim()) d.code = code.trim();
    if (comment.trim()) d.comment = comment.trim();
    return d;
  }

  async function save() {
    saving = true;
    errors = [];
    try {
      if (raw) {
        if (editor.txn) await app.replaceTxnText(editor.txn, rawText);
        else await app.applyPatches([{ op: 'append', file: targetFile, text: rawText.replace(/\s+$/, '') }], 'add transaction');
      } else if (editor.txn) await app.editTxn(editor.txn, toDraft());
      else await app.addTxn(toDraft(), targetFile);
      toasts.show(isEdit ? 'Saved' : 'Transaction added', { tone: 'ok' });
      editor.open = false;
    } catch (e) {
      errors = e instanceof SaveError ? e.errors : [{ kind: 'internal', message: (e as Error).message }];
    } finally {
      saving = false;
    }
  }

  async function remove() {
    if (!editor.txn) return;
    saving = true;
    try {
      await app.deleteTxn(editor.txn);
      editor.open = false;
    } catch (e) {
      errors = e instanceof SaveError ? e.errors : [{ kind: 'internal', message: (e as Error).message }];
    } finally {
      saving = false;
    }
  }

  // Switching to text mode renders the current form; text is validated live by hledger.
  function toggleRaw() {
    if (!raw) {
      const style = writer.inferStyle(app.files[editor.txn?.source?.file ?? targetFile] ?? '');
      if (!editor.txn || rawText === '') rawText = writer.formatTxn(toDraft(), style);
    }
    raw = !raw;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    if (!raw || !editor.open || !app.engine || !app.vault) return;
    const text = rawText;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        const files = editor.txn
          ? writer.apply(app.files, writer.planReplaceText(app.snapshot!, editor.txn, text))
          : writer.apply(app.files, [{ op: 'append', file: targetFile, text }]);
        rawErrors = await app.engine!.check(makeSnapshot(files, app.vault!.rootFile));
      } catch (e) {
        rawErrors = [{ kind: 'internal', message: (e as Error).message }];
      }
    }, 450);
  });

  function flipSign(i: number) {
    const r = rows[i]!;
    const v = r.amount.trim();
    r.amount = v.startsWith('-') ? v.slice(1) : v ? '-' + v : '-';
  }
</script>

<Sheet bind:open={editor.open} title={isEdit ? 'Edit transaction' : 'New transaction'} wide={raw}>
  {#if errors.length}<ErrorPanel title="hledger rejected this change; nothing was saved" {errors} compact />{/if}

  <div class="mode">
    <button class="chip" type="button" aria-pressed={!raw} onclick={() => raw && toggleRaw()}>Form</button>
    <button class="chip" type="button" aria-pressed={raw} onclick={() => !raw && toggleRaw()}><Icon name="code" size={16} /> Text</button>
    {#if !isEdit && journalFiles.length > 1}
      <label class="target">
        <span class="sr-only">Save to file</span>
        <select class="input" bind:value={targetFile}>
          {#each journalFiles as f (f)}<option value={f}>{f}</option>{/each}
        </select>
      </label>
    {/if}
  </div>

  {#if raw}
    <label class="field">
      <span>Journal text</span>
      <textarea class="input" rows="10" bind:value={rawText} spellcheck="false" aria-describedby="raw-status"></textarea>
    </label>
    <p id="raw-status" class="raw-status" role="status">
      {#if rawErrors.length}<span class="neg"><Icon name="alert" size={16} /> hledger: {rawErrors[0]?.message.split('\n').slice(-3).join(' ')}</span>
      {:else}<span class="pos"><Icon name="check" size={16} /> hledger reads this</span>{/if}
    </p>
  {:else}
    <form class="form" onsubmit={(e) => { e.preventDefault(); if (canSave) void save(); }}>
      <div class="row2">
        <label class="field"><span>Date</span><input class="input" type="date" bind:value={date} required /></label>
        <fieldset class="field status">
          <legend class="label">Status</legend>
          <div class="seg" role="radiogroup" aria-label="Status">
            {#each [['', 'None'], ['!', 'Pending'], ['*', 'Cleared']] as [v, l] (v)}
              <button type="button" role="radio" aria-checked={status === v} onclick={() => (status = v as Status)}>{l}</button>
            {/each}
          </div>
        </fieldset>
      </div>

      <div class="field">
        <label class="label" for="txn-desc">Description</label>
        <Autocomplete id="txn-desc" label="Description" bind:value={description} options={app.payees} placeholder="Payee | note" onpick={autofill} />
      </div>

      {#if showMore}
        <div class="row2">
          <label class="field"><span>Code</span><input class="input" bind:value={code} placeholder="e.g. 1042" /></label>
          <label class="field"><span>Comment</span><input class="input" bind:value={comment} placeholder="tag: value, note" /></label>
        </div>
      {:else}
        <button type="button" class="link" onclick={() => (showMore = true)}>+ Code or comment</button>
      {/if}

      <div class="postings" role="group" aria-label="Postings">
        <div class="phead"><span>Account</span><span>Amount</span></div>
        {#each rows as r, i (r.key)}
          <div class="posting">
            <Autocomplete id="acct-{r.key}" label="Account {i + 1}" bind:value={r.account} options={accountNames} placeholder="expenses:food" />
            <div class="amt">
              <button type="button" class="sign" onclick={() => flipSign(i)} aria-label="Flip sign of amount {i + 1}">±</button>
              <input
                class="input num"
                inputmode="decimal"
                aria-label="Amount {i + 1}"
                aria-invalid={!!amountErrors[i]}
                bind:value={r.amount}
                placeholder={!r.amount && inferred && balance.blanks === 1 ? inferred : defaultCommodity === '$' ? '0.00' : `0.00 ${defaultCommodity}`}
              />
              <label class="sr-only" for="comm-{r.key}">Commodity {i + 1}</label>
              <input id="comm-{r.key}" class="input comm" list="pl-commodities" bind:value={r.commodity} placeholder={defaultCommodity} />
            </div>
            {#if r.keep.cost || r.keep.assertion || r.keep.comment}
              <p class="kept">
                {#if r.keep.cost}<span class="badge">{r.keep.cost}</span>{/if}
                {#if r.keep.assertion}<span class="badge">{r.keep.assertion}</span>{/if}
                {#if r.keep.comment}<span class="muted">; {r.keep.comment}</span>{/if}
              </p>
            {/if}
            {#if rows.length > 2}
              <button type="button" class="icon-btn rm" onclick={() => (rows = rows.filter((x) => x.key !== r.key))} aria-label="Remove posting {i + 1}"><Icon name="minus" size={18} /></button>
            {/if}
          </div>
        {/each}
        <datalist id="pl-commodities">{#each commodityNames as c (c)}<option value={c}></option>{/each}</datalist>
        <button type="button" class="btn small ghost" onclick={() => rows.push(blank())}><Icon name="plus" size={16} /> Add posting</button>
      </div>

      <div class="balance" role="status" aria-live="polite">
        {#if balance.status === 'unbalanced'}
          <span class="badge err">Unbalanced</span> <span class="neg">{unbalancedBy}</span>
        {:else if inferred}
          <span class="badge ok">Balanced</span> <span class="muted">blank posting gets {inferred}</span>
        {:else if balance.status === 'ok'}
          <span class="badge ok">Balanced</span>
        {:else if balance.status === 'unknown'}
          <span class="badge">Costs / several commodities</span> <span class="muted">hledger will check it on save</span>
        {:else}
          <span class="muted">Enter amounts; one may be left blank for hledger to infer.</span>
        {/if}
      </div>
      <button type="submit" hidden aria-label="Save"></button>
    </form>
  {/if}

  {#snippet footer()}
    {#if isEdit}
      <button class="btn danger" type="button" onclick={remove} disabled={saving}><Icon name="trash" size={18} /> Delete</button>
      <span style="flex:1"></span>
    {/if}
    <button class="btn" type="button" onclick={() => (editor.open = false)}>Cancel</button>
    <button class="btn primary" type="button" onclick={save} disabled={raw ? saving || rawErrors.length > 0 : !canSave}>
      {saving ? 'Saving…' : isEdit ? 'Save' : 'Add'}
    </button>
  {/snippet}
</Sheet>

<style>
  .form { display: grid; gap: 14px; }
  .mode { display: flex; gap: 8px; align-items: center; margin-bottom: 14px; flex-wrap: wrap; }
  .target { margin-left: auto; min-width: 0; }
  .target select { min-height: 34px; padding: 4px 8px; font-size: 0.85rem; max-width: 220px; }
  .row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  fieldset { border: 0; padding: 0; margin: 0; min-width: 0; }
  legend { margin-bottom: 6px; }
  .seg { display: grid; grid-template-columns: repeat(3, 1fr); border: 1px solid var(--border-strong); border-radius: var(--radius-s); overflow: hidden; min-height: var(--tap); }
  .seg button { border: 0; background: var(--surface); font-size: 0.82rem; font-weight: 560; padding: 0 4px; }
  .seg button + button { border-left: 1px solid var(--border); }
  .seg button[aria-checked='true'] { background: var(--accent-soft); color: var(--accent-strong); }
  .link { justify-self: start; background: none; border: 0; color: var(--accent); font-weight: 600; font-size: 0.88rem; padding: 2px 0; }
  .postings { display: grid; gap: 10px; }
  .phead { display: grid; grid-template-columns: 1fr 1fr; font-size: 0.8rem; font-weight: 600; color: var(--text-2); }
  .posting { display: grid; grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr) auto; gap: 8px; align-items: start; }
  .amt { display: grid; grid-template-columns: auto 1fr 64px; gap: 4px; }
  .sign { width: 36px; border: 1px solid var(--border-strong); border-radius: var(--radius-s); background: var(--surface-2); font-weight: 700; }
  .comm { padding: 10px 6px; text-align: center; }
  .rm { width: 36px; height: var(--tap); }
  .kept { grid-column: 1 / -1; display: flex; gap: 6px; flex-wrap: wrap; font-size: 0.8rem; margin-top: -4px; }
  .balance { display: flex; gap: 8px; align-items: center; font-size: 0.88rem; min-height: 28px; flex-wrap: wrap; }
  .raw-status { margin-top: 8px; font-size: 0.85rem; display: flex; }
  .raw-status span { display: inline-flex; gap: 6px; align-items: center; }
  @media (max-width: 560px) {
    .posting { grid-template-columns: 1fr auto; }
    .posting .amt { grid-column: 1 / 2; }
    .posting :global(.ac) { grid-column: 1 / 2; }
    .rm { grid-row: 1 / span 2; grid-column: 2; align-self: center; }
    .posting { padding-bottom: 10px; border-bottom: 1px dashed var(--border); }
  }
</style>
