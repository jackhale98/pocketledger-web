<script lang="ts">
  // Connect a journal stored in Dropbox or GitHub. Creates the vault, downloads its
  // files (first sync / clone), picks the root journal, and opens it.
  import type { VaultRecord } from '$lib/contracts/storage';
  import { beginSignIn, takeSignInResult } from '$lib/auth';
  import { authConfig, dropboxAppKey, gitProxy, gitProxyIsPlaceholder } from '$lib/config';
  import { DropboxProvider, DropboxSession } from '$lib/dropbox';
  import { GitHubRestProvider, githubSecretKey } from '$lib/git';
  import { VaultSyncEngine, localTexts } from '$lib/sync';
  import { guessRootFile, isEngineFile, isVaultFile } from '$lib/vault';
  import { app } from '../state/app.svelte';
  import { router } from '../state/router.svelte';
  import { toasts } from '../state/toast.svelte';
  import Sheet from './Sheet.svelte';

  const PENDING = 'pl:connect-dropbox';
  const kind = $derived(router.route.query.get('connect'));
  let open = $state(false);
  let busy = $state(false);
  let error = $state('');

  let name = $state('');
  let folder = $state('/hledger');
  let repo = $state('');
  let branch = $state('main');
  let tokenText = $state('');
  let transport = $state<'rest' | 'git'>(gitProxyIsPlaceholder() ? 'rest' : 'git');
  let proxy = $state(gitProxy());
  let author = $state('PocketLedger');
  let email = $state('pocketledger@users.noreply.github.com');

  $effect(() => {
    open = kind === 'dropbox' || kind === 'github';
  });

  // Back from Dropbox sign-in?
  $effect(() => {
    if (kind !== 'dropbox') return;
    const result = takeSignInResult();
    let pending: { name: string; folder: string } | null = null;
    try {
      pending = JSON.parse(sessionStorage.getItem(PENDING) ?? 'null');
      sessionStorage.removeItem(PENDING);
    } catch {
      /* ignore */
    }
    if (result?.provider === 'dropbox' && pending) void finishDropbox(pending, result.tokens);
  });

  const store = () => {
    const s = app.getStore();
    if (!s) throw new Error('This browser does not allow local storage.');
    return s;
  };

  async function finalize(rec: VaultRecord) {
    const files = await localTexts(store(), rec.id);
    const root = guessRootFile(Object.keys(files).filter(isEngineFile));
    if (!root) throw new Error('No .journal / .hledger / .ledger file found there.');
    await store().putVault({ ...rec, rootFile: root });
    await app.refreshVaults();
    await app.openVault(rec.id);
    toasts.show(`Connected “${rec.name}” (${Object.keys(files).length} files)`, { tone: 'ok' });
    router.go('transactions');
  }

  async function startDropbox() {
    error = '';
    if (!dropboxAppKey()) {
      error = 'Dropbox is not configured for this build (PUBLIC_DROPBOX_APP_KEY). See docs/setup-cloud-storage.md.';
      return;
    }
    sessionStorage.setItem(PENDING, JSON.stringify({ name: name.trim() || 'Dropbox', folder: folder.trim() }));
    const base = new URL(import.meta.env.BASE_URL.replace(/\/?$/, '/'), location.origin);
    await beginSignIn('dropbox', authConfig(), {
      redirectUri: new URL('auth/callback/', base).href,
      returnTo: `${base.pathname}app/#/settings?connect=dropbox`,
    });
  }

  async function finishDropbox(pending: { name: string; folder: string }, tokens: Parameters<DropboxSession['save']>[0]) {
    busy = true;
    error = '';
    try {
      const rec: VaultRecord = {
        id: crypto.randomUUID(),
        name: pending.name,
        provider: 'dropbox',
        rootFile: 'main.journal',
        createdAt: Date.now(),
        lastOpenedAt: Date.now(),
        remote: { kind: 'dropbox', folder: pending.folder },
      };
      await store().putVault(rec);
      await new DropboxSession({ store: store(), vaultId: rec.id, appKey: dropboxAppKey() ?? '' }).save(tokens);
      const provider = DropboxProvider.forVault(rec, store(), { appKey: dropboxAppKey() ?? '' });
      await new VaultSyncEngine({ store: store() }).sync(rec, provider);
      await finalize(rec);
    } catch (e) {
      error = (e as Error).message;
      open = true;
    } finally {
      busy = false;
    }
  }

  async function connectGitHub() {
    busy = true;
    error = '';
    try {
      const rec: VaultRecord = {
        id: crypto.randomUUID(),
        name: name.trim() || repo.split('/').pop()?.replace(/\.git$/, '') || 'GitHub',
        provider: 'github',
        rootFile: 'main.journal',
        createdAt: Date.now(),
        lastOpenedAt: Date.now(),
        remote: {
          kind: 'github',
          url: repo.trim().startsWith('http') ? repo.trim() : `https://github.com/${repo.trim().replace(/\.git$/, '')}.git`,
          branch: branch.trim() || 'main',
          proxy: proxy.trim(),
          author: { name: author.trim(), email: email.trim() },
          transport,
        },
      };
      await store().putVault(rec);
      await store().setSecret(githubSecretKey(rec.id), tokenText.trim());
      const token = () => tokenText.trim();
      if (transport === 'rest') {
        await new VaultSyncEngine({ store: store() }).sync(rec, GitHubRestProvider.fromRemote(rec.remote as never, token));
      } else {
        const { openGitWorkspace } = await import('$lib/git/browser');
        const ws = openGitWorkspace(rec, token);
        await ws.clone();
        const files = await ws.readFiles();
        await store().putFiles(
          Object.entries(files)
            .filter(([p]) => isVaultFile(p))
            .map(([path, text]) => ({ vaultId: rec.id, path, text, base: text, baseRev: null, dirty: false, modifiedAt: Date.now() })),
        );
      }
      tokenText = '';
      await finalize(rec);
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busy = false;
    }
  }
