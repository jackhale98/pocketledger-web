// Date range presets, as hledger begin (inclusive) / end (exclusive) dates.
export type PresetId = 'all' | 'this-month' | 'last-month' | 'last-3' | 'last-6' | 'this-quarter' | 'last-quarter' | 'this-year' | 'last-year' | 'last-12' | 'custom';

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const monthStart = (y: number, m: number) => iso(new Date(y, m, 1));

export const PRESETS: { id: PresetId; label: string }[] = [
  { id: 'this-month', label: 'This month' },
  { id: 'last-month', label: 'Last month' },
  { id: 'last-3', label: '3 months' },
  { id: 'this-quarter', label: 'This quarter' },
  { id: 'last-quarter', label: 'Last quarter' },
  { id: 'this-year', label: 'This year' },
  { id: 'last-12', label: '12 months' },
  { id: 'last-year', label: 'Last year' },
  { id: 'all', label: 'All time' },
  { id: 'custom', label: 'Custom' },
];

export function presetRange(id: PresetId, today = new Date()): { begin?: string; end?: string } {
  const y = today.getFullYear();
  const m = today.getMonth();
  switch (id) {
    case 'this-month': return { begin: monthStart(y, m), end: monthStart(y, m + 1) };
    case 'last-month': return { begin: monthStart(y, m - 1), end: monthStart(y, m) };
    case 'last-3': return { begin: monthStart(y, m - 2), end: monthStart(y, m + 1) };
    case 'this-quarter': return { begin: monthStart(y, m - (m % 3)), end: monthStart(y, m - (m % 3) + 3) };
    case 'last-quarter': return { begin: monthStart(y, m - (m % 3) - 3), end: monthStart(y, m - (m % 3)) };
    case 'last-6': return { begin: monthStart(y, m - 5), end: monthStart(y, m + 1) };
    case 'this-year': return { begin: `${y}-01-01`, end: `${y + 1}-01-01` };
    case 'last-year': return { begin: `${y - 1}-01-01`, end: `${y}-01-01` };
    case 'last-12': return { begin: monthStart(y, m - 11), end: monthStart(y, m + 1) };
    default: return {};
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** Short label for a report column (begin date + interval). */
export function columnLabel(begin: string, end: string): string {
  const [y, m, d] = begin.split('-').map(Number) as [number, number, number];
  const [ey, em] = end.split('-').map(Number) as [number, number];
  const months = (ey - y) * 12 + (em - m);
  if (d === 1 && months === 1) return `${MONTHS[m - 1]} ${String(y).slice(2)}`;
  if (d === 1 && months === 3) return `Q${Math.floor((m - 1) / 3) + 1} ${String(y).slice(2)}`;
  if (d === 1 && m === 1 && months === 12) return String(y);
  const days = Math.round((Date.parse(end) - Date.parse(begin)) / 86400000);
  if (days === 7) return `${MONTHS[m - 1]} ${d}`;
  if (days === 1) return `${d} ${MONTHS[m - 1]}`;
  return begin.slice(5);
}

export function humanDate(dateIso: string, today = new Date()): string {
  const [y, m, d] = dateIso.split('-').map(Number) as [number, number, number];
  const date = new Date(y, m - 1, d);
  const t0 = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const diff = Math.round((t0.getTime() - date.getTime()) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff === -1) return 'Tomorrow';
  const wd = date.toLocaleDateString(undefined, { weekday: 'short' });
  return `${wd}, ${date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(y !== today.getFullYear() ? { year: 'numeric' } : {}) })}`;
}
