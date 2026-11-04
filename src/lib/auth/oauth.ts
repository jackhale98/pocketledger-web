// Sign in with Dropbox or GitHub: OAuth 2 authorization code with PKCE
// (ported from mycelium-web src/lib/auth/oauth.ts, reduced to the two
// providers PocketLedger uses).
//
// Flow: `beginSignIn` stores the state and verifier in sessionStorage and
// leaves for the provider. The provider returns to the app's callback page
// (e.g. /auth/callback/), which calls `completeSignIn(location.search)`: it
// checks the state, trades the code for tokens and leaves them in
// sessionStorage, then the page navigates to `returnTo`, where the app picks
// them up once with `takeSignInResult()` and stores them as a vault secret.
//
// Dropbox trades the code in the browser (PKCE, no secret, no worker).
// GitHub needs a client secret, so the code goes through the worker's
// `/oauth/github` endpoint (worker/), which adds it.

import type { AuthConfig } from '$lib/config';
import { dropboxAuthorizeUrl, exchangeDropboxCode } from '$lib/dropbox/api';
import { challengeFor, createVerifier, randomString } from './pkce';

export type SignInProvider = 'dropbox' | 'github';

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string | null;
  /** Epoch ms, or null if the token doesn't expire. */
  expiresAt: number | null;
}

export interface SignInResult {
  provider: SignInProvider;
  tokens: OAuthTokens;
  /** Set when this signed in again for an existing vault. */
  vaultId: string | null;
}

interface PendingSignIn {
  provider: SignInProvider;
  state: string;
  verifier: string;
  redirectUri: string;
  returnTo: string;
  vaultId: string | null;
  createdAt: number;
}

export interface SignInRequest {
  /** The callback page, exactly as registered with the provider. */
  redirectUri: string;
  /** Where the callback page should go afterwards (an app URL). */
  returnTo: string;
  /** Re-authenticating an existing vault. */
  vaultId?: string;
  /** GitHub OAuth App scopes (default `repo`; ignored by GitHub Apps). */
  scope?: string;
}

export interface OAuthDeps {
  /** Default `sessionStorage`. */
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  fetcher?: typeof fetch;
  now?: () => number;
}

export const PENDING_KEY = 'pocketledger:oauth-pending';
export const RESULT_KEY = 'pocketledger:oauth-result';
/** A sign-in not completed within this long is refused. */
export const PENDING_TTL = 15 * 60_000;

export const GITHUB_AUTHORIZE = 'https://github.com/login/oauth/authorize';

function storageOf(deps: OAuthDeps) {
  if (deps.storage) return deps.storage;
  const s = (globalThis as { sessionStorage?: Storage }).sessionStorage;
  if (!s) throw new Error('Sign-in needs sessionStorage');
  return s;
}

export function githubAuthorizeUrl(
  clientId: string,
  redirectUri: string,
  state: string,
  challenge: string,
  scope = 'repo',
): string {
  const url = new URL(GITHUB_AUTHORIZE);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);
  url.searchParams.set('scope', scope);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('allow_signup', 'false');
  return url.toString();
}

/** Which sign-ins this build can offer. */
export function availableSignIns(config: AuthConfig): SignInProvider[] {
  const out: SignInProvider[] = [];
  if (config.dropboxAppKey) out.push('dropbox');
  if (config.githubClientId && config.worker) out.push('github');
  return out;
}

/** Store the pending sign-in and return the provider's authorize URL. */
export async function prepareSignIn(
  provider: SignInProvider,
  config: AuthConfig,
  request: SignInRequest,
  deps: OAuthDeps = {},
): Promise<string> {
  const pending: PendingSignIn = {
    provider,
    state: randomString(16),
    verifier: createVerifier(),
    redirectUri: request.redirectUri,
    returnTo: request.returnTo,
    vaultId: request.vaultId ?? null,
    createdAt: (deps.now ?? Date.now)(),
  };
  const challenge = await challengeFor(pending.verifier);
  let url: string;
  if (provider === 'dropbox') {
    if (!config.dropboxAppKey) throw new Error("Dropbox isn't configured for this build");
    url = dropboxAuthorizeUrl(config.dropboxAppKey, request.redirectUri, pending.state, challenge);
  } else {
    if (!config.githubClientId || !config.worker)
      throw new Error("GitHub sign-in isn't configured for this build");
    url = githubAuthorizeUrl(
      config.githubClientId,
      request.redirectUri,
      pending.state,
      challenge,
      request.scope,
    );
  }
  storageOf(deps).setItem(PENDING_KEY, JSON.stringify(pending));
  return url;
}

/** Leave for the provider's sign-in page. */
export async function beginSignIn(
  provider: SignInProvider,
  config: AuthConfig,
  request: SignInRequest,
  deps: OAuthDeps = {},
): Promise<void> {
  const url = await prepareSignIn(provider, config, request, deps);
  location.assign(url);
}

/** Is a sign-in started from this tab waiting for its callback? */
export function hasPendingSignIn(deps: OAuthDeps = {}): boolean {
  try {
    return storageOf(deps).getItem(PENDING_KEY) !== null;
  } catch {
    return false;
  }
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number | string;
  error?: string;
  error_description?: string;
}

