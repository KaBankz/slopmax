#!/bin/sh
# Installs the latest slopmax release for this machine.
#
#   curl -fsSL https://raw.githubusercontent.com/KaBankz/slopmax/master/install.sh | sh
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
  *) fail "no prebuilt binary for $(uname -s); install with: cargo install --locked --git https://github.com/$repo slopmax" ;;
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
sums="slopmax-$target.sha256"
curl -fsSL "$base/$sums" -o "$tmp/$sums" || fail "could not download $base/$sums to check the download"
expected="$(cut -d ' ' -f 1 < "$tmp/$sums")"
if command -v sha256sum >/dev/null; then
  actual="$(sha256sum "$tmp/$archive" | cut -d ' ' -f 1)"
else
  actual="$(shasum -a 256 "$tmp/$archive" | cut -d ' ' -f 1)"
fi
[ -n "$expected" ] && [ "$expected" = "$actual" ] || fail "$archive does not match its SHA-256; nothing was installed"

tar -xzf "$tmp/$archive" -C "$tmp"
mkdir -p "$dir"
# Beside the old binary, then renamed over it: a proxy running the old one
# keeps its file, and sees a new one to move to.
install -m 0755 "$tmp/slopmax" "$dir/.slopmax.new"
mv -f "$dir/.slopmax.new" "$dir/slopmax"
say "Installed $("$dir/slopmax" --version) to $dir/slopmax"

case ":$PATH:" in
  *":$dir:"*) say "Run \`slopmax\` to set it up. A proxy already running moves to this version within a minute." ;;
  *) say "Add $dir to your PATH, then run \`slopmax\` to set it up." ;;
esac
