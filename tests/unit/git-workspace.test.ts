// IsoGitWorkspace against a real `git http-backend` on 127.0.0.1.

import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'isomorphic-git/http/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RemoteAuthError, type GitRemote } from '$lib/contracts/storage';
import { diffLines } from '$lib/git/diff';
import { parseRepo, tokenAuth } from '$lib/git/providers';
import { IsoGitWorkspace, UncommittedChangesError, type IsoGitWorkspaceOptions } from '$lib/git/workspace';
import { startGitServer, type GitServer } from './helpers/git-server';

const TX = (date: string, payee: string, amount: number) =>
  `${date} ${payee}\n    expenses:misc    ${amount}\n    assets:bank     ${-amount}\n`;

const MAIN = `include 2026.journal\n`;
const Y2026 = `${TX('2026-01-01', 'one', 1)}\n${TX('2026-01-02', 'two', 2)}\n${TX('2026-01-03', 'three', 3)}`;

let root: string;
let server: GitServer;
let n = 0;

beforeAll(async () => {
  root = fs.mkdtempSync(join(tmpdir(), 'pl-git-ws-'));
  server = await startGitServer('ledger', {
    'main.journal': MAIN,
    '2026.journal': Y2026,
    'README.md': '# ledger\n',
    '.github/x.journal': 'hidden\n',
  });
});

