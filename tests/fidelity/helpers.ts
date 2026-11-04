// Test helpers for the writer fidelity suite. The transaction scanner here is
// deliberately independent of src/lib/journal/locate so the two cross-check.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Txn, VaultSnapshot } from '../../src/lib/contracts/engine';
import type { TxnDraft } from '../../src/lib/contracts/writer';
import { canonicalNumber, commodityStyle, parseNumber, type InferredStyle } from '../../src/lib/journal/writer';

export const FIXTURES = join(import.meta.dirname, '..', 'fixtures');

export interface Vault {
  name: string;
  rootFile: string;
  files: Record<string, string>;
}

/** Every fixture as a one-file vault, plus the writer fixtures (kitchen-sink includes included.journal). */
export function loadVaults(): Vault[] {
  const vaults: Vault[] = [];
  for (const f of readdirSync(FIXTURES).sort()) {
    if (!/\.(journal|hledger)$/.test(f)) continue;
    vaults.push({ name: f, rootFile: f, files: { [f]: readFileSync(join(FIXTURES, f), 'utf8') } });
  }
  const wdir = join(FIXTURES, 'writer');
  const wfiles: Record<string, string> = {};
  for (const f of readdirSync(wdir).sort()) wfiles[f] = readFileSync(join(wdir, f), 'utf8');
  for (const f of Object.keys(wfiles)) {
    if (f === 'included.journal') continue;
    const files: Record<string, string> = { [f]: wfiles[f]! };
    if (wfiles[f]!.includes('include included.journal')) files['included.journal'] = wfiles['included.journal']!;
    vaults.push({ name: `writer/${f}`, rootFile: f, files });
  }
  return vaults;
}

export type Variant = 'lf' | 'crlf' | 'bom-crlf' | 'bom-lf' | 'no-final-newline';
export const VARIANTS: Variant[] = ['lf', 'crlf', 'bom-crlf', 'bom-lf', 'no-final-newline'];

export function variantText(text: string, v: Variant): string {
  const lf = text.replace(/\r\n/g, '\n');
  switch (v) {
    case 'lf':
      return text;
    case 'crlf':
      return lf.replace(/\n/g, '\r\n');
    case 'bom-crlf':
      return '﻿' + lf.replace(/\n/g, '\r\n');
    case 'bom-lf':
      return '﻿' + lf;
    case 'no-final-newline':
      return lf.replace(/\n+$/, '');
  }
}

export function variantVault(v: Vault, variant: Variant): Vault {
  const files: Record<string, string> = {};
  for (const [k, t] of Object.entries(v.files)) files[k] = variantText(t, variant);
  return { name: `${v.name} [${variant}]`, rootFile: v.rootFile, files };
}

export function snap(files: Record<string, string>, rootFile: string): VaultSnapshot {
  return { rootFile, files, revision: 'test' };
}

export function textLines(text: string): string[] {
  return text.replace(/^﻿/, '').split(/\r?\n/);
}

/** Independent scanner: a date at column 0 starts a transaction, which runs until the next blank or non-indented line. */
export function scanTxns(text: string, file: string): Txn[] {
  const lines = textLines(text);
  if (lines[lines.length - 1] === '') lines.pop();
  const txns: Txn[] = [];
  let inComment = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (inComment) {
      if (/^end\s+comment\s*$/.test(line)) inComment = false;
      continue;
    }
    if (/^comment\s*$/.test(line)) {
      inComment = true;
      continue;
    }
    const m = /^(\d{1,4})([-/.])(\d{1,2})(?:\2(\d{1,2}))?(?:=\S+)?(?=\s|$)/.exec(line);
    if (!m) continue;
    let j = i;
    while (j + 1 < lines.length && /^[ \t]+\S/.test(lines[j + 1]!)) j++;
    const date = m[4] ? `${m[1]}-${m[3]!.padStart(2, '0')}-${m[4].padStart(2, '0')}` : line.split(/\s/)[0]!;
    txns.push({
      index: txns.length + 1,
      date,
      status: '',
      code: '',
      description: '',
      comment: '',
      tags: [],
      postings: [],
      source: { file, startLine: i + 1, endLine: j + 1 },
    });
    i = j;
  }
  return txns;
}

/** Number of identical lines at the start and at the end of two line arrays. */
export function commonEdges(a: string[], b: string[]): { prefix: number; suffix: number } {
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
  return { prefix, suffix };
}

function canonComment(c: string | undefined): string {
  const lines = (c ?? '').split('\n').map((s) => s.trim());
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

/** A draft in canonical form, for "means the same" comparisons. */
export function canonDraft(d: TxnDraft, style: InferredStyle): unknown {
  return {
    date: d.date.trim().replace(/[/.]/g, '-'),
    date2: d.date2 ?? '',
    status: d.status ?? '',
    code: d.code ?? '',
    description: d.description.trim(),
    comment: canonComment(d.comment),
    postings: d.postings.map((p) => {
      const commodity = p.amount ? (p.commodity ?? style.defaultCommodity ?? '') : '';
      const n = p.amount ? parseNumber(p.amount, commodityStyle(commodity, style).decimalMark) : null;
      return {
        account: p.account.trim(),
        type: p.type ?? 'regular',
        status: p.status ?? '',
        amount: n ? canonicalNumber(n) : (p.amount ?? '').trim(),
        commodity,
        cost: (p.cost ?? '').trim().replace(/\s+/g, ' '),
        assertion: (p.assertion ?? '').trim().replace(/\s+/g, ' '),
        comment: canonComment(p.comment),
      };
    }),
  };
}

/** Longest run of consecutive blank lines. */
export function maxBlankRun(text: string): number {
  let best = 0;
  let run = 0;
  for (const l of textLines(text)) {
    run = /^\s*$/.test(l) ? run + 1 : 0;
    best = Math.max(best, run);
  }
  return best;
}
