/// PocketLedger proxy worker (optional) — stateless, no logging, no storage.
/// Ported from the mycelium-web sync worker (Apache-2.0), reduced to:
///
/// 1. Git CORS proxy. Browsers cannot call git hosts' smart-HTTP endpoints
///    (no CORS headers), so isomorphic-git sends them here as
///    `/<host>/<owner>/<repo>.git/<endpoint>` (its `corsProxy` format). Only
///    the three smart-HTTP endpoints, only allow-listed hosts, only from
///    allow-listed origins. Bodies are streamed straight through and never
///    read, logged or stored.
/// 2. GitHub OAuth code exchange. `POST /oauth/github` (alias
///    `/oauth/github/token`) trades an authorization code for a token, and
///    `POST /oauth/github/refresh` a refresh token, adding the client secret
///    the browser must never hold. GitHub's response is returned unchanged.
///
/// Dropbox needs neither: it supports CORS and PKCE without a secret.

export interface Env {
  /** Comma-separated origins allowed to use the worker, e.g. `https://ledger.example.org`. */
  ALLOWED_ORIGINS: string;
  /** Optional comma-separated extra git hosts (self-hosted Gitea, GitLab, …). */
  EXTRA_GIT_HOSTS?: string;
  /** GitHub OAuth App credentials (secrets) — only needed for "Sign in with GitHub". */
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
}

export const GIT_HOSTS = ['github.com', 'gitlab.com', 'bitbucket.org', 'codeberg.org'];
const GITHUB_TOKEN = 'https://github.com/login/oauth/access_token';

/** Request headers git needs; everything else (cookies, …) is dropped. */
const FORWARD_REQUEST = ['accept', 'authorization', 'content-type', 'content-encoding', 'git-protocol'];
const FORWARD_RESPONSE = [
  'content-type',
  'content-encoding',
  'cache-control',
  'expires',
  'pragma',
  'www-authenticate',
];

function list(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function cors(origin: string, extra: Record<string, string> = {}): Headers {
  return new Headers({
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Content-Encoding, Git-Protocol, Accept',
    'Access-Control-Expose-Headers': 'Content-Type, WWW-Authenticate',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
    'Cache-Control': 'no-store',
    ...extra,
  });
}

const deny = (status: number, message: string, origin?: string) =>
  new Response(message, {
    status,
    headers: origin
      ? cors(origin, { 'Content-Type': 'text/plain' })
      : { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' },
  });

/** `true` for the three smart-HTTP endpoints git clients use. */
export function isGitRequest(method: string, path: string, search: URLSearchParams): boolean {
  if (method === 'GET' && path.endsWith('/info/refs')) {
    const service = search.get('service');
    return service === 'git-upload-pack' || service === 'git-receive-pack';
  }
  return method === 'POST' && (path.endsWith('/git-upload-pack') || path.endsWith('/git-receive-pack'));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    if (!origin || !list(env.ALLOWED_ORIGINS).includes(origin)) return deny(403, 'Origin not allowed');
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });

    if (url.pathname === '/oauth/github' || url.pathname.startsWith('/oauth/github/'))
      return githubOAuth(request, env, url, origin);

    // Git proxy: /<host>/<owner>/<repo>.git/<endpoint>
    const [, host, ...rest] = url.pathname.split('/');
    const hosts = [...GIT_HOSTS, ...list(env.EXTRA_GIT_HOSTS)].map((h) => h.toLowerCase());
    if (!host || !hosts.includes(host.toLowerCase())) return deny(403, 'Git host not allowed', origin);
    const path = `/${rest.join('/')}`;
    if (path.split('/').includes('..') || !isGitRequest(request.method, path, url.searchParams))
      return deny(403, 'Only git smart-HTTP requests are proxied', origin);

    const headers = new Headers({ 'User-Agent': 'git/pocketledger-proxy' });
    for (const name of FORWARD_REQUEST) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    const upstream = await fetchSameHost(`https://${host}${path}${url.search}`, {
      method: request.method,
      headers,
      body: request.method === 'POST' ? request.body : null,
    });
    const out = cors(origin);
    for (const name of FORWARD_RESPONSE) {
      const value = upstream.headers.get(name);
      if (value) out.set(name, value);
    }
    // The proxy never caches: every response is per-user.
    out.set('Cache-Control', 'no-store');
    return new Response(upstream.body, { status: upstream.status, headers: out });
  },
} satisfies { fetch(request: Request, env: Env): Promise<Response> };

/**
 * Follow redirects only within the same host (e.g. a renamed repository), so
 * the Authorization header is never carried to another server.
 */
async function fetchSameHost(target: string, init: RequestInit): Promise<Response> {
  let url = new URL(target);
  for (let hops = 0; ; hops += 1) {
    const res = await fetch(url.toString(), { ...init, redirect: 'manual' });
    const location = res.headers.get('location');
    if (res.status < 300 || res.status >= 400 || !location || hops >= 3) return res;
    const next = new URL(location, url);
    // A POST body stream can't be replayed; only GETs are followed.
    if (next.host !== url.host || next.protocol !== 'https:' || init.method !== 'GET') return res;
    url = next;
  }
}

/**
 * POST /oauth/github[/token] { code, code_verifier?, redirect_uri? }
 * POST /oauth/github/refresh { refresh_token }
 */
async function githubOAuth(request: Request, env: Env, url: URL, origin: string): Promise<Response> {
  const action = url.pathname.split('/')[3] ?? 'token';
  if ((action !== 'token' && action !== 'refresh') || request.method !== 'POST')
    return deny(404, 'Unknown OAuth endpoint', origin);
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    // Name what's missing (never the values) so a misplaced setting is easy to spot.
    const missing = [
      !env.GITHUB_CLIENT_ID && 'GITHUB_CLIENT_ID',
      !env.GITHUB_CLIENT_SECRET && 'GITHUB_CLIENT_SECRET',
    ].filter(Boolean);
    return deny(501, `GitHub sign-in is not configured on this worker (missing: ${missing.join(', ')})`, origin);
  }
  let input: Record<string, unknown>;
  try {
    input = (await request.json()) as Record<string, unknown>;
  } catch {
    return deny(400, 'Expected a JSON body', origin);
  }
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : undefined);
  const form = new URLSearchParams({
    client_id: env.GITHUB_CLIENT_ID,
    client_secret: env.GITHUB_CLIENT_SECRET,
  });
  if (action === 'token') {
    const code = str('code');
    if (!code) return deny(400, 'Missing code', origin);
    form.set('code', code);
    const redirect = str('redirect_uri');
    const verifier = str('code_verifier');
    if (redirect) form.set('redirect_uri', redirect);
    if (verifier) form.set('code_verifier', verifier);
  } else {
    const refresh = str('refresh_token');
    if (!refresh) return deny(400, 'Missing refresh_token', origin);
    form.set('grant_type', 'refresh_token');
    form.set('refresh_token', refresh);
  }
  const upstream = await fetch(GITHUB_TOKEN, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form,
  });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: cors(origin, {
      'Content-Type': upstream.headers.get('content-type') ?? 'application/json',
    }),
  });
}
