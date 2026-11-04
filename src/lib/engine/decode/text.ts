import type { AccountType } from '../../contracts/engine';

/** `hledger accounts --types` lines: `assets:bank   ; type: A` */
export function decodeAccountTypes(stdout: string): { name: string; type: AccountType | null }[] {
  const out: { name: string; type: AccountType | null }[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const m = /^(.*?)\s*(?:;\s*type:\s*([ALERXCV]))?\s*$/.exec(raw);
    if (!m) continue;
    out.push({ name: m[1]!.trim(), type: (m[2] as AccountType | undefined) ?? null });
  }
  return out;
}

export const decodeLines = (stdout: string): string[] =>
  stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
