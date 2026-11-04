<script lang="ts">
  import type { Txn } from '$lib/contracts/engine';
  import type { MixedAmount } from '$lib/contracts/amount';
  import { sumMixed } from '$lib/engine/decimal';
  import { splitQuery } from '$lib/engine/args';
  import { EngineCallError } from '$lib/engine/client';
  import { app } from '../state/app.svelte';
  import { editor } from '../state/editor.svelte';
  import { PRESETS, presetRange, humanDate, type PresetId } from '../lib/periods';
  import Money from '../components/Money.svelte';
  import Icon from '../components/Icon.svelte';

  const KEY = 'pl:txn-filters';
  let saved: { preset?: PresetId; status?: string; newest?: boolean } = {};
  try {
    saved = JSON.parse(sessionStorage.getItem(KEY) ?? '{}');
  } catch {
    /* ignore */
  }
  let search = $state('');
  let preset = $state<PresetId>(saved.preset ?? 'all');
  let statusFilter = $state<'' | '*' | '!' | 'u'>((saved.status as '' | '*' | '!' | 'u') ?? '');
  let newest = $state(saved.newest ?? true);
  let limit = $state(150);
  let queryResult = $state.raw<Txn[] | null>(null);
  let queryError = $state('');

  $effect(() => {
    try {
      sessionStorage.setItem(KEY, JSON.stringify({ preset, status: statusFilter, newest }));
    } catch {
      /* ignore */
    }
  });

  /** Looks like hledger query syntax: run it through hledger instead of filtering here. */
  const isQuery = $derived(/(^|\s)(not:)?(acct|desc|payee|note|amt|date|date2|tag|status|cur|code|real|depth|expr):/.test(search));

  let qtimer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    const q = search;
    const rev = app.revision;
    if (!isQuery || !rev) {
      queryResult = null;
      queryError = '';
      return;
    }
    clearTimeout(qtimer);
    qtimer = setTimeout(async () => {
      try {
        queryResult = await app.engine!.transactions({ query: splitQuery(q) });
        queryError = '';
      } catch (e) {
        queryResult = [];
        queryError = e instanceof EngineCallError ? (e.errors[0]?.message ?? 'Invalid query') : (e as Error).message;
      }
    }, 300);
  });

  const typeOf = $derived(new Map(app.accounts.map((a) => [a.name, a.type])));
  function acctType(name: string) {
    let n = name;
    while (n) {
      const t = typeOf.get(n);
      if (t) return t;
      const i = n.lastIndexOf(':');
      if (i < 0) break;
      n = n.slice(0, i);
    }
    return /^(assets?|liabilit)/i.test(name) ? 'A' : null;
  }

  /** The money that moved in/out of asset & liability accounts: what a bank statement would show. */
  function headline(t: Txn): { amount: MixedAmount; tone: boolean } {
    const cash = t.postings.filter((p) => ['A', 'L', 'C'].includes(acctType(p.account) ?? ''));
    if (cash.length && cash.length < t.postings.length) return { amount: sumMixed(...cash.map((p) => p.amount)), tone: true };
    const pos = t.postings.filter((p) => p.amount.some((a) => !a.quantity.startsWith('-')));
    return { amount: sumMixed(...(pos.length ? pos : t.postings.slice(0, 1)).map((p) => p.amount)), tone: false };
  }

  const range = $derived(presetRange(preset));
  const filtered = $derived.by(() => {
    let list = queryResult ?? app.txns;
    const { begin, end } = range;
    if (begin) list = list.filter((t) => t.date >= begin);
    if (end) list = list.filter((t) => t.date < end);
    if (statusFilter) list = list.filter((t) => (statusFilter === 'u' ? t.status === '' : t.status === statusFilter));
    if (!isQuery && search.trim()) {
      const words = search.toLowerCase().split(/\s+/).filter(Boolean);
      list = list.filter((t) => {
        const hay = `${t.description} ${t.code} ${t.comment} ${t.postings.map((p) => `${p.account} ${p.amount.map((a) => a.quantity).join(' ')}`).join(' ')}`.toLowerCase();
        return words.every((w) => hay.includes(w));
      });
    }
    const sorted = [...list].sort((a, b) => (a.date === b.date ? a.index - b.index : a.date < b.date ? -1 : 1));
    return newest ? sorted.reverse() : sorted;
  });
  const groups = $derived.by(() => {
    const out: { date: string; txns: Txn[] }[] = [];
    for (const t of filtered.slice(0, limit)) {
      const g = out[out.length - 1];
      if (g && g.date === t.date) g.txns.push(t);
      else out.push({ date: t.date, txns: [t] });
    }
    return out;
  });

  let sentinel: HTMLElement | undefined = $state();
  $effect(() => {
    if (!sentinel) return;
    const io = new IntersectionObserver((e) => e[0]?.isIntersecting && (limit += 150), { rootMargin: '600px' });
    io.observe(sentinel);
    return () => io.disconnect();
  });
  $effect(() => {
    void filtered;
    limit = 150;
  });

  const split = (d: string) => {
    const i = d.indexOf('|');
    return i < 0 ? { payee: d, note: '' } : { payee: d.slice(0, i).trim(), note: d.slice(i + 1).trim() };
  };
  const shortAcct = (a: string) => a.split(':').slice(-2).join(':');
