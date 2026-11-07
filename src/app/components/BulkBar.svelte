<script lang="ts">
  // Sticky action bar for Transactions → Select: change an account, set the
  // status or delete the picked transactions, saved as one change (one undo).
  import type { Status, Txn } from '$lib/contracts/engine';
  import { accountsUsed, planBulk, type BulkAction } from '$lib/journal/bulk';
  import { accountNameProblem } from '$lib/journal/rename';
  import { app, SaveError } from '../state/app.svelte';
  import { toasts } from '../state/toast.svelte';
  import { pickable, type TxnSelection } from '../state/selection.svelte';
  import Sheet from './Sheet.svelte';
  import Icon from './Icon.svelte';
  import Autocomplete from './Autocomplete.svelte';
  import ErrorPanel from './ErrorPanel.svelte';

  let { sel, shown, hidden = 0 }: { sel: TxnSelection; shown: Txn[]; hidden?: number } = $props();

  type Mode = 'account' | 'status' | 'delete';
  let mode = $state<Mode | null>(null);
  let open = $state(false);
  let busy = $state(false);
  let errors = $state<SaveError | null>(null);
  let from = $state('');
  let to = $state('');

  const TITLES: Record<Mode, string> = { account: 'Change account', status: 'Set status', delete: 'Delete transactions' };
  const picked = $derived(sel.list().map((p) => p.txn));
  const used = $derived(accountsUsed(picked));
  const usingFrom = $derived(picked.filter((t) => t.postings.some((p) => p.account === from && !p.generated)).length);
  const allAccounts = $derived(app.accounts.map((a) => a.name));
  const toProblem = $derived(to.trim() ? accountNameProblem(to.trim()) : null);
  const pickableShown = $derived(shown.filter(pickable));
  const allShownPicked = $derived(pickableShown.length > 0 && pickableShown.every((t) => sel.has(t)));
  const n = (k: number) => `${k} transaction${k === 1 ? '' : 's'}`;

  function show(m: Mode) {
    mode = m;
    errors = null;
    if (m === 'account') {
      if (!used.includes(from)) from = used.find((a) => !/^(assets|liabilities|equity)/.test(a)) ?? used[0] ?? '';
      to = '';
    }
    open = true;
  }

  async function run(action: BulkAction, label: string, done: (k: number) => string) {
    if (!app.vault) return;
    busy = true;
    errors = null;
    try {
      // Re-find every pick in the current files; skip any that changed meanwhile.
      const txns: Txn[] = [];
      let stale = 0;
      for (const p of sel.list()) {
        const t = app.relocate(p.txn, p.text);
        if (t) txns.push(t);
        else stale++;
      }
      if (!txns.length) throw new Error('The selected transactions were changed elsewhere (a sync or another tab). Select them again.');
      const plan = planBulk(app.files, app.vault.rootFile, txns, action);
      if (plan.changed === 0) {
        toasts.show('Nothing to change: the selection is already like that.');
        open = false;
        return;
      }
      await app.commitFiles(plan.files, label);
      const skipped = stale ? ` · ${stale} changed elsewhere and skipped` : '';
      toasts.show(done(plan.changed) + skipped, { tone: 'ok', action: { label: 'Undo', run: () => void app.undo() } });
      sel.clear();
      open = false;
    } catch (e) {
      errors = e instanceof SaveError ? e : new SaveError([{ kind: 'internal', message: (e as Error).message }]);
    } finally {
      busy = false;
    }
  }

  const changeAccount = () =>
    run({ kind: 'account', from, to: to.trim() }, `change ${from} to ${to.trim()} in ${n(usingFrom)}`, (k) => `Changed ${from} to ${to.trim()} in ${n(k)}`);
  const STATUS: { status: Status; label: string; verb: string }[] = [
    { status: '*', label: 'Cleared', verb: 'cleared' },
    { status: '!', label: 'Pending', verb: 'pending' },
    { status: '', label: 'Unmarked', verb: 'unmarked' },
  ];
  const setStatus = (s: (typeof STATUS)[number]) => run({ kind: 'status', status: s.status }, `mark ${n(sel.size)} ${s.verb}`, (k) => `Marked ${n(k)} ${s.verb}`);
  const remove = () => run({ kind: 'delete' }, `delete ${n(sel.size)}`, (k) => `Deleted ${n(k)}`);
