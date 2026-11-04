// The demo vault, with every date shifted so its last month is the current month.
const raw = import.meta.glob('/src/demo/vault/**/*', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

export const DEMO_ANCHOR = { year: 2026, month: 10 };

function shiftDate(y: number, m: number, d: number, months: number): string {
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${String(nm).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

export function shiftDates(text: string, months: number): string {
  if (months === 0) return text;
  return text.replace(/\b(20\d\d)-(\d\d)-(\d\d)\b/g, (_, y, m, d) => shiftDate(+y, +m, +d, months)).replace(
    /\bfrom (20\d\d)-(\d\d)\b(?!-)/g,
    (_, y, m) => `from ${shiftDate(+y, +m, 1, months).slice(0, 7)}`,
  );
}

export function demoFiles(today = new Date()): Record<string, string> {
  const months = today.getFullYear() * 12 + today.getMonth() - (DEMO_ANCHOR.year * 12 + DEMO_ANCHOR.month - 1);
  const files: Record<string, string> = {};
  for (const [path, text] of Object.entries(raw)) files[path.replace('/src/demo/vault/', '')] = shiftDates(text, months);
  return files;
}
