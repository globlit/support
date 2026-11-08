#!/bin/bash
set -euo pipefail
if [[ "$(uname -s)" != Darwin ]]; then
  echo 'Run this installer on your Mac, not inside the Linux VM.' >&2
  exit 1
fi
if ! xcrun --find swiftc >/dev/null 2>&1; then
  echo 'Install Apple Command Line Tools with: xcode-select --install. Then run this installer again.' >&2
  exit 1
fi
source_dir="$(cd "$(dirname "$0")" && pwd)"
stage_dir="$(mktemp -d)"
trap 'rm -rf "$stage_dir"' EXIT
app_dir="$stage_dir/Support Companion.app"
mkdir -p "$app_dir/Contents/MacOS"
cp "$source_dir/Info.plist" "$app_dir/Contents/Info.plist"
xcrun swiftc -target "$(uname -m)-apple-macosx13.0" -swift-version 5 -parse-as-library -O \
  -framework Virtualization -framework SwiftUI -framework AppKit -framework UserNotifications -framework Security -framework ServiceManagement \
  "$source_dir/SupportCompanion.swift" "$source_dir/ManagedFiles.swift" "$source_dir/ManagedTransport.swift" "$source_dir/ManagedVM.swift" "$source_dir/ManagedVMView.swift" -o "$app_dir/Contents/MacOS/SupportCompanion"
# Release assembly inputs are host-trusted artifacts, never fetched from a guest.
# Without them this remains a local notification companion; managed startup fails closed.
if [[ -n "${SUPPORT_NODE_BINARY:-}" || -n "${SUPPORT_HOST_BUNDLE:-}" ]]; then
  [[ -x "${SUPPORT_NODE_BINARY:-}" && -f "${SUPPORT_HOST_BUNDLE:-}/host/managed-service.js" && -f "${SUPPORT_HOST_BUNDLE:-}/public/manifest.json" ]] || { echo 'Provide the macOS Node binary and built host-dist bundle together.' >&2; exit 1; }
  mkdir -p "$app_dir/Contents/Resources/Runtime"
  cp "$SUPPORT_NODE_BINARY" "$app_dir/Contents/Resources/Runtime/node"
  ditto "$SUPPORT_HOST_BUNDLE" "$app_dir/Contents/Resources/Host"
fi
codesign --force --entitlements "$source_dir/ManagedVM.entitlements" --sign "${SUPPORT_SIGNING_IDENTITY:--}" --identifier ing.support.companion "$app_dir"
# Keep an existing app untouched unless the new build and signature both succeed.
codesign --verify --strict "$app_dir"
mkdir -p "$HOME/Applications"
if pgrep -x SupportCompanion >/dev/null; then
  echo 'Quit Support Companion from its menu bar icon, then run the installer again.' >&2
  exit 1
fi
ditto "$app_dir" "$HOME/Applications/Support Companion.app"
echo "Installed: $HOME/Applications/Support Companion.app"
open "$HOME/Applications/Support Companion.app"