</script>

<div class="bulk card" role="region" aria-label="Selected transactions">
  <p class="count" aria-live="polite">
    <strong>{sel.size} selected</strong>{#if hidden > 0}<span class="muted"> · {hidden} not shown by the filters</span>{/if}
  </p>
  <div class="acts">
    {#if pickableShown.length}
      <button class="btn small ghost" type="button" onclick={() => (allShownPicked ? sel.clear() : sel.addAll(pickableShown))}>
        {allShownPicked ? 'Select none' : `Select all ${pickableShown.length}`}
      </button>
    {/if}
    <button class="btn small" type="button" disabled={!sel.size || app.readOnly} onclick={() => show('account')}><Icon name="tag" size={16} />Account</button>
    <button class="btn small" type="button" disabled={!sel.size || app.readOnly} onclick={() => show('status')}><Icon name="check-circle" size={16} />Status</button>
    <button class="btn small danger" type="button" disabled={!sel.size || app.readOnly} onclick={() => show('delete')}><Icon name="trash" size={16} />Delete</button>
    <button class="btn small ghost" type="button" onclick={() => { sel.clear(); sel.active = false; }}>Done</button>
  </div>
</div>

<Sheet bind:open title={mode ? TITLES[mode] : ''} onclose={() => (mode = null)}>
  {#if mode === 'account'}
    <div class="form">
      <label class="field">
        <span>Replace</span>
        <select class="input" bind:value={from}>
          {#each used as a (a)}<option value={a}>{a}</option>{/each}
        </select>
      </label>
      <div class="field">
        <label class="label" for="bulk-to">With</label>
        <Autocomplete id="bulk-to" label="With" bind:value={to} options={allAccounts.filter((a) => a !== from)} placeholder="expenses:groceries" invalid={!!toProblem} />
        {#if toProblem}<small class="neg">{toProblem}</small>
        {:else if to.trim() && !allAccounts.includes(to.trim())}<small class="muted">A new account: hledger creates it when it is first used.</small>{/if}
      </div>
      <p class="muted">Postings to exactly <code>{from}</code> (not its subaccounts) in {n(usingFrom)} of the {n(sel.size)} selected. Amounts and everything else stay as written.</p>
    </div>
  {:else if mode === 'status'}
    <p class="muted">Set the status mark on the {n(sel.size)} selected (the transaction line, not individual postings).</p>
    <div class="stat">
      {#each STATUS as s (s.status)}
        <button class="btn" type="button" disabled={busy} onclick={() => setStatus(s)}>{s.status ? `${s.status} ` : ''}{s.label}</button>
      {/each}
    </div>
  {:else if mode === 'delete'}
    <p>Delete {n(sel.size)} from your journal? You can undo this right after.</p>
  {/if}
  {#if errors}<ErrorPanel title="hledger rejected the change; nothing was saved" errors={errors.errors} />{/if}
  {#snippet footer()}
    <button class="btn ghost" type="button" onclick={() => (open = false)}>Cancel</button>
    {#if mode === 'account'}
      <button class="btn primary" type="button" disabled={busy || !to.trim() || !!toProblem || to.trim() === from || usingFrom === 0} onclick={changeAccount}>Change in {n(usingFrom)}</button>
    {:else if mode === 'delete'}
      <button class="btn danger" type="button" disabled={busy} onclick={remove}><Icon name="trash" size={16} />Delete {n(sel.size)}</button>
    {/if}
  {/snippet}
</Sheet>

<style>
  .bulk {
    position: sticky; z-index: 5; bottom: calc(var(--nav-h) + var(--safe-b) + 88px);
    margin-top: 12px; padding: 10px 12px; display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; justify-content: space-between;
    box-shadow: var(--shadow-2); border-color: var(--accent);
  }
  .count { font-size: 0.9rem; }
  .acts { display: flex; flex-wrap: wrap; gap: 6px; }
  .form { display: grid; gap: 12px; }
  .stat { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
  code { font-family: var(--mono); font-size: 0.85em; }
  small { font-size: 0.8rem; }
  p.muted { font-size: 0.88rem; }
  @media (min-width: 960px) { .bulk { bottom: 16px; } }
</style>
