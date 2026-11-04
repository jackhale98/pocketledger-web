// Fidelity: for every fixture x every transaction x every byte-level variant
// (LF, CRLF, BOM, no final newline), the writer changes only what it must.

import { describe, expect, it } from 'vitest';
import type { Txn } from '../../src/lib/contracts/engine';
import type { Patch, TxnDraft } from '../../src/lib/contracts/writer';
import { findTxnSpans } from '../../src/lib/journal/locate';
import {
  apply,
  draftFromText,
  draftFromTxn,
  planAdd,
  planDelete,
  planEdit,
  planReplaceText,
  styleForFile,
} from '../../src/lib/journal/writer';
import {
  VARIANTS,
  canonDraft,
  commonEdges,
  loadVaults,
  maxBlankRun,
  scanTxns,
  snap,
  textLines,
  variantVault,
  type Vault,
} from './helpers';

const vaults = loadVaults().flatMap((v) => VARIANTS.map((variant) => ({ variant, vault: variantVault(v, variant) })));

function spanText(text: string, t: Txn): string {
  return textLines(text)
    .slice(t.source!.startLine - 1, t.source!.endLine)
    .join(text.includes('\r\n') ? '\r\n' : '\n');
}

/** Text of every transaction in a file, in order (splitting the file once). */
function spanTexts(text: string, file: string, skipStart?: number): string[] {
  const lines = textLines(text);
  return scanTxns(text, file)
    .filter((x) => x.source!.startLine !== skipStart)
    .map((x) => lines.slice(x.source!.startLine - 1, x.source!.endLine).join('\n'));
}

/** Every file's transactions (by the independent scanner). */
function allTxns(v: Vault): Txn[] {
  return Object.entries(v.files).flatMap(([f, t]) => scanTxns(t, f));
}

function checkEol(before: string, after: string): void {
  expect(after.startsWith('﻿')).toBe(before.startsWith('﻿'));
  if (before.includes('\r\n')) expect(/(^|[^\r])\n/.test(after)).toBe(false);
  else expect(after.includes('\r')).toBe(false);
}

type Mutation = { name: string; lines?: number; mutate: (d: TxnDraft) => TxnDraft | null };

const mutations: Mutation[] = [
  { name: 'description', lines: 1, mutate: (d) => ({ ...d, description: `${d.description} EDITED`.trim() }) },
  {
    name: 'amount',
    lines: 1,
    mutate: (d) => {
      const i = d.postings.findIndex((p) => p.amount && /^-?[\d.,]+$/.test(p.amount));
      if (i < 0) return null;
      const postings = d.postings.map((p, k) => (k === i ? { ...p, amount: `${p.amount!.startsWith('-') ? '-' : ''}7` } : p));
      return { ...d, postings };
    },
  },
  {
    name: 'account',
    lines: 1,
    mutate: (d) => {
      if (!d.postings.length) return null;
      const i = d.postings.length - 1;
      return { ...d, postings: d.postings.map((p, k) => (k === i ? { ...p, account: `${p.account}:renamed` } : p)) };
    },
  },
  { name: 'comment', mutate: (d) => ({ ...d, comment: 'edited:yes' }) },
  { name: 'add posting', mutate: (d) => ({ ...d, postings: [...d.postings, { account: 'expenses:extra', amount: '1', commodity: '' }] }) },
  { name: 'remove posting', mutate: (d) => (d.postings.length > 2 ? { ...d, postings: d.postings.slice(1) } : null) },
];

/** Heavy per-transaction checks run on a spread-out sample of big files (all of a small one). */
function sample<T>(xs: T[], max = 80): T[] {
  if (xs.length <= max) return xs;
  const step = xs.length / max;
  return Array.from({ length: max }, (_, i) => xs[Math.floor(i * step)]!).concat([xs[xs.length - 1]!]);
}

