// A ledger repository checked out in browser storage, driven by
// isomorphic-git (ported from mycelium-web src/lib/git/repo.ts +
// workspace.ts). Storage-agnostic: pass LightningFS in the browser (see
// browser.ts) or Node's fs in tests.
//
// Edits are written to the working tree; the person reviews `status()` /
// `diff()`, commits, then pulls and pushes explicitly — this is git, not a
// sync service. Pull merges with the same line-wise three-way merge as the
// sync engine; overlapping edits come back as FileConflicts with diff3
// markers, and `pull(resolutions)` completes the merge with the person's
// chosen texts.

import git, {
  Errors,
  TREE,
  type AuthCallback,
  type HttpClient,
  type PromiseFsClient,
} from 'isomorphic-git';
import {
  RemoteAuthError,
  RemoteError,
  type FileConflict,
  type GitRemote,
  type GitStatusEntry,
  type GitWorkspace,
} from '$lib/contracts/storage';
import type { ValidateHook } from '$lib/sync/engine';
import { merge3 } from '$lib/sync/merge';
import { assertVaultPath, syncable } from '$lib/sync/paths';
import { tokenAuth } from './providers';

export type GitProgress = { phase: string; loaded: number; total?: number };

export interface IsoGitWorkspaceOptions {
  fs: PromiseFsClient;
  http: HttpClient;
  /** Working-tree directory, e.g. `/repo`. */
  dir: string;
  remote: Pick<GitRemote, 'url' | 'branch' | 'proxy' | 'author'>;
  /** The personal access token (or OAuth token); `null` for public repositories. */
  token: () => string | null | Promise<string | null>;
  /** Which files the vault shows and status reports (default `syncable`). */
  include?: (path: string) => boolean;
  /**
   * Post-merge validation (wire to engine.check). A pull that merges is
   * checked; unpushed merge commits must validate before `push()` sends them.
   */
  validate?: (files: Record<string, string>) => ReturnType<ValidateHook>;
}

/** Pull refused: the remote changed files that have uncommitted edits here. */
export class UncommittedChangesError extends Error {
  constructor(readonly paths: string[]) {
    super(`Commit or discard your changes to ${paths.join(', ')} before pulling.`);
    this.name = 'UncommittedChangesError';
  }
}

export interface GitPullResult {
  /** Paths whose working-tree text changed. */
  updated: string[];
  conflicts: FileConflict[];
  /** A merge that applied cleanly but failed validation (push is held until fixed). */
  invalid: { path: string; message: string }[];
}

const REMOTE = 'origin';
const decoder = new TextDecoder();

export class IsoGitWorkspace implements GitWorkspace {
  readonly #o: IsoGitWorkspaceOptions;
  readonly #include: (path: string) => boolean;
  /** Shared object cache: makes repeated reads from packfiles fast. */
  readonly #cache = {};

  constructor(options: IsoGitWorkspaceOptions) {
    this.#o = options;
    this.#include = options.include ?? syncable;
  }

  get dir(): string {
    return this.#o.dir;
  }

  // ---------------------------------------------------------------- plumbing

  #onAuth(): { onAuth: AuthCallback; onAuthFailure: AuthCallback } {
    const host = hostOf(this.#o.remote.url);
    return {
      onAuth: async () => {
        const token = await this.#o.token();
        return token ? tokenAuth(token, host) : {};
      },
      // A rejected token: don't loop, report it.
      onAuthFailure: () => ({ cancel: true }),
    };
  }

  #local() {
    return { fs: this.#o.fs, dir: this.#o.dir, cache: this.#cache };
  }

