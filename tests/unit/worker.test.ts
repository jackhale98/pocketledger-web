// The optional Cloudflare Worker: CORS git proxy + GitHub code exchange.

import { afterEach, describe, expect, it, vi } from 'vitest';
import worker, { isGitRequest, type Env } from '../../worker/src/index';

const env: Env = {
  ALLOWED_ORIGINS: 'https://app.example, http://localhost:4321',
  GITHUB_CLIENT_ID: 'id',
  GITHUB_CLIENT_SECRET: 'shh',
};
const ORIGIN = 'https://app.example';
const call = (path: string, init: RequestInit & { origin?: string | null } = {}, e: Env = env) => {
  const headers = new Headers(init.headers);
  if (init.origin !== null) headers.set('Origin', init.origin ?? ORIGIN);
  const { origin: _o, ...rest } = init;
  return worker.fetch(new Request(`https://proxy.example${path}`, { ...rest, headers }), e);
};

afterEach(() => vi.unstubAllGlobals());

describe('git proxy', () => {
  it('recognises only smart-HTTP endpoints', () => {
    const q = (s: string) => new URLSearchParams(s);
    expect(isGitRequest('GET', '/a/b.git/info/refs', q('service=git-upload-pack'))).toBe(true);
    expect(isGitRequest('GET', '/a/b.git/info/refs', q('service=evil'))).toBe(false);
    expect(isGitRequest('POST', '/a/b.git/git-receive-pack', q(''))).toBe(true);
    expect(isGitRequest('GET', '/a/b.git/git-receive-pack', q(''))).toBe(false);
    expect(isGitRequest('GET', '/login', q(''))).toBe(false);
  });

  it('rejects unknown origins, hosts and paths', async () => {
    const refs = '/github.com/a/b.git/info/refs?service=git-upload-pack';
    expect((await call(refs, { origin: null })).status).toBe(403);
    expect((await call(refs, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await call('/example.com/a/b.git/info/refs?service=git-upload-pack')).status).toBe(403);
    expect((await call('/github.com/settings/profile')).status).toBe(403);
    expect((await call('/github.com/login/oauth/access_token', { method: 'POST' })).status).toBe(403);
  });

  it('answers preflight with CORS headers', async () => {
    const res = await call('/github.com/a/b.git/git-upload-pack', { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
  });

  it('forwards only git headers and streams the response back', async () => {
    const upstream = vi.fn(
      async () =>
        new Response('pack', {
          status: 200,
          headers: { 'Content-Type': 'application/x-git-upload-pack-result', 'Set-Cookie': 'x=1' },
        }),
    );
    vi.stubGlobal('fetch', upstream);
    const res = await call('/github.com/a/b.git/git-upload-pack', {
      method: 'POST',
      body: 'want',
      headers: {
        Authorization: 'Basic abc',
        Cookie: 'session=1',
        'Content-Type': 'application/x-git-upload-pack-request',
      },
    });
    expect(await res.text()).toBe('pack');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    expect(res.headers.get('Set-Cookie')).toBeNull();
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const [target, init] = upstream.mock.calls[0] as unknown as [string, RequestInit];
    expect(target).toBe('https://github.com/a/b.git/git-upload-pack');
    expect(init.redirect).toBe('manual');
    const sent = new Headers(init.headers);
    expect(sent.get('authorization')).toBe('Basic abc');
    expect(sent.get('cookie')).toBeNull();
  });

  it('follows same-host redirects only', async () => {
    const upstream = vi.fn(async (url: string) =>
      url.includes('old')
        ? new Response(null, { status: 301, headers: { Location: 'https://github.com/a/new.git/info/refs?service=git-upload-pack' } })
        : url.includes('away')
          ? new Response(null, { status: 302, headers: { Location: 'https://evil.example/steal' } })
          : new Response('refs', { status: 200 }),
    );
    vi.stubGlobal('fetch', upstream);
    const ok = await call('/github.com/a/old.git/info/refs?service=git-upload-pack');
    expect(await ok.text()).toBe('refs');
    expect(upstream).toHaveBeenCalledTimes(2);
    const away = await call('/github.com/a/away.git/info/refs?service=git-upload-pack');
    expect(away.status).toBe(302);
    expect(upstream).toHaveBeenCalledTimes(3);
  });

  it('allows extra hosts from the environment', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok')));
    const refs = '/git.example.org/a/b.git/info/refs?service=git-upload-pack';
    expect((await call(refs)).status).toBe(403);
    expect((await call(refs, {}, { ...env, EXTRA_GIT_HOSTS: 'git.example.org' })).status).toBe(200);
  });
});

describe('GitHub OAuth exchange', () => {
  it('adds the client secret and returns GitHub’s answer', async () => {
    const upstream = vi.fn(
      async () =>
        new Response('{"access_token":"gho_x","token_type":"bearer"}', {
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', upstream);
    const res = await call('/oauth/github', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'c', code_verifier: 'v', redirect_uri: 'https://app.example/cb' }),
    });
    expect(await res.json()).toEqual({ access_token: 'gho_x', token_type: 'bearer' });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    const [target, init] = upstream.mock.calls[0] as unknown as [string, RequestInit];
    expect(target).toBe('https://github.com/login/oauth/access_token');
    expect(Object.fromEntries(init.body as URLSearchParams)).toEqual({
      client_id: 'id',
      client_secret: 'shh',
      code: 'c',
      code_verifier: 'v',
      redirect_uri: 'https://app.example/cb',
    });
  });

  it('refreshes tokens', async () => {
    const upstream = vi.fn(async () => new Response('{"access_token":"ghu_2"}'));
    vi.stubGlobal('fetch', upstream);
    await call('/oauth/github/refresh', {
      method: 'POST',
      body: JSON.stringify({ refresh_token: 'ghr_1' }),
    });
    const [, init] = upstream.mock.calls[0] as unknown as [string, RequestInit];
    expect(Object.fromEntries(init.body as URLSearchParams)).toMatchObject({
      grant_type: 'refresh_token',
      refresh_token: 'ghr_1',
    });
  });

  it('validates input and configuration', async () => {
    vi.stubGlobal('fetch', vi.fn());
    expect((await call('/oauth/github', { method: 'POST', body: 'nope' })).status).toBe(400);
    expect((await call('/oauth/github', { method: 'POST', body: '{}' })).status).toBe(400);
    expect((await call('/oauth/github')).status).toBe(404);
    expect((await call('/oauth/github/other', { method: 'POST', body: '{}' })).status).toBe(404);
    const res = await call('/oauth/github', { method: 'POST', body: '{"code":"c"}' }, { ALLOWED_ORIGINS: ORIGIN });
    expect(res.status).toBe(501);
    const text = await res.text();
    expect(text).toContain('GITHUB_CLIENT_SECRET');
    expect(text).not.toContain('shh');
  });
});