function toTokens(body: TokenResponse, now: number, keepRefresh: string | null = null): OAuthTokens {
  if (!body.access_token) throw new Error(body.error_description || body.error || 'Sign-in failed');
  const expires = Number(body.expires_in ?? 0);
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? keepRefresh,
    expiresAt: expires > 0 ? now + expires * 1000 : null,
  };
}

async function postJson(url: string, body: object, fetcher: typeof fetch): Promise<TokenResponse> {
  const res = await fetcher(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: TokenResponse;
  try {
    parsed = JSON.parse(text) as TokenResponse;
  } catch {
    // GitHub can answer form-encoded.
    parsed = Object.fromEntries(new URLSearchParams(text)) as TokenResponse;
  }
  if (!res.ok && !parsed.error) parsed.error = `HTTP ${res.status}`;
  return parsed;
}

const workerUrl = (worker: string, path: string) => `${worker.replace(/\/+$/, '')}${path}`;

/** Trade a GitHub code for a token through the worker (it holds the client secret). */
export async function exchangeGitHubCode(
  input: { worker: string; code: string; verifier: string; redirectUri: string },
  fetcher: typeof fetch = (...a) => fetch(...a),
  now = Date.now(),
): Promise<OAuthTokens> {
  const body = await postJson(
    workerUrl(input.worker, '/oauth/github'),
    { code: input.code, code_verifier: input.verifier, redirect_uri: input.redirectUri },
    fetcher,
  );
  return toTokens(body, now);
}

/** Refresh an expiring GitHub user token (GitHub Apps with expiring tokens). */
export async function refreshGitHubToken(
  input: { worker: string; refreshToken: string },
  fetcher: typeof fetch = (...a) => fetch(...a),
  now = Date.now(),
): Promise<OAuthTokens> {
  const body = await postJson(
    workerUrl(input.worker, '/oauth/github/refresh'),
    { refresh_token: input.refreshToken },
    fetcher,
  );
  return toTokens(body, now, input.refreshToken);
}

/**
 * On the callback page: check the state, trade the code for tokens and leave
 * them for the app. Returns the result and where to go next.
 */
export async function completeSignIn(
  params: URLSearchParams | string,
  config: AuthConfig,
  deps: OAuthDeps = {},
): Promise<{ result: SignInResult; returnTo: string }> {
  const search = typeof params === 'string' ? new URLSearchParams(params) : params;
  const storage = storageOf(deps);
  const raw = storage.getItem(PENDING_KEY);
  storage.removeItem(PENDING_KEY);
  if (!raw) throw new Error('This sign-in has expired. Start again from PocketLedger.');
  const pending = JSON.parse(raw) as PendingSignIn;
  const now = (deps.now ?? Date.now)();
  if (now - pending.createdAt > PENDING_TTL)
    throw new Error('This sign-in took too long. Start again from PocketLedger.');
  const error = search.get('error');
  if (error) throw new Error(search.get('error_description') || error);
  if (search.get('state') !== pending.state)
    throw new Error('Sign-in state mismatch. Start again from PocketLedger.');
  const code = search.get('code');
  if (!code) throw new Error('No authorization code came back.');

  const fetcher = deps.fetcher ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  let tokens: OAuthTokens;
  if (pending.provider === 'dropbox') {
    if (!config.dropboxAppKey) throw new Error("Dropbox isn't configured for this build");
    tokens = await exchangeDropboxCode(
      {
        appKey: config.dropboxAppKey,
        code,
        verifier: pending.verifier,
        redirectUri: pending.redirectUri,
      },
      fetcher,
      now,
    );
  } else {
    if (!config.worker) throw new Error("GitHub sign-in isn't configured for this build");
    tokens = await exchangeGitHubCode(
      { worker: config.worker, code, verifier: pending.verifier, redirectUri: pending.redirectUri },
      fetcher,
      now,
    );
  }
  const result: SignInResult = { provider: pending.provider, tokens, vaultId: pending.vaultId };
  storage.setItem(RESULT_KEY, JSON.stringify(result));
  return { result, returnTo: safeReturn(pending.returnTo) };
}

/** Pick up the tokens the callback page left (once). */
export function takeSignInResult(deps: OAuthDeps = {}): SignInResult | null {
  try {
    const storage = storageOf(deps);
    const raw = storage.getItem(RESULT_KEY);
    if (!raw) return null;
    storage.removeItem(RESULT_KEY);
    return JSON.parse(raw) as SignInResult;
  } catch {
    return null;
  }
}

/** Only same-origin relative paths: a crafted returnTo must not send tokens' owner elsewhere. */
function safeReturn(returnTo: string): string {
  return returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/';
}

/** `true` when a token expires within `margin` ms and can be refreshed. */
export function needsRefresh(tokens: OAuthTokens | null, now = Date.now(), margin = 120_000): boolean {
  return !!tokens?.refreshToken && tokens.expiresAt !== null && tokens.expiresAt - now < margin;
}
