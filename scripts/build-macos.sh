#!/usr/bin/env bash
set -euo pipefail
desktop=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
[[ $(uname -s) == Darwin ]] || { printf 'Run this build on macOS.\n' >&2; exit 1; }
version=$(python3 "$desktop/scripts/build-support.py" version)
if [[ ${GITHUB_REF_TYPE:-} == tag && ${GITHUB_REF_NAME:-} != "desktop-v$version" ]]; then printf 'Release tag version differs.\n' >&2; exit 1; fi
# Apply the same supported baseline to Rust, C dependencies, and the bundle.
export MACOSX_DEPLOYMENT_TARGET=11.0
target=universal-apple-darwin
build_root=${DESKTOP_BUILD_DIR:-$desktop/artifacts/build-macos}
mkdir -p "$desktop/src-tauri/binaries" "$build_root"
build_root=$(cd -- "$build_root" && pwd)
rustup target add aarch64-apple-darwin x86_64-apple-darwin
for arch in aarch64 x86_64; do
    python3 "$desktop/scripts/build-support.py" components --target "$arch-apple-darwin" --build-root "$build_root"
done
lipo -create "$desktop/src-tauri/binaries/gigahost-ghost-aarch64-apple-darwin" "$desktop/src-tauri/binaries/gigahost-ghost-x86_64-apple-darwin" -output "$desktop/src-tauri/binaries/gigahost-ghost-$target"
lipo -create "$desktop/src-tauri/binaries/gigahost-mmxwallet-aarch64-apple-darwin" "$desktop/src-tauri/binaries/gigahost-mmxwallet-x86_64-apple-darwin" -output "$desktop/src-tauri/binaries/gigahost-mmxwallet-$target"
chmod 0755 "$desktop/src-tauri/binaries/gigahost-ghost-$target" "$desktop/src-tauri/binaries/gigahost-mmxwallet-$target"
# lipo changes signed Mach-O bytes. Re-sign universal sidecars before use;
# Tauri signs them again inside-out when creating the final app bundle.
for component in ghost mmxwallet; do
    codesign --force --sign - --timestamp=none "$desktop/src-tauri/binaries/gigahost-$component-$target"
done
python3 "$desktop/scripts/check-ghost.py" "$desktop/src-tauri/binaries/gigahost-ghost-$target"
cd -- "$desktop"
npm ci
npm run icons
# Retain the app for inspection; a DMG-only build removes it after packaging.
CARGO_TARGET_DIR="$build_root/desktop" npm run tauri build -- --target "$target" --config src-tauri/tauri.macos.conf.json --bundles app,dmg -- --locked
mkdir -p "$desktop/artifacts/packages"
python3 - "$build_root/desktop/$target/release/bundle" "$desktop" <<'PY'
import hashlib, importlib.util, json, os, pathlib, shutil, subprocess, sys, tempfile
bundle, desktop = map(pathlib.Path, sys.argv[1:])
config = json.loads((desktop/'src-tauri/tauri.conf.json').read_text())
package = json.loads((desktop/'package.json').read_text())
if package['version'] != config['version']:
    raise ValueError('Desktop package/config versions differ')
spec = importlib.util.spec_from_file_location('macos_bundle', desktop/'scripts/macos-bundle.py')
inspector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inspector)
components = inspector.inspect(bundle/'macos/Gigahost.app', config['version'])
support_spec = importlib.util.spec_from_file_location('build_support', desktop/'scripts/build-support.py')
support = importlib.util.module_from_spec(support_spec)
support_spec.loader.exec_module(support)
manifest = {'desktop': support.desktop_identity(), 'target': 'universal-apple-darwin', 'version': support.version(),
            'minimum_macos': '11.0', 'signing': 'adhoc', 'notarized': False,
            **{name: {'commit': support.pins()[name]['revision'], 'dirty': False} for name in ('ghost', 'mmxwallet')}, **components}
# Select this version explicitly: caches can contain an older release DMG.
source = bundle/'dmg'/f"{config['productName']}_{config['version']}_universal.dmg"
if not source.is_file():
    raise ValueError('Expected the configured product/version universal DMG')
subprocess.run(['hdiutil', 'verify', str(source)], check=True)
out = desktop/'artifacts/packages'
name = f"gigahost_{config['version']}_macos_universal.dmg".lower()
with tempfile.TemporaryDirectory(prefix='.package-macos-', dir=out) as stage_dir:
    stage = pathlib.Path(stage_dir)
    shutil.copyfile(source, stage/name)
    (stage/name).chmod(0o644)
    (stage/'build.json').write_text(json.dumps(manifest, indent=2)+'\n')
    checksum = hashlib.sha256((stage/name).read_bytes()).hexdigest()
    (stage/'sha256sums-macos-universal').write_text(f'{checksum}  ./{name}\n')
    for item in stage.iterdir():
        os.replace(item, out/item.name)
PY
printf 'macOS universal package: %s\n' "$desktop/artifacts/packages"