</script>

<div class="toolbar">
  <div class="search">
    <Icon name="search" size={18} />
    <label class="sr-only" for="txn-search">Search transactions</label>
    <input id="txn-search" type="search" placeholder="Search, or an hledger query like acct:food amt:>50" bind:value={search} autocomplete="off" spellcheck="false" />
    {#if isQuery}<span class="badge ok" title="Filtered by hledger">hledger query</span>{/if}
  </div>
  <div class="chips" role="group" aria-label="Date range">
    {#each PRESETS as p (p.id)}
      <button class="chip" type="button" aria-pressed={preset === p.id} onclick={() => (preset = p.id)}>{p.label}</button>
    {/each}
  </div>
  <div class="chips" role="group" aria-label="Status and order">
    {#each [['', 'Any status'], ['*', 'Cleared'], ['!', 'Pending'], ['u', 'Unmarked']] as [v, l] (v)}
      <button class="chip" type="button" aria-pressed={statusFilter === v} onclick={() => (statusFilter = v as typeof statusFilter)}>{l}</button>
    {/each}
    <button class="chip" type="button" onclick={() => (newest = !newest)} aria-label="Sort: {newest ? 'newest first' : 'oldest first'}">
      <Icon name={newest ? 'arrow-down' : 'arrow-up'} size={14} />{newest ? 'Newest' : 'Oldest'}
    </button>
  </div>
</div>

{#if queryError}<p class="qerr neg" role="alert">{queryError}</p>{/if}

{#if !app.revision && app.engineStatus !== 'error'}
  <div class="card list" aria-busy="true" aria-label="Loading transactions">
    {#each Array(8) as _, i (i)}<div class="sk"><div class="skeleton" style="width:55%;height:14px"></div><div class="skeleton" style="width:20%;height:14px"></div></div>{/each}
    <p class="loading-note muted">{app.engineStatus === 'starting' ? 'Starting hledger in your browser…' : 'Reading your journal…'}</p>
  </div>
{:else if filtered.length === 0}
  <div class="empty card card-pad">
    <Icon name="search" size={28} />
    <p>No transactions match.</p>
    {#if app.txns.length === 0}<button class="btn primary" type="button" onclick={() => editor.openNew()}><Icon name="plus" /> Add your first transaction</button>{/if}
  </div>
{:else}
  <p class="count muted" aria-live="polite">{filtered.length} transaction{filtered.length === 1 ? '' : 's'}</p>
  <div class="card list">
    {#each groups as g (g.date)}
      <section aria-labelledby="d-{g.date}">
        <h2 id="d-{g.date}" class="day"><span>{humanDate(g.date)}</span><span class="iso">{g.date}</span></h2>
        <ul>
          {#each g.txns as t (t.index + ':' + (t.source?.file ?? 'gen'))}
            {@const h = headline(t)}
            {@const d = split(t.description)}
            <li>
              <button type="button" class="row" onclick={() => editor.show(t)}>
                <span class="avatar" aria-hidden="true">{(d.payee || '?').slice(0, 1).toUpperCase()}</span>
                <span class="main">
                  <span class="title">
                    {d.payee || '(no description)'}
                    {#if t.status === '!'}<span class="badge warn">Pending</span>{:else if t.status === ''}<span class="dotu" title="Unmarked" aria-label="Unmarked"></span>{/if}
                    {#if t.generated}<span class="badge">Forecast</span>{/if}
                  </span>
                  <span class="sub">{d.note ? `${d.note} · ` : ''}{t.postings.map((p) => shortAcct(p.account)).join(' → ')}</span>
                </span>
                <span class="amt"><Money value={h.amount} color={h.tone} /></span>
              </button>
            </li>
          {/each}
        </ul>
      </section>
    {/each}
    <div bind:this={sentinel} aria-hidden="true"></div>
  </div>
{/if}

<style>
  .toolbar { display: grid; gap: 10px; margin-bottom: 12px; }
  .search {
    display: flex; align-items: center; gap: 10px; padding: 0 12px; height: 46px; border-radius: var(--radius);
    background: var(--surface); border: 1px solid var(--border); color: var(--text-3);
  }
  .search:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 20%, transparent); }
  .search input { flex: 1; min-width: 0; border: 0; background: none; outline: none; height: 100%; color: var(--text); }
  .chips { display: flex; gap: 6px; overflow-x: auto; scrollbar-width: none; padding-bottom: 2px; }
  .chips::-webkit-scrollbar { display: none; }
  .qerr { font-size: 0.85rem; margin: 0 4px 10px; white-space: pre-wrap; }
  .count { font-size: 0.8rem; margin: 0 4px 6px; }
  .list { overflow: clip; }
  .day {
    position: sticky; top: 56px; z-index: 1; display: flex; justify-content: space-between; padding: 8px 16px;
    font-size: 0.78rem; font-weight: 650; color: var(--text-2); background: var(--surface-2); border-bottom: 1px solid var(--border);
    text-transform: none; letter-spacing: 0.01em;
  }
  .iso { color: var(--text-3); font-weight: 500; font-variant-numeric: tabular-nums; }
  ul { list-style: none; margin: 0; padding: 0; }
  li + li { border-top: 1px solid var(--border); }
  .row {
    width: 100%; display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 12px;
    padding: 12px 16px; border: 0; background: none; text-align: left; min-height: 60px;
  }
  .row:hover { background: var(--surface-2); }
  .avatar {
    width: 36px; height: 36px; border-radius: 10px; display: grid; place-items: center; font-weight: 700; font-size: 0.9rem;
    background: var(--accent-soft); color: var(--accent-strong);
  }
  .main { display: grid; min-width: 0; gap: 2px; }
  .title { font-weight: 600; display: flex; align-items: center; gap: 6px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .sub { font-size: 0.8rem; color: var(--text-3); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .amt { font-weight: 650; font-size: 0.95rem; }
  .dotu { width: 7px; height: 7px; border-radius: 50%; border: 1.5px solid var(--text-3); display: inline-block; }
  .empty { display: grid; justify-items: center; gap: 12px; padding: 40px 16px; color: var(--text-3); text-align: center; }
  .sk { display: flex; justify-content: space-between; padding: 18px 16px; border-bottom: 1px solid var(--border); }
  .loading-note { padding: 12px 16px; font-size: 0.85rem; }
  @media (min-width: 960px) { .day { top: 61px; } }
</style>
