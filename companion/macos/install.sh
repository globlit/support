#!/bin/bash
# Legacy developer installer. Normal distribution is the drag-to-Applications DMG.
set -euo pipefail
[[ "$(uname -s)" == Darwin ]] || { echo 'Run on macOS.' >&2; exit 1; }
source_dir="$(cd "$(dirname "$0")" && pwd)"
stage_dir=$(mktemp -d)
trap 'rm -rf "$stage_dir"' EXIT
bash "$source_dir/build-app.sh" "$stage_dir/Support Companion.app"
if pgrep -x SupportCompanion >/dev/null; then echo 'Quit Support Companion before replacing it.' >&2; exit 1; fi
mkdir -p "$HOME/Applications"
ditto "$stage_dir/Support Companion.app" "$HOME/Applications/Support Companion.app"
open "$HOME/Applications/Support Companion.app"
