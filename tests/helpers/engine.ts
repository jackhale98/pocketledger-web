// Node helpers: load the pinned engine(s) once and build engines over them.
// ENGINE=reactor runs the suite on the Option B reactor (if its artifact is present).
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { WasiCliBackend, type EngineBackend } from '../../src/lib/engine/backend';
import { ReactorBackend, type JsffiFactory } from '../../src/lib/engine/reactor-backend';
import { HledgerEngine } from '../../src/lib/engine/hledger-engine';
import type { VaultSnapshot } from '../../src/lib/contracts/engine';

export const WASM_PATH = resolve('public/wasm/hledger.wasm');
export const REACTOR_PATH = resolve('public/wasm/hledger-reactor.wasm');
export const JSFFI_PATH = resolve('public/wasm/hledger-reactor.jsffi.mjs');
export const hasReactor = existsSync(REACTOR_PATH) && existsSync(JSFFI_PATH);
export const useReactor = process.env.ENGINE === 'reactor';
export const hasWasm = useReactor ? hasReactor : existsSync(WASM_PATH);

const modules = new Map<string, Promise<WebAssembly.Module>>();
const compile = (p: string) => {
  if (!modules.has(p)) modules.set(p, WebAssembly.compile(readFileSync(p)));
  return modules.get(p)!;
};
export const engineModule = () => compile(WASM_PATH);

export async function makeBackend(kind: 'cli' | 'reactor' = useReactor ? 'reactor' : 'cli'): Promise<EngineBackend> {
  if (kind === 'reactor') {
    const glue = (await import(pathToFileURL(JSFFI_PATH).href)) as { default: JsffiFactory };
    return ReactorBackend.create(await compile(REACTOR_PATH), glue.default);
  }
  return new WasiCliBackend(await compile(WASM_PATH));
}

export async function makeEngine() {
  return new HledgerEngine(await makeBackend());
}

export const fixture = (name: string) => readFileSync(resolve('tests/fixtures', name), 'utf8');

export function snapshot(files: Record<string, string>, rootFile = Object.keys(files)[0]!): VaultSnapshot {
  return { rootFile, files, revision: JSON.stringify(Object.keys(files)) + Object.values(files).join('').length + Math.random() };
}