</script>

<Sheet bind:open title={kind === 'github' ? 'Connect GitHub' : 'Connect Dropbox'} onclose={() => router.go('settings')}>
  {#if error}<p class="err" role="alert">{error}</p>{/if}
  {#if kind === 'dropbox'}
    <form class="form" onsubmit={(e) => { e.preventDefault(); void startDropbox(); }}>
      <label class="field"><span>Name</span><input class="input" bind:value={name} placeholder="Finances" /></label>
      <label class="field"><span>Folder in Dropbox</span><input class="input mono" bind:value={folder} placeholder="/hledger" /></label>
      <p class="muted small">You'll sign in on dropbox.com. The access token stays in this browser. PocketLedger syncs .journal, .rules, .csv and .prices files in that folder.</p>
    </form>
  {:else}
    <form class="form" onsubmit={(e) => { e.preventDefault(); void connectGitHub(); }}>
      <label class="field"><span>Repository</span><input class="input mono" bind:value={repo} placeholder="owner/finances" required /></label>
      <div class="two">
        <label class="field"><span>Branch</span><input class="input mono" bind:value={branch} /></label>
        <label class="field"><span>Name</span><input class="input" bind:value={name} placeholder="(repository name)" /></label>
      </div>
      <label class="field"><span>Personal access token</span><input class="input mono" type="password" autocomplete="off" bind:value={tokenText} required /></label>
      <p class="muted small">A fine-grained token with <strong>Contents: read and write</strong> on this repository. It is stored only in this browser.</p>
      <fieldset class="field">
        <legend class="label">Mode</legend>
        <label class="radio"><input type="radio" bind:group={transport} value="rest" /> <span><strong>Direct</strong> — syncs automatically through the GitHub API; each change is a commit. No proxy needed.</span></label>
        <label class="radio"><input type="radio" bind:group={transport} value="git" /> <span><strong>Git</strong> — a real clone with explicit commit, pull and push. Needs a CORS proxy.</span></label>
      </fieldset>
      {#if transport === 'git'}
        <label class="field"><span>CORS proxy</span><input class="input mono" bind:value={proxy} /></label>
        {#if gitProxyIsPlaceholder()}<p class="warn small">No proxy is configured for this build. Deploy the worker in <code>worker/</code> and enter its URL (it must also be allowed by the site's CSP via PUBLIC_CSP_CONNECT_EXTRA).</p>{/if}
        <div class="two">
          <label class="field"><span>Commit author</span><input class="input" bind:value={author} /></label>
          <label class="field"><span>Email</span><input class="input" bind:value={email} /></label>
        </div>
      {/if}
    </form>
  {/if}
  {#snippet footer()}
    <button class="btn" type="button" onclick={() => router.go('settings')}>Cancel</button>
    {#if kind === 'dropbox'}
      <button class="btn primary" type="button" onclick={startDropbox} disabled={busy}>{busy ? 'Downloading…' : 'Sign in with Dropbox'}</button>
    {:else}
      <button class="btn primary" type="button" onclick={connectGitHub} disabled={busy || !repo.trim() || !tokenText.trim()}>{busy ? 'Downloading…' : 'Connect'}</button>
    {/if}
  {/snippet}
</Sheet>

<style>
  .form { display: grid; gap: 12px; }
  .two { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  fieldset { border: 0; padding: 0; margin: 0; }
  .radio { display: flex; gap: 10px; align-items: flex-start; font-size: 0.88rem; padding: 6px 0; }
  .radio input { margin-top: 4px; accent-color: var(--accent); }
  .small { font-size: 0.82rem; }
  .err { background: var(--neg-soft); color: var(--neg); padding: 10px 12px; border-radius: var(--radius-s); margin-bottom: 12px; font-size: 0.88rem; }
  .warn { color: var(--warn); }
  code { font-family: var(--mono); }
</style>
