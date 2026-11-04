// Sync status shared by the UI. Providers are wired in by startSync().
class SyncState {
  status = $state<'idle' | 'syncing' | 'error' | 'offline'>('idle');
  pending = $state(0);
  lastSync = $state<number | null>(null);
  message = $state('');
}
export const syncState = new SyncState();

export function startSync() {
  if (typeof window === 'undefined') return;
  const update = () => (syncState.status = navigator.onLine ? 'idle' : 'offline');
  window.addEventListener('online', update);
  window.addEventListener('offline', update);
  update();
}
