#!/usr/bin/env python3
"""Inspect the final macOS bundle, including every shipped Mach-O slice."""
import hashlib
import plistlib
from pathlib import Path
import re
import subprocess

COMPONENTS = ("ghostrack-desktop", "ghostrack-ghost", "ghostrack-mmxwallet")
ARCHITECTURES = ["arm64", "x86_64"]
MINIMUM_MACOS = "11.0"


def output(*args):
    return subprocess.check_output(args, text=True, stderr=subprocess.STDOUT, timeout=60)


def check_deployment_minimum(commands, identity):
    versions, deployment_commands, invalid = [], [], []
    for command in re.split(r"(?m)^Load command[ \t]+", commands)[1:]:
        kind = re.search(r"(?m)^[ \t]*cmd[ \t]+(LC_BUILD_VERSION|LC_VERSION_MIN_MACOSX)\b", command)
        if not kind:
            continue
        kind = kind.group(1)
        deployment_commands.append("Load command " + command.rstrip())
        # Build-tool `version` records share LC_BUILD_VERSION with `minos`.
        # Only the legacy LC_VERSION_MIN_MACOSX uses `version` for the OS.
        field = "minos" if kind == "LC_BUILD_VERSION" else "version"
        values = re.findall(rf"(?m)^[ \t]*{field}\b([^\r\n]*)", command)
        if len(values) != 1 or not re.fullmatch(r"[ \t]+[0-9]+\.[0-9]+(?:\.[0-9]+)?[ \t]*", values[0]):
            invalid.append(f"{kind} {field}={values!r}")
            continue
        versions.append((kind, field, values[0].strip()))
    found = ", ".join(f"{kind} {field}={value}" for kind, field, value in versions) or "none"
    raw = "\n".join(deployment_commands) or "(no macOS deployment load command)"
    details = f"found {found}; configured baseline {MINIMUM_MACOS}; deployment load commands:\n{raw}"
    if invalid or not versions:
        reason = "; ".join(invalid) or "no macOS deployment minimum"
        raise ValueError(f"{identity} has a missing or malformed macOS deployment minimum: {reason}; {details}")
    baseline = tuple(map(int, MINIMUM_MACOS.split(".")))
    baseline += (0,) * (3 - len(baseline))
    for _, _, value in versions:
        parts = tuple(map(int, value.split(".")))
        if parts + (0,) * (3 - len(parts)) > baseline:
            raise ValueError(f"{identity} requires a macOS version newer than {MINIMUM_MACOS}: {details}")


def inspect(app, version):
    app = Path(app)
    info = plistlib.loads((app / "Contents/Info.plist").read_bytes())
    for key, value in {"CFBundleIdentifier": "io.ghostrack.desktop",
                       "CFBundleExecutable": "ghostrack-desktop",
                       "CFBundleShortVersionString": version,
                       "CFBundleVersion": version,
                       "LSMinimumSystemVersion": MINIMUM_MACOS}.items():
        if info.get(key) != value:
            raise ValueError(f"Incorrect macOS app metadata: {key}")
    schemes = {scheme for entry in info.get("CFBundleURLTypes", [])
               for scheme in entry.get("CFBundleURLSchemes", [])}
    if schemes != {"ghostrack"}:
        raise ValueError("Missing GhostRack approval-link scheme")
    icon = info.get("CFBundleIconFile", "")
    if not icon or not (app / "Contents/Resources" / icon).is_file():
        raise ValueError("Missing macOS app icon")
    if not (app / "Contents/Resources/install.txt").is_file():
        raise ValueError("Missing macOS preview installation instructions")
    output("codesign", "--verify", "--deep", "--strict", str(app))
    hashes, architectures = {}, {}
    for name in COMPONENTS:
        executable = app / "Contents/MacOS" / name
        if not executable.is_file() or executable.is_symlink():
            raise ValueError(f"Missing bundled executable: {name}")
        slices = sorted(output("lipo", "-archs", str(executable)).split())
        if slices != ARCHITECTURES:
            raise ValueError(f"{name} must contain exactly Apple Silicon and Intel slices")
        architectures[name] = slices
        hashes[name] = hashlib.sha256(executable.read_bytes()).hexdigest()
        for arch in slices:
            signature = output("codesign", "-d", "--verbose=4", "--arch", arch, str(executable))
            if "Signature=adhoc" not in signature:
                raise ValueError(f"{name}/{arch} is not the expected ad-hoc signed preview")
            libraries = output("otool", "-arch", arch, "-L", str(executable))
            for line in libraries.splitlines():
                if line.startswith("\t"):
                    library = line.strip().split(" (", 1)[0]
                    if not library.startswith(("/usr/lib/", "/System/Library/")):
                        raise ValueError(f"{name}/{arch} links an unbundled non-system library: {library}")
            commands = output("otool", "-arch", arch, "-l", str(executable))
            check_deployment_minimum(commands, f"{name}/{arch}")
            for path in re.findall(r"\bpath (\S+) \(offset", commands):
                if path.startswith("/") and not path.startswith(("/usr/lib/", "/System/Library/")):
                    raise ValueError(f"{name}/{arch} contains a build-machine runtime search path")
    return {"sha256": hashes, "architectures": architectures}
