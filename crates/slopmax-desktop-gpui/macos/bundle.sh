#!/usr/bin/env bash
# Wraps the desktop app and the CLI it runs the proxy with into slopmax.app,
# which macOS needs to post notifications: they go to an app with a bundle
# identifier. Signed ad hoc, so it runs on the machine that built it.
#
#   crates/slopmax-desktop-gpui/macos/bundle.sh [debug|release]
#
# Leaves target/<profile>/slopmax.app.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../.." && pwd)
profile=${1:-release}
flag=()
[ "$profile" = release ] && flag=(--release)

cargo build --locked ${flag[@]+"${flag[@]}"} --manifest-path "$root/Cargo.toml" -p slopmax -p slopmax-desktop-gpui
target=$root/target/$profile
app=$target/slopmax.app
version=$(sed -n 's/^version = "\(.*\)"/\1/p' "$root/Cargo.toml" | head -1)

rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
sed "s/VERSION/$version/g" "$here/Info.plist" >"$app/Contents/Info.plist"
cp "$root/assets/icon/icon.icns" "$app/Contents/Resources/icon.icns"
# The app finds the CLI beside itself.
cp "$target/slopmax-desktop-gpui" "$target/slopmax" "$app/Contents/MacOS/"
codesign --force --sign - "$app/Contents/MacOS/slopmax"
codesign --force --sign - "$app"
echo "$app"
