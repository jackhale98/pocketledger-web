# Third-party notices

PocketLedger Web is free software, licensed under the **GNU General Public
License v3.0 or later** (see [LICENSE](LICENSE)). It includes the following
third-party software. All licences below are compatible with the GPL-3.0.

## Engine

| Component | Licence | Source |
|---|---|---|
| **hledger** 1.52.4 (`hledger`, `hledger-lib`), compiled to WebAssembly | GPL-3.0-or-later | <https://github.com/simonmichael/hledger> |
| hledger's Haskell dependencies linked into `hledger.wasm` (base, text, containers, megaparsec, regex-tdfa, Decimal, aeson, time, Glob, encoding, …) | BSD-3-Clause / BSD-2-Clause / MIT | <https://hackage.haskell.org> |
| GHC runtime system and boot libraries | BSD-3-Clause | <https://gitlab.haskell.org/ghc/ghc> |
| Build: hledger-anywhere `wasm-v2` artifact and stub packages | GPL-3.0 | <https://github.com/lc-at/hledger-anywhere> |

The corresponding source for `hledger.wasm` is the unmodified hledger 1.52.4
release plus the build configuration in `engine/` (and, for the currently
pinned artifact, hledger-anywhere's `hledger-wasm/` directory). See
[docs/ENGINE.md](docs/ENGINE.md).

## Browser code

| Package | Version | Licence |
|---|---|---|
| svelte | 5.57 | MIT |
| decimal.js-light | 2.5 | MIT |
| @bjorn3/browser_wasi_shim | 0.4 | MIT OR Apache-2.0 |
| isomorphic-git | 1.44 | MIT |
| @isomorphic-git/lightning-fs | 4.10 | MIT |
| node-diff3 | 3.2 | MIT |
| buffer | 6.0 | MIT |
| Lucide icons (paths adapted inline in `Icon.svelte`) | — | ISC |

Build-time tools (Astro, Vite, TypeScript, Vitest, Playwright) are not
shipped to the browser.

## Separate programs

`worker/` (the optional Cloudflare Worker: git CORS proxy and GitHub OAuth
code exchange) is a separate program licensed under **Apache-2.0**; see
`worker/LICENSE`.

## Reference projects

Ported with adaptation from the author's own projects:
[PocketLedger](https://github.com/jackhale98/PocketLedger) (writer behaviour,
fixtures, feature set) and
[mycelium-web](https://github.com/jackhale98/mycelium-web) (sync engine,
storage, providers, OAuth, worker, service worker), both GPL-3.0-or-later.
