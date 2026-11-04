// Parity and timing check for the hledger reactor (engine Option B).
//
//   node --no-warnings engine/scripts/check-reactor.mjs [--native PATH] [--runs N] [--json OUT]
//
// Builds one vault directory (tests/fixtures plus generated CSV/rules and
// error-case journals), mounts it at /vault in the reactor, and runs every
// case through both the reactor and the native hledger executable (with
// -f paths mapped to the host copy, LANG=C.UTF-8, TZ=UTC, an empty HOME and
// cwd, so no config file is found by either). stdout, stderr and the exit
// code must be identical. Then times compile/instantiate/first call and warm
// calls, and reports memory.
//
// Native default: $HLEDGER_NATIVE or /home/user/dl/native/hledger.

import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { brotliCompressSync, gzipSync, constants } from 'node:zlib';
import { createHash } from 'node:crypto';
import { createReactor, defaults } from './drive-reactor.mjs';

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : d;
};
const native = opt('--native', process.env.HLEDGER_NATIVE ?? '/home/user/dl/native/hledger');
const runs = Number(opt('--runs', 15));
const jsonOut = opt('--json', null);
const wasmPath = opt('--wasm', defaults.wasm);
const jsffiPath = opt('--jsffi', defaults.jsffi);

// --- vault --------------------------------------------------------------
const work = mkdtempSync(join(tmpdir(), 'hledger-parity-'));
const vaultDir = join(work, 'vault');
const emptyHome = join(work, 'home');
const emptyCwd = join(work, 'cwd');
cpSync(defaults.vault, vaultDir, { recursive: true });
for (const d of [emptyHome, emptyCwd]) cpSync(defaults.vault, d, { recursive: true, filter: () => false });
spawnSync('mkdir', ['-p', emptyHome, emptyCwd]);

const files = {
  'bank.csv': 'date,description,amount\n2025-01-03,Coffee shop,-4.50\n2025-01-05,Salary,2500.00\n2025-01-09,Groceries,-82.17\n',
  'bank.csv.rules':
    'skip 1\nfields date, description, amount\ncurrency $\naccount1 assets:bank:checking\n' +
    'if Coffee\n  account2 expenses:food:coffee\nif Salary\n  account2 income:salary\nif Groceries\n  account2 expenses:food:groceries\n',
  'bad-assertion.journal': '2025-01-01 open\n    assets:cash  $10 = $10\n    equity\n\n2025-01-02 spend\n    expenses  $3\n    assets:cash  = $8\n',
  'unbalanced.journal': '2025-01-01 oops\n    a  $10\n    b  $-9\n',
  'parse-error.journal': '2025-01-01 ok\n    a  $1\n    b\n\n2025-13-40 bad date\n    a  1\n    b\n',
  'unordered.journal': '2025-02-01 b\n    a  $1\n    b\n\n2025-01-01 a\n    a  $1\n    b\n',
  'unordered-bad-assertion.journal':
    '2025-02-01 b\n    a  $1 = $1\n    b\n\n2025-01-01 a\n    a  $1 = $5\n    b\n',
  'main.journal': 'include sub/included.journal\n\n2025-03-01 top\n    expenses:misc  $5\n    assets:cash\n',
  'sub/included.journal': '2025-02-01 inner\n    assets:cash  $100\n    equity:opening\n',
};
spawnSync('mkdir', ['-p', join(vaultDir, 'sub')]);
for (const [name, text] of Object.entries(files)) writeFileSync(join(vaultDir, name), text);

const V = (f) => `/vault/${f}`;
const EX = V('example.hledger');
const BUDGET = V('sample-with-budget.journal');

