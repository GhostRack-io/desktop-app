"""Offline publisher regressions: immutable uploads and last-write pointer."""
import hashlib
import http.client
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError, URLError
from urllib.parse import unquote, urlsplit
from urllib.request import BaseHandler, build_opener
from urllib.response import addinfourl
from zipfile import ZipFile

spec = importlib.util.spec_from_file_location("publisher", Path(__file__).parents[1] / "scripts/publish-desktop.py")
publisher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publisher)


class MissingObject(Exception):
    response = {"Error": {"Code": "NoSuchKey"}}


class Storage:
    def __init__(self):
        self.objects = {}
        self.writes = []
        self.fail_key = None
        self.corrupt_key = None

    def get_object(self, *, Bucket, Key):
        if Key not in self.objects:
            raise MissingObject()
        return {"Body": io.BytesIO(self.objects[Key])}

    def put_object(self, *, Bucket, Key, Body, **metadata):
        if Key == self.fail_key:
            raise RuntimeError("Upload failed")
        self.objects[Key] = Body.read() if hasattr(Body, "read") else Body
        if Key == self.corrupt_key:
            self.objects[Key] += b"corrupt"
        self.writes.append(Key)


class HTTPResponse(io.BytesIO):
    def __init__(self, body=b"", status=200):
        super().__init__(body)
        self.status = status


class HTTPStorageFixture:
    def __init__(self):
        self.objects = {}
        self.requests = []
        self.fail_key = None
        self.failure_status = 403

    def open(self, request, timeout):
        self.requests.append(request)
        key = unquote(urlsplit(request.full_url).path).split("/", 2)[2]
        if key == self.fail_key:
            raise HTTPError(request.full_url, self.failure_status, "Failure", {}, io.BytesIO())
        if request.method == "GET":
            if key not in self.objects:
                raise HTTPError(request.full_url, 404, "Missing", {}, io.BytesIO())
            return HTTPResponse(self.objects[key])
        chunks = []
        while chunk := request.data.read(8192):
            chunks.append(chunk)
        self.objects[key] = b"".join(chunks)
        return HTTPResponse(status=201)


