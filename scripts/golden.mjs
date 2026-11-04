// Regenerate tests/golden/expected/*.out with a NATIVE hledger of the pinned version.
//   HLEDGER=/path/to/hledger node scripts/golden.mjs
// The engine golden test (tests/golden/engine.test.ts) runs the same cases through
// the WASM engine and requires byte-identical output.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

const hledger = process.env.HLEDGER ?? 'hledger';
const lock = readFileSync('engine/wasm.lock', 'utf8');
const pinned = /hledger_version = "(.*)"/.exec(lock)[1];
const version = execFileSync(hledger, ['--version'], { encoding: 'utf8' });
if (!version.includes(pinned)) {
  console.error(`native hledger is "${version.trim()}", but wasm.lock pins ${pinned}. Use the same version.`);
  process.exit(1);
}
const cases = JSON.parse(readFileSync('tests/golden/cases.json', 'utf8'));
const fixtures = resolve('tests/fixtures');
const out = resolve('tests/golden/expected');
mkdirSync(out, { recursive: true });
const all = [];
for (const [name, file] of Object.entries(cases.fixtures))
  for (const [cmd, args] of Object.entries(cases.commands))
    if (!(cases.skipFor[name] ?? []).includes(cmd)) all.push({ fixture: name, name: cmd, args, file });
for (const e of cases.extra) all.push({ ...e, file: cases.fixtures[e.fixture] });
for (const c of all) {
  let stdout = '';
  let code = 0;
  try {
    stdout = execFileSync(hledger, ['-f', `${fixtures}/${c.file}`, ...c.args], { encoding: 'utf8', env: { ...process.env, COLUMNS: '200', LC_ALL: 'C.UTF-8' }, maxBuffer: 1 << 28 });
  } catch (e) {
    code = e.status ?? 1;
    stdout = String(e.stderr ?? '');
  }
  // Engine paths are /vault/<file>; native paths are absolute on this machine.
  const normalised = stdout.split(fixtures + '/').join('/vault/');
  writeFileSync(`${out}/${c.fixture}.${c.name}.out.gz`, gzipSync(`${code}\n${normalised}`, { level: 9 }));
  console.log(`${c.fixture}.${c.name} exit ${code} ${normalised.length} bytes`);
}
