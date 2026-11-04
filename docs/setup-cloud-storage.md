# Setting up Dropbox

PocketLedger talks to Dropbox directly from the browser: Dropbox's API allows
cross-origin requests and OAuth 2 with PKCE, so there is **no server, no
proxy and no client secret**. Each build needs a Dropbox *app key* (public).
Tokens stay in the browser (IndexedDB, separate `secrets` store) and are sent
only to Dropbox.

## 1. Create a Dropbox app

1. Go to <https://www.dropbox.com/developers/apps> → **Create app**.
2. **Scoped access**.
3. Access type:
   * **App folder** — PocketLedger sees only `/Apps/<your app name>/`.
     Safest; vault folders are then relative to that (use `""` or
     `/Finance` inside it).
   * **Full Dropbox** — needed if your journals already live elsewhere in
     Dropbox (e.g. `/Documents/Finance`).
4. Name it (e.g. "PocketLedger – yourname").

## 2. Permissions

On the app's **Permissions** tab enable, then **Submit**:

* `files.metadata.read`
* `files.content.read`
* `files.content.write`
* `account_info.read` (to show who is signed in)

Changing permissions later requires signing in again.

## 3. Redirect URIs

On the **Settings** tab, under *OAuth 2 → Redirect URIs*, add the callback
page of every place the app runs, exactly (trailing slash included):

* `https://<your site>/auth/callback/`
* `http://localhost:4321/auth/callback/` (development)

Leave *Allow public clients (Implicit Grant & PKCE)* **on** — PocketLedger
uses PKCE.

## 4. Build with the app key

Copy the **App key** (not the secret — PocketLedger never needs it) and build
with it:

```sh
PUBLIC_DROPBOX_APP_KEY=abc123xyz npm run build
# or for development, in .env (git-ignored):
PUBLIC_DROPBOX_APP_KEY=abc123xyz
```

Without `PUBLIC_DROPBOX_APP_KEY` the build simply offers no Dropbox option
(`availableSignIns()` leaves it out).

## 5. Development vs production status

A new Dropbox app is in *development* status, which allows only a limited
number of users to link it (fine for yourself and family). For a public
deployment apply for *production* status on the app's Settings tab.

## How sync behaves

* Files with journal extensions (`.journal .hledger .ledger .j .rules .csv
  .prices`) under the vault folder are synced; everything else is ignored.
* Edits are saved locally first and uploaded shortly after (2 s after the
  last save), when the device comes back online, and on a periodic check
  (every minute, slowing to every 5 minutes while nothing changes).
* Changes made on two devices are merged line by line; edits to the same
  lines become a conflict for you to resolve. A merge that makes the journal
  invalid (`hledger check` fails) is kept locally but not uploaded until you
  fix it.

See [SYNC.md](SYNC.md) for the details.

## Signing out

Removing the vault deletes its tokens from the browser. To revoke access
completely, also remove the app under Dropbox → Settings → Connected apps.
