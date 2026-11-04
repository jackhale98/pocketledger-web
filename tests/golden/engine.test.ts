// Every golden case: the WASM engine's output must equal native hledger's, byte for byte.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fixture, hasWasm, makeBackend } from '../helpers/engine';

const cases = JSON.parse(readFileSync('tests/golden/cases.json', 'utf8')) as {
  fixtures: Record<string, string>;
  commands: Record<string, string[]>;
  extra: { fixture: string; name: string; args: string[] }[];
  skipFor: Record<string, string[]>;
};
const all: { fixture: string; name: string; args: string[]; file: string }[] = [];
for (const [name, file] of Object.entries(cases.fixtures))
  for (const [cmd, args] of Object.entries(cases.commands))
    if (!(cases.skipFor[name] ?? []).includes(cmd)) all.push({ fixture: name, name: cmd, args, file });
for (const e of cases.extra) all.push({ ...e, file: cases.fixtures[e.fixture]! });

describe.skipIf(!hasWasm)('engine goldens (wasm == native hledger)', () => {
  for (const c of all) {
    it(`${c.fixture} · ${c.args.join(' ')}`, async () => {
      const expected = gunzipSync(readFileSync(`tests/golden/expected/${c.fixture}.${c.name}.out.gz`)).toString('utf8');
      const nl = expected.indexOf('\n');
      const code = Number(expected.slice(0, nl));
      const want = expected.slice(nl + 1);
      const backend = await makeBackend();
      backend.mount({ [c.file]: fixture(c.file) });
      const r = await backend.run(['-f', `/vault/${c.file}`, ...c.args]);
      expect(r.code).toBe(code);
      if (code === 0) expect(r.stdout === want, `stdout differs for ${c.fixture}.${c.name}`).toBe(true);
    });
  }
});
