// Node helpers: load the pinned hledger.wasm once and build engines over it.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { WasiCliBackend } from '../../src/lib/engine/backend';
import { HledgerEngine } from '../../src/lib/engine/hledger-engine';
import type { VaultSnapshot } from '../../src/lib/contracts/engine';

export const WASM_PATH = resolve('public/wasm/hledger.wasm');
export const hasWasm = existsSync(WASM_PATH);

let modulePromise: Promise<WebAssembly.Module> | null = null;
export function engineModule(): Promise<WebAssembly.Module> {
  modulePromise ??= WebAssembly.compile(readFileSync(WASM_PATH));
  return modulePromise;
}

export async function makeBackend() {
  return new WasiCliBackend(await engineModule());
}

export async function makeEngine() {
  return new HledgerEngine(await makeBackend());
}

export const fixture = (name: string) => readFileSync(resolve('tests/fixtures', name), 'utf8');

export function snapshot(files: Record<string, string>, rootFile = Object.keys(files)[0]!): VaultSnapshot {
  return { rootFile, files, revision: JSON.stringify(Object.keys(files)) + Object.values(files).join('').length + Math.random() };
}
