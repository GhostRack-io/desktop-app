#!/usr/bin/env python3
"""Pinned component builds and desktop source provenance (Python 3.10+)."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parent.parent
REPOSITORIES = {'ghost': 'https://github.com/GhostRack-io/ghost-cli.git',
                'mmxwallet': 'https://github.com/madMAx43v3r/mmx-node.git'}


def pins(root=ROOT):
    config = json.loads((root / 'build-dependencies.json').read_text())
    if set(config) != {'schema', 'ghost', 'mmxwallet'} or config['schema'] != 1:
        raise ValueError('Invalid dependency schema')
    for name, repository in REPOSITORIES.items():
        item = config[name]
        if (set(item) != {'repository', 'revision', 'package', 'binary'} or
                item['repository'] != repository or item['package'] != name or
                item['binary'] != name or not re.fullmatch('[0-9a-f]{40}', item['revision'])):
            raise ValueError('Invalid component pin: ' + name)
    return config


def git(root, *args, binary=False):
    return subprocess.check_output(['git', '-C', str(root), *args], text=not binary).strip()


def identity(root, repository=None, revision=None):
    root = Path(root).resolve()
    marker = root / '.git'
    if marker.is_symlink() or not marker.exists():
        raise ValueError('Source must own its Git metadata')
    if Path(git(root, 'rev-parse', '--show-toplevel')).resolve() != root:
        raise ValueError('Source is not a repository root')
    if marker.is_file():
        gitdir = Path(git(root, 'rev-parse', '--absolute-git-dir'))
        worktree = Path(git(root, 'config', '--get', 'core.worktree'))
        if not worktree.is_absolute():
            worktree = gitdir / worktree
        if worktree.resolve() != root:
            raise ValueError('Git metadata belongs to another source')
    if repository and git(root, 'remote', 'get-url', 'origin') != repository:
        raise ValueError('Source origin differs')
    commit = git(root, 'rev-parse', 'HEAD')
    if not re.fullmatch('[0-9a-f]{40}', commit) or (revision and commit != revision):
        raise ValueError('Source revision differs')
    if git(root, 'status', '--porcelain', '--untracked-files=all'):
        raise ValueError('Source is dirty')
    attributes = Path(git(root, 'rev-parse', '--path-format=absolute', '--git-path', 'info/attributes'))
    if attributes.exists() and attributes.stat().st_size:
        raise ValueError('Local archive attributes are unsupported')
    return {'commit': commit, 'dirty': False}


def archive(root, commit):
    env = dict(os.environ, GIT_ATTR_NOSYSTEM='1')
    return subprocess.check_output(['git', '-C', str(root), '-c', 'core.attributesFile=' + os.devnull,
                                    '-c', 'core.autocrlf=false', '-c', 'core.eol=lf',
                                    'archive', '--format=tar', commit], env=env)


def extract(data, destination):
    destination = Path(destination).resolve()
    with tarfile.open(fileobj=io.BytesIO(data)) as stream:
        members = stream.getmembers()
        for member in members:
            target = destination / member.name
            if not target.resolve().is_relative_to(destination) or not (member.isfile() or member.isdir() or member.issym()):
                raise ValueError('Unsafe source archive')
            if member.issym() and not (target.parent / member.linkname).resolve().is_relative_to(destination):
                raise ValueError('Unsafe source symlink')
        # Resolve paths again as preceding archive symlinks are installed.
        for member in members:
            if not (destination / member.name).resolve().is_relative_to(destination):
                raise ValueError('Unsafe source archive path')
            stream.extract(member, destination)


def version(root=ROOT):
    value = json.loads((root / 'package.json').read_text())['version']
    if not re.fullmatch(r'\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?', value):
        raise ValueError('Invalid desktop version')
    config = json.loads((root / 'src-tauri/tauri.conf.json').read_text())
    cargo = (root / 'src-tauri/Cargo.toml').read_text()
    lock = (root / 'src-tauri/Cargo.lock').read_text()
    npm_lock = json.loads((root / 'package-lock.json').read_text())
    if (config['version'] != value or npm_lock['version'] != value or
            npm_lock['packages']['']['version'] != value or
            not re.search(r'^version\s*=\s*"' + re.escape(value) + '"$', cargo, re.M) or
            'name = "gigahost-desktop"\nversion = "' + value + '"' not in lock):
        raise ValueError('Desktop versions differ')
    return value


def source_bundle():
    path = os.environ.get('DESKTOP_SOURCE_BUNDLE')
    if not path:
        return None
    bundle = Path(path)
    metadata = json.loads((bundle / 'identity.json').read_text())
    for name, item in metadata.items():
        if name not in ('desktop', 'ghost', 'mmxwallet') or set(item) != {'commit', 'dirty', 'sha256'}:
            raise ValueError('Invalid source bundle identity')
        if item['dirty'] is not False or not re.fullmatch('[0-9a-f]{40}', item['commit']):
            raise ValueError('Invalid source bundle revision')
        if hashlib.sha256((bundle / (name + '.tar')).read_bytes()).hexdigest() != item['sha256']:
            raise ValueError('Source archive hash differs')
    if 'desktop' not in metadata:
        raise ValueError('Missing desktop source identity')
    return bundle, metadata


def desktop_identity():
    bundle = source_bundle()
    if bundle:
        return {key: bundle[1]['desktop'][key] for key in ('commit', 'dirty')}
    return identity(ROOT, 'https://github.com/GhostRack-io/desktop-app.git')


def package_path(snapshot, package):
    matches = []
    for manifest in snapshot.rglob('Cargo.toml'):
        text = manifest.read_text()
        section = re.search(r'^\[package\]\s*\n(.*?)(?=^\[|\Z)', text, re.M | re.S)
        if section and re.search(r'^name\s*=\s*"' + re.escape(package) + r'"\s*$', section[1], re.M):
            matches.append(manifest.parent)
    if len(matches) != 1 or not (snapshot / 'Cargo.lock').is_file():
        raise ValueError('Source package or Cargo.lock differs')
    return matches[0]


def component(name, target, build_root):
    item = pins()[name]
    prefix = build_root / 'components' / name / item['revision'] / target
    target_dir = build_root / 'targets' / name / item['revision'] / target
    command = ['cargo', 'install', '--locked', '--force', '--root', str(prefix), '--bin', item['binary'],
               '--target', target, '--target-dir', str(target_dir), '--jobs', os.environ.get('CARGO_BUILD_JOBS', '4')]
    override = os.environ.get('GHOST_SOURCE_DIR' if name == 'ghost' else 'MMX_NODE_DIR')
    bundle = source_bundle()
    with tempfile.TemporaryDirectory(prefix='desktop-component-') as temporary:
        snapshot = Path(temporary)
        if bundle and name in bundle[1]:
            if bundle[1][name]['commit'] != item['revision']:
                raise ValueError('Bundled component revision differs')
            extract((bundle[0] / (name + '.tar')).read_bytes(), snapshot)
            command += ['--path', str(package_path(snapshot, item['package']))]
        elif override:
            source = Path(override).resolve()
            identity(source, item['repository'], item['revision'])
            extract(archive(source, item['revision']), snapshot)
            command += ['--path', str(package_path(snapshot, item['package']))]
        else:
            command += ['--git', item['repository'], '--rev', item['revision'], item['package']]
        subprocess.run(command, check=True)
    executable = prefix / 'bin' / (item['binary'] + ('.exe' if 'windows' in target else ''))
    if not executable.is_file():
        raise ValueError('Component binary missing after installation')
    return executable


def manifest(target, build_root):
    value = {'desktop': desktop_identity(), 'target': target, 'version': version()}
    config = pins()
    value['sha256'] = {}
    for name in REPOSITORIES:
        value[name] = {'commit': config[name]['revision'], 'dirty': False}
        filename = 'gigahost-' + name + '-' + target + ('.exe' if 'windows' in target else '')
        value['sha256'][filename] = hashlib.sha256((ROOT / 'src-tauri/binaries' / filename).read_bytes()).hexdigest()
    (ROOT / 'src-tauri/binaries/build-manifest.json').write_text(json.dumps(value, indent=2) + '\n')
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['components', 'manifest', 'version', 'desktop-identity'])
    parser.add_argument('--target')
    parser.add_argument('--build-root', type=Path, default=ROOT / 'artifacts/build')
    args = parser.parse_args()
    if args.action == 'version':
        print(version())
    elif args.action == 'desktop-identity':
        print(json.dumps(desktop_identity()))
    else:
        if not args.target or not re.fullmatch('[a-zA-Z0-9_-]+', args.target):
            raise ValueError('Invalid build target')
        if args.action == 'components':
            version()
            desktop_identity()
            out = ROOT / 'src-tauri/binaries'
            out.mkdir(parents=True, exist_ok=True)
            for name in REPOSITORIES:
                binary = component(name, args.target, args.build_root.resolve())
                suffix = '.exe' if 'windows' in args.target else ''
                shutil.copy2(binary, out / ('gigahost-' + name + '-' + args.target + suffix))

        else:
            manifest(args.target, args.build_root)


if __name__ == '__main__':
    main()
