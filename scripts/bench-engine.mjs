// Measure the pinned hledger.wasm under Node's WASI (Option A: CLI command module).
// Usage: node scripts/bench-engine.mjs [journal]   (default: tests/fixtures/example.hledger)
import { readFileSync, statSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { WASI } from 'node:wasi';
import { brotliCompressSync, gzipSync, constants } from 'node:zlib';

const wasmPath = resolve('public/wasm/hledger.wasm');
const journal = resolve(process.argv[2] ?? 'tests/fixtures/example.hledger');
const bytes = readFileSync(wasmPath);
const gz = gzipSync(bytes, { level: 9 }).length;
const br = brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length;
console.log(`raw ${(bytes.length / 1048576).toFixed(2)} MiB, gzip-9 ${(gz / 1048576).toFixed(2)} MiB, brotli-11 ${(br / 1048576).toFixed(2)} MiB`);

let t = performance.now();
const mod = await WebAssembly.compile(bytes);
console.log(`compile ${(performance.now() - t).toFixed(0)} ms`);

async function run(args) {
  const t0 = performance.now();
  const wasi = new WASI({
    version: 'preview1', returnOnExit: true,
    env: { HOME: '/', LC_ALL: 'C.UTF-8', PATH: '/', PWD: '/' },
    args: ['hledger', '-f', '/' + basename(journal), ...args],
    preopens: { '/': dirname(journal) },
    stdout: 2, // discard into stderr is noisy; we redirect stderr below
  });
  const inst = await WebAssembly.instantiate(mod, wasi.getImportObject());
  const code = wasi.start(inst);
  const ms = performance.now() - t0;
  console.log(`${args.join(' ').padEnd(28)} exit ${code} ${ms.toFixed(0).padStart(5)} ms  mem ${(inst.exports.memory.buffer.byteLength / 1048576).toFixed(0)} MiB`);
}
for (const a of [['bs', '-O', 'json'], ['bs', '-O', 'json'], ['print', '-O', 'json'], ['is', '-M', '-O', 'json'], ['bal', '-X', 'USD', '-O', 'json'], ['stats']])
  await run(a);
