// Performance budget: app JS (excluding the hledger engine) <= 250 KB gzip.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
const BUDGET = 250 * 1024;
const dir = 'dist/_astro';
let total = 0;
const rows = [];
for (const f of readdirSync(dir)) {
  if (!f.endsWith('.js')) continue;
  const gz = gzipSync(readFileSync(join(dir, f)), { level: 9 }).length;
  total += gz;
  rows.push([f, gz]);
}
rows.sort((a, b) => b[1] - a[1]);
for (const [f, gz] of rows.slice(0, 8)) console.log(`${(gz / 1024).toFixed(1).padStart(7)} KB  ${f}`);
const wasm = readdirSync('dist/wasm').filter((f) => f.endsWith('.wasm'));
for (const w of wasm) {
  const raw = statSync(join('dist/wasm', w)).size;
  console.log(`engine ${w}: ${(raw / 1048576).toFixed(2)} MiB raw, ${(gzipSync(readFileSync(join('dist/wasm', w))).length / 1048576).toFixed(2)} MiB gzip (excluded from budget)`);
}
console.log(`app JS total: ${(total / 1024).toFixed(1)} KB gzip (budget ${BUDGET / 1024} KB)`);
if (total > BUDGET) {
  console.error('Over budget');
  process.exit(1);
}
