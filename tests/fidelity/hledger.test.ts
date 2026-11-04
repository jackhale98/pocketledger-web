// Cross-check against the official hledger binary (skipped when it is absent):
// real tsourcepos spans drive the writer, and everything it writes must still
// parse and balance in hledger.

import { spawnSync } from 'node:child_process';
import { accessSync, constants, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Txn } from '../../src/lib/contracts/engine';
import type { Patch, TxnDraft } from '../../src/lib/contracts/writer';
import { apply, draftFromTxn, planAdd, planDelete, planEdit } from '../../src/lib/journal/writer';
import { loadVaults, scanTxns, snap, variantVault, type Vault } from './helpers';

const HLEDGER = process.env.HLEDGER_BIN ?? '/home/user/dl/native/hledger';
const available = (() => {
  try {
    accessSync(HLEDGER, constants.X_OK);
    return true;
  } catch {
    return false;
  }
})();

interface JTxn {
  tindex: number;
  tdate: string;
  tdescription: string;
  tcomment: string;
  tsourcepos: { sourceName: string; sourceLine: number; sourceColumn: number }[];
  tpostings: { paccount: string; pamount: { acommodity: string; aquantity: { floatingPoint: number } }[] }[];
}

const tmpRoot = available ? mkdtempSync(join(tmpdir(), 'pl-writer-')) : '';
afterAll(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

let n = 0;
/** Write the vault to a fresh directory and run `hledger print -O json` on it. */
function hledgerPrint(files: Record<string, string>, rootFile: string): { dir: string; txns: JTxn[] } {
  const dir = join(tmpRoot, String(n++));
  spawnSync('mkdir', ['-p', dir]);
  for (const [f, t] of Object.entries(files)) writeFileSync(join(dir, f), t);
  const r = spawnSync(HLEDGER, ['-f', join(dir, rootFile), '-I', 'print', '-O', 'json'], { encoding: 'utf8', maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`hledger failed (${rootFile}):\n${r.stderr}`);
  return { dir, txns: JSON.parse(r.stdout) as JTxn[] };
}

/** Txns with spans from hledger's own tsourcepos (end is the line after the transaction). */
function txnsFromHledger(dir: string, txns: JTxn[]): Txn[] {
  return txns.map((t) => {
    const [start, end] = t.tsourcepos;
    const endLine = end!.sourceColumn === 1 ? end!.sourceLine - 1 : end!.sourceLine;
    return {
      index: t.tindex,
      date: t.tdate,
      status: '',
      code: '',
      description: t.tdescription,
      comment: t.tcomment,
      tags: [],
      postings: [],
      source: { file: relative(dir, start!.sourceName), startLine: start!.sourceLine, endLine },
    };
  });
}

const vaults: Vault[] = loadVaults().flatMap((v) => [variantVault(v, 'lf'), variantVault(v, 'crlf'), variantVault(v, 'bom-lf'), variantVault(v, 'no-final-newline')]);

describe.skipIf(!available)('against the hledger binary', () => {
  describe.each(vaults)('$name', (vault) => {
    it('hledger tsourcepos spans match the scanner, and no-op edits on them are byte-identical', () => {
      const { dir, txns } = hledgerPrint(vault.files, vault.rootFile);
      const real = txnsFromHledger(dir, txns);
      const scanned = Object.entries(vault.files).flatMap(([f, t]) => scanTxns(t, f));
      const key = (t: Txn) => `${t.source!.file}:${t.source!.startLine}-${t.source!.endLine}`;
      expect(real.map(key).sort()).toEqual(scanned.map(key).sort());
      const s = snap(vault.files, vault.rootFile);
      for (const t of real) expect(planEdit(s, t, draftFromTxn(t, s))).toEqual([]);
    });

    it('a batch of edits, a dated insert, an append and a delete still parse and balance in hledger', () => {
      const { dir, txns } = hledgerPrint(vault.files, vault.rootFile);
      const real = txnsFromHledger(dir, txns);
      const s = snap(vault.files, vault.rootFile);
      const patches: Patch[] = [];
      // Delete the last transaction (deleting an earlier one could change what a later balance assignment computes).
      const victim = real[real.length - 1];
      const rest = real.slice(0, -1);
      patches.push(...planDelete(s, victim!));
      for (const t of rest) {
        const d = draftFromTxn(t, s);
        const edited: TxnDraft = { ...d, description: `${d.description} EDITED`.trim(), comment: d.comment ? `${d.comment}\nedited: yes` : 'edited: yes' };
        // Changing an explicit amount keeps the balance when the other posting is elided.
        const explicit = d.postings.filter((p) => p.amount);
        if (d.postings.length === 2 && explicit.length === 1 && !explicit[0]!.cost && d.postings.every((p) => !p.assertion) && /^-?[\d.,]+$/.test(explicit[0]!.amount!)) {
          edited.postings = d.postings.map((p) => (p.amount ? { ...p, amount: p.amount.startsWith('-') ? '-3' : '3' } : p));
        }
        edited.postings = edited.postings.map((p, i) => (i === 0 ? { ...p, comment: 'p:1' } : p));
        patches.push(...planEdit(s, t, edited));
      }
      const out = apply(vault.files, patches);

      // Then add two transactions to the result: one in date order, one appended.
      const s2 = snap(out, vault.rootFile);
      const after1 = hledgerPrint(out, vault.rootFile);
      const commodity = vault.rootFile.includes('comma') ? 'EUR' : undefined;
      const added: TxnDraft = {
        date: '2024-01-04',
        status: '*',
        code: 'W1',
        description: 'Writer added',
        comment: 'added:yes\nsecond line',
        postings: [
          { account: 'expenses:writer', amount: vault.rootFile.includes('comma') ? '12,34' : '12.34', ...(commodity ? { commodity } : {}), comment: 'tag:x' },
          { account: 'assets:writer' },
        ],
      };
      const p2 = [
        ...planAdd(s2, added, { dateOrder: true, txns: txnsFromHledger(after1.dir, after1.txns) }),
        ...planAdd(s2, { ...added, date: '2099-12-31', description: 'Writer appended' }),
      ];
      const final = apply(out, p2);
      const { txns: parsed } = hledgerPrint(final, vault.rootFile);
      expect(parsed.length).toBe(real.length - 1 + 2);
      expect(parsed.filter((t) => t.tdescription.endsWith('EDITED')).length).toBe(rest.filter((t) => t.description.trim()).length);
      const w = parsed.find((t) => t.tdescription === 'Writer added')!;
      expect(w.tcomment).toContain('added:yes');
      expect(w.tpostings[0]!.pamount[0]!.aquantity.floatingPoint).toBeCloseTo(12.34);
      expect(parsed.some((t) => t.tdescription === 'Writer appended')).toBe(true);
    });
  });
});
