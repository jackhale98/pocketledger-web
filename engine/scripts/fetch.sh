#!/bin/sh
# Download the pinned hledger.wasm into public/wasm/ and verify its sha256.
# Fails (exit 1) on any checksum mismatch. Skips the download when a verified
# copy is already present. A local build at engine/artifacts/hledger.wasm takes
# precedence (still checksum-verified unless ENGINE_ALLOW_UNPINNED=1).
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
root=$(CDPATH= cd -- "$here/../.." && pwd)
lock="$root/engine/wasm.lock"
get() { sed -n "s/^$1 *= *\"\(.*\)\"$/\1/p" "$lock" | head -n1; }
url=$(get url); sha=$(get sha256); size=$(get size)
out_dir="$root/public/wasm"; out="$out_dir/hledger.wasm"
mkdir -p "$out_dir"

sum() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

local_build="$root/engine/artifacts/hledger.wasm"
if [ -f "$local_build" ]; then
  got=$(sum "$local_build")
  if [ "$got" != "$sha" ] && [ "${ENGINE_ALLOW_UNPINNED:-0}" != "1" ]; then
    echo "engine/artifacts/hledger.wasm sha256 $got does not match wasm.lock ($sha)." >&2
    echo "Update wasm.lock or set ENGINE_ALLOW_UNPINNED=1 for local experiments." >&2
    exit 1
  fi
  cp "$local_build" "$out"; echo "hledger.wasm: using local build ($got)"; exit 0
fi

if [ -f "$out" ] && [ "$(sum "$out")" = "$sha" ]; then
  echo "hledger.wasm: already present and verified ($sha)"; exit 0
fi

tmp="$out.download"
echo "hledger.wasm: downloading $url"
n=0
until curl -fsSL --retry 3 -o "$tmp" "$url"; do
  n=$((n+1)); [ $n -ge 4 ] && { echo "download failed" >&2; exit 1; }; sleep $((n*2))
done
got=$(sum "$tmp")
if [ "$got" != "$sha" ]; then
  rm -f "$tmp"
  echo "hledger.wasm: CHECKSUM MISMATCH. expected $sha, got $got" >&2
  exit 1
fi
actual_size=$(wc -c < "$tmp" | tr -d ' ')
[ "$actual_size" = "$size" ] || echo "warning: size $actual_size differs from wasm.lock ($size)" >&2
mv "$tmp" "$out"
echo "hledger.wasm: verified $sha ($actual_size bytes)"
