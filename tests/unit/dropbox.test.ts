import { describe, expect, it } from 'vitest';
import { RemoteAuthError, RemoteConflict, RemoteNotFound } from '$lib/contracts/storage';
import {
  apiArg,
  DropboxApi,
  dropboxAuthorizeUrl,
  DropboxError,
  DropboxSignInError,
  exchangeDropboxCode,
  refreshDropboxToken,
} from '$lib/dropbox/api';
import { DropboxProvider, normalizeFolder } from '$lib/dropbox/provider';
import { dropboxSecretKey, DropboxSession } from '$lib/dropbox/session';
import { MemoryVaultStore } from '$lib/store/memory';
import { VaultSyncEngine } from '$lib/sync/engine';
import { vaultRecord } from './helpers/sync-fakes';

type Call = { url: string; init: RequestInit };

function fakeFetch(responses: (Response | (() => Response))[]) {
  const calls: Call[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected request ${url}`);
    return typeof next === 'function' ? next() : next;
  }) as unknown as typeof fetch;
  return { calls, fetcher };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
const header = (c: Call, name: string) => (c.init.headers as Record<string, string>)[name];
const file = (path: string, rev: string) => ({
  '.tag': 'file',
  path_display: path,
  path_lower: path.toLowerCase(),
  rev,
});

describe('DropboxApi', () => {
  it('escapes non-ASCII characters in API arguments', () => {
    expect(apiArg({ path: '/Finance/café.journal' })).toBe('{"path":"/Finance/caf\\u00e9.journal"}');
  });

  it('lists every page of a folder', async () => {
    const { calls, fetcher } = fakeFetch([
      json({ entries: [file('/F/a.journal', '1')], cursor: 'c1', has_more: true }),
      json({
        entries: [{ '.tag': 'deleted', path_display: '/F/b.journal', path_lower: '/f/b.journal' }],
        cursor: 'c2',
        has_more: false,
      }),
    ]);
    const api = new DropboxApi(async () => 'tok', fetcher);
    const r = await api.listAll({ path: '/F' });
    expect(r.cursor).toBe('c2');
    expect(r.entries).toEqual([
      { tag: 'file', path: '/F/a.journal', pathLower: '/f/a.journal', rev: '1' },
      { tag: 'deleted', path: '/F/b.journal', pathLower: '/f/b.journal' },
    ]);
    expect(calls[0]!.url).toBe('https://api.dropboxapi.com/2/files/list_folder');
    expect(JSON.parse(calls[0]!.init.body as string)).toMatchObject({ path: '/F', recursive: true });
    expect(calls[1]!.url).toMatch(/list_folder\/continue$/);
    expect(header(calls[0]!, 'Authorization')).toBe('Bearer tok');
  });

  it('downloads text with its revision', async () => {
    const { calls, fetcher } = fakeFetch([
      new Response('2026-01-01 x\n', { headers: { 'Dropbox-API-Result': '{"rev":"abc"}' } }),
      json({ error_summary: 'path/not_found/..' }, 409),
    ]);
    const api = new DropboxApi(async () => 'tok', fetcher);
    expect(await api.download('/F/a.journal')).toEqual({ text: '2026-01-01 x\n', rev: 'abc' });
    expect(header(calls[0]!, 'Dropbox-API-Arg')).toBe('{"path":"/F/a.journal"}');
    await expect(api.download('/F/b.journal')).rejects.toBeInstanceOf(RemoteNotFound);
  });

  it('uploads against a revision, or only-if-absent, and reports conflicts', async () => {
    const { calls, fetcher } = fakeFetch([
      json({ rev: 'r2', path_display: '/F/a.journal' }),
      json({ rev: 'r1', path_display: '/F/new.journal' }),
      json({ error_summary: 'path/conflict/file/..' }, 409),
      json({ error_summary: 'path/insufficient_space/..' }, 409),
    ]);
    const api = new DropboxApi(async () => 'tok', fetcher);
    expect(await api.upload('/F/a.journal', 'x', 'r1')).toEqual({ rev: 'r2', path: '/F/a.journal' });
    expect(JSON.parse(header(calls[0]!, 'Dropbox-API-Arg')!)).toMatchObject({
      mode: { '.tag': 'update', update: 'r1' },
      autorename: false,
      strict_conflict: true,
    });
    await api.upload('/F/new.journal', 'n', null);
    expect(JSON.parse(header(calls[1]!, 'Dropbox-API-Arg')!).mode).toEqual({ '.tag': 'add' });
    await expect(api.upload('/F/a.journal', 'y', 'r1')).rejects.toBeInstanceOf(RemoteConflict);
    await expect(api.upload('/F/a.journal', 'y', 'r2')).rejects.toBeInstanceOf(DropboxError);
  });

  it('deletes with parent_rev; missing files are fine', async () => {
    const { calls, fetcher } = fakeFetch([
      json({ metadata: {} }),
      json({ error_summary: 'path_lookup/not_found/..' }, 409),
      json({ error_summary: 'path_write/conflict/..' }, 409),
    ]);
    const api = new DropboxApi(async () => 'tok', fetcher);
    await api.delete('/F/a.journal', 'r1');
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ path: '/F/a.journal', parent_rev: 'r1' });
    await api.delete('/F/gone.journal', null);
    await expect(api.delete('/F/a.journal', 'old')).rejects.toBeInstanceOf(RemoteConflict);
  });

  it('retries once with a fresh token after a 401, then gives up', async () => {
    const forced: boolean[] = [];
    const token = async (force?: boolean) => {
      forced.push(!!force);
      return force ? 'fresh' : 'stale';
    };
    const { calls, fetcher } = fakeFetch([
      new Response('', { status: 401 }),
      json({ name: { display_name: 'Ada' }, email: 'ada@example.com' }),
      new Response('', { status: 401 }),
      new Response('', { status: 401 }),
    ]);
    const api = new DropboxApi(token, fetcher);
    expect(await api.account()).toEqual({ name: 'Ada', email: 'ada@example.com' });
    expect(forced).toEqual([false, true]);
    expect(header(calls[1]!, 'Authorization')).toBe('Bearer fresh');
    await expect(api.account()).rejects.toBeInstanceOf(RemoteAuthError);
  });

  it('browses folders and counts journals', async () => {
    const { fetcher } = fakeFetch([
      json({
        entries: [
          { '.tag': 'folder', path_display: '/Finance', path_lower: '/finance' },
          { '.tag': 'folder', path_display: '/.hidden', path_lower: '/.hidden' },
          file('/main.journal', '1'),
          file('/photo.jpg', '2'),
        ],
        cursor: 'c',
        has_more: false,
      }),
    ]);
    const api = new DropboxApi(async () => 'tok', fetcher);
    expect(await api.browse('')).toEqual({
      folders: [{ name: 'Finance', path: '/Finance' }],
      journals: 1,
    });
  });
});

describe('Dropbox sign-in', () => {
  it('builds a PKCE authorize URL with offline access', () => {
    const url = new URL(dropboxAuthorizeUrl('key', 'https://app.example/auth/callback/', 'st', 'ch'));
    expect(url.origin + url.pathname).toBe('https://www.dropbox.com/oauth2/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'key',
      response_type: 'code',
      redirect_uri: 'https://app.example/auth/callback/',
      state: 'st',
      code_challenge: 'ch',
      code_challenge_method: 'S256',
      token_access_type: 'offline',
    });
  });

  it('exchanges a code and refreshes (keeping the refresh token)', async () => {
    const { calls, fetcher } = fakeFetch([
      json({ access_token: 'a1', refresh_token: 'r1', expires_in: 14400 }),
      json({ access_token: 'a2', expires_in: 14400 }),
      json({ error: 'invalid_grant', error_description: 'refresh token is invalid' }, 400),
    ]);
    expect(
      await exchangeDropboxCode(
        { appKey: 'key', code: 'c', verifier: 'v', redirectUri: 'https://app.example/cb' },
        fetcher,
        1000,
      ),
    ).toEqual({ accessToken: 'a1', refreshToken: 'r1', expiresAt: 1000 + 14400_000 });
    const form = new URLSearchParams(calls[0]!.init.body as string);
    expect(Object.fromEntries(form)).toEqual({
      grant_type: 'authorization_code',
      code: 'c',
      client_id: 'key',
      code_verifier: 'v',
      redirect_uri: 'https://app.example/cb',
    });
    expect(await refreshDropboxToken('key', 'r1', fetcher, 0)).toEqual({
      accessToken: 'a2',
      refreshToken: 'r1',
      expiresAt: 14400_000,
    });
    await expect(refreshDropboxToken('key', 'r1', fetcher)).rejects.toBeInstanceOf(DropboxSignInError);
  });
});

describe('DropboxSession', () => {
  it('refreshes an expiring token once for parallel callers and stores it as a secret', async () => {
    const store = new MemoryVaultStore();
    let now = 0;
    await store.setSecret(
      dropboxSecretKey('v1'),
      JSON.stringify({ accessToken: 'old', refreshToken: 'r', expiresAt: 100_000 }),
    );
    const { calls, fetcher } = fakeFetch([json({ access_token: 'new', expires_in: 3600 })]);
    const session = new DropboxSession({ store, vaultId: 'v1', appKey: 'key', fetcher, now: () => now });
    expect(await session.token()).toBe('old');
    now = 50_000; // within the 60 s margin
    const [a, b] = await Promise.all([session.token(), session.token()]);
    expect([a, b]).toEqual(['new', 'new']);
    expect(calls).toHaveLength(1);
    expect(JSON.parse((await store.getSecret(dropboxSecretKey('v1')))!)).toMatchObject({
      accessToken: 'new',
      refreshToken: 'r',
    });
  });

  it('is signed out without tokens, and offline is not signed out', async () => {
    const store = new MemoryVaultStore();
    const offline = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    const session = new DropboxSession({ store, vaultId: 'v1', appKey: 'key', fetcher: offline });
    await expect(session.token()).rejects.toBeInstanceOf(RemoteAuthError);
    await session.save({ accessToken: 'a', refreshToken: 'r', expiresAt: 0 });
    await expect(session.token()).rejects.toBeInstanceOf(TypeError);
    await session.clear();
    expect(await session.signedIn()).toBe(false);
  });
});

describe('DropboxProvider', () => {
  it('normalises folders', () => {
    expect(normalizeFolder('/Finance/')).toBe('/Finance');
    expect(normalizeFolder('Finance/2026')).toBe('/Finance/2026');
    expect(normalizeFolder('/')).toBe('');
    expect(normalizeFolder('')).toBe('');
  });

  it('maps vault-relative paths under the folder and follows the change cursor', async () => {
    const { calls, fetcher } = fakeFetch([
      // list(): full listing
      json({
        entries: [
          { '.tag': 'folder', path_display: '/Finance', path_lower: '/finance' },
          file('/Finance/main.journal', 'a1'),
          file('/Finance/2026/jan.journal', 'b1'),
        ],
        cursor: 'c1',
        has_more: false,
      }),
      // revision(): no changes
      json({ entries: [], cursor: 'c1', has_more: false }),
      // revision(): a folder was deleted and a file changed
      json({
        entries: [
          { '.tag': 'deleted', path_display: '/Finance/2026', path_lower: '/finance/2026' },
          file('/Finance/main.journal', 'a2'),
        ],
        cursor: 'c2',
        has_more: false,
      }),
      // list(): expired cursor → full listing again
      json({ error_summary: 'reset/..' }, 409),
      json({ entries: [file('/Finance/main.journal', 'a3')], cursor: 'c3', has_more: false }),
      // write
      json({ rev: 'a4', path_display: '/Finance/main.journal' }),
    ]);
    const p = new DropboxProvider(new DropboxApi(async () => 'tok', fetcher), { folder: '/Finance/' });
    expect(await p.list()).toEqual([
      { path: '2026/jan.journal', rev: 'b1' },
      { path: 'main.journal', rev: 'a1' },
    ]);
    const r1 = await p.revision();
    const r2 = await p.revision();
    expect(r2).not.toBe(r1);
    expect(await p.list()).toEqual([{ path: 'main.journal', rev: 'a3' }]);
    expect(p.cursor).toBe('c3');
    expect(await p.write('main.journal', 'x', 'a3')).toEqual({ rev: 'a4' });
    expect(JSON.parse(header(calls[5]!, 'Dropbox-API-Arg')!).path).toBe('/Finance/main.journal');
  });

  it('gives the same revision for the same tree after a reload', async () => {
    const listing = () =>
      json({ entries: [file('/F/a.journal', '1'), file('/F/b.journal', '2')], cursor: 'c', has_more: false });
    const a = new DropboxProvider(new DropboxApi(async () => 'tok', fakeFetch([listing()]).fetcher), { folder: '/F' });
    const b = new DropboxProvider(new DropboxApi(async () => 'tok', fakeFetch([listing()]).fetcher), { folder: '/F' });
    expect(await a.revision()).toBe(await b.revision());
  });

  it('syncs a vault end to end through the engine', async () => {
    const store = new MemoryVaultStore();
    const vault = vaultRecord('v1');
    await store.putVault(vault);
    await store.setSecret(
      dropboxSecretKey('v1'),
      JSON.stringify({ accessToken: 'tok', refreshToken: null, expiresAt: null }),
    );
    const { calls, fetcher } = fakeFetch([
      json({ entries: [file('/Finance/main.journal', 'r1')], cursor: 'c1', has_more: false }),
      new Response('a\n', { headers: { 'Dropbox-API-Result': '{"rev":"r1"}' } }),
      json({ entries: [], cursor: 'c1', has_more: false }),
      json({ rev: 'r2', path_display: '/Finance/main.journal' }),
    ]);
    const provider = DropboxProvider.forVault(vault, store, { appKey: 'key', fetcher });
    const engine = new VaultSyncEngine({ store });
    expect((await engine.sync(vault, provider)).pulled).toEqual(['main.journal']);
    await store.putFiles([{ ...(await store.getFile('v1', 'main.journal'))!, text: 'a\nb\n', dirty: true }]);
    expect((await engine.sync(vault, provider)).pushed).toEqual(['main.journal']);
    expect(JSON.parse(header(calls[3]!, 'Dropbox-API-Arg')!).mode).toEqual({ '.tag': 'update', update: 'r1' });
    expect(calls.every((c) => header(c, 'Authorization') === 'Bearer tok')).toBe(true);
  });
});
