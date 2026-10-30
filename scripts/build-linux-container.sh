#!/usr/bin/env bash
set -euo pipefail
desktop=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
source "$desktop/scripts/source-archive.sh"
image=${DESKTOP_BUILD_IMAGE:-ghostrack-desktop-linux:0.1.0}
inputs=$(mktemp -d)
trap 'rm -rf -- "$inputs"' EXIT
revision=$(source_archive "$desktop" https://github.com/ghostrack-io/desktop-app.git '' "$inputs/desktop.tar")
desktop_hash=$(sha256sum "$inputs/desktop.tar"); desktop_hash=${desktop_hash%% *}
printf '{"desktop":{"commit":"%s","dirty":false,"sha256":"%s"}' "$revision" "$desktop_hash" > "$inputs/identity.json"
docker build --tag "$image" "$desktop"
# Read the selected dependency configuration inside the build environment.
ghost_pin=$(docker run --rm -v "$inputs:/inputs:ro" "$image" python3 -c 'import json,tarfile; t=tarfile.open("/inputs/desktop.tar"); print(json.load(t.extractfile("build-dependencies.json"))["ghost"]["revision"])')
override=${GHOST_SOURCE_DIR:-}
if [[ -z $override && -e $desktop/../cli/.git ]]; then override=$desktop/../cli; fi
if [[ -n $override ]]; then
    component_revision=$(source_archive "$override" https://github.com/ghostrack-io/ghost-cli.git "$ghost_pin" "$inputs/ghost.tar")
    component_hash=$(sha256sum "$inputs/ghost.tar"); component_hash=${component_hash%% *}
    printf ',"ghost":{"commit":"%s","dirty":false,"sha256":"%s"}' "$component_revision" "$component_hash" >> "$inputs/identity.json"
fi
if [[ -n ${MMX_NODE_DIR:-} ]]; then
    wallet_pin=$(docker run --rm -v "$inputs:/inputs:ro" "$image" python3 -c 'import json,tarfile; t=tarfile.open("/inputs/desktop.tar"); print(json.load(t.extractfile("build-dependencies.json"))["mmxwallet"]["revision"])')
    component_revision=$(source_archive "$MMX_NODE_DIR" https://github.com/mmx-network/mmx-rust-node.git "$wallet_pin" "$inputs/mmxwallet.tar")
    component_hash=$(sha256sum "$inputs/mmxwallet.tar"); component_hash=${component_hash%% *}
    printf ',"mmxwallet":{"commit":"%s","dirty":false,"sha256":"%s"}' "$component_revision" "$component_hash" >> "$inputs/identity.json"
fi
printf '}\n' >> "$inputs/identity.json"
mkdir -p "$desktop/artifacts/cargo" "$desktop/artifacts/build" "$desktop/artifacts/packages"
docker run --rm --user "$(id -u):$(id -g)" \
    --volume "$inputs:/inputs:ro" --volume "$desktop/artifacts:/cache" \
    --env HOME=/tmp --env RUSTUP_TOOLCHAIN=1.97.0 --env CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-4}" \
    --env CARGO_HOME=/cache/cargo --env DESKTOP_BUILD_DIR=/cache/build --env DESKTOP_SOURCE_BUNDLE=/inputs \
    "$image" bash -c 'set -euo pipefail; mkdir /tmp/desktop-source; tar -xf /inputs/desktop.tar -C /tmp/desktop-source; cd /tmp/desktop-source; python3 scripts/build-support.py desktop-identity; scripts/build-linux.sh; cp -a artifacts/packages/. /cache/packages/'
