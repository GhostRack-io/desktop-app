#!/usr/bin/env bash
set -euo pipefail
desktop=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
[[ $(uname -s) == Linux && $(uname -m) == x86_64 ]] || { printf 'Run this build on Linux x64.\n' >&2; exit 1; }
version=$(python3 "$desktop/scripts/build-support.py" version)
if [[ ${GITHUB_REF_TYPE:-} == tag && ${GITHUB_REF_NAME:-} != "desktop-v$version" ]]; then printf 'Release tag version differs.\n' >&2; exit 1; fi
target=$(rustc -vV | sed -n 's/^host: //p')
build_root=${DESKTOP_BUILD_DIR:-$desktop/artifacts/build}
mkdir -p "$build_root"
build_root=$(cd -- "$build_root" && pwd)
python3 "$desktop/scripts/build-support.py" components --target "$target" --build-root "$build_root"
# Keep the same sidecar bytes in both Linux package formats.
export PATCHELF
PATCHELF=$(command -v patchelf)
export NO_STRIP=1
for component in ghost mmxwallet; do
    "$PATCHELF" --set-rpath '$ORIGIN/../lib' "$desktop/src-tauri/binaries/ghostrack-$component-$target"
done
python3 "$desktop/scripts/check-ghost.py" "$desktop/src-tauri/binaries/ghostrack-ghost-$target"
python3 "$desktop/scripts/build-support.py" manifest --target "$target" --build-root "$build_root"
cd -- "$desktop"
npm ci
npm run icons
CARGO_TARGET_DIR="$build_root/desktop" npm run tauri build -- --bundles deb,appimage -- --locked
python3 "$desktop/scripts/verify-linux.py" \
    "$build_root/desktop/release/bundle/deb/GhostRack_${version}_amd64.deb" \
    "$build_root/desktop/release/bundle/appimage/GhostRack_${version}_amd64.AppImage" \
    "$desktop/src-tauri/binaries/build-manifest.json"
mkdir -p "$desktop/artifacts/packages"
python3 - "$build_root/desktop/release/bundle" "$desktop" <<'PY'
import hashlib,json,os,pathlib,shutil,tempfile,sys
bundle,desktop=map(pathlib.Path,sys.argv[1:])
out=desktop/'artifacts/packages'
config=json.loads((desktop/'src-tauri/tauri.conf.json').read_text())
stem=f"{config['productName']}_{config['version']}_amd64"
sources=[bundle/'deb'/f'{stem}.deb',bundle/'appimage'/f'{stem}.AppImage']
# Stage every file before publishing. Replacing the AppImage inode also works
# while an earlier build is running, without changing that process's binary.
with tempfile.TemporaryDirectory(prefix='.package-',dir=out) as stage_dir:
    stage=pathlib.Path(stage_dir)
    names=[]
    for source in sources:
        dest=stage/source.name.lower()
        shutil.copyfile(source,dest)
        dest.chmod(0o755 if source.suffix == '.AppImage' else 0o644)
        names.append(dest.name)
    shutil.copyfile(desktop/'src-tauri/binaries/build-manifest.json',stage/'build.json')
    sums=[f'{hashlib.sha256((stage/name).read_bytes()).hexdigest()}  ./{name}\n' for name in names]
    (stage/'sha256sums').write_text(''.join(sums))
    for item in stage.iterdir():
        os.replace(item,out/item.name)
PY
printf 'Linux packages: %s\n' "$desktop/artifacts/packages"
