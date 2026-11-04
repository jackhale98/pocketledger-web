// GitHubRestProvider against an in-memory imitation of the GitHub REST API
// (mocked fetch — no network, no real tokens).

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  RemoteAuthError,
  RemoteConflict,
  RemoteError,
  RemoteNotFound,
} from '$lib/contracts/storage';
import { GitHubRestProvider } from '$lib/git/github-rest';
import { MemoryVaultStore } from '$lib/store/memory';
import { VaultSyncEngine } from '$lib/sync/engine';
import { saveLocal } from '$lib/sync/local';
import { vaultRecord } from './helpers/sync-fakes';

const blobSha = (text: string) => {
  const bytes = Buffer.from(text, 'utf8');
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
};

type Req = { method: string; url: string; headers: Record<string, string>; body: unknown };

/** Just enough of api.github.com for the Contents API flow. */
class FakeGitHub {
  files = new Map<string, string>();
  commits = 0;
  head = 'c0';
  requests: Req[] = [];
  token = 'github_pat_FAKE';
  empty = false;

  put(path: string, text: string) {
    this.files.set(path, text);
    this.head = `c${++this.commits}`;
  }

  fetch = (async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    const headers = init.headers as Record<string, string>;
    const body = init.body ? JSON.parse(init.body as string) : undefined;
    this.requests.push({ method: init.method ?? 'GET', url: input, headers, body });
    const json = (b: unknown, status = 200) =>
      new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });
    if (headers.Authorization !== `Bearer ${this.token}`) return json({ message: 'Bad credentials' }, 401);
    const m = /^\/repos\/me\/ledger(?:\/(.*))?$/.exec(decodeURIComponent(url.pathname));
    if (!m) return json({ message: 'Not Found' }, 404);
    const rest = m[1] ?? '';
    if (rest === '') return json({ full_name: 'me/ledger' });
    if (rest === 'git/trees/main') {
      if (this.empty) return json({ message: 'Git Repository is empty.' }, 409);
      return json({
        sha: this.head,
        tree: [
          ...[...this.files].map(([path, text]) => ({ path, type: 'blob', sha: blobSha(text) })),
          { path: 'sub', type: 'tree', sha: 't1' },
        ],
        truncated: false,
      });
    }
    if (rest === 'git/ref/heads/main')
      return this.empty ? json({ message: 'empty' }, 409) : json({ object: { sha: this.head } });
    const blob = /^git\/blobs\/(\w+)$/.exec(rest);
    if (blob) {
      const text = [...this.files.values()].find((t) => blobSha(t) === blob[1]);
      return text === undefined
        ? json({ message: 'Not Found' }, 404)
        : json({ content: Buffer.from(text).toString('base64'), encoding: 'base64' });
    }
    const contents = /^contents\/(.+)$/.exec(rest);
    if (!contents) return json({ message: 'Not Found' }, 404);
    const path = contents[1]!;
    const current = this.files.get(path);
    const method = init.method ?? 'GET';
    if (method === 'GET') {
      if (current === undefined) return json({ message: 'Not Found' }, 404);
      const big = current.length > 50;
      return json({
        type: 'file',
        sha: blobSha(current),
        // Like GitHub for files over 1 MB: no inline content.
        ...(big ? { content: '', encoding: 'none' } : { content: Buffer.from(current).toString('base64').replace(/(.{20})/g, '$1\n'), encoding: 'base64' }),
      });
    }
    if (method === 'PUT') {
      const b = body as { content: string; sha?: string; branch: string; message: string };
      if (current !== undefined && !b.sha) return json({ message: '"sha" wasn\'t supplied.' }, 422);
      if (current !== undefined && b.sha !== blobSha(current))
        return json({ message: `${path} does not match ${b.sha}` }, 409);
      if (current === undefined && b.sha) return json({ message: 'Not Found' }, 404);
      const text = Buffer.from(b.content, 'base64').toString('utf8');
      this.put(path, text);
      return json({ content: { sha: blobSha(text), path } }, current === undefined ? 201 : 200);
    }
    if (method === 'DELETE') {
      const b = body as { sha: string };
      if (current === undefined) return json({ message: 'Not Found' }, 404);
      if (b.sha !== blobSha(current)) return json({ message: 'sha mismatch' }, 409);
      this.files.delete(path);
      this.head = `c${++this.commits}`;
      return json({ commit: { sha: this.head } });
    }
    return json({ message: 'Method' }, 405);
  }) as unknown as typeof fetch;
}

