// Build-time configuration for storage and sync, read from `import.meta.env`
// (Astro exposes `PUBLIC_*` variables to the browser). Every getter has a
// safe fallback so unit tests and builds without the variables still work.
//
// The lead owns src/env.d.ts; this module deliberately reads the env through
// a cast so it type-checks whether or not that declaration exists.

type Env = Partial<Record<string, string | boolean | undefined>>;

/**
 * Placeholder for the default CORS proxy (the Cloudflare Worker in worker/).
 * Replace it at build time with `PUBLIC_GIT_PROXY`; the placeholder host does
 * not exist, so git-over-proxy fails clearly until it is configured.
 */
export const DEFAULT_GIT_PROXY = 'https://pocketledger-proxy.example.workers.dev';

function env(): Env {
  try {
    return (import.meta as unknown as { env?: Env }).env ?? {};
  } catch {
    return {};
  }
}

function str(name: string): string | undefined {
  const v = env()[name];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}

/** Dropbox app key (public; PKCE needs no secret). `undefined` = Dropbox disabled in this build. */
export function dropboxAppKey(): string | undefined {
  return str('PUBLIC_DROPBOX_APP_KEY');
}

/** Default CORS proxy / OAuth worker base URL (no trailing slash). */
export function gitProxy(): string {
  return (str('PUBLIC_GIT_PROXY') ?? DEFAULT_GIT_PROXY).replace(/\/+$/, '');
}

/** True when `gitProxy()` is still the placeholder (the UI can suggest REST mode instead). */
export function gitProxyIsPlaceholder(): boolean {
  return gitProxy() === DEFAULT_GIT_PROXY;
}

/** GitHub OAuth App client id (optional; PATs work without it). Sign-in also needs the worker. */
export function githubClientId(): string | undefined {
  return str('PUBLIC_GITHUB_CLIENT_ID');
}

/** Everything sign-in needs, in one object (pass explicit values in tests). */
export interface AuthConfig {
  dropboxAppKey?: string | undefined;
  githubClientId?: string | undefined;
  /** Worker base URL for the GitHub code exchange. */
  worker?: string | undefined;
}

export function authConfig(): AuthConfig {
  return { dropboxAppKey: dropboxAppKey(), githubClientId: githubClientId(), worker: gitProxy() };
}
