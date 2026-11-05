<script lang="ts">
  // CSV import: hledger converts the CSV with your .rules file; PocketLedger previews,
  // flags likely duplicates, then appends the chosen transactions through the writer.
  import type { CsvPreview, Txn } from '$lib/contracts/engine';
  import type { TxnDraft } from '$lib/contracts/writer';
  import { writer } from '$lib/journal/writer';
  import { makeSnapshot } from '$lib/vault';
  import { app, SaveError } from '../state/app.svelte';
  import { toasts } from '../state/toast.svelte';
  import { toJournalNumber } from '../lib/amounts';
  import Money from '../components/Money.svelte';
  import Icon from '../components/Icon.svelte';
  import ErrorPanel from '../components/ErrorPanel.svelte';

  const RULES_TEMPLATE = `# hledger CSV rules: https://hledger.org/hledger.html#csv
skip 1
fields date, description, amount
date-format %Y-%m-%d
currency $
account1 assets:checking

# Categorise by description:
if GROCER|MARKET
  account2 expenses:groceries
`;

  let csvPath = $state('');
  let uploaded = $state<{ name: string; text: string } | null>(null);
  let rulesPath = $state('');
  let rulesText = $state('');
  let rulesDirty = $state(false);
  let preview = $state.raw<CsvPreview | null>(null);
  let existing = $state.raw<Txn[]>([]);
  let busy = $state(false);
  let selected = $state<Set<number>>(new Set());
  let targetFile = $state(app.addTargetFile());
  let saveRules = $state(true);
  let error = $state<SaveError | null>(null);

  const csvFiles = $derived(Object.keys(app.files).filter((f) => f.toLowerCase().endsWith('.csv')));
  const rulesFiles = $derived(Object.keys(app.files).filter((f) => f.toLowerCase().endsWith('.rules')));
  const journalFiles = $derived(app.engineFiles().filter((f) => /\.(journal|hledger|ledger|j)$/i.test(f)));
  const csvName = $derived(uploaded ? `import/${uploaded.name}` : csvPath);

  // Pick rules: `<csv>.rules` next to the CSV, else the only rules file, else a template.
  $effect(() => {
    const c = csvName;
    if (!c || rulesDirty) return;
    const guess = [`${c}.rules`, c.replace(/[^/]*$/, '') + `${c.split('/').pop()!.replace(/\.csv$/i, '')}.rules`].find((g) => app.files[g] != null) ?? (rulesFiles.length === 1 ? rulesFiles[0] : '');
    rulesPath = guess ?? '';
    rulesText = guess ? app.files[guess]! : RULES_TEMPLATE;
  });

  async function onFile(e: Event) {
    const f = (e.currentTarget as HTMLInputElement).files?.[0];
    if (!f) return;
    uploaded = { name: f.name.replace(/[^\w.\- ]/g, '_'), text: await f.text() };
    csvPath = '';
    rulesDirty = false;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    const c = csvName;
    const rules = rulesText;
    const csvText = uploaded?.text ?? (c ? app.files[c] : undefined);
    if (!c || csvText == null || !app.engine || !app.revision) return;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      busy = true;
      const rp = rulesPath || `${c}.rules`;
      const p = await app.engine!.csvPreview(c, rp, { [c]: csvText, [rp]: rules });
      // Existing transactions in the CSV's date range (hledger query; the loaded window may not reach back that far).
      const dates = p.txns.map((t) => t.date).sort();
      existing = [];
      if (dates.length) {
        const end = new Date(dates[dates.length - 1]! + 'T00:00:00Z');
        end.setUTCDate(end.getUTCDate() + 1);
        existing = await app.engine!.transactions({ period: { begin: dates[0]!, end: end.toISOString().slice(0, 10) } }).catch(() => []);
      }
      preview = p;
      selected = new Set(p.txns.map((t, i) => (isDuplicate(t) ? -1 : i)).filter((i) => i >= 0));
      busy = false;
    }, 350);
  });

  /** Same date, same set of amounts, and an overlapping account: probably already imported. */
  function isDuplicate(t: Txn): boolean {
    const sig = (x: Txn) => x.postings.flatMap((p) => p.amount.map((a) => `${a.commodity}${Number(a.quantity)}`)).sort().join('|');
    const s = sig(t);
    const accts = new Set(t.postings.map((p) => p.account));
    return existing.some((x) => x.date === t.date && sig(x) === s && x.postings.some((p) => accts.has(p.account)));
  }
  const dupes = $derived(new Set(preview?.txns.map((t, i) => (isDuplicate(t) ? i : -1)).filter((i) => i >= 0) ?? []));

  function toDraft(t: Txn): TxnDraft {
    const d: TxnDraft = {
      date: t.date,
      description: t.description,
      postings: t.postings.map((p) => {
        const a = p.amount[0];
        return a ? { account: p.account, amount: toJournalNumber(a.quantity, a.style), commodity: a.commodity } : { account: p.account };
      }),
    };
    if (t.status) d.status = t.status;
    if (t.code) d.code = t.code;
    if (t.comment.trim()) d.comment = t.comment.trim();
    return d;
  }

  async function doImport() {
    if (!preview || !app.vault) return;
    error = null;
    busy = true;
    try {
      let files = { ...app.files };
      const chosen = preview.txns.filter((_, i) => selected.has(i));
      for (const t of chosen) {
        const snap = makeSnapshot(files, app.vault.rootFile);
        files = writer.apply(files, writer.planAdd(snap, toDraft(t), { targetFile }));
      }
      if (saveRules && rulesText.trim()) files[rulesPath || `${csvName}.rules`] = rulesText;
      await app.commitFiles(files, `import ${chosen.length} from ${csvName.split('/').pop()}`);
      toasts.show(`Imported ${chosen.length} transaction${chosen.length === 1 ? '' : 's'}`, { tone: 'ok', action: { label: 'Undo', run: () => void app.undo() } });
      preview = null;
      uploaded = null;
      csvPath = '';
    } catch (e) {
      error = e instanceof SaveError ? e : new SaveError([{ kind: 'internal', message: (e as Error).message }]);
    } finally {
      busy = false;
    }
  }
  function toggle(i: number) {
    const s = new Set(selected);
    if (s.has(i)) s.delete(i);
    else s.add(i);
    selected = s;
  }
