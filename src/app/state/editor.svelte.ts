// Which transaction sheets are open. One editor, one detail view, app-wide.
import type { Txn } from '$lib/contracts/engine';
import type { TxnDraft } from '$lib/contracts/writer';

class EditorState {
  open = $state(false);
  /** The transaction being edited; null = new. */
  txn = $state.raw<Txn | null>(null);
  /** Pre-filled draft (duplicate, import, reconcile). */
  initial = $state.raw<TxnDraft | null>(null);
  /** Open straight into raw-text mode. */
  rawMode = $state(false);

  detailOpen = $state(false);
  detail = $state.raw<Txn | null>(null);

  openNew(initial: TxnDraft | null = null) {
    this.txn = null;
    this.initial = initial;
    this.rawMode = false;
    this.detailOpen = false;
    this.open = true;
  }
  openEdit(txn: Txn, raw = false) {
    this.txn = txn;
    this.initial = null;
    this.rawMode = raw;
    this.detailOpen = false;
    this.open = true;
  }
  show(txn: Txn) {
    this.detail = txn;
    this.detailOpen = true;
  }
}

export const editor = new EditorState();
