#!/bin/sh
# Installs the latest slopmax release for this machine.
#
#   curl -fsSL https://raw.githubusercontent.com/KaBankz/slopmax/master/ts/install.sh | sh
#
# SLOPMAX_VERSION picks a release tag (default: the latest); SLOPMAX_INSTALL_DIR
# picks where the binary goes (default: ~/.local/bin).
#
# slopmax is one executable compiled ahead of time with Bun. Linux has two
# builds: one for glibc distributions and one for musl (Alpine), picked by
# the C library this machine runs.
set -eu

repo="KaBankz/slopmax"
dir="${SLOPMAX_INSTALL_DIR:-$HOME/.local/bin}"

say() { printf '%s\n' "$*"; }
fail() { say "slopmax install: $*" >&2; exit 1; }

from_source="build it from a checkout instead: git clone https://github.com/$repo && cd slopmax/ts && mise install && mise run install"

case "$(uname -m)" in
  x86_64 | amd64) arch="x86_64" ;;
  arm64 | aarch64) arch="aarch64" ;;
  *) fail "no prebuilt binary for $(uname -m); $from_source" ;;
esac
case "$(uname -s)" in
  Linux)
    if [ -e /etc/alpine-release ] || ldd --version 2>&1 | grep -qi musl; then
      os="unknown-linux-musl"
    else
      os="unknown-linux-gnu"
    fi
    # Bun's x86-64 runtime, which the binary carries, needs AVX2.
    if [ "$arch" = "x86_64" ] && [ -r /proc/cpuinfo ] && ! grep -q avx2 /proc/cpuinfo; then
      fail "slopmax needs an x86-64 CPU with AVX2"
    fi
    ;;
  Darwin) os="apple-darwin" ;;
  *) fail "no prebuilt binary for $(uname -s); $from_source" ;;
esac
target="$arch-$os"

if [ -n "${SLOPMAX_VERSION:-}" ]; then
  base="https://github.com/$repo/releases/download/$SLOPMAX_VERSION"
else
  base="https://github.com/$repo/releases/latest/download"
fi
archive="slopmax-$target.tar.gz"

command -v curl >/dev/null || fail "curl is required"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

say "Downloading slopmax for $target…"
curl -fsSL "$base/$archive" -o "$tmp/$archive" || fail "could not download $base/$archive"
if curl -fsSL "$base/$archive.sha256" -o "$tmp/$archive.sha256" 2>/dev/null; then
  expected="$(cut -d ' ' -f 1 < "$tmp/$archive.sha256")"
  if command -v sha256sum >/dev/null; then
    actual="$(sha256sum "$tmp/$archive" | cut -d ' ' -f 1)"
  else
    actual="$(shasum -a 256 "$tmp/$archive" | cut -d ' ' -f 1)"
  fi
  [ "$expected" = "$actual" ] || fail "checksum mismatch for $archive"
fi

tar -xzf "$tmp/$archive" -C "$tmp"
[ -f "$tmp/slopmax" ] || fail "$archive has no slopmax at its root"
mkdir -p "$dir"
install -m 0755 "$tmp/slopmax" "$dir/slopmax"
say "Installed $("$dir/slopmax" --version) to $dir/slopmax"

case ":$PATH:" in
  *":$dir:"*) say "Run \`slopmax\` to set it up." ;;
  *) say "Add $dir to your PATH, then run \`slopmax\` to set it up." ;;
esac
