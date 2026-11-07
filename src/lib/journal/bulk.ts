// Bulk edits over a set of transactions: change an account, set the header
// status, or delete. Planned with the writer (planEdit / planDelete) one
// transaction at a time, bottom-up within each file, on a working copy of the
// files, so every span stays valid and the result can be saved as one change
// (one undo step). Everything outside the edited spans stays byte-identical.

import type { Status, Txn, VaultSnapshot } from '../contracts/engine';
import { draftFromTxn, planDelete, planEdit, apply } from './writer';
import { accountNameProblem } from './rename';

export type BulkAction =
  /** Replace account `from` (exactly; not its subaccounts) with `to` in the transactions' postings. */
  | { kind: 'account'; from: string; to: string }
  /** Set the transaction header's status: '*' cleared, '!' pending, '' unmarked. */
  | { kind: 'status'; status: Status }
  | { kind: 'delete' };

export interface BulkPlan {
  files: Record<string, string>;
  /** Transactions whose text changed. */
  changed: number;
  /** Transactions the action did not change (already in that state, or without that account). */
  unchanged: number;
}

/** Order transactions for editing: per file, bottom-up, each span once. */
export function bottomUp(txns: Txn[]): Txn[] {
  const seen = new Set<string>();
  const list = txns.filter((t) => {
    if (!t.source || t.generated) return false;
    const k = `${t.source.file}\u0000${t.source.startLine}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return list.sort((a, b) =>
    a.source!.file === b.source!.file ? b.source!.startLine - a.source!.startLine : a.source!.file < b.source!.file ? -1 : 1,
  );
}

/** Accounts used by the transactions' own postings (not auto-generated ones), sorted. */
export function accountsUsed(txns: Txn[]): string[] {
  return [...new Set(txns.flatMap((t) => t.postings.filter((p) => !p.generated).map((p) => p.account)))].sort();
}

/**
 * Plan a bulk action. `txns` must have source spans valid for `files` (re-find
 * them first, e.g. with the app's `relocate`). Throws StalePatchError when a
 * span no longer points at a transaction, and Error for an invalid new account.
 */
export function planBulk(files: Record<string, string>, rootFile: string, txns: Txn[], action: BulkAction): BulkPlan {
  if (action.kind === 'account') {
    const problem = accountNameProblem(action.to);
    if (problem) throw new Error(problem);
  }
  let next = { ...files };
  let changed = 0;
  let unchanged = 0;
  for (const txn of bottomUp(txns)) {
    const snap: VaultSnapshot = { rootFile, files: next, revision: '' };
    let patches;
    if (action.kind === 'delete') patches = planDelete(snap, txn);
    else {
      const d = draftFromTxn(txn, snap);
      if (action.kind === 'status') patches = planEdit(snap, txn, { ...d, status: action.status });
      else
        patches = planEdit(snap, txn, {
          ...d,
          postings: d.postings.map((p) => (p.account === action.from ? { ...p, account: action.to } : p)),
        });
    }
    if (patches.length === 0) unchanged++;
    else {
      changed++;
      next = apply(next, patches);
    }
  }
  return { files: next, changed, unchanged };
}
