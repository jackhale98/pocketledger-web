<script lang="ts">
  // Year-end close, guided. The entries are hledger's own (`hledger close`,
  // which only prints them); the app appends them verbatim with the writer's
  // append rules and saves through the normal pipeline (hledger validates,
  // one undo step). See src/lib/journal/close.ts.
  import type { Txn } from '$lib/contracts/engine';
  import {
    closeArgs,
    isIncluded,
    nextYearPath,
    parseCloseOutput,
    planClose,
    planInclude,
    priorCloseEntries,
    PRIOR_CLOSE_QUERIES,
    type CloseEntry,
    type CloseMode,
    type ClosePlacement,
    type IncludePlan,
  } from '$lib/journal/close';
  import { isJournalFile } from '$lib/vault';
  import { app, SaveError } from '../state/app.svelte';
  import { toasts } from '../state/toast.svelte';
  import { href } from '../state/router.svelte';
  import Icon from '../components/Icon.svelte';
  import ErrorPanel from '../components/ErrorPanel.svelte';

  const thisYear = new Date().getFullYear();
  const firstYear = $derived(app.stats?.firstDate ? Number(app.stats.firstDate.slice(0, 4)) : null);
  const lastYear = $derived(app.stats?.lastDate ? Number(app.stats.lastDate.slice(0, 4)) : null);
  const years = $derived.by(() => {
    if (firstYear == null || lastYear == null) return [];
    const out: number[] = [];
    for (let y = lastYear; y >= firstYear; y--) out.push(y);
    return out;
  });
  /** The last full year with transactions; else the latest year up to this one. */
  const defaultYear = $derived(years.find((y) => y < thisYear) ?? years.find((y) => y <= thisYear) ?? years[0] ?? thisYear - 1);
  let chosenYear = $state<number | null>(null);
  const year = $derived(chosenYear ?? defaultYear);

  let mode = $state<CloseMode>('migrate');
  let showCosts = $state(false);
  let openingWhere = $state<'next' | 'same' | null>(null);
  let chosenFile = $state('');
  let again = $state(false);

  let loading = $state(false);
  let runError = $state('');
  let entries = $state.raw<CloseEntry[]>([]);
  let prior = $state.raw<Txn[]>([]);
  let yearTxns = $state.raw<Txn[]>([]);
  let busy = $state(false);
  let errors = $state<SaveError | null>(null);

  const args = $derived(closeArgs(mode, year, { showCosts }));
  const root = $derived(app.vault?.rootFile ?? 'main.journal');
  const journals = $derived(Object.keys(app.files).filter(isJournalFile).sort());

  let seq = 0;
  $effect(() => {
    const rev = app.revision;
    const a = args;
    const y = year;
    const m = mode;
    if (!rev || !app.engine) return;
    const engine = app.engine;
    const token = ++seq;
    loading = true;
    runError = '';
    (async () => {
      try {
        const period = { begin: `${y}-01-01`, end: `${y + 1}-01-02` };
        const out = await engine.raw(a);
        const found: Txn[] = [];
        for (const query of PRIOR_CLOSE_QUERIES) found.push(...(await engine.transactions({ query, period })));
        const inYear = await engine.transactions({ period: { begin: `${y}-01-01`, end: `${y + 1}-01-01` } });
        if (token !== seq) return;
        if (out.code !== 0) {
          runError = out.stderr.trim() || `hledger close exited with ${out.code}`;
          entries = [];
        } else entries = parseCloseOutput(out.stdout);
        prior = priorCloseEntries(found, m, y);
        yearTxns = inYear;
        again = false;
      } catch (e) {
        if (token === seq) runError = (e as Error).message;
      } finally {
        if (token === seq) loading = false;
      }
    })();
  });

  /** The file holding most of the year's transactions (a year-named file wins ties). */
  const yearFile = $derived.by(() => {
    const counts = new Map<string, number>();
    for (const t of yearTxns) if (t.source && !t.generated) counts.set(t.source.file, (counts.get(t.source.file) ?? 0) + 1);
    const named = app.targetFor(`${year}-12-31`);
    let best: [string, number] | null = null;
    for (const [f, c] of counts) if (!best || c > best[1] || (c === best[1] && f === named)) best = [f, c];
    return best?.[0] ?? named;
  });
  const closingFile = $derived(chosenFile && app.files[chosenFile] != null ? chosenFile : yearFile);
  const nextFile = $derived.by(() => {
    const byName = app.targetFor(`${year + 1}-01-01`);
    if (byName !== app.addTargetFile() && byName !== closingFile) return byName;
    return nextYearPath(closingFile, year, root);
  });
  const nextExists = $derived(app.files[nextFile] != null);
  const multiFile = $derived(journals.length > 1 || /^include\s/m.test(app.files[root] ?? ''));
  const where = $derived(openingWhere ?? (nextExists || multiFile ? 'next' : 'same'));
  const openingFile = $derived(mode === 'migrate' && where === 'next' ? nextFile : closingFile);
  const include = $derived<IncludePlan | null>(mode === 'migrate' && where === 'next' && !isIncluded(app.files, root, openingFile) ? planInclude(app.files, root, closingFile, openingFile, year) : null);

  const closing = $derived(entries.find((e) => e.date === `${year}-12-31`) ?? (mode === 'retain' ? entries[0] : undefined));
  const opening = $derived(mode === 'migrate' ? entries.find((e) => e.date === `${year + 1}-01-01`) : undefined);
  const placements = $derived.by((): ClosePlacement[] => {
    const out: ClosePlacement[] = [];
    if (closing) out.push({ file: closingFile, entry: closing });
    if (opening) out.push({ file: openingFile, entry: opening });
    return out;
  });
  const nothing = $derived(!loading && !runError && entries.length > 0 && entries.every((e) => !e.hasAmounts));
  const yearNotOver = $derived(year >= thisYear);
  const canApply = $derived(
    !loading && !busy && !runError && !nothing && !app.readOnly && placements.length === (mode === 'migrate' ? 2 : 1) && (prior.length === 0 || again),
  );

  async function applyClose() {
    if (!app.vault) return;
    busy = true;
    errors = null;
    try {
      const plan = planClose(app.files, app.vault.rootFile, placements, include);
      const label = mode === 'migrate' ? `close ${year} (migrate balances)` : `close ${year} (retain earnings)`;
      chosenYear = year; // the new entries may extend the journal into the next year: stay on this one
      await app.commitFiles(plan.files, label);
      const made = plan.created.length ? ` · created ${plan.created.join(', ')}` : '';
      toasts.show(`Closed ${year}${made}`, { tone: 'ok', action: { label: 'Undo', run: () => void app.undo() } });
    } catch (e) {
      errors = e instanceof SaveError ? e : new SaveError([{ kind: 'internal', message: (e as Error).message }]);
    } finally {
      busy = false;
    }
  }
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
</script>

