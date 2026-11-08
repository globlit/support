#!/bin/bash
# Build an app in a NEW output location; no install, VM setup or workspace mutation.
set -euo pipefail
[[ "$(uname -s)" == Darwin && $# == 1 ]] || { echo 'Usage on macOS: build-app.sh NEW_APP_PATH | --check' >&2; exit 1; }
source_dir="$(cd "$(dirname "$0")" && pwd)"
# Resolve the compiler and SDK together. Do not depend on an inherited SDKROOT
# or a full Xcode installation; Apple Command Line Tools remain supported.
compiler=$(xcrun --sdk macosx --find swiftc)
sdk=$(xcrun --sdk macosx --show-sdk-path)
cache=$(mktemp -d "${TMPDIR:-/tmp}/support-swift.XXXXXX")
trap 'rm -rf "$cache"' EXIT
flags=(-sdk "$sdk" -target "$(uname -m)-apple-macosx13.0" -swift-version 5 -module-cache-path "$cache")
frameworks=(-framework SwiftUI -framework AppKit -framework UserNotifications -framework Security -framework ServiceManagement)
sources=("$source_dir/SupportCompanion.swift" "$source_dir/ExistingVM.swift")
if [[ "$1" == --check ]]; then
  "$compiler" --version
  printf 'macOS SDK: %s\n' "$sdk"
  "$compiler" "${flags[@]}" -typecheck -parse-as-library "${frameworks[@]}" "${sources[@]}"
  "$compiler" "${flags[@]}" -typecheck "$source_dir/InspectProcesses.swift"
  echo 'Native companion and process inspector typecheck passed.'
  exit 0
fi
app_dir=$1
[[ ! -e "$app_dir" ]] || { echo 'Output already exists; choose a new staging path.' >&2; exit 1; }
mkdir -p "$app_dir/Contents/MacOS"
cp "$source_dir/Info.plist" "$app_dir/Contents/Info.plist"
"$compiler" "${flags[@]}" -parse-as-library -O "${frameworks[@]}" "${sources[@]}" -o "$app_dir/Contents/MacOS/SupportCompanion"
if [[ -n "${SUPPORT_NODE_BINARY:-}" || -n "${SUPPORT_HOST_BUNDLE:-}" ]]; then
  [[ -x "${SUPPORT_NODE_BINARY:-}" && -f "${SUPPORT_HOST_BUNDLE:-}/host/main.js" && -f "${SUPPORT_HOST_BUNDLE:-}/public/manifest.json" ]] || { echo 'Provide the macOS Node binary and host bundle together.' >&2; exit 1; }
  "$SUPPORT_NODE_BINARY" -e 'const [a,b]=process.versions.node.split(".").map(Number); if(process.platform!=="darwin"||a<24||a===24&&b<5) process.exit(1)'
  if otool -L "$SUPPORT_NODE_BINARY" | grep -Eq '/opt/homebrew/|/usr/local/opt/|@rpath|@loader_path'; then echo 'Use a standalone Node runtime.' >&2; exit 1; fi
  mkdir -p "$app_dir/Contents/Resources/Runtime"
  cp "$SUPPORT_NODE_BINARY" "$app_dir/Contents/Resources/Runtime/node"
  ditto "$SUPPORT_HOST_BUNDLE" "$app_dir/Contents/Resources/Host"
  codesign --force --sign - "$app_dir/Contents/Resources/Runtime/node"
fi
mkdir -p "$app_dir/Contents/Resources/Runtime"
"$compiler" "${flags[@]}" -O "$source_dir/InspectProcesses.swift" -o "$app_dir/Contents/Resources/Runtime/inspect-processes"
codesign --force --sign - "$app_dir/Contents/Resources/Runtime/inspect-processes"
# No virtualization entitlement; this app cannot create a VM.
codesign --force --sign - --identifier ing.support.companion "$app_dir"
codesign --verify --deep --strict "$app_dir"
