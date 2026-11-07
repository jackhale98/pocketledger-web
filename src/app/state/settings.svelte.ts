// Per-device preferences (localStorage). Journals and tokens never live here.
import type { QueryOpts } from '$lib/contracts/engine';

const KEY = 'pl:settings';

/** How amounts are shown: as written, at cost (-B), market value (-X/-V) or unrealized gain (--gain). */
export type Valuation = '' | 'cost' | 'value' | 'gain';

export interface Settings {
  theme: 'system' | 'light' | 'dark';
  /** Currency for market value and gain (-X); '' = hledger's default valuation commodity (-V). */
  valueIn: string;
  valuation: Valuation;
  addTarget: 'root' | 'last' | string;
  dateOrder: boolean;
  showCleared: boolean;
  strictChecks: string[];
  perfOverlay: boolean;
  /** Blur every amount on screen (privacy in public). */
  hideAmounts: boolean;
}

const defaults: Settings = {
  theme: 'system',
  valueIn: '',
  valuation: '',
  addTarget: 'root',
  dateOrder: false,
  showCleared: true,
  strictChecks: [],
  perfOverlay: false,
  hideAmounts: false,
};

function read(): Settings {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Settings>;
    // Before valuation modes existed, choosing a "Value in" commodity meant market value.
    if (saved.valuation === undefined && saved.valueIn) saved.valuation = 'value';
    return { ...defaults, ...saved };
  } catch {
    return { ...defaults };
  }
}

class SettingsStore {
  v = $state<Settings>(typeof localStorage !== 'undefined' ? read() : { ...defaults });
  set<K extends keyof Settings>(k: K, value: Settings[K]) {
    this.v[k] = value;
    try {
      localStorage.setItem(KEY, JSON.stringify(this.v));
      if (k === 'hideAmounts') document.documentElement.toggleAttribute('data-private', !!value);
      if (k === 'theme') {
        if (value === 'system') delete document.documentElement.dataset.theme;
        else document.documentElement.dataset.theme = value as string;
        localStorage.setItem('pl:theme', value as string);
      }
    } catch {
      /* private mode */
    }
  }
}

export const settings = new SettingsStore();

/**
 * QueryOpts for the chosen valuation. `gain: false` treats "Unrealized gain" as market value,
 * for reports where a gain makes no sense (budgets, projections).
 */
export function valuationOpts(v: Pick<Settings, 'valuation' | 'valueIn'> = settings.v, { gain = true } = {}): Pick<QueryOpts, 'valuation' | 'valueIn'> {
  const mode = v.valuation === 'gain' && !gain ? 'value' : v.valuation;
  const vi = v.valueIn ? { valueIn: v.valueIn } : {};
  if (mode === 'cost') return { valuation: 'cost' };
  if (mode === 'value') return { valuation: 'value', ...vi };
  if (mode === 'gain') return { valuation: 'gain', ...vi };
  return {};
}

/** The market-value currency in effect ('' unless the mode is market value or gain). */
export const marketCurrency = (v: Pick<Settings, 'valuation' | 'valueIn'> = settings.v): string =>
  v.valuation === 'value' || v.valuation === 'gain' ? v.valueIn : '';
