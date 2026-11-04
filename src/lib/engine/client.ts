// UI-side Engine: forwards every call to the engine worker.
import type { Engine, EngineError } from '../contracts/engine';
import type { EngineMethod, Request, Response } from './rpc';

export class EngineCallError extends Error {
  constructor(readonly errors: EngineError[]) {
    super(errors.map((e) => e.message).join('\n'));
    this.name = 'EngineCallError';
  }
}

export interface EngineClientOptions {
  wasmUrl: string;
  sha256?: string;
  onTiming?: (args: string[], ms: number, code: number) => void;
  /** Factory for tests; defaults to the bundled module worker. */
  createWorker?: () => Worker;
}

export type EngineClient = Engine & {
  ready: Promise<{ ms: number }>;
  terminate(): void;
};

export function createEngineClient(opts: EngineClientOptions): EngineClient {
  const worker =
    opts.createWorker?.() ?? new Worker(new URL('../../worker/engine.worker.ts', import.meta.url), { type: 'module', name: 'hledger' });
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  let readyResolve!: (v: { ms: number }) => void;
  let readyReject!: (e: unknown) => void;
  const ready = new Promise<{ ms: number }>((res, rej) => {
    readyResolve = res;
    readyReject = rej;
  });
  worker.onmessage = (ev: MessageEvent<Response>) => {
    const m = ev.data;
    if (m.type === 'ready') readyResolve({ ms: m.ms });
    else if (m.type === 'init-error') readyReject(new Error(m.message));
    else if (m.type === 'timing') opts.onTiming?.(m.args, m.ms, m.code);
    else if (m.type === 'result') {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.ok) p.resolve(m.value);
      else p.reject(new EngineCallError(m.errors));
    }
  };
  worker.onerror = (e) => readyReject(new Error(e.message || 'Engine worker failed'));
  const init: Request = { type: 'init', wasmUrl: opts.wasmUrl, ...(opts.sha256 ? { sha256: opts.sha256 } : {}) };
  worker.postMessage(init);

  const call = (method: EngineMethod, args: unknown[]) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      const req: Request = { type: 'call', id, method, args };
      worker.postMessage(req);
    });

  const methods: EngineMethod[] = [
    'load', 'check', 'transactions', 'register', 'balance', 'periodicBalance', 'balanceSheet', 'incomeStatement',
    'cashFlow', 'budget', 'accounts', 'commodities', 'payees', 'csvPreview', 'raw', 'version',
  ];
  const client = { ready, terminate: () => worker.terminate() } as EngineClient;
  for (const m of methods) (client as unknown as Record<string, unknown>)[m] = (...args: unknown[]) => call(m, args);
  return client;
}
