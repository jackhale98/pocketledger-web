// Parse cost vs output cost: fresh parse via `check`, then windowed vs full print.
//   PERF=1 ENGINE=reactor PERF_OUT=... npx vitest run tests/perf/split.bench.test.ts
import { describe, it } from 'vitest';
import { appendFileSync, writeFileSync } from 'node:fs';
import { makeBackend, hasWasm } from '../helpers/engine';
import { makeJournal } from './make-journal';

describe.skipIf(!hasWasm || !process.env.PERF)('parse vs output', () => {
  for (const n of (process.env.SIZES ?? '5000,20000').split(','))
    it(`n=${n}`, async () => {
      const b = await makeBackend();
      const text = makeJournal(Number(n));
      if (process.env.PERF_DUMP) writeFileSync(`${process.env.PERF_DUMP}/synthetic-${n}.journal`, text);
      b.mount({ 'main.journal': text });
      const f = ['-f', '/vault/main.journal', '--no-conf'];
      const log = (name: string, ms: number, bytes: number) => {
        const line = `${n.padEnd(6)} ${name.padEnd(40)} ${ms.toFixed(0).padStart(6)} ms  ${(bytes / 1024).toFixed(0).padStart(7)} KB`;
        if (process.env.PERF_OUT) appendFileSync(process.env.PERF_OUT, line + '\n');
      };
      for (const [name, args] of [
        ['check (fresh parse)', ['check']],
        ['check (cached)', ['check']],
        ['print -O json -b 2025-10-01 (3 months)', ['print', '-O', 'json', '-b', '2025-10-01']],
        ['print -O json -b 2025-01-01 (12 months)', ['print', '-O', 'json', '-b', '2025-01-01']],
        ['print -O csv (all)', ['print', '-O', 'csv']],
        ['print (text, all)', ['print']],
        ['print -O json (all)', ['print', '-O', 'json']],
        ['register checking -O json (all)', ['register', 'acct:^assets:checking(:|$)', '-O', 'json']],
        ['register checking -O json -b 2025-01-01', ['register', 'acct:^assets:checking(:|$)', '-O', 'json', '-b', '2025-01-01', '-H']],
      ] as [string, string[]][]) {
        const t = performance.now();
        const r = await b.run([...f, ...args]);
        log(name, performance.now() - t, r.stdout.length);
      }
    }, 600_000);
});