// [label, args, required?]  required = part of the acceptance list
const cases = [
  ['print -O json', ['-f', EX, 'print', '-O', 'json'], true],
  ['bs -O json', ['-f', EX, 'bs', '-O', 'json'], true],
  ['is -M -O json', ['-f', EX, 'is', '-M', '-O', 'json'], true],
  ['cf -O json', ['-f', EX, 'cf', '-O', 'json'], true],
  ['bal -O json', ['-f', EX, 'bal', '-O', 'json'], true],
  ['bal --budget -M -O json (budget)', ['-f', BUDGET, 'bal', '--budget', '-M', '-O', 'json'], true],
  ['bal -X USD -O json', ['-f', EX, 'bal', '-X', 'USD', '-O', 'json'], true],
  // extra coverage
  ['print -O json date:2025', ['-f', EX, 'print', '-O', 'json', 'date:2025']],
  ['bs (text)', ['-f', EX, 'bs']],
  ['is -M (text)', ['-f', EX, 'is', '-M']],
  ['reg -O csv', ['-f', EX, 'reg', '-O', 'csv']],
  ['bal -M --tree', ['-f', EX, 'bal', '-M', '--tree']],
  ['bal -V -O json', ['-f', EX, 'bal', '-V', '-O', 'json']],
  ['stats', ['-f', EX, 'stats']],
  ['accounts --tree', ['-f', EX, 'accounts', '--tree']],
  ['flags before command', ['-f', EX, '-M', 'is', '-O', 'json']],
  ['--forecast bal -M', ['-f', BUDGET, '--forecast=2025', 'bal', '-M', '-O', 'json']],
  ['--auto print', ['-f', BUDGET, '--auto', 'print', '-O', 'json']],
  ['-I bs', ['-f', EX, '-I', 'bs', '-O', 'json']],
  ['--alias bal', ['-f', EX, '--alias', '/^expenses/=spend', 'bal', '-O', 'json']],
  ['--pivot bal', ['-f', EX, '--pivot', 'payee', 'bal', '-O', 'json']],
  ['check ordereddates (ok)', ['-f', EX, 'check', 'ordereddates']],
  ['csv + rules print -O json', ['-f', V('bank.csv'), '--rules', V('bank.csv.rules'), 'print', '-O', 'json']],
  ['include', ['-f', V('main.journal'), 'bal', '-O', 'json']],
  ['two -f files', ['-f', V('basic.journal'), '-f', V('multicurrency.journal'), 'bal']],
  ['assertions.journal bs', ['-f', V('assertions.journal'), 'bs']],
  ['comma_decimal bal', ['-f', V('comma_decimal.journal'), 'bal']],
  ['edge_cases print', ['-f', V('edge_cases.journal'), 'print']],
  ['--version', ['--version']],
  // errors: same text on stderr, code 1
  ['ERR missing file', ['-f', V('nope.journal'), 'bal']],
  ['ERR bad command', ['-f', EX, 'frobnicate']],
  ['ERR bad flag', ['-f', EX, 'bal', '--no-such-flag']],
  ['ERR failing assertion', ['-f', V('bad-assertion.journal'), 'bal']],
  ['ERR failing assertion, -I ok', ['-f', V('bad-assertion.journal'), '-I', 'bal']],
  ['ERR -I check assertions', ['-f', V('bad-assertion.journal'), '-I', 'check', 'assertions']],
  ['ERR unbalanced', ['-f', V('unbalanced.journal'), 'print']],
  ['ERR parse error', ['-f', V('parse-error.journal'), 'print']],
  ['ERR check ordereddates', ['-f', V('unordered.journal'), 'check', 'ordereddates']],
  ['ERR ordereddates beats assertion', ['-f', V('unordered-bad-assertion.journal'), 'check', 'ordereddates']],
  ['ERR bad query', ['-f', EX, 'bal', 'date:notadate']],
  ['ERR bad -X', ['-f', EX, 'bal', '-X']],
  ['ERR bad check name', ['-f', EX, 'check', 'nonsense']],
  ['ERR --strict (undeclared account)', ['-f', V('basic.journal'), '--strict', 'bal']],
  ['ERR check payees', ['-f', V('basic.journal'), 'check', 'payees']],
  ['ERR bad CSV rules', ['-f', V('bank.csv'), '--rules', V('nope.rules'), 'print']],
];

