// Drive the hledger reactor module (engine Option B) from Node, the same way
// the app's worker does in a browser: @bjorn3/browser_wasi_shim for WASI,
// files mounted in memory at /vault, the GHC JSFFI glue for the exports.
//
// As a module:
//   import { createReactor } from './drive-reactor.mjs';
//   const r = await createReactor({ vault: 'tests/fixtures' });
//   r.run(['-f', '/vault/example.hledger', 'bs', '-O', 'json'])
//     // -> { code, stdout, stderr }
//   r.invalidate(); r.version(); r.memoryBytes(); r.writeFile('/vault/x', bytes)
//
// From the shell (prints stdout/stderr, exits with the code):
//   node engine/scripts/drive-reactor.mjs [--wasm F] [--jsffi F] [--vault DIR] -- ARGS...
//
// Defaults: engine/artifacts/hledger-reactor.wasm and .jsffi.mjs, vault =
// tests/fixtures. The instantiate sequence follows choai/wasm's
// scripts/bench-bindings.mjs: compile, instantiate with wasi_snapshot_preview1
// + ghc_wasm_jsffi, wasi.initialize (runs _initialize), hs_init(0, 0).

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  WASI,
  File,
  Directory,
  OpenFile,
  PreopenDirectory,
  ConsoleStdout,
} from '@bjorn3/browser_wasi_shim';

const here = dirname(fileURLToPath(import.meta.url));
const engineDir = resolve(here, '..');
const repoDir = resolve(engineDir, '..');

export const defaults = {
  wasm: join(engineDir, 'artifacts', 'hledger-reactor.wasm'),
  jsffi: join(engineDir, 'artifacts', 'hledger-reactor.jsffi.mjs'),
  vault: join(repoDir, 'tests', 'fixtures'),
};

/** Load a host directory into browser_wasi_shim inodes (recursively). */
function loadDir(dir) {
  const entries = new Map();
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) entries.set(name, new Directory(loadDir(p)));
    else if (st.isFile()) entries.set(name, new File(readFileSync(p)));
  }
  return entries;
}

/**
 * @param {{wasm?: string|Uint8Array, jsffi?: string, vault?: string|Map,
 *          module?: WebAssembly.Module}} opts
 */
export async function createReactor(opts = {}) {
  const t0 = performance.now();
  const module =
    opts.module ??
    (await WebAssembly.compile(
      typeof opts.wasm === 'object' ? opts.wasm : readFileSync(opts.wasm ?? defaults.wasm),
    ));
  const tCompiled = performance.now();
  const jsffiPath = resolve(opts.jsffi ?? defaults.jsffi);
  const ghcJsffi = (await import(pathToFileURL(jsffiPath).href)).default;

  const vaultEntries =
    opts.vault instanceof Map ? opts.vault : loadDir(resolve(opts.vault ?? defaults.vault));
  const vault = new PreopenDirectory('/vault', vaultEntries);
  // The reactor captures stdout/stderr itself; anything that still reaches
  // fds 1/2 is collected here so a test can assert there is none.
  const leaked = { stdout: [], stderr: [] };
  const fds = [
    new OpenFile(new File([])),
    ConsoleStdout.lineBuffered((l) => leaked.stdout.push(l)),
    ConsoleStdout.lineBuffered((l) => leaked.stderr.push(l)),
    vault,
  ];
  const wasi = new WASI([], opts.env ?? [], fds, { debug: false });
  const exportsRef = {};
  const instance = await WebAssembly.instantiate(module, {
    wasi_snapshot_preview1: wasi.wasiImport,
    ghc_wasm_jsffi: ghcJsffi(exportsRef),
  });
  Object.assign(exportsRef, instance.exports);
  wasi.initialize(instance);
  instance.exports.hs_init(0, 0);
  const tReady = performance.now();
  const ex = instance.exports;

  /** Resolve '/vault/a/b' to the directory inode and leaf name. */
  function locate(path) {
    const parts = path.replace(/^\/vault\/?/, '').split('/').filter(Boolean);
    let dir = vault.dir;
    for (const p of parts.slice(0, -1)) {
      let next = dir.contents.get(p);
      if (!next) dir.contents.set(p, (next = new Directory(new Map())));
      dir = next;
    }
    return [dir, parts.at(-1)];
  }

  return {
    timings: { compileMs: tCompiled - t0, instantiateMs: tReady - tCompiled },
    leaked,
    instance,
    /** @param {string[]} args @returns {{code:number, stdout:string, stderr:string}} */
    run(args) {
      // Await-safe either way: the exports are sync, but a Promise is fine too.
      const raw = ex.hledgerRun(JSON.stringify(args));
      return JSON.parse(raw);
    },
    invalidate() {
      ex.hledgerInvalidate();
    },
    version() {
      return ex.hledgerVersion();
    },
    memoryBytes() {
      return ex.memory.buffer.byteLength;
    },
    writeFile(path, data) {
      const [dir, name] = locate(path);
      const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
      dir.contents.set(name, new File(bytes));
    },
  };
}

// --- CLI ---------------------------------------------------------------
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const opts = {};
  while (argv.length && argv[0] !== '--') {
    const k = argv.shift();
    if (k === '--wasm') opts.wasm = argv.shift();
    else if (k === '--jsffi') opts.jsffi = argv.shift();
    else if (k === '--vault') opts.vault = argv.shift();
    else {
      argv.unshift(k);
      break;
    }
  }
  if (argv[0] === '--') argv.shift();
  const r = await createReactor(opts);
  const res = r.run(argv);
  process.stdout.write(res.stdout);
  process.stderr.write(res.stderr);
  process.exitCode = res.code;
}
