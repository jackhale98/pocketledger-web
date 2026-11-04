// Engine backends execute hledger with a given argv against a mounted file set.
// Option A (CLI): a fresh WASI command instance per call (WasiCliBackend).
// Option B (reactor): a long-lived instance with a parse cache (future; same interface).

import { ConsoleStdout, Directory, File, OpenFile, PreopenDirectory, WASI, type Inode } from '@bjorn3/browser_wasi_shim';
import type { RawResult } from '../contracts/engine';

/** Absolute mount point of the vault inside the engine's filesystem. */
export const VAULT_ROOT = '/vault';

export interface EngineBackend {
  readonly mode: 'cli' | 'reactor';
  /** Replace the mounted files (vault-relative path -> text or bytes). */
  mount(files: Record<string, string | Uint8Array>): void;
  run(args: string[]): Promise<RawResult>;
}

const enc = new TextEncoder();

/** Build a directory tree for the shim from a flat path map. */
export function buildTree(files: Record<string, string | Uint8Array>): Map<string, Inode> {
  const root = new Map<string, Inode>();
  for (const [path, content] of Object.entries(files)) {
    const parts = path.split('/').filter(Boolean);
    let dir = root;
    for (const part of parts.slice(0, -1)) {
      let next = dir.get(part);
      if (!(next instanceof Directory)) {
        next = new Directory(new Map());
        dir.set(part, next);
      }
      dir = (next as Directory).contents;
    }
    const bytes = typeof content === 'string' ? enc.encode(content) : content;
    dir.set(parts[parts.length - 1]!, new File(bytes, { readonly: true }));
  }
  return root;
}

export class WasiCliBackend implements EngineBackend {
  readonly mode = 'cli' as const;
  private vault = new Map<string, Inode>();

  constructor(private readonly module: WebAssembly.Module) {}

  mount(files: Record<string, string | Uint8Array>) {
    this.vault = buildTree(files);
  }

  async run(args: string[]): Promise<RawResult> {
    const out: Uint8Array[] = [];
    const err: Uint8Array[] = [];
    const root = new PreopenDirectory(
      '/',
      new Map<string, Inode>([
        ['vault', new Directory(this.vault)],
        ['tmp', new Directory(new Map())],
      ]),
    );
    const env = ['HOME=/', 'LC_ALL=C.UTF-8', 'LANG=C.UTF-8', 'TERM=dumb', 'PATH=/', 'PWD=/vault', 'COLUMNS=200'];
    const wasi = new WASI(['hledger', ...args], env, [
      new OpenFile(new File(new Uint8Array())),
      new ConsoleStdout((b) => out.push(b.slice())),
      new ConsoleStdout((b) => err.push(b.slice())),
      root,
    ]);
    const instance = await WebAssembly.instantiate(this.module, { wasi_snapshot_preview1: wasi.wasiImport });
    let code: number;
    try {
      code = wasi.start(instance as unknown as { exports: { memory: WebAssembly.Memory; _start: () => unknown } });
    } catch (e) {
      return { code: 70, stdout: decode(out), stderr: `${decode(err)}\nengine trap: ${(e as Error).message ?? e}` };
    }
    return { code, stdout: decode(out), stderr: decode(err) };
  }
}

function decode(chunks: Uint8Array[]): string {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const buf = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    buf.set(c, o);
    o += c.length;
  }
  return new TextDecoder().decode(buf);
}
