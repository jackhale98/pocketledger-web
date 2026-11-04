// A small Dropbox API v2 client for the browser (ported from mycelium-web
// src/lib/dropbox/api.ts). Dropbox allows cross-origin calls and PKCE
// sign-in, so the page talks to Dropbox directly: no proxy, no client secret,
// and tokens never leave the browser except to Dropbox.
//
// Paths here are absolute Dropbox paths (`/Finance/main.journal`, or
// `/main.journal` in an app folder). The SyncProvider adapter in provider.ts
// maps them to vault-relative paths.

import {
  RemoteAuthError,
  RemoteConflict,
  RemoteError,
  RemoteNotFound,
} from '$lib/contracts/storage';
import { syncable } from '$lib/sync/paths';

const API = 'https://api.dropboxapi.com/2';
const CONTENT = 'https://content.dropboxapi.com/2';
export const DROPBOX_AUTHORIZE = 'https://www.dropbox.com/oauth2/authorize';
export const DROPBOX_TOKEN = 'https://api.dropboxapi.com/oauth2/token';

export interface DropboxEntry {
  tag: 'file' | 'folder' | 'deleted';
  /** Absolute, original case: `/Finance/main.journal`. */
  path: string;
  pathLower: string;
  /** Files only. */
  rev?: string;
}

export interface ListResult {
  entries: DropboxEntry[];
  cursor: string;
  hasMore: boolean;
}

/** The change cursor is too old (`reset`): list everything again. */
export class CursorExpired extends Error {
  constructor() {
    super('Dropbox change cursor expired');
    this.name = 'CursorExpired';
  }
}

export class DropboxError extends RemoteError {
  constructor(status: number, summary: string) {
    super(status, summary, 'Dropbox');
  }
}

/** Header values must be ASCII; Dropbox wants other characters as JSON \u escapes. */
export function apiArg(value: unknown): string {
  return JSON.stringify(value).replace(
    /[\u007f-￿]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

type Raw = {
  '.tag': 'file' | 'folder' | 'deleted';
  path_display?: string;
  path_lower?: string;
  name?: string;
  rev?: string;
};

const entry = (e: Raw): DropboxEntry => ({
  tag: e['.tag'],
  path: e.path_display ?? e.path_lower ?? e.name ?? '',
  pathLower: e.path_lower ?? (e.path_display ?? '').toLowerCase(),
  ...(e.rev ? { rev: e.rev } : {}),
});

/** A valid access token (refreshed first if needed); `force` asks for a fresh one. */
export type TokenSource = (force?: boolean) => Promise<string>;

export class DropboxApi {
  constructor(
    private readonly token: TokenSource,
    private readonly fetcher: typeof fetch = (...a) => fetch(...a),
  ) {}

  async #call(url: string, init: RequestInit, retried = false): Promise<Response> {
    const res = await this.fetcher(url, {
      // A stalled request mustn't hold up sync (and the edits queued behind it) forever.
      ...(typeof AbortSignal.timeout === 'function' ? { signal: AbortSignal.timeout(60_000) } : {}),
      ...init,
      headers: {
        ...(init.headers as Record<string, string>),
        Authorization: `Bearer ${await this.token(retried)}`,
      },
    });
    if (res.status === 401 && !retried) return this.#call(url, init, true);
    if (res.status === 401) throw new RemoteAuthError('Dropbox signed you out.');
    return res;
  }

  async #rpc<T>(endpoint: string, body: unknown): Promise<T> {
    const res = await this.#call(`${API}/${endpoint}`, {
      method: 'POST',
      ...(body === null ? {} : { headers: { 'Content-Type': 'application/json' } }),
      ...(body === null ? {} : { body: JSON.stringify(body) }),
    });
    if (!res.ok) {
      const err = await failure(res);
      if (/^reset/.test(err.summary)) throw new CursorExpired();
      if (/not_found/.test(err.summary))
        throw new RemoteNotFound(String((body as { path?: string } | null)?.path ?? ''));
      throw err;
    }
    return (await res.json()) as T;
  }

  async account(): Promise<{ name: string; email: string }> {
    const u = await this.#rpc<{ name: { display_name: string }; email: string }>(
      'users/get_current_account',
      null,
    );
    return { name: u.name.display_name, email: u.email };
  }

  /** List a folder (`''` is the root, or the app folder). */
  async list(path: string, recursive: boolean): Promise<ListResult> {
    const r = await this.#rpc<{ entries: Raw[]; cursor: string; has_more: boolean }>(
      'files/list_folder',
      { path, recursive, include_deleted: false, include_non_downloadable_files: false },
    );
    return { entries: r.entries.map(entry), cursor: r.cursor, hasMore: r.has_more };
  }

  /** What changed since `cursor` (including deletions). */
  async listContinue(cursor: string): Promise<ListResult> {
    const r = await this.#rpc<{ entries: Raw[]; cursor: string; has_more: boolean }>(
      'files/list_folder/continue',
      { cursor },
    );
    return { entries: r.entries.map(entry), cursor: r.cursor, hasMore: r.has_more };
  }

  /** All pages of a recursive listing, or of the changes since a cursor. */
  async listAll(start: { path: string } | { cursor: string }): Promise<ListResult> {
    let page =
      'cursor' in start ? await this.listContinue(start.cursor) : await this.list(start.path, true);
    const entries = [...page.entries];
    while (page.hasMore) {
      page = await this.listContinue(page.cursor);
      entries.push(...page.entries);
    }
    return { entries, cursor: page.cursor, hasMore: false };
  }

  async download(path: string): Promise<{ text: string; rev: string }> {
    const res = await this.#call(`${CONTENT}/files/download`, {
      method: 'POST',
      headers: { 'Dropbox-API-Arg': apiArg({ path }) },
    });
    if (!res.ok) {
      const err = await failure(res);
      if (/not_found/.test(err.summary)) throw new RemoteNotFound(path);
      throw err;
    }
    const meta = JSON.parse(res.headers.get('Dropbox-API-Result') ?? '{}') as { rev?: string };
    return { text: await res.text(), rev: meta.rev ?? '' };
  }

  /**
   * Write a file. With `rev`, only if Dropbox still has that revision (else
   * RemoteConflict); without, only if the file doesn't exist yet.
   */
  async upload(path: string, text: string, rev: string | null): Promise<{ rev: string; path: string }> {
    const res = await this.#call(`${CONTENT}/files/upload`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Dropbox-API-Arg': apiArg({
          path,
          mode: rev ? { '.tag': 'update', update: rev } : { '.tag': 'add' },
          autorename: false,
          mute: true,
          strict_conflict: true,
        }),
      },
      body: new TextEncoder().encode(text),
    });
    if (res.status === 409) {
      const err = await failure(res);
      if (/conflict/.test(err.summary)) throw new RemoteConflict(path);
      throw err;
    }
    if (!res.ok) throw await failure(res);
    const meta = (await res.json()) as { rev: string; path_display: string };
    return { rev: meta.rev, path: meta.path_display };
  }

  /** Delete a file; with `rev`, only if it's still that revision. Missing files are fine. */
  async delete(path: string, rev: string | null): Promise<void> {
    const res = await this.#call(`${API}/files/delete_v2`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(rev ? { path, parent_rev: rev } : { path }),
    });
    if (res.ok) return;
    const err = await failure(res);
    if (/not_found/.test(err.summary)) return;
    if (/conflict|parent_rev/.test(err.summary)) throw new RemoteConflict(path);
    throw err;
  }

  /** For a folder picker: subfolders of `path` and how many journal files are directly in it. */
  async browse(path: string): Promise<{ folders: { name: string; path: string }[]; journals: number }> {
    const all = (await this.listAllShallow(path)).entries;
    const name = (p: string) => p.split('/').pop() ?? '';
    return {
      folders: all
        .filter((e) => e.tag === 'folder' && !name(e.path).startsWith('.'))
        .map((e) => ({ name: name(e.path), path: e.path }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      journals: all.filter((e) => e.tag === 'file' && syncable(name(e.path))).length,
    };
  }

  async listAllShallow(path: string): Promise<ListResult> {
    let page = await this.list(path, false);
    const entries = [...page.entries];
    while (page.hasMore) {
      page = await this.listContinue(page.cursor);
      entries.push(...page.entries);
    }
    return { entries, cursor: page.cursor, hasMore: false };
  }
}

async function failure(res: Response): Promise<DropboxError> {
  let summary = '';
  try {
    const body = (await res.json()) as { error_summary?: string; error?: string };
    summary = body.error_summary ?? (typeof body.error === 'string' ? body.error : '');
  } catch {
    /* not JSON */
  }
  return new DropboxError(res.status, summary);
}

// ------------------------------------------------------------------ sign-in

export interface DropboxTokens {
  accessToken: string;
  refreshToken: string | null;
  /** Epoch ms. */
  expiresAt: number | null;
}

type TokenBody = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
};

