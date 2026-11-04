// Dropbox tokens for one vault, kept in the VaultStore's secrets store, with
// refresh shortly before expiry (and on a 401). Parallel requests share one
// refresh. Being offline is not being signed out: a network failure during a
// refresh is rethrown as is, only a refusal becomes RemoteAuthError.

import { RemoteAuthError, type VaultStore } from '$lib/contracts/storage';
import { vaultSecretKey } from '$lib/store/db';
import { refreshDropboxToken, type DropboxTokens } from './api';

export const dropboxSecretKey = (vaultId: string) => vaultSecretKey(vaultId, 'dropbox');

export interface DropboxSessionOptions {
  store: VaultStore;
  vaultId: string;
  appKey: string;
  fetcher?: typeof fetch;
  now?: () => number;
  /** Refresh this long before expiry (default 60 s). */
  marginMs?: number;
}

export class DropboxSession {
  readonly #o: DropboxSessionOptions;
  #tokens: DropboxTokens | null | undefined;
  #refreshing: Promise<DropboxTokens> | null = null;

  constructor(options: DropboxSessionOptions) {
    this.#o = options;
  }

  get key(): string {
    return dropboxSecretKey(this.#o.vaultId);
  }

  async tokens(): Promise<DropboxTokens | null> {
    if (this.#tokens === undefined) {
      const raw = await this.#o.store.getSecret(this.key);
      this.#tokens = raw ? (JSON.parse(raw) as DropboxTokens) : null;
    }
    return this.#tokens;
  }

  async signedIn(): Promise<boolean> {
    return (await this.tokens()) !== null;
  }

  async save(tokens: DropboxTokens): Promise<void> {
    this.#tokens = tokens;
    await this.#o.store.setSecret(this.key, JSON.stringify(tokens));
  }

  async clear(): Promise<void> {
    this.#tokens = null;
    await this.#o.store.setSecret(this.key, null);
  }

  /** A usable access token; `force` refreshes even if it looks valid (after a 401). */
  token = async (force = false): Promise<string> => {
    const t = await this.tokens();
    if (!t) throw new RemoteAuthError('Not signed in to Dropbox.');
    const now = (this.#o.now ?? Date.now)();
    const stale = t.expiresAt !== null && t.expiresAt - (this.#o.marginMs ?? 60_000) < now;
    if (!force && !stale) return t.accessToken;
    if (!t.refreshToken) {
      if (force) throw new RemoteAuthError('Dropbox signed you out.');
      return t.accessToken;
    }
    this.#refreshing ??= this.#refresh(t.refreshToken).finally(() => (this.#refreshing = null));
    return (await this.#refreshing).accessToken;
  };

  async #refresh(refreshToken: string): Promise<DropboxTokens> {
    const next = await refreshDropboxToken(
      this.#o.appKey,
      refreshToken,
      this.#o.fetcher,
      (this.#o.now ?? Date.now)(),
    );
    await this.save(next);
    return next;
  }
}
