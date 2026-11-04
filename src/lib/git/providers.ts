// Git hosts: clone URLs and token authentication. PocketLedger targets
// GitHub (ProviderKind 'github'); any HTTPS smart-HTTP host works over the
// proxy as long as the worker allow-lists it.

export interface RepoLocation {
  /** HTTPS clone URL, `https://github.com/owner/repo.git`. */
  url: string;
  host: string;
  owner: string;
  repo: string;
  /** `owner/repo`, for display. */
  slug: string;
}

export const GITHUB_TOKEN_URL = 'https://github.com/settings/personal-access-tokens/new';
export const GITHUB_TOKEN_HELP =
  'Fine-grained personal access token with access to just your ledger repository and the permission “Contents: Read and write” (Metadata: read is added automatically).';

/** HTTP Basic credentials git hosts accept with a token (GitHub: any username works). */
export function tokenAuth(token: string, host = 'github.com'): { username: string; password: string } {
  if (host === 'gitlab.com') return { username: 'oauth2', password: token };
  if (host === 'bitbucket.org') return { username: 'x-token-auth', password: token };
  return { username: 'x-access-token', password: token };
}

/**
 * Accept `owner/repo`, a web URL or a clone URL and return the HTTPS clone
 * URL. Only HTTPS remotes work in the browser (plain HTTP only for localhost).
 */
export function parseRepo(input: string, defaultHost = 'github.com'): RepoLocation | null {
  const value = input.trim().replace(/\/+$/, '');
  if (!value) return null;
  const short = /^([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(value);
  if (short && !value.includes(':')) {
    const [, owner, repo] = short as unknown as [string, string, string];
    return {
      url: `https://${defaultHost}/${owner}/${repo}.git`,
      host: defaultHost,
      owner,
      repo,
      slug: `${owner}/${repo}`,
    };
  }
  let url: URL;
  try {
    url = new URL(value.replace(/^git@([^:]+):/, 'https://$1/'));
  } catch {
    return null;
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) return null;
  const parts = url.pathname
    .replace(/^\/+/, '')
    .replace(/\.git$/, '')
    .replace(/\/(?:tree|blob|src)\/.*$/, '')
    .split('/')
    .filter(Boolean);
  if (parts.length < 2) return null;
  const owner = parts.slice(0, -1).join('/');
  const repo = parts.at(-1)!;
  return {
    url: `${url.protocol}//${url.host}/${owner}/${repo}.git`,
    host: url.host,
    owner,
    repo,
    slug: `${owner}/${repo}`,
  };
}
