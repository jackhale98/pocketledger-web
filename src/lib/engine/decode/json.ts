// hledger's JSON encodes Decimal mantissas as JSON integers, which can exceed
// 2^53. Quote them before JSON.parse so no precision is ever lost.
export function parseHledgerJson<T = unknown>(text: string): T {
  const safe = text.replace(/("decimalMantissa":\s*)(-?\d+)/g, '$1"$2"');
  return JSON.parse(safe) as T;
}