<section class="card card-pad intro">
  <h2><Icon name="calendar" size={18} /> Close a year</h2>
  <p>
    Closing ends a year's books with entries made by hledger's own <code>close</code> command. They are added to your journal exactly as hledger
    prints them, after hledger checks the result. Nothing else in your files changes, and you can undo it right after.
  </p>
</section>

<section class="card card-pad setup" aria-label="Close options">
  <label class="field">
    <span>Year</span>
    <select class="input" value={year} onchange={(e) => (chosenYear = Number((e.currentTarget as HTMLSelectElement).value))}>
      {#each years.length ? years : [year] as y (y)}<option value={y}>{y}{y >= thisYear ? ' (not over yet)' : ''}</option>{/each}
    </select>
  </label>
  <fieldset class="modes">
    <legend class="label">What to do</legend>
    <label class="mode" class:on={mode === 'migrate'}>
      <input type="radio" name="close-mode" value="migrate" bind:group={mode} />
      <span><strong>Migrate balances to a new year</strong>
        <small>A <em>closing balances</em> entry on {year}-12-31 moves every asset and liability balance to <code>equity:opening/closing balances</code>, with assertions that they are now zero; an <em>opening balances</em> entry on {year + 1}-01-01 brings them back. Each year can then live in its own file. Revenues and expenses are not touched.</small></span>
    </label>
    <label class="mode" class:on={mode === 'retain'}>
      <input type="radio" name="close-mode" value="retain" bind:group={mode} />
      <span><strong>Retain earnings</strong>
        <small>A <em>retain earnings</em> entry on {year}-12-31 moves the revenue and expense balances to <code>equity:retained earnings</code>, so the next year's income statement starts from zero and the profit shows in equity.</small></span>
    </label>
  </fieldset>
  <label class="check"><input type="checkbox" bind:checked={showCosts} /> Keep the cost of each lot (<code>--show-costs</code>), e.g. for investments bought at different prices</label>
  <div class="where">
    <label class="field">
      <span>{mode === 'migrate' ? 'Closing entry goes at the end of' : 'Entry goes at the end of'}</span>
      <select class="input" value={closingFile} onchange={(e) => (chosenFile = (e.currentTarget as HTMLSelectElement).value)}>
        {#each journals as f (f)}<option value={f}>{f}</option>{/each}
      </select>
    </label>
    {#if mode === 'migrate'}
      <fieldset class="field">
        <legend class="label">Opening entry goes</legend>
        <label class="check"><input type="radio" name="open-where" value="next" checked={where === 'next'} onchange={() => (openingWhere = 'next')} />
          {nextExists ? `at the end of ${nextFile}` : `in a new file, ${nextFile}`}</label>
        <label class="check"><input type="radio" name="open-where" value="same" checked={where === 'same'} onchange={() => (openingWhere = 'same')} /> after the closing entry, in {closingFile}</label>
      </fieldset>
    {/if}
  </div>
  <p class="cmd muted">hledger command: <code>hledger {args.join(' ')}</code>{#if yearTxns.length} · {plural(yearTxns.length, 'transaction')} in {year}{/if}</p>
</section>

{#if yearNotOver}
  <p class="note warn" role="note"><Icon name="alert" size={16} /> {year} is not over yet. Transactions you add later in {year} would contradict the closing entry's balance assertions, and hledger will refuse to save them until you undo or redo the close.</p>
{/if}
{#if prior.length}
  <div class="note warn" role="alert">
    <p><Icon name="alert" size={16} /> {year} looks closed already:</p>
    <ul>
      {#each prior as t (t.index)}<li><code>{t.date} {t.description}</code>{#if t.source} in {t.source.file}:{t.source.startLine}{/if}</li>{/each}
    </ul>
    <p>Closing it again adds another set of entries. {nothing ? 'hledger has nothing left to move.' : ''}</p>
    <label class="check"><input type="checkbox" bind:checked={again} /> Close {year} again anyway</label>
  </div>
{/if}

<section class="card preview" aria-label="Preview" aria-busy={loading}>
  <h2 class="card-pad">Preview</h2>
  {#if runError}
    <ErrorPanel title="hledger close failed" errors={[{ kind: 'internal', message: runError }]} />
  {:else if loading && !entries.length}
    <p class="card-pad muted">Asking hledger…</p>
  {:else if nothing}
    <p class="card-pad muted">Nothing to close: every balance hledger would move is already zero.</p>
  {:else}
    <ol class="steps">
      {#if include}
        <li>
          <p class="what"><Icon name="plus" size={16} /> Add a line to <a href="{href('files', include.file)}?line={include.beforeLine}">{include.file}</a> (line {include.beforeLine}) so hledger reads the new file:</p>
          <pre class="src">{include.text.trim()}</pre>
        </li>
      {/if}
      {#each placements as p, i (i)}
        <li>
          <p class="what">
            <Icon name="file" size={16} />
            {#if app.files[p.file] == null && !placements.slice(0, i).some((q) => q.file === p.file)}Create <strong>{p.file}</strong> with:{:else}Append to the end of <a href="{href('files', p.file)}">{p.file}</a>:{/if}
          </p>
          <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
          <pre class="src" tabindex="0" aria-label="{p.entry.description} entry">{p.entry.text}</pre>
        </li>
      {/each}
    </ol>
  {/if}
</section>

{#if errors}<ErrorPanel title="hledger rejected the closing entries; nothing was saved" errors={errors.errors} />{/if}
<div class="finish">
  <p class="muted">Reports that span both years will show these entries; add <code>not:tag:clopen</code> to a query to leave them out.</p>
  <button class="btn primary" type="button" disabled={!canApply} onclick={applyClose}>
    <Icon name="check-circle" size={18} /> {busy ? 'Closing…' : `Close ${year}`}
  </button>
</div>

<style>
  .intro, .setup, .preview { margin-bottom: 12px; }
  h2 { font-size: 1rem; display: flex; gap: 8px; align-items: center; }
  .intro p { margin-top: 6px; font-size: 0.9rem; color: var(--text-2); }
  code { font-family: var(--mono); font-size: 0.85em; overflow-wrap: anywhere; }
  .setup { display: grid; gap: 14px; }
  fieldset { border: 0; margin: 0; padding: 0; min-width: 0; }
  .modes { display: grid; gap: 8px; }
  .mode { display: flex; gap: 10px; align-items: flex-start; padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--radius-s); cursor: pointer; }
  .mode.on { border-color: var(--accent); background: var(--accent-soft); }
  .mode span { display: grid; gap: 4px; min-width: 0; }
  .mode small { color: var(--text-2); font-size: 0.83rem; }
  .mode input, .check input { accent-color: var(--accent); margin-top: 3px; flex: none; }
  .check { display: flex; gap: 8px; align-items: flex-start; font-size: 0.88rem; min-width: 0; overflow-wrap: anywhere; }
  .where { display: grid; gap: 12px; }
  @media (min-width: 760px) { .where { grid-template-columns: 1fr 1fr; } }
  .where fieldset { display: grid; gap: 6px; }
  .cmd { font-size: 0.82rem; }
  .note { display: grid; gap: 6px; padding: 10px 14px; margin: 0 0 12px; border-radius: var(--radius); font-size: 0.88rem; }
  .note.warn { background: var(--warn-soft); color: var(--warn); }
  .note ul { margin: 0; padding-left: 20px; }
  .note p { display: flex; gap: 6px; align-items: baseline; flex-wrap: wrap; }
  .preview h2 { padding-bottom: 0; }
  .steps { list-style: none; margin: 0; padding: 0 16px 16px; display: grid; gap: 12px; }
  .steps > li { min-width: 0; }
  .what { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; font-size: 0.88rem; margin: 8px 0 6px; overflow-wrap: anywhere; }
  pre.src { margin: 0; padding: 10px 12px; max-width: 100%; overflow-x: auto; background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-s); font-family: var(--mono); font-size: 0.78rem; line-height: 1.45; }
  .finish { display: flex; gap: 12px; flex-wrap: wrap; justify-content: space-between; align-items: center; margin-top: 12px; }
  .finish p { font-size: 0.82rem; flex: 1 1 240px; }
</style>