class Publishing(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.TemporaryDirectory()
        self.addCleanup(self.root.cleanup)
        self.windows = Path(self.root.name) / "windows"
        self.linux = Path(self.root.name) / "linux"
        self.revision = "a" * 40
        for directory, target in [(self.windows, "x86_64-pc-windows-msvc"), (self.linux, "x86_64-unknown-linux-gnu")]:
            directory.mkdir()
            manifest = {"target": target, "desktop": {"commit": self.revision, "dirty": False}, "ghost": {"commit": publisher.GHOST_REVISION, "dirty": False},
                        "mmxwallet": {"commit": publisher.WALLET_REVISION, "dirty": False}, "sha256": {f"gigahost-{name}-{target}" + ('.exe' if directory == self.windows else ''): hashlib.sha256(name.encode()).hexdigest() for name in ('ghost', 'mmxwallet')}, "version": "0.1.0"}
            if directory == self.windows:
                manifest["version"] = "0.1.0"
                name = "gigahost_0.1.0_windows_x64.zip"
                with ZipFile(directory / name, "w") as archive:
                    archive.writestr("gigahost_0.1.0_x64-setup.exe", b"installer")
                    archive.writestr("build.json", json.dumps(manifest))
                    archive.writestr("install.txt", "Extract and install")
                names = [name]
                sums_name = "sha256sums-windows-x64"
            else:
                names = ["gigahost_0.1.0_amd64.deb", "gigahost_0.1.0_amd64.appimage"]
                for name in names:
                    (directory / name).write_bytes(name.encode())
                sums_name = "sha256sums"
            (directory / "build.json").write_text(json.dumps(manifest))
            (directory / sums_name).write_text("".join(f"{publisher.file_digest(directory / name)}  ./{name}\n" for name in names))
        self.client = Storage()
        self.checked = []

    def test_platform_component_hashes_and_independent_source_pins(self):
        for directory in (self.windows, self.linux):
            path = directory / 'build.json'
            original = json.loads(path.read_text())
            hashes = original['sha256']
            mutations = [
                ('sha256', {}, 'component hashes'),
                ('sha256', {**hashes, 'extra': 'a' * 64}, 'component hashes'),
                ('sha256', {name: 'invalid' for name in hashes}, 'component hashes'),
                ('ghost', {'commit': self.revision, 'dirty': False}, 'clean pinned'),
                ('desktop', {'commit': publisher.GHOST_REVISION, 'dirty': False}, 'clean selected'),
                ('version', '0.2.0', 'package version'),
                ('target', 'wrong-target', 'build target'),
            ]
            for key, value, message in mutations:
                with self.subTest(platform=directory.name, key=key):
                    path.write_text(json.dumps({**original, key: value}))
                    with self.assertRaisesRegex(ValueError, message):
                        self.plan()
                    self.assertEqual(self.client.writes, [])
            path.write_text(json.dumps(original))

    def plan(self):
        return publisher.prepare(self.windows, self.linux, "0.1.0", self.revision, "desktop", "https://cdn.example")

    def publish(self, plan=None):
        uploads, latest, prefix = plan or self.plan()
        publisher.publish(self.client, "apps", "desktop", uploads, latest, prefix,
                          public_check=lambda url, sha: self.checked.append((url, sha)))
        return latest

    def test_both_platforms_and_checksums_are_verified_before_pointer(self):
        (self.windows / "never-publish.exe").write_bytes(b"not uploaded")
        latest = self.publish()
        self.assertEqual(self.client.writes[-1], "desktop/latest.json")
        self.assertEqual(len(self.checked), 7)
        self.assertIn('/latest.json?build=', self.checked[-1][0])
        self.assertEqual(set(latest["downloads"]), {"windows_x64", "linux_x64"})
        self.assertFalse(any(key.endswith(".exe") for key in self.client.objects))
        saved = json.loads(self.client.objects["desktop/latest.json"])
        self.assertEqual(saved, latest)
        for name, record in latest["files"].items():
            key = f"desktop/releases/{latest['build']}/{name}"
            self.assertEqual(hashlib.sha256(self.client.objects[key]).hexdigest(), record["sha256"])

    def test_release_filenames_download_urls_and_windows_zip_contents_are_lowercase(self):
        uploads, latest, prefix = self.plan()
        packages = {
            "windows_x64": ["gigahost_0.1.0_windows_x64.zip"],
            "linux_x64": ["gigahost_0.1.0_amd64.deb", "gigahost_0.1.0_amd64.appimage"],
        }
        if hasattr(self, "macos"):
            packages["macos_universal"] = ["gigahost_0.1.0_macos_universal.dmg"]
        names = {name for files in packages.values() for name in files}
        names.update(f"build-{platform.replace('_', '-')}.json" for platform in packages)
        self.assertEqual(set(uploads), names | {"sha256sums"})
        self.assertEqual(set(latest["files"]), set(uploads))
        self.assertEqual(latest["downloads"], {
            platform: [f"https://cdn.example/{prefix}/{name}" for name in files]
            for platform, files in packages.items()
        })
        self.assertTrue(all(name == name.lower() for name in uploads))
        sums_names = {line.split("  ./")[1] for line in uploads["sha256sums"].decode().splitlines()}
        self.assertEqual(sums_names, names)
        with ZipFile(self.windows / "gigahost_0.1.0_windows_x64.zip") as archive:
            self.assertEqual(sorted(archive.namelist()), [
                "build.json", "gigahost_0.1.0_x64-setup.exe", "install.txt",
            ])

    def test_package_checksum_allowlist_rejects_mixed_case_names(self):
        cases = [
            (self.windows, "sha256sums-windows-x64", "gigahost_0.1.0_windows_x64.zip", "Gigahost_0.1.0_windows_x64.zip"),
            (self.linux, "sha256sums", "gigahost_0.1.0_amd64.deb", "Gigahost_0.1.0_amd64.deb"),
            (self.linux, "sha256sums", "gigahost_0.1.0_amd64.appimage", "gigahost_0.1.0_amd64.AppImage"),
        ]
        if hasattr(self, "macos"):
            cases.append((self.macos, "sha256sums-macos-universal", self.mac_name, "Gigahost_0.1.0_macos_universal.dmg"))
        for directory, sums_name, name, mixed_name in cases:
            with self.subTest(name=mixed_name):
                sums = directory / sums_name
                original = sums.read_text()
                try:
                    sums.write_text(original.replace(name, mixed_name))
                    with self.assertRaisesRegex(ValueError, "exactly its expected packages"):
                        self.publish()
                    self.assertEqual(self.client.writes, [])
                finally:
                    sums.write_text(original)

    def test_windows_zip_rejects_mixed_case_installer_and_metadata_names(self):
        package = self.windows / "gigahost_0.1.0_windows_x64.zip"
        with ZipFile(package) as archive:
            contents = {name: archive.read(name) for name in archive.namelist()}
        cases = {
            "gigahost_0.1.0_x64-setup.exe": "Gigahost_0.1.0_x64-setup.exe",
            "build.json": "BUILD.json",
            "install.txt": "INSTALL.txt",
        }
        for name, mixed_name in cases.items():
            with self.subTest(name=mixed_name):
                with ZipFile(package, "w") as archive:
                    for entry, data in contents.items():
                        archive.writestr(mixed_name if entry == name else entry, data)
                (self.windows / "sha256sums-windows-x64").write_text(
                    f"{publisher.file_digest(package)}  ./{package.name}\n")
                with self.assertRaisesRegex(ValueError, "Windows ZIP contents differ"):
                    self.publish()
                self.assertEqual(self.client.writes, [])

    def test_partial_upload_and_failed_verification_leave_previous_pointer(self):
        plan = self.plan()
        for failure in ["upload", "stored-bytes", "public-download"]:
            with self.subTest(failure=failure):
                self.client = Storage()
                self.client.objects["desktop/latest.json"] = b"previous"
                key = f"{plan[2]}/gigahost_0.1.0_amd64.deb"
                if failure == "upload":
                    self.client.fail_key = key
                elif failure == "stored-bytes":
                    self.client.corrupt_key = key
                def check(url, sha):
                    if failure == "public-download":
                        raise ValueError("CDN unavailable")
                with self.assertRaises((RuntimeError, ValueError)):
                    publisher.publish(self.client, "apps", "desktop", *plan[:2], plan[2], public_check=check)
                self.assertEqual(self.client.objects["desktop/latest.json"], b"previous")

    def test_immutable_conflict_is_rejected_before_any_upload(self):
        plan = self.plan()
        self.client.objects[f"{plan[2]}/build-linux-x64.json"] = b"older bytes"
        with self.assertRaisesRegex(ValueError, "Immutable build"):
            self.publish(plan)
        self.assertEqual(self.client.writes, [])

    def test_identical_rerun_only_updates_the_pointer(self):
        plan = self.plan()
        self.publish(plan)
        self.client.writes.clear()
        self.publish(plan)
        self.assertEqual(self.client.writes, ["desktop/latest.json"])

    def test_incomplete_tampered_and_dirty_packages_are_rejected(self):
        original = (self.windows / "gigahost_0.1.0_windows_x64.zip").read_bytes()
        (self.windows / "gigahost_0.1.0_windows_x64.zip").write_bytes(b"tampered")
        with self.assertRaisesRegex(ValueError, "checksum mismatch"):
            self.plan()
        (self.windows / "gigahost_0.1.0_windows_x64.zip").write_bytes(original)
        manifest = json.loads((self.linux / "build.json").read_text())
        manifest["desktop"]["dirty"] = True
        (self.linux / "build.json").write_text(json.dumps(manifest))
        with self.assertRaisesRegex(ValueError, "clean selected source revision"):
            self.publish()
        self.assertEqual(self.client.writes, [])

    def test_http_upload_failure_leaves_previous_pointer(self):
        plan = self.plan()
        fixture = HTTPStorageFixture()
        fixture.objects["desktop/latest.json"] = b"previous"
        client = publisher.BunnyHTTPStorage("https://sg.storage.bunnycdn.com", "test-password")
        client.opener = fixture
        uploads, latest, prefix = plan
        key = f"{prefix}/gigahost_0.1.0_amd64.deb"
        # Preflight must succeed, then the package PUT fails permanently.
        original_open = fixture.open
        def fail_put(request, timeout):
            if request.method == "PUT" and request.full_url.endswith(".deb"):
                fixture.fail_key = key
            return original_open(request, timeout)
        with patch.object(fixture, "open", side_effect=fail_put):
            with self.assertRaises(publisher.StorageHTTPError):
                publisher.publish(client, "apps", "desktop", uploads, latest, prefix,
                                  public_check=lambda url, sha: None)
        self.assertEqual(fixture.objects["desktop/latest.json"], b"previous")
        self.assertFalse(any(request.method == "PUT" and request.full_url.endswith("/latest.json")
                             for request in fixture.requests))

    def test_http_publish_verifies_all_objects_and_reruns_only_update_pointer(self):
        fixture = HTTPStorageFixture()
        client = publisher.BunnyHTTPStorage("https://sg.storage.bunnycdn.com", "test-password")
        client.opener = fixture
        uploads, latest, prefix = self.plan()
        for _ in range(2):
            fixture.requests.clear()
            self.checked.clear()
            publisher.publish(client, "apps", "desktop", uploads, latest, prefix,
                              public_check=lambda url, sha: self.checked.append((url, sha)))
            writes = [request for request in fixture.requests if request.method == "PUT"]
            self.assertTrue(writes[-1].full_url.endswith("/desktop/latest.json"))
            self.assertEqual(len(self.checked), len(uploads) + 1)
        self.assertEqual(len(writes), 1)
        self.assertEqual(json.loads(fixture.objects["desktop/latest.json"]), latest)
        for name, record in latest["files"].items():
            self.assertEqual(hashlib.sha256(fixture.objects[f"{prefix}/{name}"]).hexdigest(), record["sha256"])


class MacPublishing(Publishing):
    """Run the storage/HTTP regressions again with the complete release set."""

    def setUp(self):
        super().setUp()
        self.macos = Path(self.root.name) / "macos"
        self.macos.mkdir()
        self.mac_name = "gigahost_0.1.0_macos_universal.dmg"
        self.mac_manifest = {
            "target": "universal-apple-darwin", "version": "0.1.0",
            "desktop": {"commit": self.revision, "dirty": False}, "ghost": {"commit": publisher.GHOST_REVISION, "dirty": False},
            "mmxwallet": {"commit": publisher.WALLET_REVISION, "dirty": False},
            "architectures": {name: ["arm64", "x86_64"] for name in
                              ("gigahost-desktop", "gigahost-ghost", "gigahost-mmxwallet")},
            "sha256": {name: "b" * 64 for name in
                       ("gigahost-desktop", "gigahost-ghost", "gigahost-mmxwallet")},
            "minimum_macos": "11.0", "signing": "adhoc", "notarized": False,
        }
        (self.macos / self.mac_name).write_bytes(b"DMG verified by native macOS CI")
        self.save_manifest(self.mac_manifest)
        self.save_sums()

    def save_manifest(self, manifest):
        (self.macos / "build.json").write_text(json.dumps(manifest))

    def save_sums(self):
        checksum = publisher.file_digest(self.macos / self.mac_name)
        (self.macos / "sha256sums-macos-universal").write_text(f"{checksum}  ./{self.mac_name}\n")

    def plan(self):
        return publisher.prepare(self.windows, self.linux, "0.1.0", self.revision, "desktop",
                                 "https://cdn.example", macos=self.macos)

    def test_both_platforms_and_checksums_are_verified_before_pointer(self):
        (self.macos / "never-publish.app").write_bytes(b"not uploaded")
        old_plan = publisher.prepare(self.windows, self.linux, "0.1.0", self.revision,
                                     "desktop", "https://cdn.example")
        latest = self.publish()
        self.assertEqual(set(latest["downloads"]), {"windows_x64", "linux_x64", "macos_universal"})
        self.assertIn(self.mac_name, latest["files"])
        self.assertIn("build-macos-universal.json", latest["files"])
        self.assertNotEqual(latest["build"], old_plan[1]["build"])
        self.assertEqual(len(self.checked), 9)
        self.assertEqual(self.client.writes[-1], "desktop/latest.json")
        self.assertFalse(any(key.endswith(".app") for key in self.client.objects))
        sums = self.client.objects[f"desktop/releases/{latest['build']}/sha256sums"].decode()
        self.assertIn(self.mac_name, sums)
        self.assertIn("build-macos-universal.json", sums)

    def test_invalid_mac_provenance_and_architectures_prevent_all_writes(self):
        mutations = [
            ("target", "aarch64-apple-darwin", "build target"),
            ("version", "0.2.0", "package version"),
            ("desktop", {"commit": self.revision, "dirty": True}, "clean selected"),
            ("ghost", {"commit": "c" * 40, "dirty": False}, "clean pinned"),
            ("mmxwallet", {"commit": publisher.WALLET_REVISION, "dirty": True}, "clean pinned"),
            ("mmxwallet", {"commit": "c" * 40, "dirty": False}, "clean pinned"),
            ("architectures", {"gigahost-desktop": ["arm64"]}, "architecture metadata"),
            ("architectures", {name: ["arm64"] for name in self.mac_manifest["architectures"]}, "architecture metadata"),
            ("sha256", {"gigahost-desktop": "invalid"}, "component hashes"),
            ("minimum_macos", "12.0", "compatibility/signing"),
            ("signing", "unsigned", "compatibility/signing"),
            ("notarized", True, "compatibility/signing"),
        ]
        for key, value, message in mutations:
            with self.subTest(key=key, value=value):
                self.save_manifest({**self.mac_manifest, key: value})
                with self.assertRaisesRegex(ValueError, message):
                    self.publish()
                self.assertEqual(self.client.writes, [])
        self.save_manifest(self.mac_manifest)

    def test_missing_tampered_extra_checksums_and_symlink_mac_packages(self):
        package = self.macos / self.mac_name
        original = package.read_bytes()
        package.write_bytes(b"tampered")
        with self.assertRaisesRegex(ValueError, "checksum mismatch"):
            self.publish()
        package.unlink()
        with self.assertRaisesRegex(ValueError, "Missing or invalid"):
            self.publish()
        target = self.macos / "other.dmg"
        target.write_bytes(original)
        package.symlink_to(target.name)
        with self.assertRaisesRegex(ValueError, "Missing or invalid"):
            self.publish()
        package.unlink()
        package.write_bytes(original)
        with (self.macos / "sha256sums-macos-universal").open("a") as stream:
            stream.write(f"{'b' * 64}  ./other.dmg\n")
        with self.assertRaisesRegex(ValueError, "exactly its expected packages"):
            self.publish()
        self.assertEqual(self.client.writes, [])

    def test_mac_upload_storage_and_public_failures_preserve_previous_pointer(self):
        uploads, latest, prefix = self.plan()
        for failure in ("upload", "stored-bytes", "public-download"):
            with self.subTest(failure=failure):
                client = Storage()
                client.objects["desktop/latest.json"] = b"previous"
                key = f"{prefix}/{self.mac_name}"
                if failure == "upload":
                    client.fail_key = key
                elif failure == "stored-bytes":
                    client.corrupt_key = key
                def check(url, sha):
                    if failure == "public-download" and url.endswith(".dmg"):
                        raise ValueError("Mac CDN unavailable")
                with self.assertRaises((RuntimeError, ValueError)):
                    publisher.publish(client, "apps", "desktop", uploads, latest, prefix, public_check=check)
                self.assertEqual(client.objects["desktop/latest.json"], b"previous")
                self.assertNotIn("desktop/latest.json", client.writes)


class HTTPTransport(unittest.TestCase):
    def setUp(self):
        self.client = publisher.BunnyHTTPStorage("https://sg.storage.bunnycdn.com", "test-password")
        self.fixture = HTTPStorageFixture()
        self.client.opener = self.fixture

    def test_missing_and_existing_object_digests(self):
        self.assertIsNone(publisher.existing_digest(self.client, "apps", "desktop/missing.zip"))
        self.fixture.objects["desktop/present.zip"] = b"package"
        self.assertEqual(publisher.existing_digest(self.client, "apps", "desktop/present.zip"),
                         hashlib.sha256(b"package").hexdigest())
        self.fixture.fail_key = "desktop/forbidden.zip"
        with self.assertRaises(publisher.StorageHTTPError) as result:
            publisher.existing_digest(self.client, "apps", self.fixture.fail_key)
        self.assertEqual(result.exception.response["Error"]["Code"], "403")
        self.assertTrue(all(request.get_header("Accesskey") == "test-password"
                            for request in self.fixture.requests))

    def test_put_streams_raw_payload_and_metadata_through_urllib(self):
        connections = []
        class Socket:
            def __init__(self):
                self.sent = []
            def sendall(self, data):
                self.sent.append(bytes(data))
            def makefile(self, mode):
                return io.BytesIO(b"HTTP/1.1 201 Created\r\nContent-Length: 0\r\n\r\n")
            def close(self):
                pass
        class Connection(http.client.HTTPConnection):
            def __init__(self, host, *, timeout, context=None, check_hostname=None):
                super().__init__(host, timeout=timeout)
                self.captured_socket = Socket()
                connections.append(self)
            def connect(self):
                self.sock = self.captured_socket
        class BoundedStream(io.BytesIO):
            def read(self, size=-1):
                if size < 0 or size > 8192:
                    raise AssertionError("Upload performed an unbounded read")
                return super().read(size)
        payload = b"\x00\xffraw-package" * 10000
        body = BoundedStream(b"ignored" + payload)
        body.seek(len(b"ignored"))
        # Exercise urllib/http.client's real file streaming without any socket.
        with patch.dict(os.environ, {}, clear=True), patch.object(http.client, "HTTPSConnection", Connection):
            self.client.opener = build_opener(publisher.NoStorageRedirects())
            self.client.put_object(Bucket="apps", Key="desktop/file #1.zip", Body=body,
                                   ContentType="application/zip", CacheControl="public, immutable")
        self.assertEqual(len(connections), 1)
        connection = connections[0]
        self.assertEqual(connection.host, "sg.storage.bunnycdn.com")
        headers, uploaded = b"".join(connection.captured_socket.sent).split(b"\r\n\r\n", 1)
        self.assertEqual(uploaded, payload)
        self.assertIn(b"PUT /apps/desktop/file%20%231.zip HTTP/1.1", headers)
        self.assertIn(f"Content-Length: {len(payload)}".encode(), headers)
        self.assertIn(b"Content-Type: application/zip", headers)
        self.assertIn(b"Cache-Control: public, immutable", headers)
        self.assertIn(b"Accesskey: test-password", headers)

    def test_redirect_never_forwards_credentials(self):
        requests = []
        class Redirect(BaseHandler):
            handler_order = 100
            def https_open(self, request):
                requests.append(request)
                response = addinfourl(io.BytesIO(), {"Location": "https://attacker.example/stolen"},
                                      request.full_url, 302)
                response.msg = "Found"
                return response
        self.client.opener = build_opener(publisher.NoStorageRedirects(), Redirect())
        with self.assertRaises(publisher.StorageHTTPError) as result:
            self.client.get_object(Bucket="apps", Key="desktop/package.zip")
        self.assertEqual(result.exception.response["Error"]["Code"], "302")
        self.assertEqual(len(requests), 1)
        self.assertEqual(urlsplit(requests[0].full_url).hostname, "sg.storage.bunnycdn.com")
        self.assertEqual(requests[0].get_header("Accesskey"), "test-password")

    def test_retries_rewind_upload_and_stop_after_four_attempts(self):
        payloads = []
        def fail_then_succeed(request, timeout):
            payloads.append(request.data.read())
            if len(payloads) < 3:
                raise URLError("connection interrupted")
            return HTTPResponse(status=201)
        with patch.object(self.fixture, "open", side_effect=fail_then_succeed), patch.object(publisher.time, "sleep"):
            self.client.put_object(Bucket="apps", Key="desktop/package.zip", Body=io.BytesIO(b"same bytes"),
                                   ContentType="application/zip", CacheControl="public, immutable")
        self.assertEqual(payloads, [b"same bytes"] * 3)
        self.fixture.fail_key = "desktop/package.zip"
        self.fixture.failure_status = 503
        with patch.object(publisher.time, "sleep"), self.assertRaises(publisher.StorageHTTPError):
            self.client.put_object(Bucket="apps", Key=self.fixture.fail_key, Body=b"bytes",
                                   ContentType="application/zip", CacheControl="public, immutable")
        self.assertEqual(len(self.fixture.requests), publisher.MAX_ATTEMPTS)

    def test_invalid_endpoint_zone_and_object_path_are_rejected_before_requests(self):
        for endpoint in ["http://sg.storage.bunnycdn.com", "https://attacker.example",
                         "https://sg-s3.storage.bunnycdn.com", "https://sg.storage.bunnycdn.com/path",
                         "https://user:password@sg.storage.bunnycdn.com", "https://sg.storage.bunnycdn.com:444"]:
            with self.subTest(endpoint=endpoint), self.assertRaises(ValueError):
                publisher.BunnyHTTPStorage(endpoint, "test-password")
        for bucket, key in [("apps/other", "desktop/file.zip"), ("..", "desktop/file.zip"),
                            ("apps", "../file.zip"), ("apps", "/desktop/file.zip"),
                            ("apps", "desktop//file.zip")]:
            with self.subTest(bucket=bucket, key=key), self.assertRaises(ValueError):
                self.client.get_object(Bucket=bucket, Key=key)
        self.assertEqual(self.fixture.requests, [])

    def test_http_selection_uses_its_endpoint_and_password_without_s3_id(self):
        with patch.dict(os.environ, {"DESKTOP_S3_ENDPOINT": "https://sg-s3.storage.bunnycdn.com",
                                     "DESKTOP_STORAGE_PASSWORD": "http-password"}, clear=True):
            client = publisher.create_client("bunny-http", None, "sg")
        self.assertEqual(client.endpoint, "https://sg.storage.bunnycdn.com")
        self.assertEqual(client.password, "http-password")
        with patch.dict(os.environ, {"AWS_SECRET_ACCESS_KEY": "shared-password"}, clear=True):
            client = publisher.create_client("bunny-http", None, "sg")
        self.assertEqual(client.password, "shared-password")
        with patch.dict(os.environ, {"DESKTOP_STORAGE_PASSWORD": "http-password"}, clear=True):
            with self.assertRaisesRegex(ValueError, "AWS_ACCESS_KEY_ID"):
                publisher.create_client("s3", None, "sg")

    def test_cli_defaults_to_s3_and_accepts_explicit_http_selection(self):
        argv = ["publish-desktop.py", "--windows-dir", "windows", "--linux-dir", "linux",
                "--version", "0.1.0", "--revision", "a" * 40]
        for environment, expected in [({}, "s3"), ({"DESKTOP_UPLOAD_TRANSPORT": "bunny-http"}, "bunny-http")]:
            with patch.dict(os.environ, environment, clear=True), patch.object(publisher.sys, "argv", argv), \
                    patch.object(publisher, "prepare", return_value=({}, {}, "release")), \
                    patch.object(publisher, "create_client") as factory, patch.object(publisher, "publish"):
                publisher.main()
                factory.assert_called_once_with(expected, None, "sg")

    def test_cli_passes_optional_mac_platform_to_validation(self):
        argv = ["publish-desktop.py", "--windows-dir", "windows", "--linux-dir", "linux",
                "--macos-dir", "macos", "--version", "0.1.0", "--revision", "a" * 40]
        with patch.dict(os.environ, {}, clear=True), patch.object(publisher.sys, "argv", argv), \
                patch.object(publisher, "prepare", return_value=({}, {}, "release")) as prepare, \
                patch.object(publisher, "create_client"), patch.object(publisher, "publish"):
            publisher.main()
        self.assertEqual(prepare.call_args.kwargs, {"macos": Path("macos")})

    def test_public_verification_retries_without_storage_credentials(self):
        url = "https://cdn.example/desktop/latest.json?build=version"
        expected = hashlib.sha256(b"latest").hexdigest()
        missing = HTTPError(url, 404, "Not yet replicated", {}, io.BytesIO())
        with patch.object(publisher, "urlopen", side_effect=[missing, HTTPResponse(b"stale"), HTTPResponse(b"latest")]) as fetch, \
                patch.object(publisher.time, "sleep"):
            publisher.verify_public(url, expected)
        self.assertEqual(fetch.call_count, 3)
        for call in fetch.call_args_list:
            self.assertEqual(call.args[0].full_url, url)
            self.assertIsNone(call.args[0].get_header("Accesskey"))
        with patch.object(publisher, "urlopen", side_effect=lambda *args, **kwargs: HTTPResponse(b"stale")) as fetch, \
                patch.object(publisher.time, "sleep"), self.assertRaisesRegex(ValueError, "checksum mismatch"):
            publisher.verify_public(url, expected)
        self.assertEqual(fetch.call_count, publisher.MAX_ATTEMPTS)


if __name__ == "__main__":
    unittest.main()
