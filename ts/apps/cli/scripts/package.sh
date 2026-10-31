#!/usr/bin/env bash
# Packs dist/slopmax as a release asset: slopmax-<target>.tar.gz with the
# binary at the archive's root, and slopmax-<target>.tar.gz.sha256 beside
# it, the names install.sh downloads.
#
#   scripts/package.sh [target]   # default: this machine and the libc dist/slopmax links
#
# A Linux build is named for the C library its loader belongs to:
# `unknown-linux-musl` for `bun run compile:musl`, `unknown-linux-gnu` for a
# build on a glibc host (the ahead-of-time compiler builds for the host only).
# Unlike Rust's static musl binary, Bun's musl one runs on musl systems only,
# so install.sh, which asks every Linux for `unknown-linux-musl`, needs the
# change PORT.md describes before a TS release replaces the Rust one.
set -euo pipefail
cd "$(dirname "$0")/.."

[ -x dist/slopmax ] || { echo "no dist/slopmax; run \`bun run compile\` first" >&2; exit 1; }

# The ELF loader dist/slopmax asks for.
interpreter() {
  if command -v readelf >/dev/null; then
    readelf -l dist/slopmax 2>/dev/null | sed -n 's/.*Requesting program interpreter: \(.*\)]/\1/p'
  else
    file -L dist/slopmax | sed -n 's/.*interpreter \([^,]*\).*/\1/p'
  fi
}

if [ -n "${1:-}" ]; then
  target=$1
else
  case "$(uname -s)" in
    Linux)
      case "$(interpreter)" in
        *ld-musl*) os="unknown-linux-musl" ;;
        "") echo "cannot tell which C library dist/slopmax links; pass a target" >&2; exit 1 ;;
        *) os="unknown-linux-gnu" ;;
      esac
      ;;
    Darwin) os="apple-darwin" ;;
    *) echo "no release target for $(uname -s)" >&2; exit 1 ;;
  esac
  # The machine the binary is for, which a cross build makes other than this one.
  machine=$(uname -m)
  if [ "$(uname -s)" = Linux ] && command -v readelf >/dev/null; then
    case "$(readelf -h dist/slopmax | sed -n 's/.*Machine: *//p')" in
      *X86-64*) machine=x86_64 ;;
      *AArch64*) machine=aarch64 ;;
    esac
  fi
  case "$machine" in
    x86_64 | amd64) arch="x86_64" ;;
    arm64 | aarch64) arch="aarch64" ;;
    *) echo "no release target for $machine" >&2; exit 1 ;;
  esac
  target="$arch-$os"
fi
archive="slopmax-$target.tar.gz"
tar -C dist -czf "dist/$archive" slopmax
(cd dist && if command -v sha256sum >/dev/null; then sha256sum "$archive"; else shasum -a 256 "$archive"; fi) >"dist/$archive.sha256"
# A musl build does not run on a glibc host, so it may not say its version here.
echo "dist/$archive ($(dist/slopmax --version 2>/dev/null || echo "for $target"))"
