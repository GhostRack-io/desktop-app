#!/usr/bin/env python3
"""Publish identical verified installers to GitHub Releases and the CDN."""
import argparse
import importlib.util
import os
from pathlib import Path
import shutil
import sys
import tempfile

_spec = importlib.util.spec_from_file_location('desktop_publisher', Path(__file__).with_name('publish-desktop.py'))
desktop = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(desktop)


sys.path.insert(0, str(Path(__file__).parent))
from github_release import APIError, NoRedirects, GitHub, publish


def stage(directory, windows, linux, macos, version, revision):
    if version != desktop._support.version():
        raise ValueError('Version must match the configured app version')
    ref = os.environ.get('GITHUB_REF', '')
    if ref.startswith('refs/tags/') and ref != 'refs/tags/desktop-v' + version:
        raise ValueError('Tag must match the configured app version')
    uploads, latest, _ = desktop.prepare(windows, linux, version, revision, 'desktop',
                                         'https://github.com', macos=macos)
    staged = {}
    for name, value in uploads.items():
        path = directory / name
        if isinstance(value, Path):
            shutil.copyfile(value, path)
        else:
            path.write_bytes(value)
        if desktop.file_digest(path) != latest['files'][name]['sha256']:
            raise ValueError('Staged bytes differ from validated package')
        staged[name] = path
    return staged, latest['files']


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for platform in ('windows', 'linux', 'macos'):
        parser.add_argument('--' + platform + '-dir', type=Path)
    parser.add_argument('--version', required=True)
    parser.add_argument('--revision', required=True)
    parser.add_argument('--repository', default='GhostRack-io/desktop-app')
    parser.add_argument('--notes-file', type=Path)
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    prefix = os.environ.get('DESKTOP_CDN_PREFIX') or os.environ.get('DESKTOP_S3_PREFIX') or 'desktop'
    public_base = os.environ.get('CDN_PUBLIC_BASE') or os.environ.get('DESKTOP_PUBLIC_BASE') or 'https://apps.gigahost.cloud'
    transport = os.environ.get('DESKTOP_UPLOAD_TRANSPORT') or 'bunny-http'
    endpoint = os.environ.get('CDN_STORAGE_ENDPOINT') or os.environ.get('DESKTOP_STORAGE_ENDPOINT') or None
    bucket = os.environ.get('CDN_STORAGE_ZONE') or os.environ.get('DESKTOP_S3_BUCKET') or 'gigahost-apps'
    region = os.environ.get('DESKTOP_S3_REGION') or 'sg'
    if transport == 'bunny-http':
        desktop.BunnyHTTPStorage(endpoint or 'https://sg.storage.bunnycdn.com', 'dry-run').object_url(bucket, prefix + '/latest.json')
    elif transport == 's3':
        desktop.validate_url(endpoint or os.environ.get('DESKTOP_S3_ENDPOINT') or 'https://sg-s3.storage.bunnycdn.com', 'S3 endpoint')
    else:
        raise ValueError('Storage transport must be s3 or bunny-http')
    with tempfile.TemporaryDirectory(prefix='desktop-release-') as temporary:
        staged, expected = stage(Path(temporary), args.windows_dir, args.linux_dir, args.macos_dir,
                                 args.version, args.revision)
        _, latest, release_prefix = desktop.prepare(args.windows_dir, args.linux_dir,
            args.version, args.revision, prefix, public_base, macos=args.macos_dir)
        if latest['files'].keys() != expected.keys() or any(
                latest['files'][name]['sha256'] != expected[name]['sha256'] for name in expected):
            raise ValueError('Inputs changed while freezing release')
        for name, item in expected.items():
            print(f'{name} {item["size"]} sha256:{item["sha256"]}')
        if args.dry_run:
            return
        if not all((args.windows_dir, args.linux_dir, args.macos_dir)):
            raise ValueError('Publication requires Windows, Linux and macOS artifacts')
        desktop._support.identity(Path(__file__).resolve().parents[1], revision=args.revision)
        client = desktop.create_client(transport, endpoint, region)
        notes = args.notes_file.read_text() if args.notes_file else ''
        api = GitHub(args.repository, os.environ.get('GH_TOKEN') or os.environ.get('GITHUB_TOKEN'))
        publish(api, args.version, args.revision, staged, expected, notes,
                before_publish=lambda: desktop.publish(client, bucket, prefix, staged, latest, release_prefix))
        print(f'Published https://github.com/{args.repository}/releases/tag/desktop-v{args.version}')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, APIError) as error:
        sys.exit(f'Publish failed: {error}')
    except Exception:
        sys.exit('Publish failed; rerun the publish job with the same artifacts to reconcile')