</script>

<section class="card card-pad step">
  <h2><span class="n">1</span> Choose a CSV</h2>
  <div class="pick">
    <label class="btn"><Icon name="upload" size={18} /> Upload CSV<input class="sr-only" type="file" accept=".csv,text/csv" onchange={onFile} /></label>
    {#if csvFiles.length}
      <span class="muted">or from this vault</span>
      <label class="sr-only" for="csv-pick">CSV in vault</label>
      <select id="csv-pick" class="input" bind:value={csvPath} onchange={() => { uploaded = null; rulesDirty = false; }}>
        <option value="">—</option>
        {#each csvFiles as f (f)}<option value={f}>{f}</option>{/each}
      </select>
    {/if}
  </div>
  {#if uploaded}<p class="muted small">Using <strong>{uploaded.name}</strong> ({uploaded.text.split('\n').length - 1} lines). It is not stored.</p>{/if}
</section>

{#if csvName}
  <section class="card card-pad step">
    <h2><span class="n">2</span> Rules</h2>
    <div class="pick">
      <label class="sr-only" for="rules-pick">Rules file</label>
      <select id="rules-pick" class="input" bind:value={rulesPath} onchange={() => { rulesText = app.files[rulesPath] ?? RULES_TEMPLATE; rulesDirty = true; }}>
        <option value="">New rules file ({csvName}.rules)</option>
        {#each rulesFiles as f (f)}<option value={f}>{f}</option>{/each}
      </select>
    </div>
    <label class="sr-only" for="rules-text">Rules</label>
    <textarea id="rules-text" class="input" rows="9" bind:value={rulesText} oninput={() => (rulesDirty = true)} spellcheck="false"></textarea>
    <label class="check"><input type="checkbox" bind:checked={saveRules} /> Save these rules in the vault</label>
  </section>

  <section class="card step">
    <h2 class="card-pad"><span class="n">3</span> Preview {#if busy}<span class="muted small">hledger is converting…</span>{/if}</h2>
    {#if preview?.errors.length}
      <div class="card-pad"><ErrorPanel title="hledger couldn't convert this CSV with these rules" errors={preview.errors} compact /></div>
    {:else if preview}
      <div class="card-pad sel">
        <p class="muted small">{preview.txns.length} transactions · {dupes.size} look already imported · {selected.size} selected</p>
        <button class="btn small ghost" type="button" onclick={() => (selected = new Set(preview!.txns.map((_, i) => i)))}>Select all</button>
        <button class="btn small ghost" type="button" onclick={() => (selected = new Set())}>None</button>
      </div>
      <ul class="rows">
        {#each preview.txns as t, i (i)}
          <li class:dupe={dupes.has(i)}>
            <label>
              <input type="checkbox" checked={selected.has(i)} onchange={() => toggle(i)} />
              <span class="d num">{t.date}</span>
              <span class="desc">{t.description}<small>{t.postings.map((p) => p.account).join(' → ')}</small></span>
              {#if dupes.has(i)}<span class="badge warn">Duplicate?</span>{/if}
              {#if t.postings.some((p) => /unknown/.test(p.account))}<span class="badge">Uncategorised</span>{/if}
              <span class="amt"><Money value={t.postings[0]?.amount ?? []} color /></span>
            </label>
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  {#if preview && !preview.errors.length}
    <section class="card card-pad step">
      <h2><span class="n">4</span> Import</h2>
      {#if error}<ErrorPanel title="hledger rejected the import; nothing was saved" errors={error.errors} compact />{/if}
      <div class="pick">
        <label class="field grow"><span>Append to</span>
          <select class="input" bind:value={targetFile}>{#each journalFiles as f (f)}<option value={f}>{f}</option>{/each}</select>
        </label>
        <button class="btn primary" type="button" disabled={busy || selected.size === 0 || app.readOnly} onclick={doImport}>
          <Icon name="download" size={18} /> Import {selected.size}
        </button>
      </div>
    </section>
  {/if}
{/if}

<style>
  .step { margin-bottom: 12px; display: grid; gap: 10px; }
  h2 { font-size: 1rem; display: flex; align-items: center; gap: 10px; }
  .n { width: 24px; height: 24px; border-radius: 50%; background: var(--accent); color: var(--accent-text); display: grid; place-items: center; font-size: 0.8rem; }
  .pick { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
  .pick select { width: auto; min-width: 200px; }
  .grow { flex: 1; min-width: 200px; }
  .small { font-size: 0.82rem; }
  .sel { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .sel p { margin-right: auto; }
  .check { display: flex; gap: 8px; align-items: center; font-size: 0.88rem; }
  .rows { list-style: none; margin: 0; padding: 0; max-height: 420px; overflow: auto; border-top: 1px solid var(--border); }
  .rows li + li { border-top: 1px solid var(--border); }
  .rows label { display: grid; grid-template-columns: auto auto minmax(0, 1fr) auto auto; gap: 10px; align-items: center; padding: 10px 16px; cursor: pointer; }
  .rows li.dupe { opacity: 0.7; }
  .d { font-size: 0.82rem; color: var(--text-2); }
  .desc { display: grid; min-width: 0; font-weight: 560; overflow: hidden; }
  .desc small { color: var(--text-3); font-weight: 400; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .amt { font-weight: 650; }
  input[type='checkbox'] { width: 18px; height: 18px; accent-color: var(--accent); }
  @media (max-width: 560px) { .rows label { grid-template-columns: auto minmax(0, 1fr) auto; } .d { grid-column: 2; grid-row: 2; } .badge { display: none; } }
</style>
