/// <reference lib="webworker" />
// The engine worker: compiles hledger once, then serves Engine calls.
// Prefers the reactor module (Option B: parse once, many reports); falls back
// to the CLI command module (Option A) if the reactor can't start.
import { WasiCliBackend, type EngineBackend } from '../lib/engine/backend';
import { ReactorBackend, type JsffiFactory } from '../lib/engine/reactor-backend';
import { EngineFailure, HledgerEngine } from '../lib/engine/hledger-engine';
import type { Request, Response } from '../lib/engine/rpc';
import type { EngineError } from '../lib/contracts/engine';

declare const self: DedicatedWorkerGlobalScope;

let engine: HledgerEngine | null = null;
let ready: Promise<void> | null = null;
const post = (m: Response) => self.postMessage(m);

async function compile(url: string): Promise<WebAssembly.Module> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not download the hledger engine (HTTP ${res.status})`);
  if (WebAssembly.compileStreaming && res.headers.get('content-type')?.includes('application/wasm'))
    return WebAssembly.compileStreaming(res);
  return WebAssembly.compile(await res.arrayBuffer());
}

async function start(msg: Extract<Request, { type: 'init' }>): Promise<{ backend: EngineBackend; sha256?: string }> {
  if (msg.reactor) {
    try {
      const [mod, glue] = await Promise.all([
        compile(msg.reactor.wasmUrl),
        import(/* @vite-ignore */ msg.reactor.jsffiUrl) as Promise<{ default: JsffiFactory }>,
      ]);
      return { backend: await ReactorBackend.create(mod, glue.default), sha256: msg.reactor.sha256 };
    } catch (e) {
      console.warn('hledger reactor engine failed to start; using the CLI engine', e);
    }
  }
  return { backend: new WasiCliBackend(await compile(msg.wasmUrl)), ...(msg.sha256 ? { sha256: msg.sha256 } : {}) };
}

self.onmessage = async (ev: MessageEvent<Request>) => {
  const msg = ev.data;
  if (msg.type === 'init') {
    const t0 = performance.now();
    let mode: 'cli' | 'reactor' = 'cli';
    ready = start(msg).then(({ backend, sha256 }) => {
      mode = backend.mode;
      engine = new HledgerEngine(backend, {
        version: { ...(sha256 ? { sha256 } : {}) },
        onRun: (args, ms, code) => post({ type: 'timing', args, ms, code }),
      });
    });
    try {
      await ready;
      post({ type: 'ready', ms: performance.now() - t0, mode });
    } catch (e) {
      post({ type: 'init-error', message: (e as Error).message });
    }
    return;
  }
  if (msg.type === 'call') {
    try {
      await ready;
      if (!engine) throw new Error('Engine failed to start');
      const fn = (engine[msg.method] as (...a: unknown[]) => Promise<unknown>).bind(engine);
      const value = await fn(...msg.args);
      post({ type: 'result', id: msg.id, ok: true, value });
    } catch (e) {
      const errors: EngineError[] =
        e instanceof EngineFailure ? e.errors : [{ kind: 'internal', message: (e as Error)?.message ?? String(e) }];
      post({ type: 'result', id: msg.id, ok: false, errors });
    }
  }
};
