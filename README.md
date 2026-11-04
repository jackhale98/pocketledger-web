# PocketLedger Web

A mobile-first, offline-capable web app for [hledger](https://hledger.org)
journals. It runs **the real hledger, compiled to WebAssembly**, entirely in
your browser — no server, no account, no analytics — and syncs with Dropbox,
GitHub, or a folder on disk.

**Try it:** <https://jackhale98.github.io/pocketledger-web/> (opens with demo data)

## What it does

- **Transactions** — search (plain text or raw hledger queries like
  `acct:food amt:>20`), date and status filters, add / edit / duplicate /
  delete with account & payee autocomplete, a live balance check and the
  inferred amount for a blank posting; edit any transaction as text with live
  hledger validation; undo.
- **Accounts** — the account tree with type filters and "Value in" (`-X`);
  tap through to a running-balance register.
- **Reports** — net worth, income vs spending, where the money went.
- **Statements** — balance sheet, income statement, cash flow, by period
  and interval.
- **Budget** — `~ monthly` periodic transactions vs actuals, with progress.
- **CSV import** — your `.csv.rules`, converted by hledger, with a preview and
  duplicate detection.
- **Reconcile** — tick postings against a statement, mark them cleared, and
  write a balance assertion.
- **Files, Check, Console** — view and edit journal files, run hledger's
  strict checks, and run read-only hledger commands.

## Files are sacred

Every change is a minimal line-span patch against your original text, so
comments, alignment, includes, CRLF/BOM and syntax PocketLedger doesn't model
all survive. Before anything is saved, the patched journal is re-parsed by
hledger; if it no longer parses, balances or passes its assertions, the save
is refused and you see hledger's own error. See [docs/WRITER.md](docs/WRITER.md).

## Development

```sh
npm ci
npm run fetch:engine     # downloads the pinned hledger.wasm, verifies sha256
npm run dev              # http://localhost:4321/pocketledger-web/app/
npm test                 # unit, writer fidelity, engine goldens (wasm == native)
npm run build && npm run test:e2e
```

Layout and contracts: [BUILD_PLAN.md](BUILD_PLAN.md) (if present),
[docs/ENGINE.md](docs/ENGINE.md), [docs/WRITER.md](docs/WRITER.md),
[docs/SYNC.md](docs/SYNC.md), [docs/DECISIONS.md](docs/DECISIONS.md).

Deploys to GitHub Pages from `main` (`.github/workflows/pages.yml`). Set
repository variables `PUBLIC_DROPBOX_APP_KEY` and `PUBLIC_GIT_PROXY` to enable
Dropbox and git sync — see [docs/setup-cloud-storage.md](docs/setup-cloud-storage.md)
and [docs/setup-git-providers.md](docs/setup-git-providers.md).

## Licence

PocketLedger is free software: **GPL-3.0-or-later** (see [LICENSE](LICENSE)),
because it bundles hledger (GPL-3.0-or-later, © Simon Michael and
contributors). Third-party notices: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
The optional Cloudflare Worker in `worker/` is a separate program under
Apache-2.0. PocketLedger is not affiliated with the hledger project.
