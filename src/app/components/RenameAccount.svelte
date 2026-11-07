<script lang="ts">
  // Rename an account and its subaccounts across the vault: preview every
  // changed line, then save as one change (validated by hledger, one undo).
  import { accountNameProblem, planRenameAccount, type RenamePlan } from '$lib/journal/rename';
  import { app, SaveError } from '../state/app.svelte';
  import { toasts } from '../state/toast.svelte';
  import Sheet from './Sheet.svelte';
  import Icon from './Icon.svelte';
  import ErrorPanel from './ErrorPanel.svelte';

  let { open = $bindable(false), account }: { open?: boolean; account: string } = $props();

  let to = $state('');
  let merge = $state(false);
  let busy = $state(false);
  let errors = $state<SaveError | null>(null);
  const SHOW = 60;

  $effect(() => {
    if (open) {
      to = account;
      merge = false;
      errors = null;
    }
  });

  const target = $derived(to.trim());
  const problem = $derived(target ? accountNameProblem(target) : 'Enter the new name');
  const under = (name: string, a: string) => name === a || name.startsWith(a + ':');
  /** Accounts that already exist under the new name (other than the ones being renamed). */
  const clash = $derived(problem || target === account ? [] : app.accounts.filter((a) => under(a.name, target) && !under(a.name, account)).map((a) => a.name));
  const subs = $derived(app.accounts.filter((a) => a.name.startsWith(account + ':')).length);
  const plan = $derived.by((): RenamePlan | null => {
    if (problem || target === account) return null;
    try {
      return planRenameAccount(app.files, account, target);
    } catch {
      return null;
    }
  });
  const fileCount = $derived(plan ? new Set(plan.changes.map((c) => c.file)).size : 0);
  const canApply = $derived(!!plan && plan.changes.length > 0 && (!clash.length || merge) && !busy && !app.readOnly);
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

  async function applyRename() {
    if (!plan) return;
    busy = true;
    errors = null;
    try {
      await app.commitFiles(plan.files, `rename ${account} to ${target}`);
      toasts.show(`Renamed ${account} to ${target} (${plural(plan.changes.length, 'line')})`, { tone: 'ok', action: { label: 'Undo', run: () => void app.undo() } });
      open = false;
    } catch (e) {
      errors = e instanceof SaveError ? e : new SaveError([{ kind: 'internal', message: (e as Error).message }]);
    } finally {
      busy = false;
    }
  }
</script>

<Sheet bind:open title="Rename account" wide>
  <div class="form">
    <p class="muted">Renames <code>{account}</code>{#if subs} and its {plural(subs, 'subaccount')}{/if} in every journal file: postings, <code>account</code> directives, budget and forecast (<code>~</code>) rules, auto-posting (<code>=</code>) rules, aliases and CSV rules. Descriptions and comments are left as written.</p>
    <label class="field">
      <span>New name</span>
      <input class="input mono" type="text" bind:value={to} autocomplete="off" autocapitalize="off" spellcheck="false" aria-invalid={!!problem && target !== ''} aria-describedby="rename-hint" />
    </label>
    <p id="rename-hint" class="hint" aria-live="polite">
      {#if target && problem}<span class="neg">{problem}</span>
      {:else if target === account}<span class="muted">Type the new name.</span>
      {:else if plan}<span><strong>{plural(plan.changes.length, 'line')}</strong> in {plural(fileCount, 'file')} will change.</span>{/if}
    </p>
    {#if clash.length}
      <div class="warn" role="alert">
        <p><Icon name="alert" size={16} /> <strong>{target}</strong> already exists{clash.length > 1 || clash[0] !== target ? ` (${clash.slice(0, 3).join(', ')}${clash.length > 3 ? '…' : ''})` : ''}. Renaming merges the two: their postings and balances are combined.</p>
        <label class="check"><input type="checkbox" bind:checked={merge} /> Merge into the existing account</label>
      </div>
    {/if}
    {#if plan && plan.changes.length}
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <ul class="changes" aria-label="Lines that will change" tabindex="0">
        {#each plan.changes.slice(0, SHOW) as c (c.file + c.line)}
          <li>
            <span class="loc mono">{c.file}:{c.line}</span>
            <del class="mono">{c.before}</del>
            <ins class="mono">{c.after}</ins>
          </li>
        {/each}
      </ul>
      {#if plan.changes.length > SHOW}<p class="muted more">…and {plan.changes.length - SHOW} more.</p>{/if}
    {/if}
    {#if errors}<ErrorPanel title="hledger rejected the rename; nothing was saved" errors={errors.errors} />{/if}
  </div>
  {#snippet footer()}
    <button class="btn ghost" type="button" onclick={() => (open = false)}>Cancel</button>
    <button class="btn primary" type="button" disabled={!canApply} onclick={applyRename}>
      {busy ? 'Renaming…' : plan ? `Rename (${plural(plan.changes.length, 'line')})` : 'Rename'}
    </button>
  {/snippet}
</Sheet>

<style>
  .form { display: grid; gap: 12px; }
  .form > p.muted { font-size: 0.88rem; }
  code { font-family: var(--mono); font-size: 0.85em; }
  .hint { font-size: 0.88rem; min-height: 1.3em; }
  .warn { background: var(--warn-soft); color: var(--warn); border-radius: var(--radius-s); padding: 10px 12px; display: grid; gap: 8px; font-size: 0.88rem; }
  .warn p { display: flex; gap: 6px; align-items: baseline; flex-wrap: wrap; }
  .check { display: flex; gap: 8px; align-items: center; color: var(--text); }
  .changes { list-style: none; margin: 0; padding: 0; border: 1px solid var(--border); border-radius: var(--radius-s); max-height: 40vh; overflow: auto; }
  .changes li { display: grid; gap: 2px; padding: 8px 10px; font-size: 0.8rem; min-width: 0; }
  .changes li + li { border-top: 1px solid var(--border); }
  .loc { color: var(--text-3); font-size: 0.75rem; }
  del, ins { white-space: pre-wrap; overflow-wrap: anywhere; text-decoration: none; padding: 1px 4px; border-radius: 4px; }
  del { background: var(--neg-soft); color: var(--neg); }
  ins { background: var(--pos-soft); color: var(--pos); }
  del::before { content: '− '; }
  ins::before { content: '+ '; }
  .more { font-size: 0.82rem; }
</style>
