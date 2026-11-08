#!/usr/bin/env python3
"""Normalize a trusted release kernel; reject the wrong architecture or boot format."""
import gzip
import pathlib
import sys

LIMIT = 128 * 1024 * 1024


def prepare(source, target, architecture):
    source, target = pathlib.Path(source), pathlib.Path(target)
    if source.stat().st_size > LIMIT:
        raise ValueError('Kernel exceeds 128 MiB')
    with source.open('rb') as stream:
        magic = stream.read(2)
    # ARM64 direct boot requires Image, not an opaque compressed/EFI payload.
    opener = gzip.open if architecture == 'arm64' and magic == b'\x1f\x8b' else open
    with opener(source, 'rb') as stream:
        data = stream.read(LIMIT + 1)
    if len(data) > LIMIT:
        raise ValueError('Decompressed kernel exceeds 128 MiB')
    if architecture == 'arm64':
        if data[56:60] != b'ARM\x64':
            raise ValueError('ARM64 runtime needs an uncompressed Linux Image (or gzip Image); extract it from the reviewed kernel package first')
    elif architecture == 'x86_64':
        if data[514:518] != b'HdrS':
            raise ValueError('Intel runtime needs a Linux bzImage with the x86 boot header')
    else:
        raise ValueError('Unsupported architecture')
    target.write_bytes(data)


if __name__ == '__main__':
    prepare(*sys.argv[1:])