function runNative(args) {
  const mapped = args.map((a) => (a.startsWith('/vault/') ? join(vaultDir, a.slice(7)) : a.replace(/=\/vault\//, `=${vaultDir}/`)));
  const r = spawnSync(native, mapped, {
    cwd: emptyCwd,
    env: { LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC', HOME: emptyHome, PATH: '/usr/bin:/bin' },
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  });
  // native error text mentions host paths; map them back for comparison
  const unmap = (s) => s.split(vaultDir).join('/vault');
  return { code: r.status, stdout: unmap(r.stdout), stderr: unmap(r.stderr) };
}

// --- parity ---------------------------------------------------------------
const wasmBytes = readFileSync(wasmPath);
const reactor = await createReactor({ wasm: wasmBytes, jsffi: jsffiPath, vault: vaultDir });
const results = [];
let failures = 0;
for (const [label, args, required] of cases) {
  const n = runNative(args);
  const w = reactor.run(args);
  // --version names the build platform, which necessarily differs
  const versionCase = label === '--version';
  // stats' last line is wall-clock/GC measurement, different on every run
  const noRuntime = (s) => (label === 'stats' ? s.replace(/^Runtime stats .*\n/m, '') : s);
  const same = versionCase
    ? n.code === w.code && w.stdout.startsWith('hledger 1.52.4')
    : n.code === w.code && noRuntime(n.stdout) === noRuntime(w.stdout) && n.stderr === w.stderr;
  if (!same) failures++;
  results.push({ label, required: !!required, same, nativeCode: n.code, reactorCode: w.code, bytes: w.stdout.length });
  console.log(`${same ? 'SAME' : 'DIFF'}  ${required ? '*' : ' '} ${label.padEnd(36)} code ${n.code}/${w.code}  ${w.stdout.length} B${versionCase ? `  (native: ${n.stdout.trim()} | reactor: ${w.stdout.trim()})` : ''}`);
  if (!same) {
    const show = (s) => JSON.stringify(s.slice(0, 600));
    if (n.stdout !== w.stdout) console.log(`      stdout native ${show(n.stdout)}\n      stdout wasm   ${show(w.stdout)}`);
    if (n.stderr !== w.stderr) console.log(`      stderr native ${show(n.stderr)}\n      stderr wasm   ${show(w.stderr)}`);
  }
}
console.log(`leaked to fds 1/2: ${reactor.leaked.stdout.length + reactor.leaked.stderr.length} lines`);

// --- cache behaviour -------------------------------------------------------
{
  const r = await createReactor({ wasm: wasmBytes, jsffi: jsffiPath, vault: vaultDir });
  const bal = ['-f', V('main.journal'), 'bal', '-O', 'json'];
  const before = r.run(bal).stdout;
  r.writeFile(V('sub/included.journal'), '2025-02-01 inner\n    assets:cash  $999\n    equity:opening\n');
  const stale = r.run(bal).stdout;
  r.invalidate();
  const fresh = r.run(bal).stdout;
  const ok = stale === before && fresh !== before && fresh.includes('999');
  console.log(`${ok ? 'SAME' : 'DIFF'}    cache: reused until hledgerInvalidate, then re-read (include file edited)`);
  if (!ok) failures++;
  results.push({ label: 'cache invalidate', same: ok });
}

// --- timings ---------------------------------------------------------------
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const time = (f) => {
  const t = performance.now();
  const v = f();
  return [performance.now() - t, v];
};
const timing = {};
{
  // cold: compile + instantiate + hs_init + first bs (parse included), fresh each time
  const cold = [];
  for (let i = 0; i < 5; i++) {
    const t = performance.now();
    const r = await createReactor({ wasm: wasmBytes, jsffi: jsffiPath, vault: vaultDir });
    const t1 = performance.now();
    r.run(['-f', EX, 'bs', '-O', 'json']);
    const t2 = performance.now();
    cold.push({ total: t2 - t, compile: r.timings.compileMs, inst: r.timings.instantiateMs, first: t2 - t1 });
  }
  timing.cold = {
    totalMs: median(cold.map((c) => c.total)),
    compileMs: median(cold.map((c) => c.compile)),
    instantiateMs: median(cold.map((c) => c.inst)),
    firstBsMs: median(cold.map((c) => c.first)),
  };

  const r = await createReactor({ wasm: wasmBytes, jsffi: jsffiPath, vault: vaultDir });
  r.run(['-f', EX, 'bs', '-O', 'json']); // parse + cache
  const warm = {};
  for (const [label, args] of [
    ['bs -O json', ['-f', EX, 'bs', '-O', 'json']],
    ['is -M -O json', ['-f', EX, 'is', '-M', '-O', 'json']],
    ['print -O json', ['-f', EX, 'print', '-O', 'json']],
    ['bal -X USD -O json', ['-f', EX, 'bal', '-X', 'USD', '-O', 'json']],
    ['stats', ['-f', EX, 'stats']],
    ['print -O json date:2025', ['-f', EX, 'print', '-O', 'json', 'date:2025']],
  ]) {
    const xs = [];
    for (let i = 0; i < runs; i++) xs.push(time(() => r.run(args))[0]);
    warm[label] = { medianMs: median(xs), minMs: Math.min(...xs), maxMs: Math.max(...xs) };
  }
  // re-parse cost: invalidate before each call
  const reparse = [];
  for (let i = 0; i < 5; i++) {
    r.invalidate();
    reparse.push(time(() => r.run(['-f', EX, 'bs', '-O', 'json']))[0]);
  }
  timing.warm = warm;
  timing.reparseBsMs = median(reparse);
  timing.wasmMemoryBytes = r.memoryBytes();
  timing.nodeRssBytes = process.memoryUsage().rss;
}

const br = brotliCompressSync(wasmBytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: wasmBytes.length } }).length;
const size = {
  raw: wasmBytes.length,
  gzip9: gzipSync(wasmBytes, { level: 9 }).length,
  brotli11: br,
  sha256: createHash('sha256').update(wasmBytes).digest('hex'),
};

const mib = (n) => (n / 1048576).toFixed(2);
console.log(`\nsize: raw ${size.raw} (${mib(size.raw)} MiB)  gzip-9 ${mib(size.gzip9)} MiB  brotli-11 ${size.brotli11} (${mib(size.brotli11)} MiB)`);
console.log(`sha256 ${size.sha256}`);
console.log(`cold: compile ${timing.cold.compileMs.toFixed(0)} ms + instantiate/hs_init ${timing.cold.instantiateMs.toFixed(0)} ms + first bs -O json ${timing.cold.firstBsMs.toFixed(0)} ms = ${timing.cold.totalMs.toFixed(0)} ms`);
for (const [k, v] of Object.entries(timing.warm)) console.log(`warm ${k.padEnd(26)} median ${v.medianMs.toFixed(1)} ms  (min ${v.minMs.toFixed(1)}, max ${v.maxMs.toFixed(1)})`);
console.log(`re-parse + bs -O json (after invalidate): ${timing.reparseBsMs.toFixed(0)} ms`);
console.log(`wasm linear memory ${mib(timing.wasmMemoryBytes)} MiB (never shrinks, so = peak); node rss ${mib(timing.nodeRssBytes)} MiB`);
console.log(`\nparity: ${results.filter((r) => r.same).length}/${results.length} same, ${failures} different`);

if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ size, timing, results, node: process.version }, null, 2));
rmSync(work, { recursive: true, force: true });
process.exitCode = failures ? 1 : 0;
