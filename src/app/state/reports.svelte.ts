// Filters shared by every Reports tab (PocketLedger applies one query to all reports).
import type { Interval, QueryOpts } from '$lib/contracts/engine';
import { splitQuery } from '$lib/engine/args';
import { presetRange, type PresetId } from '../lib/periods';
import { settings } from './settings.svelte';
import { app } from './app.svelte';

export type ReportTab = 'overview' | 'table' | 'account' | 'forecast' | 'prices' | 'stats';
const KEY = 'pl:report-filters';

interface Saved {
  tab: ReportTab;
  preset: PresetId;
  begin: string;
  end: string;
  query: string;
  interval: 'auto' | Interval;
  forecast: boolean;
  account: string;
}

function load(): Partial<Saved> {
  try {
    return JSON.parse(sessionStorage.getItem(KEY) ?? '{}');
  } catch {
    return {};
  }
}

const DAY = 86400000;

class ReportFilters {
  tab = $state<ReportTab>('overview');
  preset = $state<PresetId>('last-12');
  /** Custom range (preset === 'custom'): begin inclusive, end exclusive. */
  begin = $state('');
  end = $state('');
  query = $state('');
  interval = $state<'auto' | Interval>('auto');
  forecast = $state(false);
  account = $state('');

  constructor() {
    if (typeof sessionStorage !== 'undefined') Object.assign(this, load());
  }

  save() {
    try {
      const { tab, preset, begin, end, query, interval, forecast, account } = this;
      sessionStorage.setItem(KEY, JSON.stringify({ tab, preset, begin, end, query, interval, forecast, account }));
    } catch {
      /* ignore */
    }
  }

  /** The report period (begin inclusive, end exclusive). "All time" uses the journal's own span. */
  get range(): { begin?: string; end?: string } {
    if (this.preset === 'custom') return { ...(this.begin ? { begin: this.begin } : {}), ...(this.end ? { end: this.end } : {}) };
    return presetRange(this.preset);
  }

  get words(): string[] {
    return splitQuery(this.query);
  }

  /** Interval for charts: explicit, or chosen from the range length. */
  get chartInterval(): Interval {
    if (this.interval !== 'auto') return this.interval;
    const r = this.range;
    const b = r.begin ?? app.stats?.firstDate ?? '';
    const e = r.end ?? app.stats?.lastDate ?? '';
    if (!b || !e) return 'monthly';
    const days = (Date.parse(e) - Date.parse(b)) / DAY;
    return days <= 45 ? 'daily' : days <= 120 ? 'weekly' : 'monthly';
  }

  /** Common QueryOpts for a report: period, filter query, forecast, valuation. */
  opts(extra: QueryOpts = {}, withInterval = false): QueryOpts {
    const valueIn = extra.valueIn ?? settings.v.valueIn;
    return {
      ...extra,
      period: { ...this.range, ...(withInterval ? { interval: this.chartInterval } : {}), ...extra.period },
      query: [...(extra.query ?? []), ...this.words],
      ...(this.forecast ? { forecast: true } : {}),
      ...(valueIn ? { valueIn } : {}),
    };
  }
}

export const reportFilters = new ReportFilters();
