#!/usr/bin/env bash
# Release-builder operation, never invoked by the model or the Mac guest channel.
# Usage: assemble-image.sh ROOTFS_TAR OUTPUT_DIR arm64|x86_64
set -euo pipefail
[[ $# == 3 && "$(uname -s)" == Linux ]] || { echo 'Usage on Linux: assemble-image.sh ROOTFS_TAR NEW_OUTPUT_DIR arm64|x86_64' >&2; exit 1; }
rootfs_tar=$(realpath "$1")
output=$(realpath -m "$2")
architecture=$3
[[ "$architecture" == arm64 || "$architecture" == x86_64 ]] || exit 1
[[ -f "$rootfs_tar" && ! -e "$output" ]] || { echo 'Input tar must exist and output must be new.' >&2; exit 1; }
command -v fakeroot >/dev/null
command -v mkfs.ext4 >/dev/null
stage=$(mktemp -d)
script_dir=$(cd "$(dirname "$0")" && pwd)
trap 'rm -rf -- "$stage"' EXIT
mkdir -p "$stage/root" "$output"
# A trusted OCI export, not a guest-generated archive. fakeroot retains root ownership
# in the filesystem without mounting anything or requiring a privileged loop device.
fakeroot bash -euc 'tar --numeric-owner -xpf "$1" -C "$2"; truncate -s 8G "$3"; mkfs.ext4 -q -F -L SUPPORT_ROOT -d "$2" "$3"' _ "$rootfs_tar" "$stage/root" "$output/rootfs.raw"
python3 - "$stage/root" "$output" "$architecture" "$script_dir" <<'PY'
import hashlib, json, pathlib, shutil, sys
root, output = map(pathlib.Path, sys.argv[1:3])
kernels = sorted((root/'boot').glob('vmlinuz-*'))
if len(kernels) != 1:
    raise SystemExit('Expected one reviewed kernel in the rootfs export.')
kernel = kernels[0]
initrd = root/'boot'/('initrd.img-'+kernel.name.removeprefix('vmlinuz-'))
import runpy
runpy.run_path(str(pathlib.Path(sys.argv[4])/'prepare-kernel.py'))['prepare'](kernel, output/'vmlinuz', sys.argv[3])
shutil.copyfile(initrd, output/'initrd')
hashes = {}
for name in ['vmlinuz','initrd','rootfs.raw']:
    with (output/name).open('rb') as stream:
        hashes[name] = hashlib.file_digest(stream, 'sha256').hexdigest()
    (output/name).chmod(0o600)
(output/'manifest.json').write_text(json.dumps({'version':1,'architecture':sys.argv[3],'sha256':hashes},indent=2)+'\n')
PY
printf 'Created Linux boot bundle: %s\n' "$output"
