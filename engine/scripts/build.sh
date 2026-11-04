#!/usr/bin/env bash
# Build hledger 1.52.4 as a wasm32-wasi reactor module (engine Option B).
#
#   bash engine/scripts/build.sh
#
# Steps, each skipped when already done:
#   1. toolchain  ghc-wasm-meta at a pinned commit, FLAVOUR=9.12, into
#                 $GHC_WASM_PREFIX (default ~/.ghc-wasm). Multi-GB download.
#   2. sources    hledger at tag hledger-1.52.4 (commit checked) into
#                 engine/artifacts/vendor/hledger. Never modified.
#   3. build      wasm32-wasi-cabal build hledger-reactor (engine/hledger-wasm);
#                 the first build compiles ~110 Hackage packages (30-90 min).
#   4. glue       post-link.mjs generates the JSFFI glue from the linked module.
#   5. optimise   wasm-opt -Oz, then size (raw/gzip/brotli) and sha256.
#
# Outputs (git-ignored):
#   engine/artifacts/hledger-reactor.wasm        optimised module
#   engine/artifacts/hledger-reactor.jsffi.mjs   JSFFI glue for the exports
#   engine/artifacts/hledger-reactor.unopt.wasm  linked module before wasm-opt
# Set ENGINE_OUT=/some/dir to also copy the two shipped files there.
#
# Prior art: lc-at/hledger-anywhere scripts/build-hledger-wasm.sh (toolchain,
# pinned tag, network stubs) and choai/wasm scripts/build.sh (reactor link
# flags, post-link before wasm-opt).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
engine="$(cd "$here/.." && pwd)"
project="$engine/hledger-wasm"
artifacts="$engine/artifacts"

GHC_WASM_PREFIX="${GHC_WASM_PREFIX:-$HOME/.ghc-wasm}"
GHC_FLAVOUR="${GHC_FLAVOUR:-9.12}"
# ghc-wasm-meta master on 2026-10-12. Its autogen.json pins
# wasm32-wasi-ghc 9.12.4.20260731, wasi-sdk, binaryen 133, node, cabal 3.14.2.
GHC_WASM_META_REF="${GHC_WASM_META_REF:-8079eb96bbc63823d99ad8acaff0765532625474}"
HLEDGER_VERSION="1.52.4"
HLEDGER_TAG="hledger-$HLEDGER_VERSION"
HLEDGER_COMMIT="33fa849e7ae841968bd21c427094c4fb4a4ec38d"
HLEDGER_REPO="${HLEDGER_REPO:-https://github.com/simonmichael/hledger.git}"
JOBS="${JOBS:-$(nproc 2>/dev/null || echo 2)}"

say() { printf '==> %s\n' "$*"; }
die() { printf '\nbuild.sh: %s\n' "$*" >&2; exit 1; }

# --- 1. toolchain -----------------------------------------------------------
if [ ! -x "$GHC_WASM_PREFIX/wasm32-wasi-ghc/bin/wasm32-wasi-ghc" ]; then
  say "installing ghc-wasm-meta $GHC_WASM_META_REF (FLAVOUR=$GHC_FLAVOUR) into $GHC_WASM_PREFIX"
  command -v unzstd >/dev/null || die "ghc-wasm-meta's setup.sh needs unzstd (apt-get install zstd)"
  command -v jq >/dev/null || die "ghc-wasm-meta's setup.sh needs jq"
  meta="$(mktemp -d)"
  trap 'rm -rf "$meta"' EXIT
  curl -fL --retry 5 \
    "https://gitlab.haskell.org/haskell-wasm/ghc-wasm-meta/-/archive/$GHC_WASM_META_REF/ghc-wasm-meta-$GHC_WASM_META_REF.tar.gz" \
    | tar xz --strip-components=1 -C "$meta"
  PREFIX="$GHC_WASM_PREFIX" FLAVOUR="$GHC_FLAVOUR" bash "$meta/setup.sh"
