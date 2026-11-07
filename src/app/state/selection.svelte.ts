// A set of picked transactions for bulk actions (Transactions → Select).
//
// Each pick keeps the transaction's exact source text from when it was picked,
// keyed by its current span. After a save the picks are re-found in the new
// files (app.relocate), so a pick follows its transaction when lines move and
// is dropped when that text is gone; picks are independent of filters and
// paging, so they survive scrolling and searching.

import type { Txn } from '$lib/contracts/engine';
import { app } from './app.svelte';

export interface Pick {
  txn: Txn;
  /** Source text when picked (app.sourceText). */
  text: string;
}

export const pickKey = (t: Txn) => (t.source ? `${t.source.file}\u0000${t.source.startLine}` : '');
/** Only transactions written in a file can be picked (not forecast ones). */
export const pickable = (t: Txn) => !!t.source && !t.generated;

export class TxnSelection {
  active = $state(false);
  picks = $state.raw<Map<string, Pick>>(new Map());

  get size() {
    return this.picks.size;
  }
  has(t: Txn) {
    return this.picks.has(pickKey(t));
  }
  list(): Pick[] {
    return [...this.picks.values()];
  }
  toggle(t: Txn) {
    if (!pickable(t)) return;
    const next = new Map(this.picks);
    const k = pickKey(t);
    if (next.has(k)) next.delete(k);
    else {
      const text = app.sourceText(t);
      if (text == null) return;
      next.set(k, { txn: t, text });
    }
    this.picks = next;
  }
  addAll(txns: Txn[]) {
    const next = new Map(this.picks);
    for (const t of txns) {
      if (!pickable(t) || next.has(pickKey(t))) continue;
      const text = app.sourceText(t);
      if (text != null) next.set(pickKey(t), { txn: t, text });
    }
    this.picks = next;
  }
  clear() {
    if (this.picks.size) this.picks = new Map();
  }
  /** Re-find every pick in the current files (after a save or sync); drop the ones whose text is gone. */
  remap() {
    if (!this.picks.size) return;
    const next = new Map<string, Pick>();
    for (const p of this.picks.values()) {
      const t = app.relocate(p.txn, p.text);
      if (t) next.set(pickKey(t), { txn: t, text: p.text });
    }
    this.picks = next;
  }
}
