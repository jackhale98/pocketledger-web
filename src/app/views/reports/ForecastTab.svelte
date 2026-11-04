<script lang="ts">
  // Forecast: hledger's --forecast over the vault's periodic rules (`~ …`).
  // Projected month-end balance for one account, the upcoming generated
  // transactions, and an editor for the rules themselves.
  import type { EngineError, PeriodicReport, RegisterRow, Txn } from '$lib/contracts/engine';
  import type { Patch, PostingDraft, TxnDraft } from '$lib/contracts/writer';
  import type { MixedAmount } from '$lib/contracts/amount';
  import { EngineCallError } from '$lib/engine/client';
  import { formatAmount, sumMixed } from '$lib/engine/decimal';
  import { writer } from '$lib/journal/writer';
  import {
    composePeriod,
    defaultRuleFile,
    findRules,
    formatRule,
    parseRuleHeader,
    planAddRule,
    planAddRuleText,
    planDeleteRule,
    planEditRule,
    planReplaceRuleText,
    ruleCheckWindow,
    ruleFromText,
    ruleStyle,
    splitPeriod,
    validateRule,
    type PeriodicRule,
    type RuleDraft,
  } from '$lib/journal/periodic';
  import { makeSnapshot } from '$lib/vault';
  import { app, SaveError } from '../../state/app.svelte';
  import { settings } from '../../state/settings.svelte';
  import { editor } from '../../state/editor.svelte';
  import { toasts } from '../../state/toast.svelte';
  import { href } from '../../state/router.svelte';
  import { columnLabel, humanDate } from '../../lib/periods';
  import { chartCommodity, fmtIn, numberIn, otherCommodities, styleOf } from '../../lib/primary';
  import { balanceOf, parseAmountInput, todayISO, toJournalNumber } from '../../lib/amounts';
  import LineChart from '../../components/charts/LineChart.svelte';
  import Sheet from '../../components/Sheet.svelte';
  import Autocomplete from '../../components/Autocomplete.svelte';
  import ErrorPanel from '../../components/ErrorPanel.svelte';
  import Money from '../../components/Money.svelte';
  import Icon from '../../components/Icon.svelte';

  let { query = [] }: { query: string[] } = $props();

  // ─── Dates ───
  const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const today = todayISO();
  const now = new Date();
  const HISTORY_MONTHS = 3;
  const HORIZONS = [
    [3, '3m', '3 months'],
    [6, '6m', '6 months'],
    [12, '1y', '1 year'],
    [24, '2y', '2 years'],
  ] as const;
  let months = $state<number>(12);
  /** Exclusive end: the first day of the month after `months` months from now, so every month shown is whole. */
  const horizon = $derived(iso(new Date(now.getFullYear(), now.getMonth() + months + 1, 1)));
  const histBegin = iso(new Date(now.getFullYear(), now.getMonth() - HISTORY_MONTHS, 1));
  const todayLabel = now.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const forecastPeriod = $derived(`${today}..${horizon}`);
  const lastDayLabel = $derived(new Date(now.getFullYear(), now.getMonth() + months + 1, 0).toLocaleDateString(undefined, { month: 'short', year: 'numeric' }));

  // ─── Account ───
  const acctQuery = (name: string) => `acct:^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(:|$)`;
  const cashAccounts = $derived(app.accounts.filter((a) => a.type === 'C' || a.type === 'A').map((a) => a.name));
  const otherAccounts = $derived(app.accounts.filter((a) => a.type !== 'C' && a.type !== 'A').map((a) => a.name));
  const defaultAccount = $derived(
    app.accounts.find((a) => a.type === 'C')?.name ?? app.accounts.find((a) => a.type === 'A')?.name ?? app.accounts.find((a) => /^assets?(:|$)/i.test(a.name))?.name ?? app.accounts[0]?.name ?? '',
  );
  let picked = $state('');
  const account = $derived(picked && app.accounts.some((a) => a.name === picked) ? picked : defaultAccount);

  // ─── Queries ───
  let report = $state.raw<PeriodicReport | null>(null);
  let path = $state.raw<RegisterRow[]>([]);
  let upcoming = $state.raw<Txn[]>([]);
  let error = $state.raw<EngineCallError | null>(null);
  let loading = $state(false);

  $effect(() => {
    const rev = app.revision;
    const engine = app.engine;
    const acct = account;
    const words = [...query];
    const valueIn = settings.v.valueIn;
    const forecast = forecastPeriod;
    const end = horizon;
    if (!rev || !engine || !acct) return;
    let stale = false;
    loading = true;
    error = null;
    const vi = valueIn ? { valueIn } : {};
    (async () => {
      try {
        const q = [acctQuery(acct), ...words];
        const [r, reg, txns] = await Promise.all([
          engine.periodicBalance({ query: q, period: { begin: histBegin, end, interval: 'monthly' }, accumulation: 'historical', forecast, ...vi }),
          engine.register(acct, { query: words, period: { begin: today, end }, accumulation: 'historical', forecast, ...vi }),
          engine.transactions({ query: words, period: { begin: today, end }, forecast }),
        ]);
        if (stale) return;
        report = r;
        path = reg;
        upcoming = txns.filter((t) => t.generated);
      } catch (e) {
        if (stale) return;
        error = e instanceof EngineCallError ? e : new EngineCallError([{ kind: 'internal', message: (e as Error).message }]);
      } finally {
        if (!stale) loading = false;
      }
    })();
    return () => {
      stale = true;
    };
  });

  // ─── Projection ───
  /** The chart's commodity: "Value in" if set, else the one the account mostly holds. */
  const commodity = $derived.by(() => {
    if (settings.v.valueIn) return settings.v.valueIn;
    const last = report?.totals.amounts.at(-1) ?? [];
    const top = [...sumMixed(last)].sort((a, b) => Math.abs(Number(b.quantity)) - Math.abs(Number(a.quantity)))[0];
    return top?.commodity ?? (app.revision ? chartCommodity() : '');
  });
  const fmt = $derived(fmtIn(commodity));
  const labels = $derived(report ? report.columns.map((c) => columnLabel(c.begin, c.end)) : []);
  const values = $derived(report ? report.totals.amounts.map((m) => numberIn(m, commodity)) : []);
  /** First column whose month-end lies after today: projected from here on. */
  const cut = $derived(report ? Math.max(0, report.columns.findIndex((c) => c.end > today)) : 0);
  const hidden = $derived(report ? otherCommodities(report.totals.amounts, commodity) : []);
  const endBalance = $derived(values.at(-1) ?? 0);
  const lastActual = $derived(cut > 0 ? (values[cut - 1] ?? 0) : null);
  /** Balance today (before anything projected), then every projected step: the lowest point and when. */
  const startBalance = $derived.by(() => {
    const first = path[0];
    if (!first) return endBalance;
    return numberIn(first.balance, commodity) - numberIn(first.posting.amount, commodity);
  });
  const lowest = $derived.by(() => {
    let low = { value: startBalance, date: today };
    for (const r of path) {
      const v = numberIn(r.balance, commodity);
      if (v < low.value) low = { value: v, date: r.date };
    }
    return low;
  });
  const lowMonth = (d: string) => new Date(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  // Where the projection starts, under the plot (LineChart's plot insets: 48px left, 12px right).
  let plotWidth = $state(0);
  const splitX = $derived.by(() => {
    const n = values.length;
    if (n <= 1 || cut <= 0) return 48;
    return 48 + ((cut - 1) / (n - 1)) * Math.max(10, plotWidth - 60);
  });

  // ─── Upcoming ───
  const SHOW = 40;
  let showAll = $state(false);
  const shown = $derived(showAll ? upcoming : upcoming.slice(0, SHOW));
  const groups = $derived.by(() => {
    const out: { key: string; label: string; txns: Txn[] }[] = [];
    for (const t of shown) {
      const key = t.date.slice(0, 7);
      let g = out[out.length - 1];
      if (!g || g.key !== key) out.push((g = { key, label: lowMonth(t.date), txns: [] }));
      g.txns.push(t);
    }
    return out;
  });
  const touches = (t: Txn) => t.postings.filter((p) => p.account === account || p.account.startsWith(account + ':'));
  const amountOf = (t: Txn): { amount: MixedAmount; own: boolean } => {
    const own = touches(t);
    if (own.length) return { amount: sumMixed(...own.map((p) => p.amount)), own: true };
    return { amount: t.postings[0]?.amount ?? [], own: false };
  };
  const others = (t: Txn) => {
    const names = t.postings.filter((p) => !(p.account === account || p.account.startsWith(account + ':'))).map((p) => p.account);
    return names.length ? names.join(', ') : t.postings.map((p) => p.account).join(', ');
  };

  // ─── Rules ───
  const journalFiles = $derived(app.engineFiles().filter((f) => /\.(journal|hledger|ledger|j)$/i.test(f)));
  const rules = $derived(findRules(app.files, journalFiles));

  function ruleFor(t: Txn): PeriodicRule | undefined {
    return rules.find(
      (r) =>
        r.description.trim() === t.description.trim() &&
        r.postings.length === t.postings.length &&
        r.postings.every((p, i) => p.account === t.postings[i]!.account),
    );
  }

  /** Draft to record a forecast transaction for real: the rule's postings as written when it can be found, else hledger's amounts. */
  function recordDraft(t: Txn): TxnDraft {
    const rule = ruleFor(t);
    const postings: PostingDraft[] = rule
      ? rule.postings.map((p) => ({ ...p }))
      : t.postings.map((p, i) => {
          const d: PostingDraft = { account: p.account };
          if (p.type !== 'regular') d.type = p.type;
          const a = p.amount[0];
          const elide = i === t.postings.length - 1 && t.postings.length === 2;
          if (a && p.amount.length === 1 && !elide) {
            d.amount = toJournalNumber(a.quantity, a.style);
            d.commodity = a.commodity;
          }
          return d;
        });
    const d: TxnDraft = { date: t.date, description: t.description, postings };
    const comment = rule?.comment ?? t.comment.trim();
    if (comment) d.comment = comment;
    return d;
  }

  const amountText = (p: PostingDraft): string => {
    const raw = (p.amount ?? '').trim();
    if (!raw) return '';
    const c = p.commodity ?? defaultCommodity;
    const parsed = parseAmountInput(raw, styleOf(c).decimalMark);
    if (parsed.quantity == null) return `${raw} ${c}`.trim();
    return formatAmount({ commodity: c, quantity: parsed.quantity, style: styleOf(c) });
  };

  let confirmDelete = $state<string | null>(null);
  let listErrors = $state<EngineError[]>([]);
  const ruleKey = (r: PeriodicRule) => `${r.span.file}:${r.span.startLine}`;

  async function removeRule(r: PeriodicRule) {
    confirmDelete = null;
    listErrors = [];
    try {
      await app.applyPatches(planDeleteRule(app.snapshot!, r), `delete rule “${r.description || r.period}”`);
      toasts.show(`Deleted rule “${r.description || r.period}”`, { action: { label: 'Undo', run: () => void app.undo() } });
    } catch (e) {
      listErrors = toErrors(e);
    }
  }

  // ─── Rule editor ───
  type Preset = 'monthly' | 'weekly' | 'biweekly' | 'quarterly' | 'yearly' | 'custom';
  const PRESETS: [Preset, string][] = [
    ['monthly', 'Monthly'],
    ['weekly', 'Weekly'],
    ['biweekly', 'Every 2 weeks'],
    ['quarterly', 'Quarterly'],
    ['yearly', 'Yearly'],
    ['custom', 'Custom'],
  ];
  interface Row {
    key: number;
    account: string;
    amount: string;
    commodity: string;
    keep: Omit<PostingDraft, 'account' | 'amount' | 'commodity'>;
  }
  let rowKey = 0;
  const blankRow = (): Row => ({ key: rowKey++, account: '', amount: '', commodity: '', keep: {} });

  let sheetOpen = $state(false);
  let editing = $state.raw<PeriodicRule | null>(null);
  let preset = $state<Preset>('monthly');
  let customInterval = $state('');
  let from = $state('');
  let to = $state('');
  let description = $state('');
  let comment = $state('');
  /** Comment lines after the inline comment, kept as they were (the form edits the inline comment). */
  let commentRest = $state<string[]>([]);
  let rows = $state<Row[]>([]);
  let textMode = $state(false);
  let ruleText = $state('');
  let targetFile = $state('');
  let formErrors = $state<EngineError[]>([]);
  let saving = $state(false);

  const accountNames = $derived(app.accounts.map((a) => a.name));
  const commodityNames = $derived(app.commodities.map((c) => c.symbol));
  const defaultCommodity = $derived.by(() => {
    const count = new Map<string, number>();
    for (const t of app.txns.slice(-300)) for (const p of t.postings) for (const a of p.amount) count.set(a.commodity, (count.get(a.commodity) ?? 0) + 1);
    return [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '$';
  });

  const period = $derived(composePeriod({ interval: preset === 'custom' ? customInterval : preset, from, to }));
  const parsedRows = $derived(
    rows.map((r) => {
      const c0 = r.commodity || defaultCommodity;
      const p = parseAmountInput(r.amount, styleOf(c0).decimalMark);
      return { ...p, commodity: p.commodity ?? c0 };
    }),
  );
  const balance = $derived(balanceOf(parsedRows.map((p, i) => ({ quantity: p.quantity, commodity: p.commodity, hasCost: !!rows[i]?.keep.cost }))));
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
  const amountErrors = $derived(parsedRows.map((p) => p.error));

  function toDraft(): RuleDraft {
    const postings: PostingDraft[] = [];
    rows.forEach((r, i) => {
      if (!r.account.trim()) return;
      const p = parsedRows[i]!;
      const pd: PostingDraft = { ...r.keep, account: r.account.trim() };
      if (p.quantity != null) {
        pd.amount = toJournalNumber(p.quantity, styleOf(p.commodity));
        pd.commodity = p.commodity;
      }
      postings.push(pd);
    });
    const d: RuleDraft = { period, description: description.trim(), postings };
    if (comment.trim() || commentRest.length) d.comment = [comment.trim(), ...commentRest].join('\n');
    return d;
  }
  const draftProblems = $derived(validateRule(toDraft()));
  const canSave = $derived(
    !saving && (textMode ? ruleText.trim().startsWith('~') : draftProblems.length === 0 && !amountErrors.some(Boolean) && balance.status !== 'unbalanced'),
  );

  function fillForm(d: RuleDraft) {
    const parts = splitPeriod(d.period);
    const known = PRESETS.some(([p]) => p !== 'custom' && p === parts.interval);
    preset = known ? (parts.interval as Preset) : 'custom';
    customInterval = known ? '' : parts.interval;
    from = parts.from;
    to = parts.to;
    description = d.description;
    const c = d.comment === undefined ? [] : d.comment.split('\n');
    comment = c[0] ?? '';
    commentRest = c.slice(1);
    rows = d.postings.map((p) => {
      const { account: a, amount, commodity: c, ...keep } = p;
      return { key: rowKey++, account: a, amount: amount ?? '', commodity: c ?? '', keep };
    });
    while (rows.length < 2) rows.push(blankRow());
  }

  function openRule(r: PeriodicRule | null, copy = false) {
    formErrors = [];
    textMode = false;
    editing = copy ? null : r;
    const snap = app.snapshot;
    targetFile = r && copy ? r.span.file : snap ? defaultRuleFile(snap, journalFiles) : '';
    if (r) {
      fillForm(r);
      ruleText = r.text;
    } else {
      preset = 'monthly';
      customInterval = '';
      from = '';
      to = '';
      description = '';
      comment = '';
      commentRest = [];
      rows = [blankRow(), blankRow()];
      ruleText = '';
    }
    sheetOpen = true;
  }

  function toErrors(e: unknown): EngineError[] {
    if (e instanceof SaveError) return e.errors;
    if (e instanceof EngineCallError) return e.errors;
    return [{ kind: 'internal', message: (e as Error).message }];
  }

  function toggleText() {
    formErrors = [];
    const snap = app.snapshot;
    if (!textMode) {
      if (!snap) return;
      try {
        const d = toDraft();
        if (editing) {
          const p = planEditRule(snap, editing, d);
          ruleText = p[0]?.op === 'replace' ? p[0].text.replace(/\r\n/g, '\n') : editing.text.replace(/\r\n/g, '\n');
        } else ruleText = formatRule(d, { ...ruleStyle(snap, targetFile), eol: '\n' });
      } catch {
        // An incomplete form: start the text from what can be rendered.
        if (!ruleText) ruleText = `~ ${period || 'monthly'}${description.trim() ? `  ${description.trim()}` : ''}\n    `;
      }
      textMode = true;
    } else {
      try {
        fillForm(ruleFromText(ruleText));
        textMode = false;
      } catch (e) {
        formErrors = toErrors(e);
      }
    }
  }

  async function commit(patches: Patch[], label: string, periodExpr: string) {
    if (!app.engine || !app.vault) throw new Error('No vault open');
    if (app.readOnly) throw new SaveError([{ kind: 'internal', message: 'Another tab is editing this vault. Choose “Edit here” to edit in this tab.' }]);
    const next = writer.apply(app.files, patches);
    // hledger checks a rule's balancing only when it generates transactions: check with a forecast window it occurs in.
    const errs = await app.engine.check(makeSnapshot(next, app.vault.rootFile), ['-I', `--forecast=${ruleCheckWindow(periodExpr, today)}`]);
    if (errs.length) throw new SaveError(errs);
    await app.commitFiles(next, label);
  }

  async function save() {
    const snap = app.snapshot;
    if (!snap) return;
    saving = true;
    formErrors = [];
    try {
      let patches: Patch[];
      let periodExpr = period;
      let name = description.trim() || period;
      if (textMode) {
        const h = parseRuleHeader(ruleText.trim().split(/\r?\n/)[0] ?? '');
        periodExpr = h?.period ?? 'monthly';
        name = h?.description || h?.period || 'rule';
        patches = editing ? planReplaceRuleText(snap, editing, ruleText) : planAddRuleText(snap, ruleText, { targetFile });
      } else {
        const d = toDraft();
        patches = editing ? planEditRule(snap, editing, d) : planAddRule(snap, d, { targetFile });
      }
      if (patches.length) {
        await commit(patches, editing ? `edit rule “${name}”` : `add rule “${name}”`, periodExpr);
        toasts.show(editing ? 'Rule saved' : 'Rule added', { tone: 'ok' });
      }
      sheetOpen = false;
    } catch (e) {
      formErrors = toErrors(e);
    } finally {
      saving = false;
    }
  }

  function flipSign(i: number) {
    const r = rows[i]!;
    const v = r.amount.trim();
    r.amount = v.startsWith('-') ? v.slice(1) : v ? '-' + v : '-';
  }
</script>

<div class="forecast">
  <div class="controls">
    <label class="acct">
      <span class="label">Account</span>
      <select class="input" value={account} onchange={(e) => (picked = (e.currentTarget as HTMLSelectElement).value)}>
        {#if cashAccounts.length}
          <optgroup label="Cash and assets">{#each cashAccounts as a (a)}<option value={a}>{a}</option>{/each}</optgroup>
        {/if}
        {#if otherAccounts.length}
          <optgroup label="Other accounts">{#each otherAccounts as a (a)}<option value={a}>{a}</option>{/each}</optgroup>
        {/if}
      </select>
    </label>
    <div class="horizon">
      <span class="label" id="fc-horizon">Look ahead</span>
      <div class="chips" role="group" aria-labelledby="fc-horizon">
        {#each HORIZONS as [m, short, long] (m)}
          <button class="chip" type="button" aria-pressed={months === m} title={long} onclick={() => (months = m)}>{short}<span class="sr-only"> ({long})</span></button>
        {/each}
      </div>
    </div>
  </div>

  {#if error}
    <ErrorPanel title="hledger couldn't produce the forecast" errors={error.errors} />
  {:else}
    <section class="tiles" aria-label="Forecast summary">
      <div class="tile card">
        <p class="label">Projected by {lastDayLabel}</p>
        <p class="big num" class:neg={report && endBalance < 0}>{report ? fmt(endBalance) : '…'}</p>
        {#if report && lastActual !== null}
          {@const d = endBalance - lastActual}
          <p class="delta" class:pos={d >= 0} class:neg={d < 0}><Icon name={d >= 0 ? 'arrow-up' : 'arrow-down'} size={14} /> {fmt(Math.abs(d))} vs {labels[cut - 1]}</p>
        {/if}
      </div>
      <div class="tile card" class:alert={report && lowest.value < 0}>
        <p class="label">Lowest projected</p>
        <p class="big num" class:neg={report && lowest.value < 0}>{report ? fmt(lowest.value) : '…'}</p>
        {#if report}<p class="delta muted">{lowest.date === today ? 'today' : `on ${humanDate(lowest.date)}`}</p>{/if}
      </div>
    </section>

    {#if report && lowest.value < 0}
      <p class="warn-line" role="status"><Icon name="alert" size={16} /> {account} is projected to go below zero on {humanDate(lowest.date)}.</p>
    {/if}

    <section class="card card-pad" aria-labelledby="fc-chart-h">
      <header>
        <h2 id="fc-chart-h">Projected balance</h2>
        <span class="muted">{account}{commodity ? `, month end, in ${commodity}` : ''}</span>
      </header>
      {#if report && values.length}
        <div class="chart-wrap" bind:clientWidth={plotWidth}>
          <LineChart title="Projected month-end balance of {account}" {labels} {values} format={fmt} prefix={commodity.length === 1 ? commodity : ''} />
          <div class="timeline" aria-hidden="true">
            <span class="actual" style:left="48px" style:width="{Math.max(0, splitX - 48)}px"></span>
            <span class="future" style:left="{splitX}px" style:right="12px"></span>
          </div>
        </div>
        <p class="note">
          <span class="key"><span class="sw actual"></span> Recorded{cut > 0 ? ` to ${labels[cut - 1]}` : ''}</span>
          <span class="key"><span class="sw future"></span> Projected from today ({todayLabel}) by your recurring rules</span>
        </p>
        {#if hidden.length}<p class="note muted">Not shown (other commodities, no price to {commodity}): {hidden.join(', ')}.</p>{/if}
      {:else if report}
        <p class="muted">No balance to project for {account}.</p>
      {:else}<div class="skeleton" style="height:220px"></div>{/if}
    </section>

    <section class="card list" aria-labelledby="fc-up-h">
      <header class="list-head">
        <h2 id="fc-up-h">Upcoming</h2>
        <span class="muted">{upcoming.length} by {lastDayLabel}</span>
      </header>
      {#if loading && !report}
        <div class="pad"><div class="skeleton" style="height:120px"></div></div>
      {:else if upcoming.length === 0}
        <p class="pad muted">{rules.length ? 'Nothing projected before the horizon.' : 'No recurring rules yet. Add rent, salary or subscriptions below to project your balance forward.'}</p>
      {:else}
        {#each groups as g (g.key)}
          <h3 class="month-h">{g.label}</h3>
          <ul class="up">
            {#each g.txns as t, i (t.date + t.description + i)}
              {@const a = amountOf(t)}
              <li>
                <button class="up-row" type="button" onclick={() => editor.openNew(recordDraft(t))}>
                  <span class="day num"><span class="sr-only">Record </span>{t.date.slice(8)}</span>
                  <span class="what">
                    <span class="desc">{t.description || `Recurring · ${ruleFor(t)?.period ?? 'forecast'}`}</span>
                    <span class="sub muted">{others(t)}</span>
                  </span>
                  <span class="amt" class:muted={!a.own}><Money value={a.amount} color={a.own} /></span>
                </button>
              </li>
            {/each}
          </ul>
        {/each}
        {#if upcoming.length > SHOW}
          <div class="pad"><button class="btn small ghost" type="button" onclick={() => (showAll = !showAll)}>{showAll ? 'Show fewer' : `Show all ${upcoming.length}`}</button></div>
        {/if}
        <p class="pad hint muted">Tap one to record it as a real transaction.</p>
      {/if}
    </section>
  {/if}

  <section class="card list" aria-labelledby="fc-rules-h">
    <header class="list-head">
      <h2 id="fc-rules-h">Recurring rules</h2>
      <button class="btn small primary" type="button" onclick={() => openRule(null)} disabled={!app.snapshot}><Icon name="plus" size={16} /> Add rule</button>
    </header>
    <p class="pad hint muted">Periodic transactions (<code>~</code>) in your journal. hledger uses the same rules for forecasts and for budget goals.</p>
    {#if listErrors.length}<div class="pad"><ErrorPanel title="hledger rejected this change; nothing was saved" errors={listErrors} compact /></div>{/if}
    {#if rules.length === 0}
      <p class="pad muted">No recurring rules yet.</p>
    {:else}
      <ul class="rules">
        {#each rules as r (ruleKey(r))}
          <li class="rule">
            <div class="rule-head">
              <div class="rule-title">
                <strong class="desc">{r.description || 'No description'}</strong>
                <span class="meta"><span class="badge"><Icon name="repeat" size={12} />&nbsp;{r.period}</span> <a class="mono loc" href="{href('files', r.span.file)}?line={r.span.startLine}">{r.span.file}:{r.span.startLine}</a></span>
              </div>
              <div class="rule-actions">
                <button class="icon-btn" type="button" onclick={() => openRule(r)} aria-label="Edit rule {r.description || r.period}"><Icon name="edit" size={18} /></button>
                <button class="icon-btn" type="button" onclick={() => openRule(r, true)} aria-label="Duplicate rule {r.description || r.period}"><Icon name="copy" size={18} /></button>
                <button class="icon-btn danger" type="button" aria-expanded={confirmDelete === ruleKey(r)} onclick={() => (confirmDelete = confirmDelete === ruleKey(r) ? null : ruleKey(r))} aria-label="Delete rule {r.description || r.period}"><Icon name="trash" size={18} /></button>
              </div>
            </div>
            {#if confirmDelete === ruleKey(r)}
              <div class="confirm">
                <span>Remove this rule from {r.span.file}?</span>
                <button class="btn small" type="button" onclick={() => (confirmDelete = null)}>Cancel</button>
                <button class="btn small danger" type="button" onclick={() => removeRule(r)}>Delete</button>
              </div>
            {/if}
            <ul class="postings">
              {#each r.postings as p, i (i)}
                <li>
                  <span class="pacct">{p.type === 'virtual' ? `(${p.account})` : p.type === 'balanced-virtual' ? `[${p.account}]` : p.account}</span>
                  <span class="pamt num" class:muted={!p.amount}>{p.amount ? amountText(p) : 'balance'}</span>
                </li>
              {/each}
            </ul>
            {#if r.comment?.trim()}<p class="rcomment muted">; {r.comment.trim().replace(/\n/g, ' · ')}</p>{/if}
          </li>
        {/each}
      </ul>
    {/if}
  </section>
</div>

<Sheet bind:open={sheetOpen} title={editing ? 'Edit recurring rule' : 'New recurring rule'} wide={textMode}>
  {#if formErrors.length}<ErrorPanel title="hledger rejected this rule; nothing was saved" errors={formErrors} compact />{/if}

  <div class="mode">
    <button class="chip" type="button" aria-pressed={!textMode} onclick={() => textMode && toggleText()}>Form</button>
    <button class="chip" type="button" aria-pressed={textMode} onclick={() => !textMode && toggleText()}><Icon name="code" size={16} /> Edit as text</button>
    {#if !editing && journalFiles.length > 1}
      <label class="target">
        <span class="sr-only">Save to file</span>
        <select class="input" bind:value={targetFile}>
          {#each journalFiles as f (f)}<option value={f}>{f}</option>{/each}
        </select>
      </label>
    {:else if editing}
      <span class="target muted mono">{editing.span.file}:{editing.span.startLine}</span>
    {/if}
  </div>

  {#if textMode}
    <label class="field">
      <span>Rule text</span>
      <textarea class="input mono" rows="9" bind:value={ruleText} spellcheck="false" aria-describedby="rule-text-help"></textarea>
    </label>
    <p id="rule-text-help" class="hint muted">Starts with <code>~ PERIOD</code>, then two spaces and a description; postings are indented below. hledger checks it when you save.</p>
  {:else}
    <form class="form" onsubmit={(e) => { e.preventDefault(); if (canSave) void save(); }}>
      <div class="field">
        <label class="label" for="rule-desc">Description</label>
        <input id="rule-desc" class="input" bind:value={description} placeholder="e.g. Rent" autocomplete="off" />
      </div>

      <fieldset class="field">
        <legend class="label">Repeats</legend>
        <div class="presets">
          {#each PRESETS as [v, l] (v)}
            <button class="chip" type="button" aria-pressed={preset === v} onclick={() => (preset = v)}>{l}</button>
          {/each}
        </div>
        {#if preset === 'custom'}
          <label class="sr-only" for="rule-interval">Custom period expression</label>
          <input id="rule-interval" class="input mono" bind:value={customInterval} placeholder="every 15th day of month" autocapitalize="off" spellcheck="false" />
          <p class="hint muted">Any hledger period: <code>every 2 months</code>, <code>every friday</code>, <code>every 15th day of month</code>, <code>every 3rd day of week</code>…</p>
        {/if}
      </fieldset>

      <div class="row2">
        <label class="field"><span>From (optional)</span><input class="input mono" bind:value={from} placeholder="2026-01-01" autocapitalize="off" spellcheck="false" /></label>
        <label class="field"><span>To (optional)</span><input class="input mono" bind:value={to} placeholder="2027-01-01" autocapitalize="off" spellcheck="false" /></label>
      </div>
      <p class="hint muted period">Period: <code>{period || '…'}</code></p>

      <div class="postings-form" role="group" aria-label="Postings">
        <div class="phead"><span>Account</span><span>Amount</span></div>
        {#each rows as r, i (r.key)}
          <div class="posting">
            <Autocomplete id="rule-acct-{r.key}" label="Account {i + 1}" bind:value={r.account} options={accountNames} placeholder="expenses:rent" />
            <div class="pamount">
              <button type="button" class="sign" onclick={() => flipSign(i)} aria-label="Flip sign of amount {i + 1}">±</button>
              <input class="input num" inputmode="decimal" aria-label="Amount {i + 1}" aria-invalid={!!amountErrors[i]} bind:value={r.amount} placeholder={!r.amount && inferred && balance.blanks === 1 ? inferred : 'blank = balance'} />
              <label class="sr-only" for="rule-comm-{r.key}">Commodity {i + 1}</label>
              <input id="rule-comm-{r.key}" class="input comm" list="fc-commodities" bind:value={r.commodity} placeholder={defaultCommodity} />
            </div>
            {#if rows.length > 1}
              <button type="button" class="icon-btn rm" onclick={() => (rows = rows.filter((x) => x.key !== r.key))} aria-label="Remove posting {i + 1}"><Icon name="minus" size={18} /></button>
            {/if}
          </div>
        {/each}
        <datalist id="fc-commodities">{#each commodityNames as c (c)}<option value={c}></option>{/each}</datalist>
        <button type="button" class="btn small ghost" onclick={() => rows.push(blankRow())}><Icon name="plus" size={16} /> Add posting</button>
      </div>

      <label class="field"><span>Comment (optional)</span><input class="input" bind:value={comment} placeholder="note, tag: value" /></label>

      <div class="balance" role="status" aria-live="polite">
        {#if balance.status === 'unbalanced'}
          <span class="badge err">Unbalanced</span> <span class="neg">{unbalancedBy}</span>
        {:else if inferred}
          <span class="badge ok">Balanced</span> <span class="muted">blank posting gets {inferred}</span>
        {:else if balance.status === 'ok'}
          <span class="badge ok">Balanced</span>
        {:else if balance.status === 'unknown'}
          <span class="badge">Several commodities</span> <span class="muted">hledger checks it on save</span>
        {:else}
          <span class="muted">Leave one amount blank and hledger fills it in.</span>
        {/if}
      </div>
      {#if draftProblems.length && rows.some((r) => r.account.trim())}<p class="hint neg">{draftProblems[0]}</p>{/if}
      <button type="submit" hidden aria-label="Save"></button>
    </form>
  {/if}

  {#snippet footer()}
    <button class="btn" type="button" onclick={() => (sheetOpen = false)}>Cancel</button>
    <button class="btn primary" type="button" onclick={save} disabled={!canSave}>{saving ? 'Saving…' : editing ? 'Save' : 'Add rule'}</button>
  {/snippet}
</Sheet>

<style>
  .forecast { display: grid; gap: 12px; min-width: 0; }
  .controls { display: grid; gap: 10px; min-width: 0; }
  .acct { display: grid; gap: 6px; min-width: 0; }
  .acct select { min-width: 0; width: 100%; text-overflow: ellipsis; }
  .horizon { display: flex; align-items: center; gap: 10px; min-width: 0; flex-wrap: wrap; }
  .chips { display: flex; gap: 6px; flex-wrap: wrap; }
  .tiles { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
  .tile { padding: 14px 16px; display: grid; gap: 4px; min-width: 0; }
  .tile.alert { border-color: color-mix(in srgb, var(--neg) 40%, var(--border)); }
  .big { font-size: 1.35rem; font-weight: 750; letter-spacing: -0.02em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .delta { font-size: 0.8rem; display: flex; align-items: center; gap: 4px; min-width: 0; overflow-wrap: anywhere; }
  .warn-line { display: flex; gap: 8px; align-items: center; color: var(--neg); background: var(--neg-soft); border-radius: var(--radius-s); padding: 10px 12px; font-size: 0.88rem; }
  section { min-width: 0; }
  section header { display: flex; justify-content: space-between; align-items: baseline; gap: 6px 10px; margin-bottom: 12px; flex-wrap: wrap; }
  section h2 { font-size: 1rem; }
  section header span { font-size: 0.8rem; overflow-wrap: anywhere; }
  .chart-wrap { position: relative; min-width: 0; }
  .timeline { position: relative; height: 6px; margin-top: 2px; }
  .timeline span { position: absolute; top: 0; height: 6px; border-radius: 3px; }
  .actual { background: var(--chart-1); }
  .future { background: repeating-linear-gradient(90deg, var(--chart-3) 0 6px, transparent 6px 10px); }
  .note { font-size: 0.8rem; margin-top: 8px; display: flex; flex-wrap: wrap; gap: 4px 14px; color: var(--text-2); }
  .key { display: inline-flex; align-items: center; gap: 6px; }
  .sw { display: inline-block; width: 18px; height: 6px; border-radius: 3px; }
  .list { overflow: hidden; }
  .list-head { padding: 14px 16px 0; margin-bottom: 6px !important; align-items: center !important; }
  .pad { padding: 8px 16px 14px; }
  .hint { font-size: 0.8rem; }
  .month-h { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-2); padding: 10px 16px 4px; border-top: 1px solid var(--border); }
  ul { list-style: none; margin: 0; padding: 0; }
  .up-row {
    width: 100%; display: grid; grid-template-columns: 28px minmax(0, 1fr) auto; gap: 10px; align-items: center;
    padding: 9px 16px; border: 0; background: none; text-align: left; min-height: var(--tap);
  }
  .up-row:hover { background: var(--surface-2); }
  .day { font-weight: 700; color: var(--text-2); }
  .what { display: grid; min-width: 0; }
  .desc { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
  .sub { font-size: 0.78rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .amt { font-size: 0.92rem; }
  .rules { border-top: 1px solid var(--border); }
  .rule { padding: 12px 16px; border-bottom: 1px solid var(--border); display: grid; gap: 8px; min-width: 0; }
  .rule:last-child { border-bottom: 0; }
  .rule-head { display: flex; gap: 8px; align-items: flex-start; justify-content: space-between; min-width: 0; }
  .rule-title { display: grid; gap: 4px; min-width: 0; }
  .meta { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; font-size: 0.78rem; min-width: 0; }
  .meta .badge { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: inline-flex; }
  .loc { color: var(--text-3); font-size: 0.75rem; overflow-wrap: anywhere; }
  .rule-actions { display: flex; flex-shrink: 0; margin: -6px -8px 0 0; }
  .icon-btn.danger { color: var(--neg); }
  .confirm { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; font-size: 0.85rem; color: var(--neg); }
  .confirm span { flex: 1 1 160px; }
  .postings li { display: flex; justify-content: space-between; gap: 10px; font-size: 0.85rem; padding: 3px 0; min-width: 0; }
  .pacct { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-2); min-width: 0; }
  .pamt { flex-shrink: 0; }
  .pamt.muted { font-style: italic; }
  .rcomment { font-size: 0.8rem; overflow-wrap: anywhere; }
  code { font-family: var(--mono); font-size: 0.9em; background: var(--surface-2); padding: 0 4px; border-radius: 4px; }

  /* Sheet form */
  .mode { display: flex; gap: 8px; align-items: center; margin-bottom: 14px; flex-wrap: wrap; }
  .target { margin-left: auto; min-width: 0; font-size: 0.8rem; }
  .target select { min-height: 34px; padding: 4px 8px; font-size: 0.85rem; max-width: 220px; }
  .form { display: grid; gap: 14px; }
  fieldset { border: 0; padding: 0; margin: 0; min-width: 0; }
  legend { margin-bottom: 6px; }
  .presets { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
  .row2 { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 12px; }
  .period { margin-top: -6px; overflow-wrap: anywhere; }
  .postings-form { display: grid; gap: 10px; }
  .phead { display: grid; grid-template-columns: 1fr 1fr; font-size: 0.8rem; font-weight: 600; color: var(--text-2); }
  .posting { display: grid; grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr) auto; gap: 8px; align-items: start; }
  .pamount { display: grid; grid-template-columns: auto minmax(0, 1fr) 64px; gap: 4px; }
  .sign { width: 36px; border: 1px solid var(--border-strong); border-radius: var(--radius-s); background: var(--surface-2); font-weight: 700; }
  .comm { padding: 10px 6px; text-align: center; }
  .rm { width: 36px; height: var(--tap); }
  .balance { display: flex; gap: 8px; align-items: center; font-size: 0.88rem; min-height: 28px; flex-wrap: wrap; }
  textarea { font-size: 0.85rem; line-height: 1.5; }
  @media (max-width: 560px) {
    .posting { grid-template-columns: minmax(0, 1fr) auto; padding-bottom: 10px; border-bottom: 1px dashed var(--border); }
    .posting .pamount { grid-column: 1 / 2; }
    .posting :global(.ac) { grid-column: 1 / 2; }
    .rm { grid-row: 1 / span 2; grid-column: 2; align-self: center; }
  }
  @media (min-width: 640px) {
    .controls { grid-template-columns: minmax(0, 1fr) auto; align-items: end; }
  }
</style>