afterAll(() => {
  server?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

function remote(patch: Partial<GitRemote> = {}): GitRemote {
  return {
    kind: 'github',
    url: `${server.url}/ledger.git`,
    branch: 'main',
    proxy: '',
    author: { name: 'Tester', email: 'tester@example.com' },
    transport: 'git',
    ...patch,
  };
}

function open(patch: Partial<GitRemote> = {}, extra: Partial<IsoGitWorkspaceOptions> = {}) {
  return new IsoGitWorkspace({
    fs: { promises: fs.promises },
    http,
    dir: join(root, `clone-${++n}`),
    remote: remote(patch),
    token: () => null,
    ...extra,
  });
}

describe('IsoGitWorkspace', () => {
  it('clones and reads only journal files outside hidden folders', async () => {
    const ws = open();
    expect(await ws.isCloned()).toBe(false);
    const phases: string[] = [];
    await ws.clone((p) => phases.push(p.phase));
    expect(await ws.isCloned()).toBe(true);
    expect(phases[0]).toBe('Contacting the git host');
    expect(await ws.readFiles()).toEqual({ '2026.journal': Y2026, 'main.journal': MAIN });
    expect(await ws.status()).toEqual([]);
    expect(await ws.aheadBehind()).toEqual({ ahead: 0, behind: 0 });
  });

  it('writes, reports status and diffs, commits and pushes', async () => {
    const ws = open();
    await ws.clone();
    const edited = Y2026.replace('two', 'TWO');
    await ws.writeFiles([
      { path: '2026.journal', text: edited },
      { path: 'prices/2026.prices', text: 'P 2026-01-01 EUR 1.1 USD\n' },
      { path: 'main.journal', text: null },
    ]);
    expect(await ws.status()).toEqual([
      { path: '2026.journal', status: 'modified' },
      { path: 'main.journal', status: 'deleted' },
      { path: 'prices/2026.prices', status: 'added' },
    ]);
    expect(await ws.diff('2026.journal')).toEqual({ before: Y2026, after: edited });
    expect(await ws.diff('prices/2026.prices')).toEqual({ before: null, after: 'P 2026-01-01 EUR 1.1 USD\n' });
    expect(await ws.diff('main.journal')).toEqual({ before: MAIN, after: null });
    const hunks = diffLines(Y2026, edited);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]!.lines.filter((l) => l.kind !== 'context').map((l) => `${l.kind} ${l.text}`)).toEqual([
      'remove 2026-01-02 two',
      'add 2026-01-02 TWO',
    ]);

    const oid = await ws.commit(['2026.journal', 'prices/2026.prices'], 'Edit two, add prices');
    expect(oid).toMatch(/^[0-9a-f]{40}$/);
    expect(await ws.status()).toEqual([{ path: 'main.journal', status: 'deleted' }]);
    expect(await ws.aheadBehind()).toEqual({ ahead: 1, behind: 0 });
    // Bring main.journal back so later tests see the original repository.
    await ws.discard('main.journal');
    expect(await ws.status()).toEqual([]);

    expect(await ws.push()).toEqual({ ok: true });
    expect(server.git('ledger.git', 'log', '-1', '--format=%s %an', 'main')).toBe('Edit two, add prices Tester');
    expect(await ws.aheadBehind()).toEqual({ ahead: 0, behind: 0 });
    expect(await ws.push()).toEqual({ ok: true, message: 'Up to date' });
    expect((await ws.log(1))[0]!.message).toBe('Edit two, add prices');
  });

  it('pulls a fast-forward and reports what changed', async () => {
    const ws = open();
    await ws.clone();
    server.commit('ledger.git', { '2026.journal': `${(await ws.readFiles())['2026.journal']}\n${TX('2026-01-04', 'four', 4)}` }, 'four');
    expect(await ws.fetch()).toEqual({ ahead: 0, behind: 1 });
    const r = await ws.pull();
    expect(r).toEqual({ updated: ['2026.journal'], conflicts: [], invalid: [] });
    expect((await ws.readFiles())['2026.journal']).toContain('four');
    expect(await ws.pull()).toEqual({ updated: [], conflicts: [], invalid: [] });
  });

  it('merges non-overlapping edits from another device and pushes the merge', async () => {
    const ws = open();
    await ws.clone();
    const text = (await ws.readFiles())['2026.journal']!;
    await ws.writeFiles([{ path: '2026.journal', text: text.replace('one', 'ONE') }]);
    await ws.commit(['2026.journal'], 'one → ONE');
    server.commit('ledger.git', { '2026.journal': text.replace('three', 'THREE') }, 'three → THREE');
    expect((await ws.push()).ok).toBe(false);
    const r = await ws.pull();
    expect(r.conflicts).toEqual([]);
    expect(r.updated).toEqual(['2026.journal']);
    const merged = (await ws.readFiles())['2026.journal']!;
    expect(merged).toContain('ONE');
    expect(merged).toContain('THREE');
    expect(await ws.push()).toEqual({ ok: true });
    expect(server.git('ledger.git', 'show', 'main:2026.journal')).toBe(merged.trimEnd());
  });

  it('returns overlapping edits as conflicts with markers, then completes with resolutions', async () => {
    server.seed('conflict', { 'main.journal': MAIN, '2026.journal': Y2026 });
    const ws = open({ url: `${server.url}/conflict.git` });
    await ws.clone();
    const text = (await ws.readFiles())['2026.journal']!;
    await ws.writeFiles([{ path: '2026.journal', text: text.replace('two', 'phone') }]);
    await ws.commit(['2026.journal'], 'phone');
    server.commit('conflict.git', { '2026.journal': text.replace('two', 'laptop') }, 'laptop');
    const r = await ws.pull();
    expect(r.updated).toEqual([]);
    expect(r.conflicts).toHaveLength(1);
    const c = r.conflicts[0]!;
    expect(c.path).toBe('2026.journal');
    expect(c.base).toBe(text);
    expect(c.local).toContain('phone');
    expect(c.remote).toContain('laptop');
    expect(c.merged).toMatch(/<<<<<<< local\n.*phone[\s\S]*=======\n.*laptop[\s\S]*>>>>>>> remote/);
    // Nothing changed in the working tree.
    expect((await ws.readFiles())['2026.journal']).toBe(text.replace('two', 'phone'));

    const chosen = text.replace('two', 'phone and laptop');
    const done = await ws.pull(new Map([['2026.journal', chosen]]));
    expect(done.conflicts).toEqual([]);
    expect((await ws.readFiles())['2026.journal']).toBe(chosen);
    expect((await ws.push()).ok).toBe(true);
  });

  it('refuses to pull over uncommitted edits to incoming files', async () => {
    const ws = open();
    await ws.clone();
    const text = (await ws.readFiles())['main.journal']!;
    await ws.writeFiles([{ path: 'main.journal', text: `${text}; local\n` }]);
    server.commit('ledger.git', { 'main.journal': `${text}; remote\n` }, 'remote main');
    await expect(ws.pull()).rejects.toBeInstanceOf(UncommittedChangesError);
    expect((await ws.readFiles())['main.journal']).toBe(`${text}; local\n`);
  });

  it('reports a merge that fails validation and holds the push until it is fixed', async () => {
    const validate = async (files: Record<string, string>) =>
      /expenses:misc {4}1\n {4}assets:bank {5}-2/.test(files['2026.journal'] ?? '')
        ? [{ path: '2026.journal', message: 'unbalanced' }]
        : [];
    server.seed('invalid', { 'main.journal': MAIN, '2026.journal': Y2026 });
    const ws = open({ url: `${server.url}/invalid.git` }, { validate });
    await ws.clone();
    const text = (await ws.readFiles())['2026.journal']!;
    const tx = TX('2026-01-01', 'one', 1);
    expect(text).toContain(tx);
    // The local side breaks the balance; the remote edits another transaction. The
    // merge is clean, but the merged journal fails the check.
    await ws.writeFiles([{ path: '2026.journal', text: text.replace(tx, tx.replace('-1', '-2')) }]);
    await ws.commit(['2026.journal'], 'local half');
    server.commit('invalid.git', { '2026.journal': text.replace('three', 'tres') }, 'remote half');
    const r = await ws.pull();
    expect(r.conflicts).toEqual([]);
    expect(r.invalid).toEqual([{ path: '2026.journal', message: 'unbalanced' }]);
    const pushed = await ws.push();
    expect(pushed.ok).toBe(false);
    expect(pushed.message).toMatch(/unbalanced/);

    const fixed = (await ws.readFiles())['2026.journal']!.replace('-2', '-1');
    await ws.writeFiles([{ path: '2026.journal', text: fixed }]);
    await ws.commit(['2026.journal'], 'fix');
    expect(await ws.push()).toEqual({ ok: true });
  });

  it('clones an empty repository, then makes and pushes the first commit', async () => {
    server.empty('blank');
    const ws = open({ url: `${server.url}/blank.git`, branch: 'main' });
    await ws.clone();
    expect(await ws.readFiles()).toEqual({});
    expect(await ws.aheadBehind()).toEqual({ ahead: 0, behind: 0 });
    expect(await ws.pull()).toEqual({ updated: [], conflicts: [], invalid: [] });
    await ws.writeFiles([{ path: 'main.journal', text: MAIN }]);
    await ws.commit(['main.journal'], 'First');
    expect(await ws.push()).toEqual({ ok: true });
    expect(server.git('blank.git', 'log', '-1', '--format=%s', 'main')).toBe('First');
  });

  it('explains a branch that does not exist', async () => {
    await expect(open({ branch: 'nope' }).clone()).rejects.toThrow(/isn't in this repository/);
  });

  it('rejects paths outside the vault', async () => {
    const ws = open();
    await ws.clone();
    await expect(ws.writeFiles([{ path: '../evil.journal', text: 'x' }])).rejects.toThrow(/Invalid vault path/);
  });
});

describe('IsoGitWorkspace through a CORS proxy with a PAT', () => {
  let proxy: GitServer;
  beforeAll(async () => {
    proxy = await startGitServer(
      'private',
      { 'main.journal': MAIN },
      { auth: 'x-access-token:github_pat_test', prefix: '/proxy' },
    );
  });
  afterAll(() => proxy?.close());

  const make = (token: string | null) =>
    new IsoGitWorkspace({
      fs: { promises: fs.promises },
      http,
      dir: join(root, `private-${++n}`),
      // The git host is never contacted directly: every request goes through the proxy.
      remote: {
        url: 'https://git.example/private.git',
        branch: 'main',
        proxy: `${proxy.url}/proxy/`,
        author: { name: 'T', email: 't@example.com' },
      },
      token: async () => token,
    });

  it('sends the token via onAuth and every request through the proxy', async () => {
    const ws = make('github_pat_test');
    await ws.clone();
    expect(await ws.readFiles()).toEqual({ 'main.journal': MAIN });
    const paths = proxy.requests.map((r) => r.path);
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.every((p) => p.startsWith('/proxy/git.example/private.git/'))).toBe(true);
    expect(proxy.requests.some((r) => r.auth === `Basic ${btoa('x-access-token:github_pat_test')}`)).toBe(true);
    await ws.writeFiles([{ path: 'main.journal', text: `${MAIN}; edit\n` }]);
    await ws.commit(['main.journal'], 'Edit');
    expect(await ws.push()).toEqual({ ok: true });
  });

  it('a missing or wrong token is a RemoteAuthError', async () => {
    await expect(make(null).clone()).rejects.toBeInstanceOf(RemoteAuthError);
    await expect(make('wrong').clone()).rejects.toBeInstanceOf(RemoteAuthError);
  });
});

describe('git providers', () => {
  it('parses repository inputs into clone URLs', () => {
    expect(parseRepo('me/ledger')).toMatchObject({ url: 'https://github.com/me/ledger.git', slug: 'me/ledger' });
    expect(parseRepo('https://github.com/me/ledger')?.url).toBe('https://github.com/me/ledger.git');
    expect(parseRepo('https://github.com/me/ledger/tree/main/2026')?.url).toBe('https://github.com/me/ledger.git');
    expect(parseRepo('git@github.com:me/ledger.git')?.url).toBe('https://github.com/me/ledger.git');
    expect(parseRepo('http://github.com/me/ledger')).toBeNull();
    expect(parseRepo('https://github.com/me')).toBeNull();
    expect(parseRepo('')).toBeNull();
  });
  it('builds token credentials per host', () => {
    expect(tokenAuth('t')).toEqual({ username: 'x-access-token', password: 't' });
    expect(tokenAuth('t', 'gitlab.com')).toEqual({ username: 'oauth2', password: 't' });
  });
});
