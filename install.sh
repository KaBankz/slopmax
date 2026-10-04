#!/bin/sh
# Installs the latest slopmax release for this machine.
#
#   curl -fsSL https://raw.githubusercontent.com/KaBankz/slopmax/main/install.sh | sh
#
# SLOPMAX_VERSION picks a release (default: the latest); SLOPMAX_INSTALL_DIR
# picks where the binary goes (default: ~/.local/bin).
set -eu

repo="KaBankz/slopmax"
dir="${SLOPMAX_INSTALL_DIR:-$HOME/.local/bin}"

say() { printf '%s\n' "$*"; }
fail() { say "slopmax install: $*" >&2; exit 1; }

case "$(uname -s)" in
  Linux) os="unknown-linux-musl" ;;
  Darwin) os="apple-darwin" ;;
  *) fail "no prebuilt binary for $(uname -s); install with: cargo install --locked --git https://github.com/$repo" ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch="x86_64" ;;
  arm64 | aarch64) arch="aarch64" ;;
  *) fail "no prebuilt binary for $(uname -m)" ;;
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
mkdir -p "$dir"
install -m 0755 "$tmp/slopmax" "$dir/slopmax"
say "Installed $("$dir/slopmax" --version) to $dir/slopmax"

case ":$PATH:" in
  *":$dir:"*) say "Run \`slopmax\` to set it up." ;;
  *) say "Add $dir to your PATH, then run \`slopmax\` to set it up." ;;
esac
