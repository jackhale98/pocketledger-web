// Which transaction sheets are open. One editor, one detail view, app-wide.
import type { Txn } from '$lib/contracts/engine';
import type { TxnDraft } from '$lib/contracts/writer';
import { app } from './app.svelte';

class EditorState {
  open = $state(false);
  /** The transaction being edited; null = new. */
  txn = $state.raw<Txn | null>(null);
  /** Pre-filled draft (duplicate, import, reconcile). */
  initial = $state.raw<TxnDraft | null>(null);
  /** The transaction's exact source text when it was opened (to detect changes made elsewhere). */
  txnText = $state<string | null>(null);
  /** Open straight into raw-text mode. */
  rawMode = $state(false);

  detailOpen = $state(false);
  detail = $state.raw<Txn | null>(null);
  detailText = $state<string | null>(null);

  openNew(initial: TxnDraft | null = null) {
    this.txn = null;
    this.initial = initial;
    this.rawMode = false;
    this.detailOpen = false;
    this.open = true;
  }
  openEdit(txn: Txn, raw = false) {
    // From the detail sheet, keep the text captured when it opened.
    const sameAsDetail = this.detail === txn && this.detailText != null;
    this.txnText = sameAsDetail ? this.detailText : app.sourceText(txn);
    this.txn = txn;
    this.initial = null;
    this.rawMode = raw;
    this.detailOpen = false;
    this.open = true;
  }
  show(txn: Txn) {
    this.detail = txn;
    this.detailText = app.sourceText(txn);
    this.detailOpen = true;
  }
}

export const editor = new EditorState();
