// A real smart-HTTP git server for tests: `git http-backend` behind a tiny
// Node server on 127.0.0.1 (ported from mycelium-web tests/support). Local
// only — no network beyond the loopback interface.

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface GitServer {
  url: string;
  root: string;
  /** Run git in a bare repo of the server, e.g. `git('ledger.git', 'log', '-1')`. */
  git: (repo: string, ...args: string[]) => string;
  /** Commit `files` to the server's repo through a scratch clone (another device). */
  commit: (repo: string, files: Record<string, string | null>, message: string) => void;
  empty: (name: string, branch?: string) => void;
  /** Add another bare repo `name.git` seeded with `files`. */
  seed: (name: string, files: Record<string, string>) => void;
  /** Every request path seen (for asserting proxy / auth use). */
  requests: { method: string; path: string; auth: string | undefined }[];
  close: () => void;
}

const sh = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=Seed', '-c', 'user.email=seed@example.com', ...args], {
    cwd,
    stdio: 'pipe',
  })
    .toString()
    .trim();

export async function startGitServer(
  name: string,
  files: Record<string, string>,
  options: { branch?: string; auth?: string; prefix?: string } = {},
): Promise<GitServer> {
  const root = fs.mkdtempSync(join(tmpdir(), 'pl-git-srv-'));
  const seed = join(root, 'seed');
  fs.mkdirSync(seed);
  const branch = options.branch ?? 'main';
  sh(seed, 'init', '-q', '-b', branch);
  for (const [path, content] of Object.entries(files)) {
    fs.mkdirSync(join(seed, path, '..'), { recursive: true });
    fs.writeFileSync(join(seed, path), content);
  }
  sh(seed, 'add', '.');
  sh(seed, 'commit', '-q', '-m', 'seed');
  sh(root, 'clone', '-q', '--bare', seed, `${name}.git`);
  sh(join(root, `${name}.git`), 'config', 'http.receivepack', 'true');
  fs.rmSync(seed, { recursive: true, force: true });

  const requests: GitServer['requests'] = [];
  const server: Server = createServer((req, res) => {
    let pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    const search = new URL(req.url ?? '/', 'http://localhost').search;
    requests.push({ method: req.method ?? 'GET', path: pathname, auth: req.headers.authorization });
    // Acting as a CORS proxy: /<prefix>/<host>/<path> → /<path>.
    if (options.prefix) {
      if (!pathname.startsWith(options.prefix)) return void res.writeHead(404).end();
      pathname = `/${pathname.slice(options.prefix.length).split('/').slice(2).join('/')}`;
    }
    if (options.auth) {
      const want = `Basic ${Buffer.from(options.auth).toString('base64')}`;
      if (req.headers.authorization !== want)
        return void res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="git"' }).end('no');
    }
    const cgi = spawn('git', ['http-backend'], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: '1',
        PATH_INFO: pathname,
        QUERY_STRING: search.slice(1),
        REQUEST_METHOD: req.method ?? 'GET',
        CONTENT_TYPE: req.headers['content-type'] ?? '',
        REMOTE_USER: 'tester',
      },
    });
    req.pipe(cgi.stdin);
    let head = Buffer.alloc(0);
    let done = false;
    cgi.stdout.on('data', (chunk: Buffer) => {
      if (done) return void res.write(chunk);
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end === -1) return;
      done = true;
      let status = 200;
      for (const line of head.subarray(0, end).toString().split('\r\n')) {
        const [k, ...v] = line.split(':');
        if (k!.toLowerCase() === 'status') status = parseInt(v.join(':'), 10);
        else res.setHeader(k!, v.join(':').trim());
      }
      res.writeHead(status);
      res.write(head.subarray(end + 4));
    });
    cgi.stdout.on('end', () => res.end());
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://localhost:${port}`,
    root,
    requests,
    git: (repo, ...args) => sh(join(root, repo), ...args),
    commit: (repo, changes, message) => {
      const work = fs.mkdtempSync(join(tmpdir(), 'pl-git-other-'));
      try {
        sh(work, 'clone', '-q', join(root, repo), '.');
        for (const [path, content] of Object.entries(changes)) {
          if (content === null) fs.rmSync(join(work, path), { force: true });
          else {
            fs.mkdirSync(join(work, path, '..'), { recursive: true });
            fs.writeFileSync(join(work, path), content);
          }
        }
        sh(work, 'add', '-A');
        sh(work, 'commit', '-q', '-m', message);
        sh(work, 'push', '-q', 'origin', `HEAD:${branch}`);
      } finally {
        fs.rmSync(work, { recursive: true, force: true });
      }
    },
    seed: (n, seeded) => {
      const dir = fs.mkdtempSync(join(tmpdir(), 'pl-git-seed-'));
      try {
        sh(dir, 'init', '-q', '-b', branch);
        for (const [path, content] of Object.entries(seeded)) {
          fs.mkdirSync(join(dir, path, '..'), { recursive: true });
          fs.writeFileSync(join(dir, path), content);
        }
        sh(dir, 'add', '.');
        sh(dir, 'commit', '-q', '-m', 'seed');
        sh(root, 'clone', '-q', '--bare', dir, `${n}.git`);
        sh(join(root, `${n}.git`), 'config', 'http.receivepack', 'true');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    empty: (n, b = 'main') => {
      sh(root, 'init', '-q', '--bare', '-b', b, `${n}.git`);
      sh(join(root, `${n}.git`), 'config', 'http.receivepack', 'true');
    },
    close: () => {
      server.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
