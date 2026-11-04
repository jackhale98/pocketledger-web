# The engine: hledger in WebAssembly

PocketLedger never reimplements hledger. Every report, balance, budget, CSV
conversion and validation comes from **hledger itself**, compiled to
`wasm32-wasi` and run in a Web Worker.

## What ships

| | |
|---|---|
| hledger | **1.52.4**, unmodified source |
| Toolchain | GHC 9.12 via [ghc-wasm-meta](https://gitlab.haskell.org/haskell-wasm/ghc-wasm-meta) |
| Flavour | `hledger-cli`: the real `hledger` executable as a WASI command module (Option A) |
| Pin | `engine/wasm.lock` (URL, sha256, size). `engine/scripts/fetch.sh` refuses a mismatching file. |
| Served as | `wasm/hledger-<sha256[0..16]>.wasm` (content-addressed, so updates are atomic) |
| Size | 12.58 MiB raw · 4.20 MiB gzip · 2.83 MiB brotli |

The artifact currently pinned is the one published by
[lc-at/hledger-anywhere](https://github.com/lc-at/hledger-anywhere) (release
`wasm-v2`, GPL-3.0), built from upstream hledger with three stub packages
(`terminal-size`, `req`, `http-client`) that remove the TLS/socket C
dependency tree. This also means **price downloading is absent from the
build**: the HTTP client is a stub that always fails. See
[DECISIONS D-002](DECISIONS.md) for why the app pins that artifact and how
`engine.yml` reproduces it for this repository.

Prior art read and reused:

- **hledger-anywhere** — the `cabal.project` + stub packages, the minimal
  WASI environment (`HOME=/` avoids a `geteuid` call WASI doesn't support;
  `/` must be a preopen because the GHC RTS `chdir`s at start-up), and the
  pin-by-URL-and-sha256 scheme.
- **choai** (`wasm/RESULTS.md`, `Bindings.hs`) — the reactor-module layout
  for Option B (`-optl-mexec-model=reactor`, `--export=hs_init`, JSFFI glue
  from `post-link.mjs`), and its size attribution (regex-tdfa and emojis are
  the largest avoidable dependencies).

## How it is invoked

```
UI thread ──postMessage──▶ engine.worker.ts ──▶ HledgerEngine ──▶ EngineBackend.run(argv)
                                                (contracts/engine.ts)     │
                                                                          ▼
                                         WASI (browser_wasi_shim), in-memory fs:
                                           /            (preopen; RTS needs it)
                                           /vault/…     (the vault's files, read-only)
                                           /tmp
```

- `src/lib/engine/backend.ts` — `WasiCliBackend`: compiles the module once,
  instantiates it **per call** with `hledger -f /vault/<root> <command> … -O json`,
  captures stdout/stderr and the exit code.
- `src/lib/engine/hledger-engine.ts` — implements the `Engine` contract:
  builds argv from `QueryOpts` (`args.ts`), decodes JSON (`decode/`), and
  caches results per `(snapshot revision, argv)`. `load()` runs
  `print -O json`, which both validates the journal (parse, balancing,
  assertions) and yields the transaction list, so the first screen costs one
  parse.
- `decode/json.ts` quotes `decimalMantissa` before `JSON.parse`, so amounts
  are exact decimal strings and never pass through a float.
- Errors keep hledger's message verbatim; `decode/errors.ts` only extracts
  `file:line[:column]` and maps `/vault/x` back to `x`.

The same code runs under Node in the test suite (`tests/helpers/engine.ts`),
which is how the goldens exercise the exact browser code path.

## Measurements (Option A)

On `tests/fixtures/example.hledger` (791 transactions, 9 commodities, 624
prices), Node 22 / V8 on x86-64 (`npm run bench:engine`):

| | measured | target | hard limit |
|---|---:|---:|---:|
| Transfer (brotli / gzip) | 2.83 / 4.20 MiB | ≤ 6 MB | ≤ 10 MB |
| Compile | 50 ms | | |
| First parse (`print`, cold) | 1.39 s | ≤ 1.5 s | ≤ 3 s |
| Balance sheet, warm | **858 ms** | ≤ 150 ms | ≤ 500 ms |
| Peak memory (linear) | 22 MiB | ≤ 150 MB | ≤ 300 MB |
| Golden parity (85 cases) | **100 %** | 100 % | 100 % |

On the demo vault (≈150 transactions) every report is 110–270 ms.

The one miss is the warm large-journal report: Option A re-parses the journal
on every command. Mitigations in place: per-revision result caching, `load`
doubling as the transaction query, payees derived from that result, and all
views querying only what they show. Option B (a reactor module that keeps the
parsed `Journal` in memory and dispatches CLI commands against it) removes the
re-parse; its build lives in `engine/hledger-wasm/` and `engine.yml`, and it
plugs in behind the same `EngineBackend` interface. Results go in
`engine/RESULTS.md`.

## Goldens

`tests/golden/cases.json` lists fixture × command cases. `npm run golden`
(with `HLEDGER=/path/to/native/hledger` of the **same pinned version**)
regenerates `tests/golden/expected/*.out.gz`; `tests/golden/engine.test.ts`
requires the WASM output to be **byte-identical**. Regenerate them on every
engine bump.

## Updating hledger

1. Bump `hledger_version` in `engine/scripts/build.sh` / `engine.yml` inputs.
2. Run the **Build engine** workflow (manual dispatch or an `engine-v*` tag).
   It builds, runs `wasm-opt -Oz`, checks goldens under wasmtime, uploads a
   release asset and opens a PR updating `engine/wasm.lock`.
3. Regenerate goldens with the matching native hledger; review JSON changes
   in the decoders (`src/lib/engine/decode/`).
