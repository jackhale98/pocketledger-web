// The browser wiring for a git vault: LightningFS (IndexedDB database
// `pocketledger-git-<vaultId>`) and isomorphic-git's fetch-based HTTP client.
// Kept apart from workspace.ts so Node tests don't load LightningFS.

import './polyfill';
import LightningFS from '@isomorphic-git/lightning-fs';
import http from 'isomorphic-git/http/web';
import type { PromiseFsClient } from 'isomorphic-git';
import type { VaultRecord } from '$lib/contracts/storage';
import { deleteDatabase } from '$lib/store/idb';
import { IsoGitWorkspace, type IsoGitWorkspaceOptions } from './workspace';

export const GIT_DIR = '/repo';
export const gitDbName = (vaultId: string) => `pocketledger-git-${vaultId}`;

/** Open (not clone) the git workspace for a vault whose `remote.kind` is 'github'. */
export function openGitWorkspace(
  vault: VaultRecord,
  token: IsoGitWorkspaceOptions['token'],
  extra: Pick<IsoGitWorkspaceOptions, 'include' | 'validate'> = {},
): IsoGitWorkspace {
  if (vault.remote?.kind !== 'github') throw new Error('This vault is not a git vault.');
  const fs = new LightningFS(gitDbName(vault.id)) as unknown as PromiseFsClient;
  return new IsoGitWorkspace({ fs, http, dir: GIT_DIR, remote: vault.remote, token, ...extra });
}

/** Delete a vault's local clone (the remote is untouched). */
export async function destroyGitWorkspace(vaultId: string): Promise<void> {
  // LightningFS keeps its files in one IndexedDB database named after the fs.
  new LightningFS(gitDbName(vaultId), { wipe: true });
  if (typeof indexedDB !== 'undefined') await deleteDatabase(indexedDB, gitDbName(vaultId));
}
