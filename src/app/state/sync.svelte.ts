// Sync controller: connects the open vault to its provider (Dropbox, GitHub REST,
// git via proxy, or a folder on disk), schedules syncs, validates merges with
// hledger, and keeps one editing tab per vault.

import type { FileConflict, SyncProvider, SyncResult, VaultRecord } from '$lib/contracts/storage';
import { VaultSyncEngine, SyncScheduler, pendingCount, localTexts } from '$lib/sync';
import { DropboxProvider } from '$lib/dropbox';
import { GitHubRestProvider, githubSecretKey } from '$lib/git';
import { openGitWorkspace } from '$lib/git/browser';
import type { IsoGitWorkspace } from '$lib/git/workspace';
import { TabCoordinator } from '$lib/pwa/tabs';
import { dropboxAppKey } from '$lib/config';
import { makeSnapshot } from '$lib/vault';
import { persistStorage } from '$lib/pwa/register';
import { app } from './app.svelte';
import { toasts } from './toast.svelte';

class SyncState {
  status = $state<'idle' | 'syncing' | 'error' | 'offline'>('idle');
  pending = $state(0);
  lastSync = $state<number | null>(null);
  message = $state('');
  conflicts = $state.raw<FileConflict[]>([]);
  invalid = $state.raw<{ path: string; message: string }[]>([]);
  /** Git mode: uncommitted / unpushed state. */
  git = $state.raw<{ changed: { path: string; status: string }[]; ahead: number; behind: number } | null>(null);
}
export const syncState = new SyncState();

let tabs: TabCoordinator | null = null;
let scheduler: SyncScheduler | null = null;
let engine: VaultSyncEngine | null = null;
let provider: SyncProvider | null = null;
let gitWs: IsoGitWorkspace | null = null;
let currentVault: string | null = null;

async function validate(files: Record<string, string>, vault: VaultRecord) {
  if (!app.engine) return [];
  const errs = await app.engine.check(makeSnapshot(files, vault.rootFile));
  return errs.map((e) => ({ path: e.file ?? vault.rootFile, message: e.message }));
}

async function token(vaultId: string) {
  return (await app.getStore()?.getSecret(githubSecretKey(vaultId))) ?? null;
}

/** Re-read the vault's files from the store after a sync pulled changes. */
async function reloadFromStore() {
  const store = app.getStore();
  if (!store || !app.vault) return;
  const files = await localTexts(store, app.vault.id);
  const changed = Object.keys({ ...files, ...app.files }).some((p) => files[p] !== app.files[p]);
  if (changed) {
    app.files = files;
    await app.reload();
  }
}

async function refreshPending() {
  const store = app.getStore();
  if (store && app.vault && app.vault.provider !== 'demo') syncState.pending = await pendingCount(store, app.vault.id);
  else syncState.pending = 0;
}

function report(r: SyncResult) {
  syncState.lastSync = Date.now();
  syncState.conflicts = r.conflicts;
  syncState.invalid = r.invalid;
  if (r.conflicts.length) toasts.show(`${r.conflicts.length} file(s) changed on both sides: resolve in Settings → Sync`, { tone: 'error' });
  else if (r.invalid.length) toasts.show('Synced changes would break the journal; uploads paused. See Settings → Sync.', { tone: 'error' });
}

/** Run one sync for the open vault now. */
export async function syncNow(): Promise<void> {
  const vault = app.vault;
  const store = app.getStore();
  if (!vault || !store || !engine || !provider || !tabs) return;
  if (!navigator.onLine) {
    syncState.status = 'offline';
    return;
  }
  syncState.status = 'syncing';
  try {
    const r = await tabs.withSyncLock(vault.id, () => engine!.sync(vault, provider!));
    if (!r) {
      syncState.status = 'idle';
      return; // another tab is syncing this vault
    }
    report(r);
    if (vault.conflicted !== app.vault?.conflicted) await app.updateVault({ conflicted: !!vault.conflicted });
    if (r.pulled.length || r.deleted.length) await reloadFromStore();
    syncState.status = 'idle';
    syncState.message = '';
  } catch (e) {
    syncState.status = 'error';
    syncState.message = (e as Error).message;
  } finally {
    await refreshPending();
  }
}

function stopProvider() {
  scheduler?.stop();
  scheduler = null;
  engine = null;
  provider = null;
  gitWs = null;
  syncState.git = null;
  syncState.conflicts = [];
  syncState.invalid = [];
}

