# GhostRack desktop

A Tauri desktop app for your GhostRack account and MMX wallet. Ghost and the
native Rust mmxwallet are bundled; no separate CLI installation is needed.

## Build

Rust 1.97, Node 24 and Python 3.10 or newer are required. Linux packaging uses
Ubuntu 22.04 with GTK/WebKit development libraries; the Docker wrapper supplies
the build environment. Native Windows builds require PowerShell 7 and MSVC;
macOS builds produce an ad-hoc signed universal app and DMG for macOS 11+.

```sh
npm ci
npm test
npm run build
scripts/build-linux-container.sh
```

Run `scripts/build-macos.sh` on macOS or `scripts/build-windows.ps1` on Windows.
Packages and checksums are written to `artifacts/packages`. `npm run dev` opens
a browser preview; `npm run tauri dev` runs the native app after staging sidecars
and icons with a package build.

`build-dependencies.json` pins both components to full Git revisions. Builds use
`cargo install --git ... --rev ... --locked --force`, with separate component,
revision and target caches. The wallet source is
`https://github.com/mmx-network/mmx-rust-node.git`. `GHOST_SOURCE_DIR` optionally
selects a clean Ghost checkout; `MMX_NODE_DIR` selects a clean Rust wallet
checkout. Both require the exact configured origin and revision. Overrides are exported as
tracked Git archives before building. Ignored files are excluded. Set
`CARGO_BUILD_JOBS` to bound parallel compilation (default 4).

Build records distinguish the desktop source revision, both component revisions,
target, version and executable hashes. The environment and toolchain remain part
of the trusted build setup.

## Checks

```sh
npm test
npm run test:ui:offline
python3 -m unittest discover -s tests -p 'test_*.py'
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --locked --manifest-path src-tauri/Cargo.toml --no-default-features --features test-driver
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --no-default-features --features test-driver --all-targets -- -D warnings
```

Install Playwright Chromium with `npx playwright install chromium` first. Native
integration checks use disposable keys and local RPC/API fixtures; see
`python3 tests/native.py --help`. Package startup checks are in
`tests/window-state.py`, `scripts/smoke-windows.ps1` and `scripts/smoke-macos.py`.
Run installer checks on disposable systems.

## Releases

Download installers from [GitHub Releases](https://github.com/ghostrack-io/desktop-app/releases/latest)
or the [CDN catalog](https://apps.ghostrack.io/desktop/latest.json).

The public repository's Desktop packages Action builds and checks Windows, Linux
and universal macOS packages. Manual runs default to checking only; select
`publish` to upload to both GitHub Releases and the CDN. Matching
`desktop-v<configured version>` tags also publish. `macos_only` never publishes.
The source revision and configured version must match every build record.

Set the Actions secret `CDN_STORAGE_PASSWORD` and allow this repository to use it.
The publish job alone receives storage credentials and `GITHUB_TOKEN` with
`contents: write`. Optional Actions variables: `CDN_STORAGE_ENDPOINT` (default
`https://sg.storage.bunnycdn.com`), `CDN_STORAGE_ZONE` (`gigahost-apps`),
`CDN_PUBLIC_BASE` (`https://apps.ghostrack.io`) and `DESKTOP_CDN_PREFIX`
(`desktop`). Existing `DESKTOP_STORAGE_PASSWORD`, `DESKTOP_STORAGE_ENDPOINT`,
`DESKTOP_S3_BUCKET`, `DESKTOP_S3_PREFIX` and `DESKTOP_PUBLIC_BASE` settings remain
fallbacks. `DESKTOP_UPLOAD_TRANSPORT=s3` retains the S3 adapter with
`DESKTOP_S3_ENDPOINT`, `DESKTOP_S3_REGION`, `DESKTOP_S3_ACCESS_KEY_ID` and
`DESKTOP_S3_SECRET_ACCESS_KEY`.

Publication freezes one verified asset set, reconciles a GitHub draft, verifies
immutable CDN objects and public downloads, then writes and verifies `latest.json`
and publishes GitHub last. On failure, rerun the failed publish job using the same
workflow artifacts. Identical objects resume; conflicting or incomplete published
releases fail without replacing assets or moving tags. A matching published
GitHub release still reconciles CDN publication. The providers are not atomic;
CDN publication can succeed before final GitHub publication fails.

Offline validation can use `scripts/publish-github-release.py --dry-run` with
package directories, version and revision; it performs no uploads and needs no
credentials. Actions owns release publication.

## Keys and state

Wallets use `MMX_HOME` or `$HOME/.mmx`. Account keys use `GHOST_SEED_FILE`, absolute
`XDG_CONFIG_HOME`, or `$HOME/.config/ghost/account.seed`. Windows defaults follow
the CLIs' user-profile locations. Selected key paths are independent. Key creation
and export never overwrite existing files. A wallet derivation passphrase changes
its keys and does not encrypt the wallet file. Keep safe backups.

Settings and operation state use `$XDG_STATE_HOME/gigahost` or
`$HOME/.local/state/gigahost`; on Windows, `%LOCALAPPDATA%\gigahost`. Keys and
state remain outside the install directory. Uncertain transfers retain their
reviewed bytes and reconcile before retrying. Background refreshes never submit
payments. The browser preview cannot sign account or wallet operations.

## License

Apache-2.0; see `LICENSE`. Instrument Sans and Geist Mono are separately licensed
under the SIL Open Font License. Their notices are in `public/shared`, beside
the font files, and all three license texts are included as readable app resources.
