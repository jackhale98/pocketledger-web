/** "Nice" axis ticks covering [min, max]. */
export function niceTicks(min: number, max: number, count = 4, includeZero = true): number[] {
  if (min === max) {
    max = min + 1;
  }
  const lo = includeZero ? Math.min(0, min) : min;
  const hi = includeZero ? Math.max(0, max) : max;
  const raw = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const start = Math.floor(lo / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= hi + step * 0.001; v += step) ticks.push(Math.round(v / step) * step);
  if (ticks[ticks.length - 1]! < hi) ticks.push(ticks[ticks.length - 1]! + step);
  return ticks;
}

/** Compact number label: 1.2k, 3.4M. */
export function compact(v: number, prefix = ''): string {
  const a = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  const n = a >= 1e9 ? (a / 1e9).toFixed(1) + 'B' : a >= 1e6 ? (a / 1e6).toFixed(1) + 'M' : a >= 1e4 ? (a / 1e3).toFixed(0) + 'k' : a >= 1e3 ? (a / 1e3).toFixed(1) + 'k' : a.toFixed(0);
  return sign + prefix + n.replace(/\.0(?=[kMB]|$)/, '');
}
