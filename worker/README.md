# PocketLedger proxy worker (optional)

A tiny, stateless Cloudflare Worker that PocketLedger can use for two things
the browser cannot do on its own:

1. **Git CORS proxy.** Git hosts don't send CORS headers on their smart-HTTP
   endpoints, so a browser can't clone/pull/push directly. isomorphic-git
   sends those requests to `https://<worker>/<host>/<owner>/<repo>.git/...`
   and the worker forwards them.
2. **GitHub OAuth code exchange** (`POST /oauth/github`, `POST
   /oauth/github/refresh`). GitHub needs a client secret to trade a sign-in
   code for a token; the worker adds it so the browser never holds it.

You **don't need it** for Dropbox (Dropbox supports CORS and PKCE without a
secret) or for GitHub "REST mode" (api.github.com sends CORS headers; a
personal access token is enough). See `docs/setup-git-providers.md`.

Licensed under Apache-2.0 (see `LICENSE`), ported from the Mycelium sync
worker. The rest of PocketLedger is GPL-3.0-or-later.

## What it allows — and refuses

| Request | Allowed when |
| --- | --- |
| `OPTIONS *` | Origin is in `ALLOWED_ORIGINS` (preflight) |
| `GET /<host>/…/info/refs?service=git-upload-pack\|git-receive-pack` | Origin allowed **and** host allow-listed |
| `POST /<host>/…/git-upload-pack`, `…/git-receive-pack` | same |
| `POST /oauth/github`, `/oauth/github/token`, `/oauth/github/refresh` | Origin allowed and `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` set |
| anything else | 403 / 404 |

* Allow-listed git hosts: `github.com`, `gitlab.com`, `bitbucket.org`,
  `codeberg.org`, plus `EXTRA_GIT_HOSTS`.
* Only `Accept`, `Authorization`, `Content-Type`, `Content-Encoding` and
  `Git-Protocol` are forwarded; cookies and everything else are dropped.
  Responses are `Cache-Control: no-store`.
* Redirects are followed only on the same host and only for GETs, so an
  `Authorization` header is never carried to another server.
* **Stateless and silent:** no storage bindings, `observability` disabled,
  and the code never reads, logs or stores request bodies or tokens — bodies
  are streamed straight through.

## Deploy your own

```sh
cd worker
npm install            # installs wrangler only
# edit ALLOWED_ORIGINS in wrangler.toml to your site's origin(s)
npx wrangler login
npx wrangler deploy
```

The deploy prints a URL like `https://pocketledger-proxy.<you>.workers.dev`.
Build PocketLedger with it:

```sh
PUBLIC_GIT_PROXY=https://pocketledger-proxy.<you>.workers.dev npm run build
```

(or enter it per vault in the app's git settings — `GitRemote.proxy`).

### Sign in with GitHub (optional)

1. GitHub → Settings → Developer settings → OAuth Apps → New OAuth App.
   *Authorization callback URL*: `https://<your site>/auth/callback/`.
2. `npx wrangler secret put GITHUB_CLIENT_ID` and
   `npx wrangler secret put GITHUB_CLIENT_SECRET`.
3. Build the site with `PUBLIC_GITHUB_CLIENT_ID=<client id>`.

## Local development

```sh
npx wrangler dev      # http://localhost:8787
```

Add `http://localhost:4321` (Astro's dev server) to `ALLOWED_ORIGINS`.
Unit tests live in the main repository: `npx vitest run tests/unit/worker.test.ts`.
