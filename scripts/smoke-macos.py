#!/usr/bin/env python3
"""Verify/install/launch a DMG on a disposable native macOS CI runner."""
import argparse
import ctypes as c
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import plistlib
import subprocess
import sys
import tempfile
import time

spec = importlib.util.spec_from_file_location("macos_bundle", Path(__file__).with_name("macos-bundle.py"))
bundle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bundle)


def run(*args, **kwargs):
    return subprocess.check_output(args, timeout=60, **kwargs)


class Windows:
    """Read PID and geometry only; no Accessibility or screen-recording access."""

    def __init__(self):
        self.cg = c.CDLL("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics")
        self.cf = c.CDLL("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")
        self.cg.CGWindowListCopyWindowInfo.argtypes = [c.c_uint32, c.c_uint32]
        self.cg.CGWindowListCopyWindowInfo.restype = c.c_void_p
        self.cf.CFPropertyListCreateData.argtypes = [c.c_void_p, c.c_void_p, c.c_long, c.c_ulong, c.c_void_p]
        self.cf.CFPropertyListCreateData.restype = c.c_void_p
        self.cf.CFDataGetLength.argtypes = [c.c_void_p]
        self.cf.CFDataGetLength.restype = c.c_long
        self.cf.CFDataGetBytePtr.argtypes = [c.c_void_p]
        self.cf.CFDataGetBytePtr.restype = c.c_void_p
        self.cf.CFRelease.argtypes = [c.c_void_p]

    def visible(self, pid):
        # On-screen windows, excluding the desktop; names are unnecessary.
        windows = self.cg.CGWindowListCopyWindowInfo(1 | 16, 0)
        if not windows:
            raise RuntimeError("CoreGraphics window list is unavailable")
        data = None
        try:
            data = self.cf.CFPropertyListCreateData(None, windows, 100, 0, None)
            if not data:
                raise RuntimeError("CoreGraphics window metadata could not be read")
            records = plistlib.loads(c.string_at(self.cf.CFDataGetBytePtr(data), self.cf.CFDataGetLength(data)))
            return any(record.get("kCGWindowOwnerPID") == pid and
                       record.get("kCGWindowLayer") == 0 and
                       record.get("kCGWindowBounds", {}).get("Width", 0) >= 760 and
                       record.get("kCGWindowBounds", {}).get("Height", 0) >= 600
                       for record in records)
        finally:
            if data:
                self.cf.CFRelease(data)
            self.cf.CFRelease(windows)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--packages", type=Path, default=Path(__file__).parents[1] / "artifacts/packages")
    parser.add_argument("--native-arch", choices=("arm64", "x86_64"), required=True)
    args = parser.parse_args()
    if sys.platform != "darwin" or platform.machine() != args.native_arch:
        raise ValueError("Run the smoke on the requested native macOS architecture")
    packages = args.packages.resolve()
    manifest = json.loads((packages / "build.json").read_text())
    if manifest.get("target") != "universal-apple-darwin":
        raise ValueError("Wrong macOS bundle target")
    if (manifest.get("minimum_macos") != "11.0" or manifest.get("signing") != "adhoc" or
            manifest.get("notarized") is not False):
        raise ValueError("Wrong macOS preview metadata")
    version = manifest["version"]
    name = f"gigahost_{version}_macos_universal.dmg".lower()
    image = packages / name
    expected = hashlib.sha256(image.read_bytes()).hexdigest()
    if (packages / "sha256sums-macos-universal").read_text() != f"{expected}  ./{name}\n":
        raise ValueError("DMG package checksum differs")
    run("hdiutil", "verify", str(image))
    windows = Windows()
    process = None
    mounted = False
    with tempfile.TemporaryDirectory(prefix="gigahost-macos-smoke-") as directory:
        root = Path(directory)
        mount = root / "mount"
        mount.mkdir()
        home = root / "home"
        home.mkdir()
        log_path = root / "app.log"
        try:
            run("hdiutil", "attach", "-readonly", "-nobrowse", "-noautoopen", "-mountpoint", str(mount), str(image))
            mounted = True
            apps = list(mount.glob("*.app"))
            if len(apps) != 1 or apps[0].name != "Gigahost.app":
                raise ValueError("Expected exactly one Gigahost.app in the DMG")
            inspected = bundle.inspect(apps[0], version)
            if any(manifest.get(key) != value for key, value in inspected.items()):
                raise ValueError("Packaged binary checksums or architectures differ from build.json")
            # Simulate dragging to Applications without touching /Applications.
            installed = root / "Applications/Gigahost.app"
            installed.parent.mkdir()
            run("ditto", str(apps[0]), str(installed))
            if bundle.inspect(installed, version) != inspected:
                raise ValueError("Installed bundle differs from the DMG")
            run("hdiutil", "detach", str(mount))
            mounted = False
            env = dict(os.environ, HOME=str(home), XDG_CONFIG_HOME=str(home / "config"),
                       XDG_STATE_HOME=str(home / "state"), XDG_DATA_HOME=str(home / "data"),
                       MMX_HOME=str(home / "wallets"))
            for key in ["GHOST_SEED_FILE", "GHOST_RECOVERY_SEED_FILE", "DYLD_LIBRARY_PATH", "DYLD_FRAMEWORK_PATH"]:
                env.pop(key, None)
            executable_dir = installed / "Contents/MacOS"
            native = ["/usr/bin/arch", "-" + args.native_arch]
            ghost = executable_dir / "gigahost-ghost"
            wallet = executable_dir / "gigahost-mmxwallet"
            assert run(*native, str(ghost), "--version", env=env, text=True).startswith("ghost ")
            assert run(*native, str(wallet), "--version", env=env, text=True).startswith("mmxwallet ")
            capabilities = json.loads(run(*native, str(wallet), "--json", "capabilities", env=env))
            assert capabilities["schema_version"] == 1 and capabilities["http_transport"] == "native-rust"
            listed = json.loads(run(*native, str(wallet), "--json", "list", env=env))
            assert listed["schema_version"] == 1 and listed["wallets"] == []
            assert Path(listed["wallet_directory"]) == home / "wallets"
            # A saved offline configuration avoids public RPC/API use entirely.
            state = home / "state/gigahost"
            state.mkdir(parents=True)
            (state / "settings.json").write_text(json.dumps({"rpc_url": "http://127.0.0.1:9",
                "api_url": "http://127.0.0.1:9", "website_url": "http://127.0.0.1:9"}))
            with log_path.open("w") as log:
                process = subprocess.Popen([*native, str(executable_dir / "gigahost-desktop")],
                                           env=env, stdout=log, stderr=log)
                deadline = time.monotonic() + 45
                while time.monotonic() < deadline:
                    if process.poll() is not None:
                        raise RuntimeError(f"Packaged app exited at startup ({process.returncode})")
                    if windows.visible(process.pid) and (state / "transactions").is_dir():
                        break
                    time.sleep(0.1)
                else:
                    raise RuntimeError("Installed app window and controller state did not become ready")
                stable_until = time.monotonic() + 3
                while time.monotonic() < stable_until:
                    if process.poll() is not None or not windows.visible(process.pid):
                        raise RuntimeError("Installed app did not remain open after startup")
                    time.sleep(0.1)
                assert not list(home.rglob("*.seed")), "Startup created an account key"
                assert not list((home / "wallets").glob("*")), "Startup created a wallet or selection"
            print(json.dumps({"native_arch": args.native_arch, "target": manifest["target"],
                              "version": version, "window": "visible and stable", "startup_keys": 0}))
        except Exception:
            if log_path.exists():
                print("Disposable packaged-app log:", file=sys.stderr)
                print(log_path.read_text(errors="replace"), file=sys.stderr)
            raise
        finally:
            if process and process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=10)
            if mounted or os.path.ismount(mount):
                run("hdiutil", "detach", str(mount))


if __name__ == "__main__":
    main()