function setup() {
  const gh = new FakeGitHub();
  const provider = GitHubRestProvider.fromRemote(
    {
      url: 'https://github.com/me/ledger.git',
      branch: 'main',
      author: { name: 'Pat', email: 'pat@example.com' },
    },
    async () => gh.token,
    gh.fetch,
  );
  return { gh, provider };
}

describe('GitHubRestProvider', () => {
  it('lists blobs with their sha as rev', async () => {
    const { gh, provider } = setup();
    gh.put('main.journal', 'include 2026.journal\n');
    gh.put('sub/2026.journal', '2026-01-01 x\n');
    expect(await provider.list()).toEqual([
      { path: 'main.journal', rev: blobSha('include 2026.journal\n') },
      { path: 'sub/2026.journal', rev: blobSha('2026-01-01 x\n') },
    ]);
    const req = gh.requests[0]!;
    expect(req.url).toBe('https://api.github.com/repos/me/ledger/git/trees/main?recursive=1');
    expect(req.headers.Accept).toBe('application/vnd.github+json');
    expect(req.headers['X-GitHub-Api-Version']).toBe('2022-11-28');
    expect(provider.maxConcurrentWrites).toBe(1);
  });

  it('treats an empty repository as empty', async () => {
    const { gh, provider } = setup();
    gh.empty = true;
    expect(await provider.list()).toEqual([]);
    expect(await provider.revision()).toBe('empty');
  });

  it('reads UTF-8 content (and large files via the blob API)', async () => {
    const { gh, provider } = setup();
    gh.put('café.journal', '2026-01-01 Café ☕\n');
    const big = `${'2026-01-01 x\n'.repeat(10)}`;
    gh.put('big.journal', big);
    expect(await provider.read('café.journal')).toEqual({
      text: '2026-01-01 Café ☕\n',
      rev: blobSha('2026-01-01 Café ☕\n'),
    });
    expect(gh.requests.at(-1)!.url).toBe('https://api.github.com/repos/me/ledger/contents/caf%C3%A9.journal?ref=main');
    expect(await provider.read('big.journal')).toEqual({ text: big, rev: blobSha(big) });
    expect(gh.requests.at(-1)!.url).toMatch(/\/git\/blobs\/[0-9a-f]{40}$/);
    await expect(provider.read('nope.journal')).rejects.toBeInstanceOf(RemoteNotFound);
  });

  it('writes conditionally on the blob sha', async () => {
    const { gh, provider } = setup();
    const { rev } = await provider.write('main.journal', 'a\n', null);
    expect(rev).toBe(blobSha('a\n'));
    const put = gh.requests.at(-1)!;
    expect(put.method).toBe('PUT');
    expect(put.body).toMatchObject({
      message: 'Add main.journal (PocketLedger)',
      branch: 'main',
      author: { name: 'Pat', email: 'pat@example.com' },
    });
    expect(put.body).not.toHaveProperty('sha');
    // Create when it exists, update with a stale sha: both conflicts.
    await expect(provider.write('main.journal', 'b\n', null)).rejects.toBeInstanceOf(RemoteConflict);
    await expect(provider.write('main.journal', 'b\n', blobSha('old\n'))).rejects.toBeInstanceOf(RemoteConflict);
    expect((await provider.write('main.journal', 'b\n', rev)).rev).toBe(blobSha('b\n'));
    expect(gh.requests.at(-1)!.body).toMatchObject({ sha: rev, message: 'Update main.journal (PocketLedger)' });
  });

  it('deletes conditionally; missing files are fine', async () => {
    const { gh, provider } = setup();
    gh.put('a.journal', 'a\n');
    await expect(provider.delete('a.journal', blobSha('x\n'))).rejects.toBeInstanceOf(RemoteConflict);
    await provider.delete('a.journal', blobSha('a\n'));
    expect(gh.files.has('a.journal')).toBe(false);
    await provider.delete('a.journal', null);
    gh.put('b.journal', 'b\n');
    await provider.delete('b.journal', null);
    expect(gh.files.size).toBe(0);
  });

  it('revision is the branch head and changes with every commit', async () => {
    const { gh, provider } = setup();
    gh.put('a.journal', 'a\n');
    const r1 = await provider.revision();
    expect(r1).toBe(gh.head);
    await provider.write('b.journal', 'b\n', null);
    expect(await provider.revision()).not.toBe(r1);
  });

  it('reports a refused token, a missing repository and other errors', async () => {
    const { gh } = setup();
    const wrong = new GitHubRestProvider({
      owner: 'me',
      repo: 'ledger',
      branch: 'main',
      token: () => 'wrong',
      fetcher: gh.fetch,
    });
    await expect(wrong.list()).rejects.toBeInstanceOf(RemoteAuthError);
    const missing = new GitHubRestProvider({
      owner: 'me',
      repo: 'nope',
      branch: 'main',
      token: () => gh.token,
      fetcher: gh.fetch,
    });
    await expect(missing.list()).rejects.toBeInstanceOf(RemoteNotFound);
    const limited = new GitHubRestProvider({
      owner: 'me',
      repo: 'ledger',
      branch: 'main',
      token: () => 't',
      fetcher: (async () =>
        new Response('{"message":"API rate limit exceeded"}', {
          status: 403,
          headers: { 'x-ratelimit-remaining': '0' },
        })) as unknown as typeof fetch,
    });
    await expect(limited.revision()).rejects.toBeInstanceOf(RemoteError);
  });

  it('refuses non-GitHub remotes', () => {
    expect(() =>
      GitHubRestProvider.fromRemote(
        { url: 'https://gitlab.com/me/ledger.git', branch: 'main', author: { name: 'a', email: 'b' } },
        () => null,
      ),
    ).toThrow(/github\.com/);
  });

  it('syncs a vault end to end through the engine (one commit per changed file)', async () => {
    const { gh, provider } = setup();
    gh.put('main.journal', 'include 2026.journal\n');
    gh.put('2026.journal', '2026-01-01 a\n    x  1\n    y\n');
    const store = new MemoryVaultStore();
    const vault = vaultRecord('g1', { provider: 'github' });
    const engine = new VaultSyncEngine({ store });
    expect((await engine.sync(vault, provider)).pulled).toEqual(['2026.journal', 'main.journal']);
    await saveLocal(store, 'g1', [
      { path: '2026.journal', text: '2026-01-01 a\n    x  1\n    y\n\n2026-01-02 b\n    x  2\n    y\n' },
    ]);
    // Meanwhile on github.com: an edit to another line of the same file.
    gh.put('2026.journal', '2026-01-01 A\n    x  1\n    y\n');
    const commits = gh.commits;
    const r = await engine.sync(vault, provider);
    expect(r.conflicts).toEqual([]);
    expect(r.pushed).toEqual(['2026.journal']);
    expect(gh.files.get('2026.journal')).toBe('2026-01-01 A\n    x  1\n    y\n\n2026-01-02 b\n    x  2\n    y\n');
    expect(gh.commits).toBe(commits + 1);
    expect(gh.requests.every((q) => q.headers.Authorization === 'Bearer github_pat_FAKE')).toBe(true);
  });
});
