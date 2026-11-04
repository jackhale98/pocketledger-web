// Message protocol between the UI thread and the engine worker.
import type { Engine, EngineError } from '../contracts/engine';

export type EngineMethod = keyof Engine;

export type Request =
  | { type: 'init'; wasmUrl: string; sha256?: string; hledger?: string }
  | { type: 'call'; id: number; method: EngineMethod; args: unknown[] };

export type Response =
  | { type: 'ready'; ms: number }
  | { type: 'init-error'; message: string }
  | { type: 'result'; id: number; ok: true; value: unknown }
  | { type: 'result'; id: number; ok: false; errors: EngineError[] }
  | { type: 'timing'; args: string[]; ms: number; code: number };
