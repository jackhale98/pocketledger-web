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

/** Remove transactions dated after `today` (the demo's last month becomes the current, partial month). */
export function dropFuture(text: string, todayIso: string): string {
  const blocks = text.split(/\n(?=\d{4}-\d\d-\d\d)/);
  return blocks.filter((b) => !/^\d{4}-\d\d-\d\d/.test(b) || b.slice(0, 10) <= todayIso).join('\n');
}

export function demoFiles(today = new Date()): Record<string, string> {
  const months = today.getFullYear() * 12 + today.getMonth() - (DEMO_ANCHOR.year * 12 + DEMO_ANCHOR.month - 1);
  const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const files: Record<string, string> = {};
  for (const [path, text] of Object.entries(raw)) {
    const shifted = shiftDates(text, months);
    files[path.replace('/src/demo/vault/', '')] = path.endsWith('.journal') && !path.includes('budget') ? dropFuture(shifted, iso) : shifted;
  }
  return files;
}
