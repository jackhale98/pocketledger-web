import type { EngineError } from '../../contracts/engine';

/**
 * Turn hledger's stderr into structured errors. hledger prints
 * `hledger: Error: /vault/x.journal:12:5:` (or `:1-3:` for a range, or `:4:`),
 * then an excerpt and the explanation. The message is kept verbatim.
 */
export function decodeErrors(stderr: string, toVault: (abs: string) => string | null, fallback: EngineError['kind'] = 'parse'): EngineError[] {
  const text = stderr.replace(/\r\n/g, '\n').trim();
  if (!text) return [{ kind: 'internal', message: 'hledger failed without a message' }];
  const body = text.replace(/^hledger(?:\.wasm)?:\s*(?:Error:\s*)?/i, '');
  const err: EngineError = { kind: classify(body, fallback), message: body };
  const m = /^(\/[^\n]*?):(\d+)(?:-(\d+))?(?::(\d+))?:/.exec(body);
  if (m) {
    const file = toVault(m[1]!);
    if (file) err.file = file;
    err.line = Number(m[2]);
    if (m[4]) err.column = Number(m[4]);
    // Rewrite the absolute engine path to the vault-relative one in the message.
    if (file) err.message = body.replace(m[1]!, file);
  }
  return [err];
}

function classify(msg: string, fallback: EngineError['kind']): EngineError['kind'] {
  if (/balance assertion|assertion failed/i.test(msg)) return 'assertion';
  if (/unbalanced|could not be balanced|does not balance/i.test(msg)) return 'balance';
  if (/checking is enabled|undeclared|check/i.test(msg) && fallback === 'check') return 'check';
  return fallback;
}
