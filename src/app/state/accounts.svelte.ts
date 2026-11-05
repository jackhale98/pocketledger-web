// Accounts screen state, kept while you visit a register and come back.
class AccountsViewState {
  filter = $state('all');
  search = $state('');
  showZero = $state(false);
  /** Collapsed parents; null = default (only top level expanded). */
  collapsed = $state<Set<string> | null>(null);
}
export const accountsView = new AccountsViewState();