describe.each(vaults)('$vault.name', ({ vault }) => {
  const txns = allTxns(vault);
  const some = sample(txns);

  it('the locate scanner agrees with the independent test scanner', () => {
    for (const [f, t] of Object.entries(vault.files)) {
      expect(findTxnSpans(t, f)).toEqual(scanTxns(t, f).map((x) => x.source));
    }
  });

  it('no-op edit and no-op text replace are byte-identical for every transaction', () => {
    const s = snap(vault.files, vault.rootFile);
    expect(txns.length).toBeGreaterThan(0);
    for (const t of txns) {
      const d = draftFromTxn(t, s);
      const patches = planEdit(s, t, d);
      expect(patches, `txn at ${t.source!.file}:${t.source!.startLine}`).toEqual([]);
      expect(apply(vault.files, patches)).toEqual(vault.files);
      expect(planReplaceText(s, t, spanText(vault.files[t.source!.file]!, t))).toEqual([]);
    }
  });

  it('a draft from a span re-renders to the same meaning (formatTxn -> draftFromText)', async () => {
    const { formatTxn } = await import('../../src/lib/journal/writer');
    for (const t of txns) {
      const style = styleForFile(vault.files, t.source!.file, vault.rootFile);
      const d = draftFromTxn(t, vault.files[t.source!.file]!);
      expect(canonDraft(draftFromText(formatTxn(d, style)), style)).toEqual(canonDraft(d, style));
    }
  });

  it.each(mutations)('fuzzed edit ($name) changes only lines inside the span', ({ mutate, lines: changed }) => {
    const s = snap(vault.files, vault.rootFile);
    for (const t of some) {
      const file = t.source!.file;
      const before = vault.files[file]!;
      const d = mutate(draftFromTxn(t, before));
      if (!d) continue;
      const patches = planEdit(s, t, d);
      expect(patches.length).toBe(1);
      const after = apply(vault.files, patches)[file]!;
      checkEol(before, after);
      const a = textLines(before);
      const b = textLines(after);
      const { prefix, suffix } = commonEdges(a, b);
      const { startLine, endLine } = t.source!;
      // Every differing line is inside the transaction's span.
      expect(prefix).toBeGreaterThanOrEqual(startLine - 1);
      expect(suffix).toBeGreaterThanOrEqual(a.length - endLine);
      if (changed !== undefined) {
        expect(b.length).toBe(a.length);
        expect(a.filter((l, i) => l !== b[i]).length).toBe(changed);
      }
      // The edited transaction still reads back as the draft.
      const newEnd = endLine + (b.length - a.length);
      const style = styleForFile(vault.files, file, vault.rootFile);
      const reread = draftFromText(b.slice(startLine - 1, newEnd).join('\n'));
      expect(canonDraft(reread, style)).toEqual(canonDraft(d, style));
      expect(scanTxns(after, file).length).toBe(scanTxns(before, file).length);
    }
  });

  it('delete then re-add of the same draft re-parses, with no double blank lines', () => {
    const s = snap(vault.files, vault.rootFile);
    for (const t of some) {
      const file = t.source!.file;
      const before = vault.files[file]!;
      const d = draftFromTxn(t, before);
      const deleted = apply(vault.files, planDelete(s, t));
      const del = deleted[file]!;
      checkEol(before, del);
      expect(maxBlankRun(del)).toBeLessThanOrEqual(Math.max(1, maxBlankRun(before)));
      const others = spanTexts(before, file, t.source!.startLine);
      expect(spanTexts(del, file)).toEqual(others);

      const style = styleForFile(vault.files, file, vault.rootFile);
      for (const dateOrder of [false, true]) {
        const s2 = snap(deleted, vault.rootFile);
        const added = apply(deleted, planAdd(s2, d, { targetFile: file, dateOrder, txns: scanTxns(del, file) }))[file]!;
        checkEol(before, added);
        expect(added.endsWith('\n')).toBe(before.endsWith('\n'));
        const now = spanTexts(added, file);
        expect(now.length).toBe(others.length + 1);
        // Exactly one span is new, and it reads back as the draft.
        const pool = new Map<string, number>();
        for (const x of others) pool.set(x, (pool.get(x) ?? 0) + 1);
        const fresh = now.filter((x) => {
          const c = pool.get(x) ?? 0;
          if (c > 0) pool.set(x, c - 1);
          return c === 0;
        });
        expect(fresh.length).toBeLessThanOrEqual(1);
        const newText = fresh[0] ?? spanText(before, t);
        expect(canonDraft(draftFromText(newText), style)).toEqual(canonDraft(d, style));
        expect(maxBlankRun(added)).toBeLessThanOrEqual(Math.max(1, maxBlankRun(before)));
      }
    }
  });

  it('a batch edit of every transaction keeps every line outside the spans (comments, tags, directives)', () => {
    const s = snap(vault.files, vault.rootFile);
    const patches: Patch[] = txns.flatMap((t) => planEdit(s, t, { ...draftFromTxn(t, s), description: 'BATCH' }));
    const out = apply(vault.files, patches);
    for (const [file, before] of Object.entries(vault.files)) {
      const after = out[file]!;
      checkEol(before, after);
      const inSpan = (text: string) => {
        const set = new Set<number>();
        for (const x of scanTxns(text, file)) for (let i = x.source!.startLine; i <= x.source!.endLine; i++) set.add(i);
        return textLines(text).filter((_, i) => !set.has(i + 1));
      };
      expect(inSpan(after)).toEqual(inSpan(before));
      const n = scanTxns(before, file).length;
      expect(scanTxns(after, file).length).toBe(n);
    }
  });
});
