"""Offline bundle-inspection regressions; native DMG/window checks run on Macs."""
import importlib.util
from pathlib import Path
import plistlib
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("macos_bundle", Path(__file__).parents[1] / "scripts/macos-bundle.py")
bundle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bundle)


class BundleInspection(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.TemporaryDirectory()
        self.addCleanup(self.root.cleanup)
        self.app = Path(self.root.name) / "GhostRack.app"
        self.contents = self.app / "Contents"
        (self.contents / "MacOS").mkdir(parents=True)
        (self.contents / "Resources").mkdir()
        for name in bundle.COMPONENTS:
            (self.contents / "MacOS" / name).write_bytes(name.encode())
        for name in ("icon.icns", "install.txt"):
            (self.contents / "Resources" / name).write_bytes(b"resource")
        self.info = {"CFBundleIdentifier": "io.ghostrack.desktop",
                     "CFBundleExecutable": "ghostrack-desktop",
                     "CFBundleShortVersionString": "0.1.0", "CFBundleVersion": "0.1.0",
                     "LSMinimumSystemVersion": "11.0", "CFBundleIconFile": "icon.icns",
                     "CFBundleURLTypes": [{"CFBundleURLSchemes": ["ghostrack"]}]}
        (self.contents / "Info.plist").write_bytes(plistlib.dumps(self.info))
        self.architectures = "x86_64 arm64\n"
        self.libraries = "binary:\n\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1345.0.0)\n"
        self.commands = """Load command 0
               cmd LC_LOAD_DYLIB
              name /usr/lib/libSystem.B.dylib (offset 24)
           current version 1345.0.0
     compatibility version 1.0.0
Load command 1
      cmd LC_BUILD_VERSION
  cmdsize 32
 platform 1
    minos 11.0
      sdk 14.5
   ntools 1
     tool 3
  version 1115.7.3
Load command 2
      cmd LC_SOURCE_VERSION
  version 2000.0
"""
        self.signature = "Signature=adhoc\n"
        patcher = patch.object(bundle, "output", side_effect=self.output)
        patcher.start()
        self.addCleanup(patcher.stop)

    def output(self, *args):
        if args[0] == "lipo":
            return self.architectures
        if args[:2] == ("codesign", "-d"):
            return self.signature
        if args[0] == "otool":
            return self.libraries if "-L" in args else self.commands
        return ""

    def test_dependency_sdk_source_and_build_tool_versions_are_not_deployment_minima(self):
        # Apple's otool emits build-tool `version` within LC_BUILD_VERSION:
        # https://github.com/apple-oss-distributions/cctools/blob/main/otool/ofile_print.c
        record = bundle.inspect(self.app, "0.1.0")
        self.assertEqual(set(record["sha256"]), set(bundle.COMPONENTS))
        self.assertEqual(record["architectures"], {name: ["arm64", "x86_64"] for name in bundle.COMPONENTS})
        self.commands = "Load command 0\n cmd LC_VERSION_MIN_MACOSX\n version 11.0\n sdk 14.5\n"
        self.assertEqual(bundle.inspect(self.app, "0.1.0"), record)

    def test_whitespace_and_zero_patch_versions_are_normalized(self):
        for kind, field in [("LC_BUILD_VERSION", "minos"), ("LC_VERSION_MIN_MACOSX", "version")]:
            for separator in ["  ", "\t", " \t "]:
                for value in ["10.15.7", "11.0", "11.0.0"]:
                    with self.subTest(kind=kind, separator=separator, value=value):
                        self.commands = (f"Load command{separator}0\n\tcmd{separator}{kind}\n"
                                         f"\t{field}{separator}{value} \t\n\tsdk{separator}14.5\n")
                        bundle.inspect(self.app, "0.1.0")

    def test_missing_malformed_and_duplicate_minima_are_rejected_with_diagnostics(self):
        for kind, field in [("LC_BUILD_VERSION", "minos"), ("LC_VERSION_MIN_MACOSX", "version")]:
            for value in ["n/a", "", "11", "11.0garbage", "11.0.1.2", "11.0 extra"]:
                with self.subTest(kind=kind, value=value):
                    self.commands = f"Load command 0\n cmd {kind}\n {field} {value}\n sdk 14.5\n"
                    with self.assertRaisesRegex(ValueError, "missing or malformed") as error:
                        bundle.inspect(self.app, "0.1.0")
                    self.assertIn("ghostrack-desktop/arm64", str(error.exception))
                    self.assertIn("configured baseline 11.0", str(error.exception))
                    self.assertIn(self.commands.rstrip(), str(error.exception))
            for fields in ["", f" {field} 11.0\n {field} 11.0\n"]:
                with self.subTest(kind=kind, fields=fields):
                    # A second valid record must not hide the broken first one.
                    self.commands = (f"Load command 0\n cmd {kind}\n{fields} sdk 14.5\n"
                                     "Load command 1\n cmd LC_BUILD_VERSION\n minos 11.0\n")
                    with self.assertRaisesRegex(ValueError, "missing or malformed"):
                        bundle.inspect(self.app, "0.1.0")
        self.commands = "Load command 0\n cmd LC_BUILD_VERSION\n tool 3\n version 1115.7.3\n"
        with self.assertRaisesRegex(ValueError, "missing or malformed"):
            bundle.inspect(self.app, "0.1.0")
        self.commands = "Load command 0\n cmd LC_SOURCE_VERSION\n version 11.0\n"
        with self.assertRaisesRegex(ValueError, "found none"):
            bundle.inspect(self.app, "0.1.0")

    def test_newer_minima_show_actual_values_and_raw_load_commands(self):
        for kind, field in [("LC_BUILD_VERSION", "minos"), ("LC_VERSION_MIN_MACOSX", "version")]:
            for value in ["11.0.1", "11.1", "12.0"]:
                with self.subTest(kind=kind, value=value):
                    self.commands = ("Load command 0\n cmd LC_BUILD_VERSION\n minos 11.0\n"
                                     f"Load command 1\n cmd {kind}\n {field} {value}\n sdk 14.5\n")
                    with self.assertRaisesRegex(ValueError, "newer than 11.0") as error:
                        bundle.inspect(self.app, "0.1.0")
                    self.assertIn(f"{kind} {field}={value}", str(error.exception))
                    self.assertIn("LC_BUILD_VERSION minos=11.0", str(error.exception))
                    self.assertIn(self.commands.rstrip(), str(error.exception))

    def test_every_component_slice_requires_a_compatible_minimum(self):
        original_output = self.output
        for name in bundle.COMPONENTS:
            for arch in bundle.ARCHITECTURES:
                with self.subTest(name=name, arch=arch):
                    def output(*args):
                        if (args[:2] == ("otool", "-arch") and "-l" in args
                                and args[2] == arch and Path(args[-1]).name == name):
                            return self.commands.replace("minos 11.0", "minos 12.0")
                        return original_output(*args)
                    with patch.object(bundle, "output", side_effect=output):
                        with self.assertRaisesRegex(ValueError, f"{name}/{arch} requires"):
                            bundle.inspect(self.app, "0.1.0")

    def test_missing_slice_and_non_system_dependencies_are_rejected(self):
        self.architectures = "arm64\n"
        with self.assertRaisesRegex(ValueError, "exactly Apple Silicon and Intel"):
            bundle.inspect(self.app, "0.1.0")
        self.architectures = "arm64 x86_64\n"
        self.libraries += "\t/opt/homebrew/lib/libexample.dylib (compatibility version 1.0.0)\n"
        with self.assertRaisesRegex(ValueError, "non-system library"):
            bundle.inspect(self.app, "0.1.0")

    def test_newer_minimum_rpath_and_missing_ad_hoc_signature_are_rejected(self):
        self.commands = self.commands.replace("minos 11.0", "minos 12.0")
        with self.assertRaisesRegex(ValueError, "newer than 11.0"):
            bundle.inspect(self.app, "0.1.0")
        self.commands = self.commands.replace("minos 12.0", "minos 11.0")
        self.commands += "Load command 2\n cmd LC_RPATH\n path /Users/builder/lib (offset 12)\n"
        with self.assertRaisesRegex(ValueError, "build-machine runtime"):
            bundle.inspect(self.app, "0.1.0")
        self.signature = "Signature=Developer ID\n"
        with self.assertRaisesRegex(ValueError, "ad-hoc signed preview"):
            bundle.inspect(self.app, "0.1.0")

    def test_app_identity_version_icon_and_link_scheme_are_required(self):
        for key, value in [("CFBundleIdentifier", "wrong.app"),
                           ("CFBundleVersion", "0.2.0"),
                           ("CFBundleIconFile", "missing.icns"),
                           ("CFBundleURLTypes", [])]:
            with self.subTest(key=key):
                (self.contents / "Info.plist").write_bytes(plistlib.dumps({**self.info, key: value}))
                with self.assertRaises(ValueError):
                    bundle.inspect(self.app, "0.1.0")
