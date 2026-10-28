#!/usr/bin/env python3
"""Verify packaged Linux sidecars and readable license resources."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent.parent


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def verify_tree(tree, manifest, root=ROOT):
    target = manifest['target']
    for component in ('ghost', 'mmxwallet'):
        name = 'gigahost-' + component
        binary = tree / 'usr/bin' / name
        if not binary.is_file() or binary.is_symlink() or digest(binary) != manifest['sha256'][name + '-' + target]:
            raise ValueError('Packaged sidecar hash differs: ' + name)
    for source in (root / 'LICENSE', root / 'public/shared/instrument-sans-ofl.txt', root / 'public/shared/geist-mono-ofl.txt'):
        matches = [path for path in tree.rglob(source.name) if path.parent.name == 'licenses' and path.is_file() and not path.is_symlink()]
        if len(matches) != 1 or digest(matches[0]) != digest(source):
            raise ValueError('Packaged license differs: ' + source.name)


def verify(deb, appimage, manifest):
    with tempfile.TemporaryDirectory(prefix='desktop-package-check-') as temporary:
        temporary = Path(temporary)
        deb_tree = temporary / 'deb'
        subprocess.run(['dpkg-deb', '--extract', str(deb.resolve()), str(deb_tree)], check=True)
        version = subprocess.check_output(['dpkg-deb', '--field', str(deb.resolve()), 'Version'], text=True).strip()
        if version != manifest['version']:
            raise ValueError('Debian package version differs')
        verify_tree(deb_tree, manifest)
        subprocess.run([str(appimage.resolve()), '--appimage-extract'], cwd=temporary, check=True, stdout=subprocess.DEVNULL)
        verify_tree(temporary / 'squashfs-root', manifest)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('deb', type=Path)
    parser.add_argument('appimage', type=Path)
    parser.add_argument('manifest', type=Path)
    args = parser.parse_args()
    verify(args.deb, args.appimage, json.loads(args.manifest.read_text()))