/** The token endpoint refused (bad code, revoked refresh token): the person must sign in again. */
export class DropboxSignInError extends RemoteAuthError {
  override name = 'DropboxSignInError';
}

function tokens(body: TokenBody, now: number, keepRefresh: string | null = null): DropboxTokens {
  if (!body.access_token)
    throw new DropboxSignInError(body.error_description || body.error || 'Dropbox sign-in failed');
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? keepRefresh,
    expiresAt: body.expires_in ? now + body.expires_in * 1000 : null,
  };
}

/** The authorize URL (PKCE, offline access so a refresh token comes back). */
export function dropboxAuthorizeUrl(
  appKey: string,
  redirectUri: string,
  state: string,
  challenge: string,
): string {
  const url = new URL(DROPBOX_AUTHORIZE);
  url.searchParams.set('client_id', appKey);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('token_access_type', 'offline');
  return url.toString();
}

async function tokenRequest(form: Record<string, string>, fetcher: typeof fetch): Promise<TokenBody> {
  const res = await fetcher(DROPBOX_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  });
  try {
    return (await res.json()) as TokenBody;
  } catch {
    return { error: `HTTP ${res.status}` };
  }
}

export async function exchangeDropboxCode(
  input: { appKey: string; code: string; verifier: string; redirectUri: string },
  fetcher: typeof fetch = (...a) => fetch(...a),
  now = Date.now(),
): Promise<DropboxTokens> {
  return tokens(
    await tokenRequest(
      {
        grant_type: 'authorization_code',
        code: input.code,
        client_id: input.appKey,
        code_verifier: input.verifier,
        redirect_uri: input.redirectUri,
      },
      fetcher,
    ),
    now,
  );
}

export async function refreshDropboxToken(
  appKey: string,
  refreshToken: string,
  fetcher: typeof fetch = (...a) => fetch(...a),
  now = Date.now(),
): Promise<DropboxTokens> {
  return tokens(
    await tokenRequest(
      { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: appKey },
      fetcher,
    ),
    now,
    refreshToken,
  );
}

/** Revoke the access token (sign out). Best effort. */
export async function revokeDropboxToken(
  accessToken: string,
  fetcher: typeof fetch = (...a) => fetch(...a),
): Promise<void> {
  try {
    await fetcher(`${API}/auth/token/revoke`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch {
    /* offline: the token expires on its own */
  }
}
