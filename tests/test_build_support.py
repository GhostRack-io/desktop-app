"""Offline source identity and pinned component acquisition regressions."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('support', Path(__file__).parents[1] / 'scripts/build-support.py')
support = importlib.util.module_from_spec(spec)
spec.loader.exec_module(support)


class SourceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repo = self.root / 'source'
        self.repo.mkdir()
        self.git('init', '-b', 'main')
        self.git('config', 'user.name', 'Example')
        self.git('config', 'user.email', 'example@example.com')
        self.git('remote', 'add', 'origin', support.REPOSITORIES['ghost'])
        (self.repo / 'Cargo.toml').write_text('[package]\nname = "ghost"\nversion = "0.1.0"\n')
        (self.repo / 'Cargo.lock').write_text('version = 4\n')
        (self.repo / '.gitignore').write_text('.cargo/\n')
        self.git('add', 'Cargo.toml', 'Cargo.lock', '.gitignore')
        self.git('commit', '-m', 'Example source')
        self.commit = self.git('rev-parse', 'HEAD')

    def git(self, *args):
        return subprocess.check_output(['git', '-C', str(self.repo), *args], text=True, stderr=subprocess.DEVNULL).strip()

    def test_snapshot_checkout_preserves_text_and_font_bytes_with_autocrlf(self):
        (self.repo / '.gitattributes').write_bytes((support.ROOT / '.gitattributes').read_bytes())
        shared = self.repo / 'public/shared'
        shared.mkdir(parents=True)
        expected = {}
        for source in (support.ROOT / 'public/shared').iterdir():
            expected[source.name] = source.read_bytes()
            (shared / source.name).write_bytes(expected[source.name])
        self.git('config', 'core.autocrlf', 'false')
        self.git('add', '.gitattributes', 'public/shared')
        self.git('commit', '-m', 'Example asset snapshot')
        checkout = self.root / 'checkout'
        subprocess.run(['git', '-c', 'core.autocrlf=true', 'clone', '--config', 'core.autocrlf=true', '--no-local', str(self.repo), str(checkout)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for name, content in expected.items():
            self.assertEqual((checkout / 'public/shared' / name).read_bytes(), content, name)
        self.assertEqual(subprocess.check_output(['git', '-C', str(checkout), 'status', '--porcelain']), b'')

    def test_identity_requires_exact_clean_origin_and_revision(self):
        expected = {'commit': self.commit, 'dirty': False}
        self.assertEqual(support.identity(self.repo, support.REPOSITORIES['ghost'], self.commit), expected)
        with self.assertRaisesRegex(ValueError, 'revision'):
            support.identity(self.repo, support.REPOSITORIES['ghost'], '0' * 40)
        with self.assertRaisesRegex(ValueError, 'origin'):
            support.identity(self.repo, 'https://example.com/other.git', self.commit)
        (self.repo / 'extra').write_text('untracked')
        with self.assertRaisesRegex(ValueError, 'dirty'):
            support.identity(self.repo)

    def install_replacement(self, kind):
        original = subprocess.check_output(['git', '--no-replace-objects', '-C', str(self.repo), 'show', self.commit + ':Cargo.lock'])
        blob = self.git('rev-parse', self.commit + ':Cargo.lock')
        (self.repo / 'Cargo.lock').write_bytes(b'version = 3\n')
        self.git('add', 'Cargo.lock')
        if kind == 'commit':
            self.git('commit', '-m', 'Example alternate source')
            replacement = self.git('rev-parse', 'HEAD')
            self.git('replace', self.commit, replacement)
            self.git('update-ref', 'refs/heads/main', self.commit)
        else:
            replacement = self.git('rev-parse', ':Cargo.lock')
            self.git('replace', blob, replacement)
        if kind == 'commit':
            self.assertEqual(self.git('status', '--porcelain', '--untracked-files=all'), '')
        self.assertNotEqual(subprocess.check_output(['git', '--no-replace-objects', '-C', str(self.repo), 'status', '--porcelain']), b'')
        return original

    def test_python_identity_and_archive_use_original_commit_and_blob_objects(self):
        for kind in ('commit', 'blob'):
            with self.subTest(kind=kind):
                original = self.install_replacement(kind)
                with self.assertRaisesRegex(ValueError, 'dirty'):
                    support.identity(self.repo, support.REPOSITORIES['ghost'], self.commit)
                snapshot = self.root / ('python-' + kind)
                snapshot.mkdir()
                support.extract(support.archive(self.repo, self.commit), snapshot)
                self.assertEqual((snapshot / 'Cargo.lock').read_bytes(), original)
                subprocess.run(['git', '--no-replace-objects', '-C', str(self.repo), 'reset', '--hard', self.commit], check=True, stdout=subprocess.DEVNULL)
                self.assertEqual(support.identity(self.repo)['commit'], self.commit)
                self.git('replace', '-d', self.git('replace', '-l'))

    @unittest.skipIf(os.name == 'nt', 'Linux wrapper uses Bash')
    def test_shell_exporter_uses_original_commit_and_blob_objects(self):
        for kind in ('commit', 'blob'):
            with self.subTest(kind=kind):
                original = self.install_replacement(kind)
                output = self.root / (kind + '.tar')
                command = ['bash', '-c', 'set -euo pipefail; source "$1"; source_archive "$2" "$3" "$4" "$5"', '--', str(support.ROOT / 'scripts/source-archive.sh'), str(self.repo), support.REPOSITORIES['ghost'], self.commit, str(output)]
                rejected = subprocess.run(command, capture_output=True, text=True)
                self.assertNotEqual(rejected.returncode, 0)
                self.assertIn('Source is dirty', rejected.stderr)
                subprocess.run(['git', '--no-replace-objects', '-C', str(self.repo), 'reset', '--hard', self.commit], check=True, stdout=subprocess.DEVNULL)
                self.assertEqual(subprocess.check_output(command, text=True), self.commit)
                snapshot = self.root / ('shell-' + kind)
                snapshot.mkdir()
                support.extract(output.read_bytes(), snapshot)
                self.assertEqual((snapshot / 'Cargo.lock').read_bytes(), original)
                self.git('replace', '-d', self.git('replace', '-l'))

    @unittest.skipIf(os.name == 'nt', 'Requires symbolic link privileges')
    def test_symlink_and_unowned_gitfile_are_refused(self):
        marker = self.repo / '.git'
        owned = self.root / 'metadata'
        marker.rename(owned)
        marker.symlink_to(owned, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'own'):
            support.identity(self.repo)
        marker.unlink()
        marker.write_text('gitdir: ' + str(owned) + '\n')
        subprocess.run(['git', '--git-dir', str(owned), 'config', 'core.worktree', str(self.root)], check=True)
        with self.assertRaises(ValueError):
            support.identity(self.repo)
        subprocess.run(['git', '--git-dir', str(owned), 'config', 'core.worktree', str(self.repo)], check=True)
        self.assertEqual(support.identity(self.repo)['commit'], self.commit)

    @unittest.skipIf(os.name == 'nt', 'Uses a POSIX executable fixture')
    def test_override_build_receives_only_tracked_archive_and_forces_install(self):
        (self.repo / '.cargo').mkdir()
        (self.repo / '.cargo/config.toml').write_text('unexpected ignored input')
        tools = self.root / 'tools'
        tools.mkdir()
        cargo = tools / 'cargo'
        cargo.write_text('''#!/usr/bin/env python3
import json,pathlib,sys
args=sys.argv[1:]
assert args[0]=='install' and '--force' in args and '--locked' in args
source=pathlib.Path(args[args.index('--path')+1])
assert not (source/'.cargo').exists()
assert (source/'Cargo.lock').is_file()
root=pathlib.Path(args[args.index('--root')+1]); (root/'bin').mkdir(parents=True,exist_ok=True)
(root/'bin/ghost').write_text('selected source')
''')
        cargo.chmod(0o755)
        pins = {'ghost': {'revision': self.commit, 'repository': support.REPOSITORIES['ghost'], 'package': 'ghost', 'binary': 'ghost'}}
        with patch.object(support, 'pins', return_value=pins), patch.dict(os.environ, {'GHOST_SOURCE_DIR': str(self.repo), 'PATH': str(tools) + os.pathsep + os.environ['PATH']}, clear=False):
            binary = support.component('ghost', 'x86_64-unknown-linux-gnu', self.root / 'build')
        self.assertEqual(binary.read_text(), 'selected source')
        self.assertIn(self.commit, str(binary))

    @unittest.skipIf(os.name == 'nt', 'Linux wrapper uses Bash')
    def test_shell_exporter_checks_owned_git_and_ignores_extra_files(self):
        script = support.ROOT / 'scripts/source-archive.sh'
        output = self.root / 'source.tar'
        (self.repo / '.cargo').mkdir()
        (self.repo / '.cargo/config.toml').write_text('ignored input')
        command = ['bash', '-c', 'set -euo pipefail; source "$1"; source_archive "$2" "$3" "$4" "$5"', '--', str(script), str(self.repo), support.REPOSITORIES['ghost'], self.commit, str(output)]
        self.assertEqual(subprocess.check_output(command, text=True), self.commit)
        snapshot = self.root / 'export'
        snapshot.mkdir()
        support.extract(output.read_bytes(), snapshot)
        self.assertFalse((snapshot / '.cargo').exists())
        marker = self.repo / '.git'
        metadata = self.root / 'metadata'
        marker.rename(metadata)
        marker.symlink_to(metadata, target_is_directory=True)
        result = subprocess.run(command, capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(b'own', result.stderr)

    @unittest.skipIf(os.name == 'nt', 'Linux wrapper uses Bash')
    def test_linux_wrapper_validates_wallet_origin_pin_and_archive(self):
        wallet_origin = 'https://github.com/mmx-network/mmx-rust-node.git'
        self.git('remote', 'set-url', 'origin', wallet_origin)
        (self.repo / '.cargo').mkdir()
        (self.repo / '.cargo/config.toml').write_text('ignored extra input')
        desktop = self.root / 'desktop'
        (desktop / 'scripts').mkdir(parents=True)
        for name in ('source-archive.sh', 'build-linux-container.sh'):
            shutil.copyfile(support.ROOT / 'scripts' / name, desktop / 'scripts' / name)
        config = support.pins()
        self.assertEqual(config['mmxwallet']['repository'], wallet_origin)
        config['mmxwallet']['revision'] = self.commit
        (desktop / 'build-dependencies.json').write_text(json.dumps(config))
        (desktop / '.gitignore').write_text('artifacts/\n')
        def desktop_git(*args):
            return subprocess.check_output(['git', '-C', str(desktop), *args], stderr=subprocess.DEVNULL)
        desktop_git('init', '-b', 'main')
        desktop_git('config', 'user.name', 'Example')
        desktop_git('config', 'user.email', 'example@example.com')
        desktop_git('remote', 'add', 'origin', 'https://github.com/GhostRack-io/desktop-app.git')
        desktop_git('add', 'scripts', 'build-dependencies.json', '.gitignore')
        desktop_git('commit', '-m', 'Example desktop source')
        tools = self.root / 'tools'
        tools.mkdir()
        docker = tools / 'docker'
        docker.write_text('#!' + sys.executable + '\n' + '''import json,os,pathlib,shutil,sys,tarfile
args=sys.argv[1:]
if args[0]=='build':
    sys.exit(0)
mounts=[args[i+1] for i,a in enumerate(args) if a in ('-v','--volume')]
bundle=pathlib.Path(next(m.split(':')[0] for m in mounts if m.endswith(':/inputs:ro')))
if 'python3' in args:
    # Read the real archived configuration at the container boundary.
    with tarfile.open(bundle/'desktop.tar') as archive:
        config=json.load(archive.extractfile('build-dependencies.json'))
    component='mmxwallet' if '["mmxwallet"]' in args[-1] else 'ghost'
    print(config[component]['revision'])
else:
    shutil.copytree(bundle, os.environ['CAPTURE_BUNDLE'])
''')
        docker.chmod(0o755)
        captured = self.root / 'captured'
        env = dict(os.environ, PATH=str(tools) + os.pathsep + os.environ['PATH'],
                   MMX_NODE_DIR=str(self.repo), CAPTURE_BUNDLE=str(captured))
        env.pop('GHOST_SOURCE_DIR', None)
        def run():
            return subprocess.run(['bash', str(desktop / 'scripts/build-linux-container.sh')],
                                  env=env, capture_output=True, text=True)
        accepted = run()
        self.assertEqual(accepted.returncode, 0, accepted.stderr)
        metadata = json.loads((captured / 'identity.json').read_text())
        self.assertEqual(metadata['mmxwallet']['commit'], self.commit)
        self.assertFalse(metadata['mmxwallet']['dirty'])
        archive = (captured / 'mmxwallet.tar').read_bytes()
        self.assertEqual(metadata['mmxwallet']['sha256'], hashlib.sha256(archive).hexdigest())
        snapshot = self.root / 'snapshot'
        snapshot.mkdir()
        support.extract(archive, snapshot)
        self.assertTrue((snapshot / 'Cargo.lock').is_file())
        self.assertFalse((snapshot / '.cargo').exists())
        shutil.rmtree(captured)
        self.git('remote', 'set-url', 'origin', 'https://example.com/unrelated.git')
        refused = run()
        self.assertNotEqual(refused.returncode, 0)
        self.assertIn('origin', refused.stderr)
        self.assertFalse(captured.exists())
        self.git('remote', 'set-url', 'origin', wallet_origin)
        (self.repo / 'Cargo.lock').write_text('dirty tracked input')
        refused = run()
        self.assertNotEqual(refused.returncode, 0)
        self.assertIn('dirty', refused.stderr)
        self.assertFalse(captured.exists())
        self.git('add', 'Cargo.lock')
        self.git('commit', '-m', 'Example different revision')
        self.assertNotEqual(run().returncode, 0)
        self.assertFalse(captured.exists())

    def test_pin_configuration_rejects_mutable_or_unexpected_sources(self):
        config = support.pins()
        config['ghost']['revision'] = 'main'
        (self.root / 'build-dependencies.json').write_text(json.dumps(config))
        with self.assertRaisesRegex(ValueError, 'component pin'):
            support.pins(self.root)
        config['ghost']['revision'] = 'a' * 40
        config['ghost']['repository'] = 'https://example.com/other.git'
        (self.root / 'build-dependencies.json').write_text(json.dumps(config))
        with self.assertRaisesRegex(ValueError, 'component pin'):
            support.pins(self.root)

    def test_local_archive_attributes_are_refused(self):
        (self.repo / '.git/info/attributes').write_text('* export-ignore\n')
        with self.assertRaisesRegex(ValueError, 'attributes'):
            support.identity(self.repo)

    def test_default_acquisition_uses_pinned_git_and_forced_install(self):
        calls = []
        def install(command, check):
            calls.append(command)
            out = Path(command[command.index('--root') + 1]) / 'bin'
            out.mkdir(parents=True)
            (out / 'mmxwallet').write_bytes(b'fresh executable')
        with patch.dict(os.environ, {}, clear=True), patch.object(support.subprocess, 'run', side_effect=install):
            binary = support.component('mmxwallet', 'x86_64-unknown-linux-gnu', self.root / 'build')
        command = calls[0]
        self.assertEqual(command[command.index('--rev') + 1], support.pins()['mmxwallet']['revision'])
        self.assertEqual(command[command.index('--git') + 1], support.REPOSITORIES['mmxwallet'])
        self.assertIn('--locked', command)
        self.assertIn('--force', command)
        self.assertEqual(binary.read_bytes(), b'fresh executable')

    def test_cross_target_staging_does_not_execute_foreign_components(self):
        desktop = self.root / 'desktop'
        desktop.mkdir()
        executable = self.root / 'foreign-binary'
        executable.write_bytes(b'not a native executable')
        with patch.object(support, 'ROOT', desktop), patch.object(support, 'version'), patch.object(support, 'desktop_identity'), patch.object(support, 'component', return_value=executable), patch.object(support.subprocess, 'run') as run, patch('sys.argv', ['build-support.py', 'components', '--target', 'aarch64-apple-darwin']):
            support.main()
            run.assert_not_called()
        self.assertEqual((desktop / 'src-tauri/binaries/gigahost-ghost-aarch64-apple-darwin').read_bytes(), executable.read_bytes())

    def test_linux_package_tree_requires_exact_sidecars_and_readable_licenses(self):
        spec = importlib.util.spec_from_file_location('verify_linux', support.ROOT / 'scripts/verify-linux.py')
        verify = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(verify)
        tree = self.root / 'package'
        (tree / 'usr/bin').mkdir(parents=True)
        licenses = tree / 'usr/lib/Gigahost/licenses'
        licenses.mkdir(parents=True)
        manifest = {'target': 'x86_64-unknown-linux-gnu', 'sha256': {}}
        for name in ('ghost', 'mmxwallet'):
            executable = tree / ('usr/bin/gigahost-' + name)
            executable.write_bytes(name.encode())
            manifest['sha256']['gigahost-' + name + '-' + manifest['target']] = verify.digest(executable)
        for source in (support.ROOT / 'LICENSE', support.ROOT / 'public/shared/instrument-sans-ofl.txt', support.ROOT / 'public/shared/geist-mono-ofl.txt'):
            (licenses / source.name).write_bytes(source.read_bytes())
        verify.verify_tree(tree, manifest)
        (tree / 'usr/bin/gigahost-ghost').write_bytes(b'changed during packaging')
        with self.assertRaisesRegex(ValueError, 'sidecar hash'):
            verify.verify_tree(tree, manifest)
        (tree / 'usr/bin/gigahost-ghost').write_bytes(b'ghost')
        (licenses / 'LICENSE').unlink()
        with self.assertRaisesRegex(ValueError, 'license'):
            verify.verify_tree(tree, manifest)

    def test_source_bundle_rejects_hash_and_pin_mismatch(self):
        bundle = self.root / 'bundle'
        bundle.mkdir()
        data = support.archive(self.repo, self.commit)
        (bundle / 'desktop.tar').write_bytes(data)
        metadata = {'desktop': {'commit': self.commit, 'dirty': False, 'sha256': '0' * 64}}
        (bundle / 'identity.json').write_text(json.dumps(metadata))
        with patch.dict(os.environ, {'DESKTOP_SOURCE_BUNDLE': str(bundle)}):
            with self.assertRaisesRegex(ValueError, 'hash'):
                support.source_bundle()
            metadata['desktop']['sha256'] = hashlib.sha256(data).hexdigest()
            (bundle / 'identity.json').write_text(json.dumps(metadata))
            self.assertEqual(support.desktop_identity(), {'commit': self.commit, 'dirty': False})


@unittest.skipIf(os.name == 'nt', 'Uses a POSIX executable fixture')
class WorkflowSourceTests(unittest.TestCase):
    def test_workflow_generated_and_restored_caches_keep_source_clean(self):
        workflow = (support.ROOT / '.github/workflows/packages.yml').read_text()
        for job, targets in (('build', ('x86_64-pc-windows-msvc',)),
                             ('macos', ('aarch64-apple-darwin', 'x86_64-apple-darwin'))):
            with self.subTest(job=job), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary) / 'source'
                root.mkdir()
                block = re.search(r'^  ' + job + r':\n(.*?)(?=^  [a-zA-Z_-]+:|\Z)', workflow, re.M | re.S)[1]
                selected = dict(re.findall(r'^      (DESKTOP_BUILD_DIR|CARGO_TARGET_DIR): (.+)$', block, re.M))
                selected = {key: value.replace('${{ github.workspace }}', str(root)) for key, value in selected.items()}
                self.assertEqual(set(selected), {'DESKTOP_BUILD_DIR', 'CARGO_TARGET_DIR'})
                build_root = Path(selected['DESKTOP_BUILD_DIR'])
                workspace, cache_target = re.search(r'^          workspaces: (\S+) -> (\S+)$', block, re.M).groups()
                native_target = (root / workspace / cache_target).resolve()
                self.assertEqual(native_target, Path(selected['CARGO_TARGET_DIR']).resolve())
                cache_block = re.search(r'uses: actions/cache@v4\n        with:\n          path: \|\n(.*?)(?=^          key:)', block, re.M | re.S)[1]
                cache_paths = [Path(value.strip().replace('${{ env.DESKTOP_BUILD_DIR }}', str(build_root))) for value in cache_block.splitlines() if value.strip()]
                self.assertEqual(len(cache_paths), 2)
                for name in ('.gitignore', 'build-dependencies.json', 'package.json', 'package-lock.json',
                             'src-tauri/tauri.conf.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock',
                             'scripts/build-support.py'):
                    destination = root / name
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(support.ROOT / name, destination)
                def git(*args):
                    return subprocess.check_output(['git', '-C', str(root), *args], text=True, stderr=subprocess.DEVNULL).strip()
                git('init', '-b', 'main')
                git('config', 'user.name', 'Example')
                git('config', 'user.email', 'example@example.com')
                git('remote', 'add', 'origin', 'https://github.com/GhostRack-io/desktop-app.git')
                git('add', '.')
                git('commit', '-m', 'Example desktop source')
                commit = git('rev-parse', 'HEAD')
                tools = Path(temporary) / 'tools'
                tools.mkdir()
                cargo = tools / 'cargo'
                cargo.write_text('''#!/usr/bin/env python3
import pathlib,sys
args=sys.argv[1:]
prefix=pathlib.Path(args[args.index('--root')+1])/'bin'
prefix.mkdir(parents=True,exist_ok=True)
target=args[args.index('--target')+1]
name=args[args.index('--bin')+1]+('.exe' if 'windows' in target else '')
(prefix/name).write_bytes(b'example executable')
cache=pathlib.Path(args[args.index('--target-dir')+1])
cache.mkdir(parents=True,exist_ok=True)
(cache/'generated').write_bytes(b'example compilation cache')
''')
                cargo.chmod(0o755)
                env = dict(os.environ, **selected, PATH=str(tools) + os.pathsep + os.environ['PATH'])
                for name in ('DESKTOP_SOURCE_BUNDLE', 'GHOST_SOURCE_DIR', 'MMX_NODE_DIR'):
                    env.pop(name, None)
                helper = [sys.executable, 'scripts/build-support.py']
                for phase in ('generated', 'restored'):
                    for cache in [native_target, *cache_paths]:
                        cache.mkdir(parents=True, exist_ok=True)
                        (cache / phase).write_bytes(b'example cached output')
                    for target in targets:
                        for action in ('components', 'manifest', 'desktop-identity'):
                            result = subprocess.run(helper + [action, '--target', target, '--build-root', str(build_root)], cwd=root, env=env, capture_output=True, text=True)
                            self.assertEqual(result.returncode, 0, result.stderr)
                            if action == 'desktop-identity':
                                self.assertEqual(json.loads(result.stdout), {'commit': commit, 'dirty': False})
                        manifest = json.loads((root / 'src-tauri/binaries/build-manifest.json').read_text())
                        self.assertEqual(manifest['desktop'], {'commit': commit, 'dirty': False})
                        self.assertEqual(manifest['target'], target)
                        self.assertEqual(git('status', '--porcelain', '--untracked-files=all'), '')
                    self.assertTrue(list((build_root / 'components').rglob('ghost*')))
                    self.assertTrue(list((build_root / 'targets').rglob('generated')))


if __name__ == '__main__':
    unittest.main()