async function attach(vault: VaultRecord) {
  stopProvider();
  currentVault = vault.id;
  tabs?.open(vault.id);
  const store = app.getStore();
  if (!store) return;
  await refreshPending();
  try {
    if (vault.provider === 'dropbox') {
      provider = DropboxProvider.forVault(vault, store, { appKey: dropboxAppKey() ?? '' });
    } else if (vault.provider === 'github' && vault.remote?.kind === 'github' && vault.remote.transport === 'rest') {
      provider = GitHubRestProvider.fromRemote(vault.remote, () => token(vault.id));
    } else if (vault.provider === 'github') {
      gitWs = openGitWorkspace(vault, () => token(vault.id), { validate: (files) => validate(files, vault) });
      await refreshGit();
      return;
    } else return;
    engine = new VaultSyncEngine({ store, validate });
    scheduler = new SyncScheduler({
      run: async () => {
        await syncNow();
        return true;
      },
      onError: (e) => {
        syncState.status = 'error';
        syncState.message = (e as Error).message;
      },
    });
    scheduler.start();
  } catch (e) {
    syncState.status = 'error';
    syncState.message = (e as Error).message;
  }
}

// ------------------------------------------------------------------ git mode

export async function refreshGit() {
  if (!gitWs) return;
  try {
    const [changed, ab] = await Promise.all([gitWs.status(), gitWs.aheadBehind()]);
    syncState.git = { changed, ...ab };
  } catch (e) {
    syncState.message = (e as Error).message;
  }
}
export function gitWorkspace(): IsoGitWorkspace | null {
  return gitWs;
}
export async function gitCommit(message: string) {
  if (!gitWs || !syncState.git) return;
  await gitWs.commit(syncState.git.changed.map((c) => c.path), message);
  await refreshGit();
}
export async function gitPull() {
  if (!gitWs) return;
  syncState.status = 'syncing';
  try {
    const r = await gitWs.pull();
    syncState.conflicts = r.conflicts;
    if (r.updated.length) {
      const files = await gitWs.readFiles();
      await app.commitFiles(files, 'pull', { allowUndo: false, skipValidation: true });
    }
    syncState.status = 'idle';
  } catch (e) {
    syncState.status = 'error';
    syncState.message = (e as Error).message;
  }
  await refreshGit();
}
export async function gitPush() {
  if (!gitWs) return;
  syncState.status = 'syncing';
  const r = await gitWs.push().catch((e: Error) => ({ ok: false, message: e.message }));
  syncState.status = r.ok ? 'idle' : 'error';
  syncState.message = r.ok ? '' : (r.message ?? 'Push failed');
  if (r.ok) toasts.show('Pushed to GitHub', { tone: 'ok' });
  await refreshGit();
}

// ------------------------------------------------------------------ folder on disk

async function writeFolder(vault: VaultRecord, paths: string[]) {
  const store = app.getStore();
  const dir = (await store?.getSetting<FileSystemDirectoryHandle>(`fsa:${vault.id}`)) ?? null;
  if (!dir) return;
  const h = dir as unknown as { queryPermission(o: object): Promise<string>; requestPermission(o: object): Promise<string> };
  if ((await h.queryPermission({ mode: 'readwrite' })) !== 'granted' && (await h.requestPermission({ mode: 'readwrite' })) !== 'granted') {
    toasts.show('Saved in the browser, but the folder is not writable: allow access to save to disk.', { tone: 'error' });
    return;
  }
  for (const path of paths) {
    const parts = path.split('/');
    let d: FileSystemDirectoryHandle = dir;
    for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p, { create: true });
    const text = app.files[path];
    if (text == null) await d.removeEntry(parts[parts.length - 1]!).catch(() => {});
    else {
      const w = await (await d.getFileHandle(parts[parts.length - 1]!, { create: true })).createWritable();
      await w.write(text);
      await w.close();
    }
  }
}

// ------------------------------------------------------------------ start

export function startSync() {
  if (typeof window === 'undefined') return;
  const online = () => {
    if (!navigator.onLine) syncState.status = 'offline';
    else if (syncState.status === 'offline') syncState.status = 'idle';
  };
  window.addEventListener('online', online);
  window.addEventListener('offline', online);
  online();

  tabs = new TabCoordinator({
    onRole: (role) => (app.readOnly = role === 'follower'),
    onChanged: () => void reloadFromStore(),
  });
  window.addEventListener('pl:edit-here', () => tabs?.editHere());

  app.onSaved = (vault, paths) => {
    void persistStorage();
    tabs?.changed(paths);
    if (vault.provider === 'fsa') void writeFolder(vault, paths);
    else if (gitWs) void gitWs.writeFiles(paths.map((p) => ({ path: p, text: app.files[p] ?? null }))).then(refreshGit);
    else scheduler?.saved();
    void refreshPending();
  };

  // Follow the open vault.
  $effect.root(() => {
    $effect(() => {
      const v = app.vault;
      if (!v || v.id === currentVault) return;
      if (v.provider === 'demo') {
        stopProvider();
        currentVault = v.id;
        tabs?.leave();
        app.readOnly = false;
        syncState.pending = 0;
        return;
      }
      void attach(v);
    });
  });
}

/** Record a hand-resolved conflict and sync again. */
export async function resolveConflict(conflict: FileConflict, text: string) {
  if (!engine || !app.vault) return;
  await engine.resolve(app.vault.id, conflict, text);
  syncState.conflicts = syncState.conflicts.filter((c) => c.path !== conflict.path);
  await reloadFromStore();
  await syncNow();
}
