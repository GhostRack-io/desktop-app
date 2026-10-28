"""Offline source identity and pinned component acquisition regressions."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
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


if __name__ == '__main__':
    unittest.main()
