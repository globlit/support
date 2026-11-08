#!/bin/bash
# Invoked by the Finder build helper. Never uses the current node_modules or data.
set -euo pipefail
umask 077
repo=$(cd "$(dirname "$0")/../.." && pwd)
[[ "$(uname -s)" == Darwin ]] || { echo 'Build the DMG on macOS.' >&2; exit 1; }
arch=$(uname -m); [[ "$arch" == arm64 ]] || arch=x64
cache="$repo/.mac-build/cache"
mkdir -p "$cache" "$repo/release"
stage=$(mktemp -d "$repo/.mac-build/build.XXXXXX")
trap 'rm -rf "$stage"' EXIT
printf 'STEP 1 Checking native compilation\n'
# Fail before downloads/npm work, using the same sources and flags as the build.
bash "$repo/companion/macos/build-app.sh" --check
version=24.14.1
case "$arch" in
 arm64) checksum=25495ff85bd89e2d8a24d88566d7e2f827c6b0d3d872b2cebf75371f93fcb1fe ;;
 x64) checksum=2526230ad7d922be82d4fdb1e7ee1e84303e133e3b4b0ec4c2897ab31de0253d ;;
esac
archive="node-v$version-darwin-$arch.tar.gz"
if [[ ! -f "$cache/$archive" ]] || [[ "$(shasum -a 256 "$cache/$archive" | cut -d ' ' -f 1)" != "$checksum" ]]; then
  curl --fail --show-error --silent --proto '=https' --tlsv1.2 --connect-timeout 15 --max-time 600 --max-filesize 104857600 \
    "https://nodejs.org/dist/v$version/$archive" -o "$cache/$archive.partial"
  [[ "$(shasum -a 256 "$cache/$archive.partial" | cut -d ' ' -f 1)" == "$checksum" ]] || { echo 'Node checksum mismatch; refusing to execute it.' >&2; exit 1; }
  mv "$cache/$archive.partial" "$cache/$archive"
fi
tar -xzf "$cache/$archive" -C "$stage"
node_dir="$stage/node-v$version-darwin-$arch"
export PATH="$node_dir/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export NODE_OPTIONS=--max-old-space-size=384
printf 'STEP 2 Building in an isolated working directory\n'
work="$stage/work"
mkdir -p "$work"
# Fixed source allowlist: no .env, .support-data, repositories, SSH keys or user tokens.
for entry in package.json package-lock.json tsconfig.json tsconfig.host.json tsconfig.guest.json vite.config.ts index.html src server host scripts companion deployment tests docs; do
  [[ ! -L "$repo/$entry" ]] || { echo 'Build input cannot be a symlink.' >&2; exit 1; }
  ditto "$repo/$entry" "$work/$entry"
done
cd "$work"
# Nested links are not expected in source and must not import unrelated local files.
if [[ -n "$(find . -type l -print -quit)" ]]; then echo 'Remove source symlinks before building.' >&2; exit 1; fi
npm ci --no-audit --no-fund
printf 'STEP 3 Building the UI and host gateway\n'
npm run build
printf 'STEP 4 Compiling the native companion\n'
mkdir -p "$stage/volume"
SUPPORT_NODE_BINARY="$node_dir/bin/node" SUPPORT_HOST_BUNDLE="$work/host-dist" bash companion/macos/build-app.sh "$stage/volume/Support Companion.app"
# Trusted help is included inside the app and visible on the DMG.
cp "$repo/docs/mac-install.html" "$stage/volume/Start here.html"
ln -s /Applications "$stage/volume/Applications"
printf 'STEP 5 Creating the drag-to-Applications disk image\n'
hdiutil create -quiet -volname 'Support' -srcfolder "$stage/volume" -format UDZO -ov "$stage/Support-$arch.dmg"
hdiutil verify "$stage/Support-$arch.dmg"
codesign --verify --deep --strict "$stage/volume/Support Companion.app"
# Only publish a fully built and verified image. A failed rebuild keeps the old one.
mv "$stage/Support-$arch.dmg" "$repo/release/Support-$arch.dmg"
shasum -a 256 "$repo/release/Support-$arch.dmg" > "$repo/release/Support-$arch.dmg.sha256"
printf 'STEP 6 DMG ready\n'
