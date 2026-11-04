# Engine spike results

## Option B — hledger 1.52.4 as a wasm32-wasi reactor module

**Verdict:** works, with output identical to native hledger. 46 of 46 parity
cases match byte for byte (all 7 required ones, plus the error cases), and the
module is 2.84 MiB brotli. The parse is paid once per journal. **Warm
`bs -O json` is ~380–410 ms**: inside the 500 ms hard limit, but it misses the
150 ms target. The report itself takes ~20 ms. The rest is hledger's own JSON
rendering (aeson-pretty), which cannot be changed without patching hledger;
see [Where the time goes](#where-the-time-goes).

Measured 2026-11-04 on Linux x86_64 (4 cores, idle), Node 22.23.4,
@bjorn3/browser_wasi_shim 0.4.2, GHC 9.12.4.20260731 (ghc-wasm-meta
`8079eb96`), cabal 3.14.2.0, wasm-opt 133. Journal:
`tests/fixtures/example.hledger` (791 txns, 9 commodities, 624 prices).
Numbers come from `node --no-warnings engine/scripts/check-reactor.mjs`.

### What was built

`engine/artifacts/hledger-reactor.wasm` (optimised) and
`hledger-reactor.jsffi.mjs` (GHC JSFFI glue). Both are produced by
`engine/scripts/build.sh` and published by `.github/workflows/engine.yml`.

| file | bytes | sha256 |
|---|---:|---|
| hledger-reactor.wasm (`-Oz`) | 13,269,254 | `a581c3e898e685561a79b9a5c812393271d93d368c8472ed7da099f12af7fdd6` |
| hledger-reactor.jsffi.mjs | 4,458 | `acb55816a681ae098b33886c7b44fd5d33ded40393b295c1c1c5fc54473ed052` |

Exports. All three are `sync`: they return a value, not a Promise, and
`await` on them still works.

- `hledgerRun(argsJson) -> string`. `argsJson` is a JSON array of CLI
  arguments without the program name. Returns
  `{"code":int,"stdout":string,"stderr":string}`.
- `hledgerInvalidate()` drops every cached journal.
- `hledgerVersion() -> "1.52.4"`.
- `hs_init` and `memory`, plus the usual reactor `_initialize`. The host calls
  `wasi.initialize(instance)` and then `hs_init(0, 0)`. See
  `engine/scripts/drive-reactor.mjs`.

How it works (`engine/hledger-wasm/`):

- **CLI.** `src/CliMain.hs` is a verbatim copy of `Hledger.Cli.main` and its
  private helpers (Cli.hs lines 77–707 at tag hledger-1.52.4). It is copied
  because `Hledger.Cli` exports only `main`, whose journal read is hard-wired.
  The copy has four marked `[pocketledger]` changes:
  1. journal reads go through a hook (the cache) instead of `withJournal`;
  2. `add`/`import` invalidate the cache;
  3. there are no addon commands;
  4. `handleExit` is applied by the caller.

  Everything else is hledger's own code: config file lookup, flag moving,
  cmdargs parsing, `findBuiltinCommand`, `journalTransform`, and the commands
  themselves.
- **Parse cache.** Journals are keyed by (InputOpts, input files), the same key
  hledger's own `run` command uses (`withJournalCached`), but over all `-f` files
  together, as `withJournal` reads them. So `--forecast`, `--auto`, `-I`,
  `--strict`, `--rules`, `--alias`, `--infer-*`, `-c` and today's date all
  select a different entry. `reportspan_` is ignored without `--forecast`; it
  only feeds the forecast period. At most 8 entries are kept. There is never
  any caching for `--new` (it is stateful) or stdin.
- **Output capture.** `src/Capture.hs` swaps the `Handle__` inside the global
  `stdout`/`stderr` Handles for one over an in-memory device during each call.
  This is needed because WASI has no dup2 or pipes. `Debug.Trace` warnings
  bypass the Handle (they go RTS `debugBelch` → `debugMsgFn`), so
  `cbits/capture.c` hooks `debugMsgFn` into the same stderr buffer, keeping
  order. Nothing reaches the real fds 1 and 2; the parity run checks this.
  The JSON envelope is built by `JSON.stringify` on the JS side.
- **Errors.** hledger's own `handleExit` prints the exact native text
  (`hledger: Error: ...`). `ExitCode` becomes `code`, and any other exception
  is reported as `hledger: <exception>` with code 1. The instance never traps.
- **Process state.**
  - `progArgs` and the colour flags are one-shot CAFs in hledger-lib. They are
    forced once at first call, with no args and with output captured. They then
    hold the "no special args, not a terminal" values, instead of whatever the
    first call passed.
  - The two parse-time checks that read `progArgs` are reproduced per call from
    that call's arguments: `check … assertions` overrides `-I`, and
    `check … ordereddates` is checked on the pre-balancing postings, so its
    error wins over assertion failures, as natively.
  - `HOME` and `PATH` default to non-existent directories. hledger's config and
    pager lookups throw under WASI without them.
  - UTF-8 is used everywhere.
- **No network.** `stubs/req`, `stubs/http-client` and `stubs/terminal-size`
  are local stand-ins that shadow the Hackage packages. Every HTTP request
  throws. Removing the real packages also removes tls/crypton/basement/network,
  which do not cross-compile. hledger has no price-download feature to disable.
  The route follows lc-at/hledger-anywhere; the stubs were rewritten for this
  GPL project because hledger-anywhere is AGPL.
- `cbits/rtsopts.c` replaces the RTS `FlagDefaultsHook`. A reactor never sees
  `-with-rtsopts`. The hook turns on `-T`, as native hledger does, so `stats`
  prints GC figures. It also allows `HLEDGER_RTS_A_MB` (WASI env) to tune the
  nursery; see below.
- hledger's sources are a pristine clone; build.sh verifies the commit and that
  the tree is clean. **0 lines of hledger changed.** Dependency versions are
  pinned by `cabal.project.freeze` (index-state 2026-11-04T06:39:07Z).

### Acceptance measurements

| measure | target | result | |
|---|---|---:|---|
| size, `wasm-opt -Oz`, raw | — | 13,269,254 B (12.65 MiB) | |
| size, gzip -9 | — | 4,426,286 B (4.22 MiB) | |
| **size, brotli -11** | ≤ 6 MB (hard ≤ 10 MB) | **2,976,197 B (2.84 MiB)** | PASS |
| compile (`WebAssembly.compile`) | — | 47 ms | |
| instantiate + `_initialize` + `hs_init` | — | 32 ms | |
| first `bs -O json` (parse + report) | — | 820 ms | |
| **compile + instantiate + first `bs -O json`** | — | **918 ms** | |
| **warm `bs -O json`** (journal cached) | ≤ 150 ms (hard ≤ 500 ms) | **377–412 ms** median | target MISSED, hard limit PASS |
| warm `is -M -O json` | — | 208–253 ms | |
| warm `print -O json` (2.75 MB output) | — | 913 ms | |
| warm `print -O json date:2025` | — | 481 ms | |
| warm `bal -X USD -O json` | — | 52 ms | |
| warm `stats` | — | 16 ms | |
| re-parse + `bs -O json` after `hledgerInvalidate` | — | 752 ms | |
| wasm linear memory after first `bs -O json` | — | 23.3 MiB | |
| **peak wasm linear memory** (whole suite, incl. `print -O json`) | — | **40.7 MiB** | |

Warm medians are over 15 calls. The two figures for `bs`/`is` come from two
separate runs; run-to-run noise is about ±10%. Linear memory never shrinks,
so its final size is the peak. For comparison, Option A
(`public/wasm/hledger.wasm`, a new WASI command per call) takes ≈ 860 ms for
`bs -O json` on every call.

Warm calls in other output formats (same instance, journal cached, medians of 9):

| command | time | stdout |
|---|---:|---:|
| `bs` | 20 ms | 3,501 B |
| `bs -O csv` | 17 ms | 812 B |
| `bs -O json` | 377 ms | 1,016,437 B |
| `bs --depth 2 -O json` | 363 ms | 1,010,392 B |
| `is -M` | 75 ms | 56,425 B |
| `is -M -O csv` | 40 ms | 15,386 B |
| `is -M -O json` | 253 ms | 578,947 B |
| `bal` | 26 ms | 3,107 B |
| `bal -O json` | 118 ms | 218,623 B |
| `reg checking -O csv` | 28 ms | 21,974 B |
| `print date:2025-12` | 7 ms | 5,710 B |
| `print -O json date:2025-12` | 37 ms | 96,170 B |
| `print -O csv` | 140 ms | 304,369 B |

### Where the time goes

Cost follows the JSON output volume, not the report work. `bs` as text is
20 ms, but `bs -O json` is 1 MB. Every amount in hledger's JSON carries its
full `astyle` and `acost`, so `--depth 2` hardly shrinks it.

A temporary instrumented export timed `print -O json` (2.75 MB) on the cached
journal; it has since been removed:

| stage (hledger code) | time |
|---|---:|
| `toJsonText` = aeson-pretty `encodePrettyToTextBuilder'` (sorted keys, indent 2) | 600–950 ms |
| `putStr . TL.unpack` (hledger's `writeOutputLazyText`) | ~155 ms |
| `TL.hPutStr` instead, for comparison | ~110 ms |
| *plain `Data.Aeson.encode` of the same values (compact), for comparison* | *~180 ms* |
| reactor capture + JSON envelope | ~2 ms |

Native hledger pays the same: `bs -O json` minus `bs` is +110 ms natively and
+360 ms in wasm, the usual ~3.5× slowdown of GHC's wasm backend (parse shows
the same ratio). GC tuning was tried via `HLEDGER_RTS_A_MB`, with nurseries of
4, 16, 32, 64 and 128 MiB; the gain was ≤ 10%, within noise, at up to 140 MiB
more memory, so the RTS default is kept. `wasm-opt -O3` instead of `-Oz` gave
no speed-up and a 42% larger module.

Ways to reach ≤ 150 ms, for the lead to choose from:

1. **Use text/CSV output in the app where it can.** `bs`, `bs -O csv` and
   `is -M -O csv` are 17–75 ms. They are byte-identical to native too, and are
   already within target.
2. **Upstream hledger change:** render `-O json` with `Data.Aeson.encode`, or
   offer a compact-JSON flag, and write it with `TL.hPutStr`. That would bring
   `bs -O json` to roughly 100 ms here. A patch to vendor/ would also work, but
   only as a last resort and recorded.
3. A compact-JSON export that runs the report functions directly would
   re-implement each command's output stage. It is not done here because it
   gives up the "hledger's CLI, unmodified" property.

### Output parity

Each case runs through the reactor (fixtures mounted at `/vault`) and through
native `/home/user/dl/native/hledger` (official 1.52.4 linux-x86_64 binary,
`LANG=C.UTF-8 TZ=UTC`, empty HOME/cwd, `-f` mapped to the same files).
stdout, stderr and exit code are compared exactly.

| case (`*` = required) | result |
|---|---|
| `*` `print -O json` | identical |
| `*` `bs -O json` | identical |
| `*` `is -M -O json` | identical |
| `*` `cf -O json` | identical |
| `*` `bal -O json` | identical |
| `*` `bal --budget -M -O json` (sample-with-budget.journal) | identical |
| `*` `bal -X USD -O json` | identical |
| `print -O json date:2025`, `bs`, `is -M`, `reg -O csv`, `bal -M --tree`, `bal -V -O json`, `accounts --tree` | identical |
| `stats` | identical except the "Runtime stats" line (wall-clock/GC, differs every run) |
| flags before the command (`-f X -M is`), `--forecast=2025`, `--auto`, `-I`, `--alias`, `--pivot` | identical |
| CSV + `--rules` `print -O json`, `include`, two `-f` files, the other fixtures | identical |
| errors: missing file, unknown command, bad flag, failing assertion, `-I check assertions`, unbalanced txn, parse error, `check ordereddates` (also when an assertion fails too), bad query, `-X` without value, unknown check, `--strict`, `check payees`, missing rules file | identical stderr, code 1 |
| `--version` | `hledger 1.52.4, wasi-wasm32` vs `hledger 1.52.4, linux-x86_64` (platform name, expected) |
| cache: reuse until `hledgerInvalidate`, then re-read (edited include file) | as specified |

**46/46.** Nothing was written to the real fds 1/2.

### Deviations and known differences

- The exports are synchronous (`"hledgerRun sync"`): they return a string, not
  a Promise. Code that awaits them is unaffected.
- **Not reproduced:**
  - `--debug` output. It is read through the one-shot `progArgs` CAF, which is
    frozen at "no args".
  - `--color=always` in the few places hledger checks colour through
    `unsafePerformIO` (the commands list banner, warnings). Ordinary `--color`
    handling reads `getArgs` per call and works.
  - Addon commands (`hledger-ui` and so on), the pager, and anything that
    execs a program.
- `stats` "Runtime stats" measures from command start. With a cached journal
  that excludes the parse, so it shows near-zero time.
- `check ordereddates` with **several `-f` files**: natively the pre-balancing
  check runs per file during parsing. Here it runs on the combined journal,
  grouped by file, which gives the same result unless the boundary between two
  files is out of order (natively an error only for `check`, here for every
  command that has `check` and `ordereddates` among its arguments).
- Config file: found the native way (`./hledger.conf` up to `/`, `$HOME`,
  XDG). With the default HOME and cwd `/`, only `/hledger.conf` or `--conf FILE`
  is used.
- Dates and "today" use the WASI clock in UTC (no TZ database). Native runs in
  the parity check used `TZ=UTC`.
- The cache trusts the host to call `hledgerInvalidate` after changing files.
  It does not compare mtimes. It invalidates itself after `add`/`import`.

### Reproducing

```sh
bash engine/scripts/build.sh                  # toolchain + sources + build + -Oz (cold: ~30 min on 4 cores)
node --no-warnings engine/scripts/check-reactor.mjs   # parity + timings (needs native hledger 1.52.4)
node engine/scripts/drive-reactor.mjs -- -f /vault/example.hledger bs   # one command
```

build.sh needs `curl`, `git`, `jq` and `zstd` (`unzstd`) on the host;
ghc-wasm-meta's setup.sh uses them. On this machine the cold dependency build
took ~25 min. The dependency plan is ~110 packages; hledger-lib and hledger
take most of the time.

Prior art reused:

- lc-at/hledger-anywhere: `hledger-wasm/cabal.project` (boot-library
  `installed` pins, `allow-newer`), the idea of stubbing
  req/http-client/terminal-size, and the pinned tag and toolchain flow of
  `scripts/build-hledger-wasm.sh`.
- choai/wasm: reactor link flags (`-optl-mexec-model=reactor
  -optl-Wl,--export=hs_init`), a dummy `main`, post-link before wasm-opt
  (`scripts/build.sh`), and the browser_wasi_shim instantiate sequence
  (`scripts/bench-bindings.mjs`).
