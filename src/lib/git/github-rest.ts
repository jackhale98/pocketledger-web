// "No-proxy mode" (BUILD_PLAN §8.3): a GitHub repository as a SyncProvider
// over the REST Contents API. api.github.com sends CORS headers, so the
// browser talks to it directly — no worker. Each write or delete is one
// commit on the branch; a file's `rev` is its blob sha, and GitHub refuses a
// write whose `sha` is stale (→ RemoteConflict), which is exactly the
// conditional write the sync engine needs.

import {
  RemoteAuthError,
  RemoteConflict,
  RemoteError,
  RemoteNotFound,
  type GitRemote,
  type RemoteEntry,
  type SyncProvider,
} from '$lib/contracts/storage';
import type { ProviderHints } from '$lib/sync/engine';
import { assertVaultPath } from '$lib/sync/paths';
import { parseRepo } from './providers';

export const GITHUB_API = 'https://api.github.com';

export interface GitHubRestOptions {
  owner: string;
  repo: string;
  branch: string;
  /** Fine-grained PAT (Contents: read & write) or OAuth token. */
  token: () => string | null | Promise<string | null>;
  /** Commit author/committer; GitHub uses the token's user when omitted. */
  author?: { name: string; email: string } | undefined;
  /** Commit message for each write/delete. */
  message?: ((op: 'create' | 'update' | 'delete', path: string) => string) | undefined;
  fetcher?: typeof fetch | undefined;
  apiBase?: string | undefined;
}

const defaultMessage = (op: 'create' | 'update' | 'delete', path: string) =>
  `${op === 'create' ? 'Add' : op === 'update' ? 'Update' : 'Delete'} ${path} (PocketLedger)`;

function encodeBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function decodeBase64(b64: string): string {
  const bin = atob(b64.replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

const encodePath = (path: string) => assertVaultPath(path).split('/').map(encodeURIComponent).join('/');

export class GitHubRestProvider implements SyncProvider, ProviderHints {
  readonly kind = 'github' as const;
  /** Every write is a commit on one branch: parallel writes would race each other. */
  readonly maxConcurrentWrites = 1;
  readonly #o: GitHubRestOptions;
  readonly #fetch: typeof fetch;
  readonly #api: string;

  constructor(options: GitHubRestOptions) {
    this.#o = options;
    this.#fetch = options.fetcher ?? ((...a) => fetch(...a));
    this.#api = (options.apiBase ?? GITHUB_API).replace(/\/+$/, '');
  }

  /** From a vault's GitRemote (`transport: 'rest'`). */
  static fromRemote(
    remote: Pick<GitRemote, 'url' | 'branch' | 'author'>,
    token: GitHubRestOptions['token'],
    fetcher?: typeof fetch,
  ): GitHubRestProvider {
    const loc = parseRepo(remote.url);
    if (!loc || loc.host !== 'github.com')
      throw new Error('REST mode works with github.com repositories only.');
    return new GitHubRestProvider({
      owner: loc.owner,
      repo: loc.repo,
      branch: remote.branch || 'main',
      token,
      author: remote.author,
      fetcher,
    });
  }

  get #repo() {
    return `${this.#api}/repos/${encodeURIComponent(this.#o.owner)}/${encodeURIComponent(this.#o.repo)}`;
  }

  async #call(url: string, init: RequestInit = {}): Promise<Response> {
    const token = await this.#o.token();
    const res = await this.#fetch(url, {
      // GitHub marks API responses cacheable for 60 s; sync must see the latest.
      cache: 'no-store',
      ...(typeof AbortSignal.timeout === 'function' ? { signal: AbortSignal.timeout(60_000) } : {}),
      ...init,
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers as Record<string, string> | undefined),
      },
    });
    if (res.status === 401) throw new RemoteAuthError('GitHub refused the access token.');
    if (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0')
      throw new RemoteError(403, 'API rate limit exceeded; try again later', 'GitHub');
    return res;
  }

  async #fail(res: Response): Promise<never> {
    let message = '';
    try {
      message = ((await res.json()) as { message?: string }).message ?? '';
    } catch {
      /* not JSON */
    }
    if (res.status === 403)
      throw new RemoteAuthError(
        `GitHub: ${message || 'forbidden'} — the token needs Contents read/write on ${this.#o.owner}/${this.#o.repo}.`,
      );
    throw new RemoteError(res.status, message, 'GitHub');
  }

  /** Every blob on the branch (the engine filters to journal files). */
  async list(): Promise<RemoteEntry[]> {
    const res = await this.#call(
      `${this.#repo}/git/trees/${encodeURIComponent(this.#o.branch)}?recursive=1`,
    );
    // An empty repository (409) or a branch that doesn't exist yet (404): nothing there.
    if (res.status === 409 || res.status === 404) {
      if (res.status === 404 && !(await this.#repoExists()))
        throw new RemoteNotFound(`${this.#o.owner}/${this.#o.repo}`);
      return [];
    }
    if (!res.ok) return this.#fail(res);
    const body = (await res.json()) as {
      tree: { path: string; type: string; sha: string }[];
      truncated?: boolean;
    };
    if (body.truncated)
      throw new RemoteError(200, 'repository too large for REST mode; use git mode', 'GitHub');
    return body.tree
      .filter((e) => e.type === 'blob')
      .map((e) => ({ path: e.path, rev: e.sha }))
      .sort((a, b) => (a.path < b.path ? -1 : 1));
  }

  async #repoExists(): Promise<boolean> {
    const res = await this.#call(this.#repo);
    return res.ok;
  }

  async read(path: string): Promise<{ text: string; rev: string }> {
    const res = await this.#call(
      `${this.#repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(this.#o.branch)}`,
    );
    if (res.status === 404) throw new RemoteNotFound(path);
    if (!res.ok) return this.#fail(res);
    const body = (await res.json()) as {
      type?: string;
      sha: string;
      content?: string;
      encoding?: string;
    };
    if (body.type && body.type !== 'file') throw new RemoteNotFound(path);
    if (body.encoding === 'base64' && body.content !== undefined)
      return { text: decodeBase64(body.content), rev: body.sha };
    // Files over 1 MB come without content: fetch the blob itself.
    return { text: await this.#blob(body.sha), rev: body.sha };
  }

  async #blob(sha: string): Promise<string> {
    const res = await this.#call(`${this.#repo}/git/blobs/${sha}`);
    if (!res.ok) return this.#fail(res);
    const body = (await res.json()) as { content: string; encoding: string };
    return body.encoding === 'base64' ? decodeBase64(body.content) : body.content;
  }

  async write(path: string, text: string, rev: string | null): Promise<{ rev: string }> {
    const op = rev ? 'update' : 'create';
    const res = await this.#call(`${this.#repo}/contents/${encodePath(path)}`, {
      method: 'PUT',
      body: JSON.stringify({
        message: (this.#o.message ?? defaultMessage)(op, path),
        content: encodeBase64(text),
        branch: this.#o.branch,
        ...(rev ? { sha: rev } : {}),
        ...(this.#o.author ? { author: this.#o.author, committer: this.#o.author } : {}),
      }),
    });
    // 409: sha doesn't match; 422: "sha wasn't supplied" (the file exists already).
    if (res.status === 409 || res.status === 422) throw new RemoteConflict(path);
    if (res.status === 404) throw rev ? new RemoteConflict(path) : new RemoteNotFound(path);
    if (!res.ok) return this.#fail(res);
    const body = (await res.json()) as { content: { sha: string } };
    return { rev: body.content.sha };
  }

  async delete(path: string, rev: string | null): Promise<void> {
    let sha = rev;
    if (!sha) {
      try {
        sha = (await this.read(path)).rev;
      } catch (e) {
        if (e instanceof RemoteNotFound) return;
        throw e;
      }
    }
    const res = await this.#call(`${this.#repo}/contents/${encodePath(path)}`, {
      method: 'DELETE',
      body: JSON.stringify({
        message: (this.#o.message ?? defaultMessage)('delete', path),
        sha,
        branch: this.#o.branch,
        ...(this.#o.author ? { author: this.#o.author, committer: this.#o.author } : {}),
      }),
    });
    if (res.status === 404) return;
    if (res.status === 409 || res.status === 422) throw new RemoteConflict(path);
    if (!res.ok) return this.#fail(res);
  }

  /** The branch's head commit sha: changes with every commit (one cheap request). */
  async revision(): Promise<string> {
    const res = await this.#call(
      `${this.#repo}/git/ref/heads/${encodeURIComponent(this.#o.branch)}`,
    );
    if (res.status === 404 || res.status === 409) return 'empty';
    if (!res.ok) return this.#fail(res);
    const body = (await res.json()) as { object: { sha: string } };
    return body.object.sha;
  }
}
