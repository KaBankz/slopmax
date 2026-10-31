#!/usr/bin/env bash
# The JIT build (`bun run compile:jit`): `bun build --compile` with the flags
# docs/RUNTIME.md measured best. Built twice: the first binary records which
# bytecode `--version` and `serve` load (BUN_BYTECODE_ORDER_OUT), and the
# second lays the bytecode out in that order.
#
#   scripts/compile-jit.sh [bun target]   # e.g. bun-linux-x64-musl (`bun run compile:musl`)
#
# The profiles are recorded with a build for this machine, so a target it
# cannot run (musl on a glibc host) still gets them.
set -euo pipefail
cd "$(dirname "$0")/.."

flags=(--compile --minify --bytecode --format=esm --compile-jit-policy=4
  --no-compile-autoload-dotenv --no-compile-autoload-bunfig
  --no-compile-autoload-tsconfig --no-compile-autoload-package-json)
order=dist/order
rm -rf "$order"
mkdir -p "$order"
bun build "${flags[@]}" --outfile "$order/slopmax" src/main.ts >/dev/null

# A throwaway home, a port the system picks, and no login service.
home=$(mktemp -d)
trap 'rm -rf "$home"' EXIT
BUN_BYTECODE_ORDER_OUT=$order/version.txt "$order/slopmax" --version >/dev/null
BUN_BYTECODE_ORDER_OUT=$order/serve.txt SLOPMAX_HOME=$home SLOPMAX_LISTEN=127.0.0.1:0 SLOPMAX_NO_SERVICE=1 \
  timeout -s INT 1.5 "$order/slopmax" serve >/dev/null 2>&1 || true
rm -f "$order/slopmax"

target=()
[ -n "${1:-}" ] && target=(--target="$1")
bun build "${flags[@]}" "${target[@]}" --bytecode-order="$order/version.txt,$order/serve.txt" \
  --outfile dist/slopmax src/main.ts
