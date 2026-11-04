// Per-device preferences (localStorage). Journals and tokens never live here.
const KEY = 'pl:settings';

export interface Settings {
  theme: 'system' | 'light' | 'dark';
  valueIn: string;
  addTarget: 'root' | 'last' | string;
  dateOrder: boolean;
  showCleared: boolean;
  strictChecks: string[];
  perfOverlay: boolean;
}

const defaults: Settings = {
  theme: 'system',
  valueIn: '',
  addTarget: 'root',
  dateOrder: false,
  showCleared: true,
  strictChecks: [],
  perfOverlay: false,
};

function read(): Settings {
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
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