fi
# shellcheck disable=SC1091
. "$GHC_WASM_PREFIX/env"
say "toolchain: $(wasm32-wasi-ghc --version)"
say "           cabal $(wasm32-wasi-cabal --numeric-version), $(wasm-opt --version)"
POST_LINK="$(wasm32-wasi-ghc --print-libdir)/post-link.mjs"
[ -f "$POST_LINK" ] || die "post-link.mjs not found at $POST_LINK"

# --- 2. hledger sources -----------------------------------------------------
src="$artifacts/vendor/hledger"
if [ ! -d "$src/.git" ]; then
  say "cloning $HLEDGER_TAG"
  mkdir -p "$(dirname "$src")"
  git clone --quiet --depth 1 --branch "$HLEDGER_TAG" "$HLEDGER_REPO" "$src"
fi
actual="$(git -C "$src" rev-parse HEAD)"
[ "$actual" = "$HLEDGER_COMMIT" ] || die "$src is at $actual, expected $HLEDGER_TAG = $HLEDGER_COMMIT"
git -C "$src" diff --quiet || die "$src has local modifications; it must be a pristine $HLEDGER_TAG"
say "hledger sources: $HLEDGER_TAG ($actual)"

# --- 3. build ---------------------------------------------------------------
say "building hledger-reactor (-j$JOBS)"
wasm32-wasi-cabal update >/dev/null
wasm32-wasi-cabal build hledger-reactor \
  --project-dir="$project" \
  --builddir="$artifacts/dist-newstyle" \
  -j"$JOBS"
linked="$(wasm32-wasi-cabal list-bin hledger-reactor \
  --project-dir="$project" --builddir="$artifacts/dist-newstyle")"
[ -f "$linked" ] || die "no module at $linked"
cp "$linked" "$artifacts/hledger-reactor.unopt.wasm"

# --- 4. JSFFI glue ----------------------------------------------------------
# Generated from the linked module; wasm-opt afterwards does not invalidate it
# (the glue only names imports/exports, which -Oz keeps).
say "generating JSFFI glue"
node "$POST_LINK" -i "$artifacts/hledger-reactor.unopt.wasm" -o "$artifacts/hledger-reactor.jsffi.mjs"

# --- 5. optimise + report ---------------------------------------------------
# Features come from the module's target_features section (kept by the
# toolchain's link flags), so -Oz cannot introduce instructions the linked
# module did not already use.
say "wasm-opt -Oz"
wasm-opt -Oz "$artifacts/hledger-reactor.unopt.wasm" -o "$artifacts/hledger-reactor.wasm"

node --input-type=module - "$artifacts/hledger-reactor.unopt.wasm" "$artifacts/hledger-reactor.wasm" "$artifacts/hledger-reactor.jsffi.mjs" <<'EOF'
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { brotliCompressSync, gzipSync, constants } from 'node:zlib';
const [unopt, opt, glue] = process.argv.slice(2);
const mib = (n) => (n / 1048576).toFixed(2) + ' MiB';
for (const f of [unopt, opt, glue]) {
  const b = readFileSync(f);
  const gz = gzipSync(b, { level: 9 }).length;
  const br = brotliCompressSync(b, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: b.length } }).length;
  console.log(`${f.split('/').pop()}\n    size    ${b.length} (${mib(b.length)})  gzip-9 ${gz} (${mib(gz)})  brotli-11 ${br} (${mib(br)})\n    sha256  ${createHash('sha256').update(b).digest('hex')}`);
}
EOF

if [ -n "${ENGINE_OUT:-}" ]; then
  mkdir -p "$ENGINE_OUT"
  cp "$artifacts/hledger-reactor.wasm" "$artifacts/hledger-reactor.jsffi.mjs" "$ENGINE_OUT/"
  say "copied to $ENGINE_OUT"
fi
say "done"