  #net() {
    const proxy = this.#o.remote.proxy?.trim();
    return {
      ...this.#local(),
      http: this.#o.http,
      ...(proxy ? { corsProxy: proxy.replace(/\/+$/, '') } : {}),
      ...this.#onAuth(),
    };
  }

  #author() {
    return { name: this.#o.remote.author.name, email: this.#o.remote.author.email };
  }

  /** LightningFS persists lazily; flush after writes so a closed tab loses nothing. */
  async #flush() {
    const p = this.#o.fs.promises as { flush?: () => Promise<void> };
    await p.flush?.();
  }

  async #mapErrors<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (e) {
      throw gitError(e);
    }
  }

  async branch(): Promise<string> {
    return (
      (await git.currentBranch({ ...this.#local(), fullname: false })) ||
      this.#o.remote.branch ||
      'main'
    );
  }

  async head(): Promise<string | null> {
    try {
      return await git.resolveRef({ ...this.#local(), ref: 'HEAD' });
    } catch {
      return null;
    }
  }

  async isCloned(): Promise<boolean> {
    try {
      await this.#o.fs.promises.stat(`${this.#o.dir}/.git`);
      return true;
    } catch {
      return false;
    }
  }

  async #remoteHead(branch: string): Promise<string | null> {
    try {
      return await git.resolveRef({ ...this.#local(), ref: `refs/remotes/${REMOTE}/${branch}` });
    } catch {
      return null;
    }
  }

  /** Paths → blob ids of included files in a commit. */
  async #tree(ref: string): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    await git.walk({
      ...this.#local(),
      trees: [TREE({ ref })],
      map: async (path, [entry]) => {
        if (!entry || path === '.') return true;
        const type = await entry.type();
        if (type === 'blob' && this.#include(path)) out.set(path, await entry.oid());
        return true;
      },
    });
    return out;
  }

  async #blob(oid: string): Promise<string> {
    const { blob } = await git.readBlob({ ...this.#local(), oid });
    return decoder.decode(blob);
  }

  async #readWorking(path: string): Promise<string | null> {
    try {
      return (await this.#o.fs.promises.readFile(`${this.#o.dir}/${path}`, {
        encoding: 'utf8',
      })) as string;
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------- GitWorkspace

  /**
   * Clone the branch (full history of that one branch, no tags). An empty
   * remote becomes an empty local repository on the requested branch, ready
   * for a first commit and push.
   */
  async clone(onProgress?: (p: GitProgress) => void): Promise<void> {
    const { url, branch } = this.#o.remote;
    await this.#mapErrors(async () => {
      onProgress?.({ phase: 'Contacting the git host', loaded: 0 });
      const net = this.#net();
      const info = await git.getRemoteInfo2({
        http: net.http,
        url,
        ...('corsProxy' in net ? { corsProxy: net.corsProxy } : {}),
        onAuth: net.onAuth,
        onAuthFailure: net.onAuthFailure,
        protocolVersion: 1,
      });
      const heads = (info.refs ?? [])
        .filter((r) => r.ref.startsWith('refs/heads/'))
        .map((r) => r.ref.slice('refs/heads/'.length));
      await mkdirp(this.#o.fs, this.#o.dir);
      if (heads.length === 0) {
        const b = branch || 'main';
        await git.init({ ...this.#local(), defaultBranch: b });
        await git.addRemote({ ...this.#local(), remote: REMOTE, url });
        await git.setConfig({ ...this.#local(), path: `branch.${b}.remote`, value: REMOTE });
        await git.setConfig({ ...this.#local(), path: `branch.${b}.merge`, value: `refs/heads/${b}` });
        return;
      }
      if (branch && !heads.includes(branch))
        throw new Error(
          `The branch “${branch}” isn't in this repository. It has: ${heads.slice(0, 8).join(', ')}.`,
        );
      const target = (info.refs ?? []).find((r) => r.ref === 'HEAD')?.target;
      const ref =
        branch ||
        (target?.startsWith('refs/heads/') ? target.slice('refs/heads/'.length) : null) ||
        (heads.includes('main') ? 'main' : heads.includes('master') ? 'master' : heads[0]!);
      await git.clone({
        ...net,
        url,
        ref,
        singleBranch: true,
        noTags: true,
        onProgress: (e) =>
          onProgress?.({ phase: e.phase, loaded: e.loaded, ...(e.total ? { total: e.total } : {}) }),
      });
    });
    await this.#flush();
  }

  /** Every included file in the working tree (committed or not). */
  async readFiles(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    const walk = async (rel: string) => {
      const abs = rel ? `${this.#o.dir}/${rel}` : this.#o.dir;
      let names: string[];
      try {
        names = (await this.#o.fs.promises.readdir(abs)) as string[];
      } catch {
        return;
      }
      for (const name of names.sort()) {
        if (!rel && name === '.git') continue;
        const path = rel ? `${rel}/${name}` : name;
        const stat = (await this.#o.fs.promises.stat(`${this.#o.dir}/${path}`)) as {
          isDirectory(): boolean;
        };
        if (stat.isDirectory()) {
          if (!name.startsWith('.')) await walk(path);
        } else if (this.#include(path)) {
          const text = await this.#readWorking(path);
          if (text !== null) out[path] = text;
        }
      }
    };
    await walk('');
    return out;
  }

  /** Write (or with `text: null`, delete) working-tree files. Nothing is staged. */
  async writeFiles(changes: { path: string; text: string | null }[]): Promise<void> {
    for (const change of changes) {
      const path = assertVaultPath(change.path);
      const full = `${this.#o.dir}/${path}`;
      if (change.text === null) {
        await this.#o.fs.promises.unlink(full).catch(() => undefined);
      } else {
        await mkdirp(this.#o.fs, full.slice(0, full.lastIndexOf('/')));
        await this.#o.fs.promises.writeFile(full, change.text, 'utf8');
      }
    }
    await this.#flush();
  }

  /** Uncommitted changes to included files, compared with HEAD. */
  async status(): Promise<GitStatusEntry[]> {
    const rows = await git.statusMatrix({
      ...this.#local(),
      filter: (p) => this.#include(p) && !p.split('/').slice(0, -1).some((s) => s.startsWith('.')),
    });
    const out: GitStatusEntry[] = [];
    for (const [path, head, workdir] of rows) {
      if (head === 0 && workdir === 2) out.push({ path, status: 'added' });
      else if (head === 1 && workdir === 0) out.push({ path, status: 'deleted' });
      else if (head === 1 && workdir === 2) out.push({ path, status: 'modified' });
    }
    return out;
  }

  /** Committed (HEAD) and working text of a file; `null` where it doesn't exist. */
  async diff(path: string): Promise<{ before: string | null; after: string | null }> {
    const p = assertVaultPath(path);
    const head = await this.head();
    let before: string | null = null;
    if (head) {
      try {
        const { blob } = await git.readBlob({ ...this.#local(), oid: head, filepath: p });
        before = decoder.decode(blob);
      } catch (e) {
        if (!(e instanceof Errors.NotFoundError)) throw e;
      }
    }
    return { before, after: await this.#readWorking(p) };
  }

  /** Stage exactly these paths (additions, edits, deletions) and commit them. Returns the oid. */
  async commit(paths: string[], message: string): Promise<string> {
    if (paths.length === 0) throw new Error('Nothing to commit');
    for (const raw of paths) {
      const path = assertVaultPath(raw);
      if ((await this.#readWorking(path)) === null)
        await git.remove({ ...this.#local(), filepath: path });
      else await git.add({ ...this.#local(), filepath: path });
    }
    const oid = await git.commit({ ...this.#local(), message, author: this.#author() });
    await this.#flush();
    return oid;
  }

  /** Download remote commits without touching the working tree. */
  async fetch(onProgress?: (p: GitProgress) => void): Promise<{ ahead: number; behind: number }> {
    const branch = await this.branch();
    await this.#mapErrors(async () => {
      try {
        await git.fetch({
          ...this.#net(),
          remote: REMOTE,
          ref: branch,
          singleBranch: true,
          tags: false,
          onProgress: (e) =>
            onProgress?.({ phase: e.phase, loaded: e.loaded, ...(e.total ? { total: e.total } : {}) }),
        });
      } catch (e) {
        // The branch isn't on the remote yet (a new, empty repository): nothing to fetch.
        if (!(e instanceof Errors.NotFoundError)) throw e;
      }
    });
    await this.#flush();
    return this.aheadBehind();
  }

  /**
   * Fetch and integrate the remote branch: fast-forward, or a local merge
   * commit using the three-way merge. Never overwrites uncommitted work: if
   * the remote changed a file with uncommitted edits, throws
   * UncommittedChangesError. Overlapping edits come back as `conflicts` (with
   * diff3 markers in `merged`) and nothing changes; call again with
   * `resolutions` (path → final text) to complete the merge.
   */
  async pull(
    resolutions?: Map<string, string>,
    onProgress?: (p: GitProgress) => void,
  ): Promise<GitPullResult> {
    const none: GitPullResult = { updated: [], conflicts: [], invalid: [] };
    await this.fetch(onProgress);
    const branch = await this.branch();
    const local = await this.head();
    const remote = await this.#remoteHead(branch);
    if (remote === null || local === remote) return none;

    const dirty = new Set((await this.status()).map((s) => s.path));
    if (local === null) {
      // Nothing committed here yet: take the remote branch as it is.
      const incoming = [...(await this.#tree(remote)).keys()];
      const blocked = incoming.filter((p) => dirty.has(p));
      if (blocked.length) throw new UncommittedChangesError(blocked);
      await git.writeRef({ ...this.#local(), ref: `refs/heads/${branch}`, value: remote, force: true });
      await git.checkout({ ...this.#local(), ref: branch, force: true });
      await this.#flush();
      return { ...none, updated: incoming };
    }
    const [base] = await git.findMergeBase({ ...this.#local(), oids: [local, remote] });
    if (base === remote) return none;
    const incoming = await this.#changed(base ?? local, remote);
    const blocked = incoming.filter((p) => dirty.has(p));
    if (blocked.length) throw new UncommittedChangesError(blocked);

    try {
      if (base === local) {
        await git.merge({
          ...this.#local(),
          ours: branch,
          theirs: `refs/remotes/${REMOTE}/${branch}`,
          fastForwardOnly: true,
          author: this.#author(),
        });
        await this.#checkout(branch, incoming);
        return { ...none, updated: incoming };
      }
      try {
        await git.merge({
          ...this.#local(),
          ours: branch,
          theirs: `refs/remotes/${REMOTE}/${branch}`,
          author: this.#author(),
          message: `Merge ${REMOTE}/${branch}`,
          abortOnConflict: true,
          mergeDriver: ({ contents, path }) => {
            const resolved = resolutions?.get(path);
            if (resolved !== undefined) return { cleanMerge: true, mergedText: resolved };
            const r = merge3(contents[0] ?? '', contents[1] ?? '', contents[2] ?? '');
            return { cleanMerge: r.clean, mergedText: r.text };
          },
        });
      } catch (e) {
        if (!(e instanceof Errors.MergeConflictError)) throw e;
        const { bothModified, deleteByUs, deleteByTheirs } = e.data;
        return {
          ...none,
          conflicts: await this.#conflicts(
            [...bothModified, ...deleteByUs, ...deleteByTheirs],
            base ?? null,
            local,
            remote,
          ),
        };
      }
      const head = (await this.head())!;
      const updated = await this.#changed(local, head);
      await this.#checkout(branch, updated);
      const invalid = this.#o.validate ? await this.#o.validate(await this.readFiles()) : [];
      return { updated, conflicts: [], invalid };
    } finally {
      await this.#flush();
    }
  }

  async #checkout(branch: string, paths: string[]) {
    if (paths.length === 0) return;
    await git.checkout({ ...this.#local(), ref: branch, filepaths: paths, force: true });
  }

  async #conflicts(
    paths: string[],
    base: string | null,
    ours: string,
    theirs: string,
  ): Promise<FileConflict[]> {
    const read = async (oid: string | null, path: string) => {
      if (!oid) return null;
      try {
        const { blob } = await git.readBlob({ ...this.#local(), oid, filepath: path });
        return decoder.decode(blob);
      } catch {
        return null;
      }
    };
    return Promise.all(
      [...new Set(paths)].sort().map(async (path) => {
        const [b, o, t] = await Promise.all([read(base, path), read(ours, path), read(theirs, path)]);
        const merged = merge3(b ?? '', o ?? '', t ?? '', { unionInsertions: false });
        return { path, base: b, local: o ?? '', remote: t ?? '', merged: merged.text };
      }),
    );
  }

  /** Included paths whose content differs between two commits. */
  async #changed(from: string, to: string): Promise<string[]> {
    const changed: string[] = [];
    await git.walk({
      ...this.#local(),
      trees: [TREE({ ref: from }), TREE({ ref: to })],
      map: async (path, [a, b]) => {
        if (path === '.') return true;
        const [ta, tb] = await Promise.all([a?.type(), b?.type()]);
        if (ta === 'tree' || tb === 'tree') return true;
        const [oa, ob] = await Promise.all([a?.oid(), b?.oid()]);
        if (oa !== ob && this.#include(path)) changed.push(path);
        return true;
      },
    });
    return changed;
  }

  /**
   * Push local commits. Rejected (the remote moved on) → `{ok: false}`: pull
   * first. With `validate`, unpushed merge commits must leave a valid journal.
   */
  async push(onProgress?: (p: GitProgress) => void): Promise<{ ok: boolean; message?: string }> {
    const branch = await this.branch();
    const local = await this.head();
    if (!local) return { ok: true, message: 'Nothing to push' };
    const remoteHead = await this.#remoteHead(branch);
    if (remoteHead === local) return { ok: true, message: 'Up to date' };
    if (this.#o.validate && (await this.#unpushedMerge(local, remoteHead))) {
      const files: Record<string, string> = {};
      for (const [path, oid] of await this.#tree(local)) files[path] = await this.#blob(oid);
      const errors = await this.#o.validate(files);
      if (errors.length)
        return {
          ok: false,
          message: `The merged journal has errors (${errors[0]!.path}: ${errors[0]!.message}). Fix and commit before pushing.`,
        };
    }
    try {
      const result = await this.#mapErrors(() =>
        git.push({
          ...this.#net(),
          remote: REMOTE,
          ref: branch,
          onProgress: (e) =>
            onProgress?.({ phase: e.phase, loaded: e.loaded, ...(e.total ? { total: e.total } : {}) }),
        }),
      );
      if (!result.ok) return { ok: false, message: result.error ?? 'Push was rejected' };
      return { ok: true };
    } catch (e) {
      if (e instanceof Errors.PushRejectedError)
        return { ok: false, message: 'The remote has new commits: pull first.' };
      throw e;
    } finally {
      await this.#flush();
    }
  }

  async #unpushedMerge(local: string, remote: string | null): Promise<boolean> {
    const theirs = remote
      ? new Set((await git.log({ ...this.#local(), ref: remote, depth: 500 })).map((c) => c.oid))
      : new Set<string>();
    for (const c of await git.log({ ...this.#local(), ref: local, depth: 500 })) {
      if (theirs.has(c.oid)) break;
      if (c.commit.parent.length > 1) return true;
    }
    return false;
  }

  /** Commits only here (`ahead`) and only on the last-fetched remote (`behind`). */
  async aheadBehind(): Promise<{ ahead: number; behind: number }> {
    const branch = await this.branch();
    const local = await this.head();
    const remote = await this.#remoteHead(branch);
    if (!local) return { ahead: 0, behind: 0 };
    const ids = async (ref: string) =>
      new Set((await git.log({ ...this.#local(), ref, depth: 500 })).map((c) => c.oid));
    if (!remote) return { ahead: (await ids(local)).size, behind: 0 };
    if (remote === local) return { ahead: 0, behind: 0 };
    const [mine, theirs] = await Promise.all([ids(local), ids(remote)]);
    let ahead = 0;
    let behind = 0;
    for (const id of mine) if (!theirs.has(id)) ahead += 1;
    for (const id of theirs) if (!mine.has(id)) behind += 1;
    return { ahead, behind };
  }

  /** Recent history, newest first; `path` limits it to one file. */
  async log(
    depth = 50,
    path?: string,
  ): Promise<{ oid: string; message: string; author: string; timestamp: number }[]> {
    try {
      const entries = await git.log({ ...this.#local(), depth, ...(path ? { filepath: path } : {}) });
      return entries.map((e) => ({
        oid: e.oid,
        message: e.commit.message.trim(),
        author: e.commit.author.name,
        timestamp: e.commit.author.timestamp,
      }));
    } catch (e) {
      if (e instanceof Errors.NotFoundError) return [];
      throw e;
    }
  }

  /** Throw away uncommitted changes to a file (restore from HEAD, or delete if new). */
  async discard(path: string): Promise<void> {
    const { before } = await this.diff(path);
    await this.writeFiles([{ path, text: before }]);
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'github.com';
  }
}

/** isomorphic-git errors → the contract's Remote* errors where they mean the same. */
export function gitError(e: unknown): unknown {
  if (e instanceof Errors.HttpError) {
    const status = e.data.statusCode;
    if (status === 401 || status === 403)
      return new RemoteAuthError(
        'The git host refused the token. Check that it has Contents read/write access to this repository.',
      );
    return new RemoteError(status, e.data.statusMessage, 'The git host');
  }
  if (e instanceof Errors.UserCanceledError)
    return new RemoteAuthError('The git host needs a valid access token for this repository.');
  return e;
}

async function mkdirp(fs: PromiseFsClient, dir: string) {
  let current = '';
  for (const part of dir.split('/').filter(Boolean)) {
    current += `/${part}`;
    try {
      await fs.promises.mkdir(current);
    } catch (e) {
      if ((e as { code?: string }).code !== 'EEXIST') throw e;
    }
  }
}
