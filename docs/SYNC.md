# Storage and sync

How PocketLedger keeps journals in the browser and exchanges them with
Dropbox or GitHub. Implements the frozen contract
`src/lib/contracts/storage.ts`; ported from mycelium-web (see
[Renames vs Mycelium](#renames-vs-mycelium)).

```
 editor ──saveLocal──▶ VaultStore (IndexedDB "pocketledger")
                         │  files: text · base · baseRev · dirty · deleted
                         ▼
               VaultSyncEngine.sync(vault, provider)
                 list → download changed → three-way merge → validate → upload
                         │
          ┌──────────────┼────────────────────┐
   DropboxProvider   GitHubRestProvider   (any SyncProvider)
   (api.dropboxapi)  (api.github.com)

 git mode (explicit commit/pull/push): IsoGitWorkspace ── isomorphic-git ── CORS proxy (worker/)
```

## Modules

| Module | Main exports |
| --- | --- |
| `src/lib/store` | `IdbVaultStore` (VaultStore over IndexedDB), `MemoryVaultStore`, `vaultStore()` singleton, `requestPersistence()`, `vaultSecretKey(vaultId, name)` |
| `src/lib/sync` | `VaultSyncEngine` (SyncEngine), `saveLocal`, `localTexts`, `pendingCount`, `merge3`, `syncable`, `SyncScheduler`, `nextCheckDelay` |
| `src/lib/dropbox` | `DropboxApi`, `DropboxProvider` (SyncProvider), `DropboxSession` (tokens + refresh), `dropboxAuthorizeUrl`, `exchangeDropboxCode`, `refreshDropboxToken` |
| `src/lib/auth` | `prepareSignIn` / `beginSignIn`, `completeSignIn`, `takeSignInResult`, PKCE helpers |
| `src/lib/git` | `IsoGitWorkspace` (GitWorkspace), `GitHubRestProvider` (SyncProvider, no proxy), `parseRepo`, `diffLines`; browser wiring in `src/lib/git/browser.ts` (`openGitWorkspace`, `destroyGitWorkspace`) |
| `src/lib/pwa/tabs.ts` | `TabCoordinator` (one editing tab per vault, "Edit here", per-vault sync lock) |
| `src/lib/config.ts` | `dropboxAppKey()`, `gitProxy()`, `githubClientId()`, `authConfig()`, `DEFAULT_GIT_PROXY` |
| `worker/` | Optional Cloudflare Worker: git CORS proxy + GitHub OAuth code exchange (Apache-2.0) |

## Local storage

IndexedDB database **`pocketledger`**, schema v1, raw IndexedDB behind a
~60-line wrapper (`src/lib/store/idb.ts`; no Dexie — the store needs four
object stores and one index, not a query layer, and it saves tens of kB of
gzipped JS):

| Object store | Key | Holds |
| --- | --- | --- |
| `vaults` | `id` | `VaultRecord` |
| `files` | `[vaultId, path]` (+ index `vaultId`) | `StoredFile` |
| `settings` | string | any structured-cloneable value (e.g. `sync:revision:<vaultId>`) |
| `secrets` | string | tokens only; never exported or synced |

Secrets for a vault use `vaultSecretKey(vaultId, name)` (`vault:<id>:<name>`,
e.g. `vault:abc:dropbox`, `vault:abc:github-token`); `deleteVault` removes the
vault, its files and all such secrets in one transaction.

`IdbVaultStore.updateFile(vaultId, path, fn)` is an atomic read-modify-write
(not in the contract); the engine uses it when present so an edit saved while
a sync runs is never overwritten. Records are JSON-cloned on write, so Svelte
`$state` proxies are safe to pass to `putVault` / `putFiles`.

Call `requestPersistence()` once a real vault exists (best effort; browsers may
evict non-persistent storage under pressure).

A git-mode vault keeps its clone in a separate LightningFS database
`pocketledger-git-<vaultId>`.

## Local edits and the pending-upload queue

All edits go through `saveLocal(store, vaultId, [{ path, text | null }])`:

* edit → `text` updated, `dirty = true`, `base`/`baseRev` untouched (they are
  the three-way merge base); editing a file back to exactly `base` clears
  `dirty`;
* new file → `base = baseRev = null`, `dirty = true`;
* delete → tombstone (`deleted: true, dirty: true`) if the file was ever
  synced, otherwise the record is simply removed.

Because the flag lives in IndexedDB next to the text, pending uploads survive
going offline, closing the tab and reloading. `pendingCount(store, vaultId)`
gives the badge count.

## The sync algorithm

`engine.sync(vault, provider)` lists the remote, downloads every file whose
revision differs from the stored `baseRev`, decides per path, validates if
needed, then writes locally and uploads:

| Remote | Local | Outcome |
| --- | --- | --- |
| unchanged (`rev = baseRev`) | clean | nothing |
| unchanged | edited | upload against `baseRev` |
| unchanged | deleted | delete remotely (conditional on `baseRev`) |
| changed / new | clean or absent | take the remote text |
| changed | edited | **three-way merge** against `base`: clean → upload the merge; overlapping → `FileConflict` |
| changed | deleted | remote edit wins (file restored); if the remote text equals `base`, the delete stands |
| gone | clean | delete locally |
| gone | edited | keep the edit, upload as a new file |
| gone | deleted | forget it |
| absent | new (never synced) | upload (create-only) |

Every upload is conditional (`write(path, text, rev)`; `rev = null` means
"only if absent"). If another device got there first the provider throws
`RemoteConflict`; the engine keeps the work locally and runs another round
(up to `maxRetries`, default 2), which merges the newer remote version.

Only paths for which `syncable(path)` holds take part: extensions `.journal
.hledger .ledger .j .rules .csv .prices` (case-insensitive), not inside a
hidden folder (`.git/`, `.trash/`, …). Hidden *files* are allowed.

Syncs of one vault are serialised inside an engine instance; across tabs use
`TabCoordinator.withSyncLock` (Web Locks).

### The merge

`merge3(base, local, remote)` (`src/lib/sync/merge.ts`) is a line-wise diff3
(node-diff3) that keeps each line's own terminator, so a clean merge
reproduces both sides' bytes exactly (CRLF and a missing final newline
survive). Two refinements over plain diff3:

* **Same-shape regions merge line by line**, so edits to adjacent lines (two
  postings of one transaction) are not a conflict.
* **Pure insertions at the same spot are unioned, local first** — the common
  case of two devices each appending a transaction at the end of the file.
  Disable with `unionInsertions: false`. Not applied when the file has no base
  (two devices created the same new file): that is a conflict.

Overlapping edits produce a `FileConflict`:

```ts
{ path, base, local, remote, merged /* with markers */, remoteRev /* engine extra */ }
```

`merged` uses diff3-style markers:

```
<<<<<<< local
    expenses:food   21 EUR
||||||| base
    expenses:food   20 EUR
=======
    expenses:food   22 EUR
>>>>>>> remote
```

Nothing is written for a conflicted file: it stays dirty against its old base,
so every sync reports it again until resolved. The resolver UI calls
`engine.resolve(vaultId, conflict, chosenText)`: the chosen text becomes the
local version and the remote text becomes the new base, so the next sync
uploads it — or merges it once more if the remote moved on in the meantime.
`resolve` refuses text that still contains markers.

### Post-merge validation

A merge can be clean line-wise and still break the journal (an unbalanced
transaction, a broken balance assertion). The engine takes a hook:

```ts
new VaultSyncEngine({ store, validate: async (files, vault) => [...] })
```

When any three-way merge happened in a round (or the vault is already
`conflicted`), the engine passes the whole would-be vault (`files`: every
local file with the round's outcomes applied) to `validate`. If it returns
errors:

* **nothing is uploaded** in that round (not the merge, not other pending
  edits);
* the merged text is kept locally (still `dirty`, base = the remote version
  it was merged with), so the person sees it in the editor and can fix it;
* the errors come back in `SyncResult.invalid`;
* `vault.conflicted = true` is set on the passed object and persisted.

While `vault.conflicted` is set, every sync validates first and holds uploads
until the vault validates again; then the flag clears and everything pending
goes up. Remote changes to files not edited here are still pulled.

The app wires the hook to the engine (`check` from `src/lib/contracts/engine.ts`):

```ts
const sync = new VaultSyncEngine({
  store,
  validate: async (files, vault) =>
    (await engine.check({ rootFile: vault.rootFile, files, revision: snapshotRevision(files) }))
      .map((e) => ({ path: e.file ?? vault.rootFile, message: e.message })),
});
```

### Edits made while a sync runs

The engine snapshots each file at the start of a round. When it is about to
store an outcome and the record changed in the meantime, it keeps the
person's edit: if the edit rebases cleanly onto the outcome (three-way merge
snapshot → edit → outcome) it stores the rebased text, still pending;
otherwise it leaves the record untouched for the next sync.

### `SyncResult`

* `pulled` — local files whose text changed because of the remote (takes,
  restores, merges). Reload these.
* `pushed` — files uploaded.
* `deleted` — deletions propagated in either direction (local files removed
  because the remote deleted them, remote files deleted because of a local
  tombstone, both-sides deletions forgotten).
* `conflicts` — open conflicts (latest round only).
* `invalid` — validation errors that held uploads (latest round only).

### Cheap checks

`engine.syncIfChanged(vault, provider)` skips the listing when nothing is
pending, the vault isn't conflicted and `provider.revision()` equals the
token stored after the last quiet sync (`settings: sync:revision:<id>`).
Returns `null` when it skipped. Use it for periodic polling.

## Scheduling

```ts
const scheduler = new SyncScheduler({
  run: async () => {
    const r = await tabs.withSyncLock(vault.id, () => sync.syncIfChanged(vault, provider));
    return !!r && r.pulled.length + r.pushed.length + r.deleted.length > 0;
  },
  onError: (e) => showSyncError(e),
});
scheduler.start();          // sync now, then periodically
// after every saveLocal(...):
scheduler.saved();          // debounced (2 s after the last save)
```

* After a save: debounced (`debounceMs`, default 2 s).
* On `online` (window) and when the app returns to the foreground
  (`visibilitychange`): immediately.
* Periodically: `intervalMs` (default 1 min), doubling while nothing changes
  up to 5 min; with Data Saver at least 10, at most 15 min. Hidden tabs
  don't poll. Offline (`navigator.onLine === false`) skips until `online`.
* A trigger during a running sync joins it and runs once more afterwards.

## Providers

### Dropbox

`DropboxProvider.forVault(vault, store, { appKey })` — paths are relative to
`DropboxRemote.folder` (`"/Finance"`, or `""` for the root / app folder).
Dropbox is case-insensitive; the provider declares `caseInsensitive` and the
engine keeps the vault's own spelling. The provider keeps the folder tree in
memory and follows Dropbox's change cursor, so after the first listing
`list()` / `revision()` cost one `list_folder/continue` call; an expired
cursor falls back to a full listing. `rev` is Dropbox's file `rev`; uploads
use `mode: update` with that rev (or `add`), deletes `parent_rev`.

Tokens live in the secrets store (`vault:<id>:dropbox`, JSON
`{accessToken, refreshToken, expiresAt}`); `DropboxSession` refreshes 60 s
before expiry and once on a 401. A refused refresh is `RemoteAuthError`
(sign in again); a network failure is rethrown as is (offline ≠ signed out).
Setup: [setup-cloud-storage.md](setup-cloud-storage.md).

### GitHub, REST mode (no proxy)

`GitHubRestProvider.fromRemote(vault.remote, () => token)` for
`GitRemote.transport === 'rest'`. Uses the Contents API on
`api.github.com` (which sends CORS headers): `list` = recursive tree of the
branch, `rev` = blob sha, `write` = `PUT contents` with `sha` (409/422 →
`RemoteConflict`), `delete` = `DELETE contents` with `sha`, `revision` = the
branch head commit. Every write is one commit, so the provider declares
`maxConcurrentWrites = 1`. Requests use `cache: 'no-store'` (GitHub marks API
responses cacheable for 60 s).

### GitHub, git mode (proxy)

`openGitWorkspace(vault, () => token, { validate })` returns an
`IsoGitWorkspace`: clone (single branch, via `GitRemote.proxy` as
isomorphic-git's `corsProxy`), `readFiles` / `writeFiles` on the working tree,
`status` / `diff`, `commit(paths, message)`, `pull()` (fast-forward or merge
with `merge3`; overlapping edits → `FileConflict[]` with markers and nothing
changed; `pull(resolutions)` completes the merge; uncommitted edits to
incoming files → `UncommittedChangesError`), `push()` (`{ok:false}` when the
remote moved on), `aheadBehind()`. With `validate`, a merging pull returns
`invalid` and `push()` refuses unpushed merge commits whose tree fails
validation. Git mode doesn't use `VaultStore.files` or the sync engine: the
working tree *is* the local copy.

Setup: [setup-git-providers.md](setup-git-providers.md).

## Sign-in (OAuth PKCE)

```ts
await beginSignIn('dropbox', authConfig(), {
  redirectUri: new URL('/auth/callback/', location.origin).href,
  returnTo: '/vaults/new',
});
// on /auth/callback/:
const { returnTo } = await completeSignIn(location.search, authConfig());
location.replace(returnTo);
// back in the app:
const r = takeSignInResult();   // { provider, tokens, vaultId } once, or null
if (r?.provider === 'dropbox') await new DropboxSession({ store, vaultId, appKey }).save(r.tokens);
```

State and verifier are kept in `sessionStorage` for 15 minutes and are
single-use; the state is checked; `returnTo` must be a same-origin path.
Dropbox trades the code in the browser; GitHub through the worker's
`/oauth/github` (it adds the client secret).

## Several tabs

`TabCoordinator` (BroadcastChannel `pocketledger-tabs`): the tab that opens a
vault last becomes its editor; others become read-only followers (`onRole`),
reload when the editor announces a save (`changed(paths)` → `onChanged`,
coalesced), and take over with `editHere()`. Check `canEdit` before every
save. `withSyncLock(vaultId, fn)` runs sync under an exclusive Web Lock.

## Renames vs Mycelium

| Mycelium | PocketLedger | Note |
| --- | --- | --- |
| `syncFolder()` (pure function returning writes/bases/cursor/pending) | `VaultSyncEngine.sync(vault, provider)` | engine reads/writes the `VaultStore` itself |
| `SyncBase {rev, source}` table + `CloudState.pending[]` | `StoredFile.base` / `baseRev` / `dirty` / `deleted` | base and pending flag live on the file record |
| `RemoteFiles.listAll/download/upload` (absolute paths, cursor) | `SyncProvider.list/read/write/delete/revision` (vault-relative) | cursor handling moved into `DropboxProvider` |
| `FileConflict {base, ours, theirs, hunks}` | `FileConflict {base, local, remote, merged}` | markers instead of hunks; `base: null` for never-synced |
| `mergeText()` | `merge3()` | + pure-insertion union, + diff3 markers |
| `syncable()` (`.org`) | `syncable()` (journal extensions) | |
| `resolutions` map passed to sync | `engine.resolve(vaultId, conflict, text)` | resolution stored as local edit with new base |
| — | `validate` hook, `SyncResult.invalid`, `VaultRecord.conflicted` | new |
| `db()` (Dexie, DB `mycelium`) | `IdbVaultStore` / `vaultStore()` (raw IDB, DB `pocketledger`) | tokens moved to a `secrets` store |
| `CloudState.accessToken/refreshToken/expiresAt` on the vault record | `DropboxSession` over `secrets` (`vault:<id>:dropbox`) | |
| `GitRepo` + `Workspace` | `IsoGitWorkspace` (+ `openGitWorkspace` in `git/browser.ts`) | |
| `PROVIDERS[id].auth` | `tokenAuth(token, host)` | GitHub-first |
| `TabLink` (app/tabs.ts) + follower logic in app state | `TabCoordinator` (`src/lib/pwa/tabs.ts`) | + Web Lock for sync |
| `CloudWorkspace` timers in app state | `SyncScheduler` | |
| worker: git proxy + OAuth for 3 hosts + WebDAV relay + push reminders | git proxy + GitHub OAuth only | stateless |
| OAuth result keys `mycelium:*` | `pocketledger:oauth-pending` / `pocketledger:oauth-result` | |
