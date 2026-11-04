# Setting up GitHub (and other git hosts)

PocketLedger can keep a vault in a GitHub repository in two ways
(`GitRemote.transport`):

| | **REST mode** (`'rest'`) | **Git mode** (`'git'`) |
| --- | --- | --- |
| How | GitHub Contents API on `api.github.com` | real git (isomorphic-git) in the browser |
| Needs a proxy | **No** — api.github.com sends CORS headers | **Yes** — git hosts don't; use the worker |
| Hosts | github.com only | GitHub, GitLab, Bitbucket, Codeberg, + your own |
| Workflow | automatic sync like Dropbox; each changed file is one commit | explicit commit / pull / push, history, diffs |
| Good for | "just keep my journal on GitHub" | people who want git |

Both authenticate with a **personal access token** (PAT). Optional "Sign in
with GitHub" needs the worker too.

## Personal access token

Create a **fine-grained** token at
<https://github.com/settings/personal-access-tokens/new>:

* **Resource owner**: you (or the organisation that owns the repository).
* **Repository access**: *Only select repositories* → your ledger repository.
* **Repository permissions**: **Contents: Read and write**. (Metadata:
  Read-only is added automatically.) Nothing else.
* Expiration: your choice; PocketLedger asks for a new token when GitHub
  starts refusing it.

A classic token with the `repo` scope also works but grants access to all
your repositories — prefer fine-grained.

Other hosts (git mode): GitLab — a personal/project access token with
`read_repository` and `write_repository`; Bitbucket — a repository access
token with read/write; Codeberg/Gitea — an access token with repository
read/write.

The token is stored only in this browser (IndexedDB `secrets` store, key
`vault:<vaultId>:github-token`), never in the vault record, never exported,
and sent only to the git host (through the proxy in git mode — the worker
streams it through and does not log it).

## REST mode (no proxy)

Nothing to deploy: pick REST mode, enter `owner/repo`, the branch and the
token. Limits: github.com only; repositories with more than ~100 000 files
are refused (`truncated` tree); each sync that uploads N files makes N
commits (messages like `Update 2026.journal (PocketLedger)`).

## Git mode: the CORS proxy

isomorphic-git sends git's smart-HTTP requests to
`<proxy>/<host>/<owner>/<repo>.git/...`. The proxy URL comes from, in order:

1. the vault's `GitRemote.proxy` (editable per vault in the app);
2. the build-time default `PUBLIC_GIT_PROXY`;
3. the placeholder `https://pocketledger-proxy.example.workers.dev` (does
   not exist — git mode fails clearly until 1 or 2 is set;
   `gitProxyIsPlaceholder()` lets the UI suggest REST mode instead).

```sh
PUBLIC_GIT_PROXY=https://pocketledger-proxy.<you>.workers.dev npm run build
```

A proxy sees your token and repository contents in transit. Use one you
trust — ideally your own.

### Self-hosting the worker

The worker in [`worker/`](../worker/README.md) is ~200 lines, stateless,
with logging disabled. It forwards only the three git smart-HTTP endpoints,
only to allow-listed hosts (github.com, gitlab.com, bitbucket.org,
codeberg.org + `EXTRA_GIT_HOSTS`), only for origins in `ALLOWED_ORIGINS`.

```sh
cd worker
npm install
# set ALLOWED_ORIGINS in wrangler.toml to your site, e.g. https://ledger.example.org
npx wrangler login
npx wrangler deploy
```

Self-hosted git server (Gitea, GitLab CE…): add its host name to
`EXTRA_GIT_HOSTS` (it must be reachable over HTTPS).

## Optional: "Sign in with GitHub"

Instead of pasting a PAT, people can sign in with an OAuth App:

1. GitHub → Settings → Developer settings → **OAuth Apps** → New.
   *Homepage URL*: your site. *Authorization callback URL*:
   `https://<your site>/auth/callback/`.
2. Put the credentials on the worker (secrets, never vars):
   `npx wrangler secret put GITHUB_CLIENT_ID`,
   `npx wrangler secret put GITHUB_CLIENT_SECRET`.
3. Build the site with `PUBLIC_GITHUB_CLIENT_ID=<client id>` (and
   `PUBLIC_GIT_PROXY` pointing at that worker).

The browser sends the code (with its PKCE verifier) to
`<worker>/oauth/github`; the worker adds the secret, calls GitHub and returns
GitHub's answer unchanged. OAuth Apps request the `repo` scope (all your
repositories); a GitHub App with fine-grained installation access is a
possible later improvement.

## Build-time variables (summary)

| Variable | Used for | Default |
| --- | --- | --- |
| `PUBLIC_DROPBOX_APP_KEY` | Dropbox sign-in | unset → no Dropbox |
| `PUBLIC_GIT_PROXY` | git-mode CORS proxy and GitHub OAuth worker | placeholder (see above) |
| `PUBLIC_GITHUB_CLIENT_ID` | "Sign in with GitHub" | unset → PAT only |
