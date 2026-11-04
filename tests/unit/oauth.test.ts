import { describe, expect, it } from 'vitest';
import {
  availableSignIns,
  completeSignIn,
  hasPendingSignIn,
  needsRefresh,
  PENDING_KEY,
  PENDING_TTL,
  prepareSignIn,
  refreshGitHubToken,
  takeSignInResult,
  type OAuthDeps,
} from '$lib/auth/oauth';
import { base64url, challengeFor, createVerifier, randomString } from '$lib/auth/pkce';

class MemoryStorage {
  map = new Map<string, string>();
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
}

type Call = { url: string; init: RequestInit };
function fakeFetch(responses: Response[]) {
  const calls: Call[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return responses.shift()!;
  }) as unknown as typeof fetch;
  return { calls, fetcher };
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const config = { dropboxAppKey: 'dbkey', githubClientId: 'ghid', worker: 'https://proxy.example/' };
const request = { redirectUri: 'https://app.example/auth/callback/', returnTo: '/vaults/new' };

describe('PKCE', () => {
  it('matches the RFC 7636 appendix B example', async () => {
    expect(await challengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });
  it('makes URL-safe random verifiers of a valid length', () => {
    const v = createVerifier();
    expect(v).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(randomString(16)).not.toBe(randomString(16));
    expect(base64url(new Uint8Array([251, 255]))).toBe('-_8');
  });
});

describe('sign-in flow', () => {
  function deps(now = 1_000): OAuthDeps & { storage: MemoryStorage } {
    return { storage: new MemoryStorage(), now: () => now };
  }

  it('lists the sign-ins this build supports', () => {
    expect(availableSignIns(config)).toEqual(['dropbox', 'github']);
    expect(availableSignIns({ dropboxAppKey: 'k' })).toEqual(['dropbox']);
    expect(availableSignIns({ githubClientId: 'id' })).toEqual([]);
  });

  it('Dropbox: stores state + verifier, then exchanges the code in the browser', async () => {
    const d = deps();
    const url = new URL(await prepareSignIn('dropbox', config, request, d));
    expect(url.host).toBe('www.dropbox.com');
    const pending = JSON.parse(d.storage.getItem(PENDING_KEY)!);
    expect(url.searchParams.get('state')).toBe(pending.state);
    expect(url.searchParams.get('code_challenge')).toBe(await challengeFor(pending.verifier));
    expect(hasPendingSignIn(d)).toBe(true);

    const { calls, fetcher } = fakeFetch([json({ access_token: 'at', refresh_token: 'rt', expires_in: 60 })]);
    const out = await completeSignIn(`?code=abc&state=${pending.state}`, config, { ...d, fetcher });
    expect(out.returnTo).toBe('/vaults/new');
    expect(out.result).toEqual({
      provider: 'dropbox',
      tokens: { accessToken: 'at', refreshToken: 'rt', expiresAt: 61_000 },
      vaultId: null,
    });
    expect(calls[0]!.url).toBe('https://api.dropboxapi.com/oauth2/token');
    const form = Object.fromEntries(new URLSearchParams(calls[0]!.init.body as string));
    expect(form).toMatchObject({ code: 'abc', code_verifier: pending.verifier, client_id: 'dbkey' });
    expect(hasPendingSignIn(d)).toBe(false);
    expect(takeSignInResult(d)).toEqual(out.result);
    expect(takeSignInResult(d)).toBeNull();
  });

  it('GitHub: exchanges the code through the worker', async () => {
    const d = deps();
    const url = new URL(
      await prepareSignIn('github', config, { ...request, vaultId: 'v9', scope: 'repo' }, d),
    );
    expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('ghid');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    const { state, verifier } = JSON.parse(d.storage.getItem(PENDING_KEY)!);
    // GitHub can answer form-encoded.
    const { calls, fetcher } = fakeFetch([
      new Response('access_token=gho_x&token_type=bearer&scope=repo', { status: 200 }),
    ]);
    const out = await completeSignIn(new URLSearchParams({ code: 'c', state }), config, { ...d, fetcher });
    expect(calls[0]!.url).toBe('https://proxy.example/oauth/github');
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      code: 'c',
      code_verifier: verifier,
      redirect_uri: request.redirectUri,
    });
    expect(out.result).toEqual({
      provider: 'github',
      tokens: { accessToken: 'gho_x', refreshToken: null, expiresAt: null },
      vaultId: 'v9',
    });
  });

  it('refuses a mismatched state, a provider error, an expired or missing sign-in', async () => {
    const d = deps();
    await prepareSignIn('dropbox', config, request, d);
    await expect(completeSignIn('?code=x&state=evil', config, d)).rejects.toThrow(/state mismatch/);
    // The pending sign-in is single-use.
    await expect(completeSignIn('?code=x&state=evil', config, d)).rejects.toThrow(/expired/);

    await prepareSignIn('dropbox', config, request, d);
    await expect(
      completeSignIn('?error=access_denied&error_description=The+user+said+no', config, d),
    ).rejects.toThrow('The user said no');

    const late = deps(0);
    await prepareSignIn('dropbox', config, request, late);
    late.now = () => PENDING_TTL + 1;
    const { state } = JSON.parse(late.storage.getItem(PENDING_KEY)!);
    await expect(completeSignIn(`?code=x&state=${state}`, config, late)).rejects.toThrow(/too long/);
  });

  it('never returns to another origin', async () => {
    const d = deps();
    await prepareSignIn('dropbox', config, { ...request, returnTo: '//evil.example/x' }, d);
    const { state } = JSON.parse(d.storage.getItem(PENDING_KEY)!);
    const { fetcher } = fakeFetch([json({ access_token: 'at' })]);
    const out = await completeSignIn(`?code=c&state=${state}`, config, { ...d, fetcher });
    expect(out.returnTo).toBe('/');
  });

  it('reports a failed code exchange', async () => {
    const d = deps();
    await prepareSignIn('github', config, request, d);
    const { state } = JSON.parse(d.storage.getItem(PENDING_KEY)!);
    const { fetcher } = fakeFetch([json({ error: 'bad_verification_code' }, 200)]);
    await expect(completeSignIn(`?code=c&state=${state}`, config, { ...d, fetcher })).rejects.toThrow(
      'bad_verification_code',
    );
    expect(takeSignInResult(d)).toBeNull();
  });

  it('refuses providers this build lacks', async () => {
    await expect(prepareSignIn('dropbox', {}, request, deps())).rejects.toThrow(/configured/);
    await expect(prepareSignIn('github', { githubClientId: 'x' }, request, deps())).rejects.toThrow(
      /configured/,
    );
  });
});

describe('token refresh', () => {
  it('refreshes a GitHub token through the worker and keeps the refresh token', async () => {
    const { calls, fetcher } = fakeFetch([json({ access_token: 'ghu_2', expires_in: 28800 })]);
    expect(await refreshGitHubToken({ worker: 'https://proxy.example', refreshToken: 'ghr_1' }, fetcher, 0)).toEqual({
      accessToken: 'ghu_2',
      refreshToken: 'ghr_1',
      expiresAt: 28_800_000,
    });
    expect(calls[0]!.url).toBe('https://proxy.example/oauth/github/refresh');
  });

  it('knows when a token needs refreshing', () => {
    expect(needsRefresh({ accessToken: 'a', refreshToken: 'r', expiresAt: 100_000 }, 0)).toBe(true);
    expect(needsRefresh({ accessToken: 'a', refreshToken: 'r', expiresAt: 1e9 }, 0)).toBe(false);
    expect(needsRefresh({ accessToken: 'a', refreshToken: null, expiresAt: 1 }, 0)).toBe(false);
    expect(needsRefresh(null)).toBe(false);
  });
});
