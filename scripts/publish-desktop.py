#!/usr/bin/env python3
"""Publish verified desktop packages via an explicit storage transport; advance the CDN pointer last."""
import argparse
import hashlib
from http.client import HTTPException
import io
import json
import os
from pathlib import Path
import re
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener, urlopen
from zipfile import ZipFile


import importlib.util
_support_spec = importlib.util.spec_from_file_location('build_support', Path(__file__).with_name('build-support.py'))
_support = importlib.util.module_from_spec(_support_spec)
_support_spec.loader.exec_module(_support)
DEPENDENCIES = _support.pins()
WALLET_REVISION = DEPENDENCIES['mmxwallet']['revision']
GHOST_REVISION = DEPENDENCIES['ghost']['revision']
RETRY_STATUSES = {408, 429, 500, 502, 503, 504}
MAX_ATTEMPTS = 4


def digest(stream):
    value = hashlib.sha256()
    while chunk := stream.read(1024 * 1024):
        value.update(chunk)
    return value.hexdigest()


def file_digest(path):
    with path.open("rb") as stream:
        return digest(stream)


def json_bytes(value):
    return (json.dumps(value, indent=2, sort_keys=True) + "\n").encode()


def validate_url(url, name):
    parsed = urlsplit(url)
    if (parsed.scheme != "https" or not parsed.netloc or parsed.username or
            parsed.password or parsed.query or parsed.fragment):
        raise ValueError(f"{name} must be an HTTPS URL without credentials, query, or fragment")
    return url.rstrip("/")


class StorageHTTPError(Exception):
    def __init__(self, status):
        # Preserve the missing-object convention used by the S3 publisher, but
        # never retain response bodies or request headers containing secrets.
        self.response = {"Error": {"Code": str(status)}}
        super().__init__(f"Storage API request failed (HTTP {status})")


class NoStorageRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # AccessKey must never be forwarded to a redirect destination.
        return None


class BunnyHTTPStorage:
    """Small S3-compatible get/put adapter for Bunny's HTTP Storage API."""

    def __init__(self, endpoint, password):
        self.endpoint = validate_url(endpoint, "Bunny HTTP endpoint")
        parsed = urlsplit(self.endpoint)
        if (parsed.path or parsed.port not in (None, 443) or
                not re.fullmatch(r"(?:[a-z]{2,3}\.)?storage\.bunnycdn\.com", parsed.hostname or "")):
            raise ValueError("Bunny HTTP endpoint must be a regional Bunny Storage HTTPS origin")
        if not password or "\r" in password or "\n" in password:
            raise ValueError("Set a valid DESKTOP_STORAGE_PASSWORD outside Git")
        self.password = password
        self.opener = build_opener(NoStorageRedirects())

    def object_url(self, bucket, key):
        if not re.fullmatch(r"[A-Za-z0-9_-]+", bucket):
            raise ValueError("Storage zone must be a single safe path component")
        parts = key.split("/")
        if any(part in ("", ".", "..") for part in parts):
            raise ValueError("Invalid storage object path")
        return f"{self.endpoint}/{bucket}/" + "/".join(quote(part, safe="") for part in parts)

    def request(self, method, bucket, key, body=None, headers=None):
        url = self.object_url(bucket, key)
        headers = {**(headers or {}), "AccessKey": self.password, "Accept-Encoding": "identity"}
        start = body.tell() if body is not None else None
        for attempt in range(MAX_ATTEMPTS):
            if body is not None:
                body.seek(start)
            try:
                # urllib streams file-like data in bounded chunks when an
                # explicit Content-Length is present. Redirects are disabled.
                response = self.opener.open(Request(url, data=body, headers=headers, method=method), timeout=120)
                if 200 <= response.status < 300:
                    return response
                status = response.status
                response.close()
                raise StorageHTTPError(status)
            except HTTPError as error:
                status = error.code
                error.close()
                if status not in RETRY_STATUSES or attempt == MAX_ATTEMPTS - 1:
                    raise StorageHTTPError(status) from None
            except StorageHTTPError as error:
                if int(error.response["Error"]["Code"]) not in RETRY_STATUSES or attempt == MAX_ATTEMPTS - 1:
                    raise
            except (URLError, TimeoutError, ConnectionError, HTTPException):
                if attempt == MAX_ATTEMPTS - 1:
                    raise
            time.sleep(2 ** attempt)

    def get_object(self, *, Bucket, Key):
        return {"Body": self.request("GET", Bucket, Key)}

    def put_object(self, *, Bucket, Key, Body, ContentType, CacheControl):
        body = io.BytesIO(Body) if isinstance(Body, bytes) else Body
        try:
            start = body.tell()
            body.seek(0, io.SEEK_END)
            length = body.tell() - start
            body.seek(start)
        except (AttributeError, OSError):
            raise ValueError("HTTP upload body must be a seekable binary stream") from None
        response = self.request("PUT", Bucket, Key, body,
                                {"Content-Length": str(length), "Content-Type": ContentType,
                                 "Cache-Control": CacheControl})
        response.close()


def create_client(transport, endpoint, region):
    if transport == "bunny-http":
        endpoint = endpoint or "https://sg.storage.bunnycdn.com"
        password = os.environ.get("CDN_STORAGE_PASSWORD") or os.environ.get("DESKTOP_STORAGE_PASSWORD") or os.environ.get("AWS_SECRET_ACCESS_KEY")
        return BunnyHTTPStorage(endpoint, password)
    if transport != "s3":
        raise ValueError("Storage transport must be s3 or bunny-http")
    endpoint = validate_url(endpoint or os.environ.get("DESKTOP_S3_ENDPOINT") or
                            "https://sg-s3.storage.bunnycdn.com", "S3 endpoint")
    if not os.environ.get("AWS_ACCESS_KEY_ID") or not os.environ.get("AWS_SECRET_ACCESS_KEY"):
        raise ValueError("Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY outside Git")
    import boto3
    from botocore.config import Config
    return boto3.client("s3", endpoint_url=endpoint, region_name=region,
                        config=Config(signature_version="s3v4", s3={"addressing_style": "path"},
                                      request_checksum_calculation="when_required",
                                      response_checksum_validation="when_required",
                                      retries={"mode": "standard", "total_max_attempts": 4}))


def prepare(windows, linux, version, revision, prefix, public_base, macos=None):
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?", version):
        raise ValueError("Invalid desktop version")
    if not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise ValueError("Revision must be the full source Git SHA")
    if not re.fullmatch(r"[A-Za-z0-9_-]+(?:/[A-Za-z0-9_-]+)*", prefix):
        raise ValueError("Invalid object prefix")
    public_base = validate_url(public_base, "Public base URL")
    filename_version = version.lower()
    package_names = {
        "windows_x64": [f"ghostrack_{filename_version}_windows_x64.zip"],
        "linux_x64": [f"ghostrack_{filename_version}_amd64.deb", f"ghostrack_{filename_version}_amd64.appimage"],
    }
    platforms = [(name, directory) for name, directory in
                 [("windows_x64", windows), ("linux_x64", linux)] if directory is not None]
    if macos is not None:
        package_names["macos_universal"] = [f"ghostrack_{filename_version}_macos_universal.dmg"]
        platforms.append(("macos_universal", macos))
    if not platforms:
        raise ValueError("Supply at least one platform directory")
    package_names = {name: package_names[name] for name, _ in platforms}
    uploads = {}
    for platform, directory in platforms:
        manifest = json.loads((directory / "build.json").read_text())
        if manifest.get("desktop") != {"commit": revision, "dirty": False}:
            raise ValueError(f"{platform} must be built from the clean selected source revision")
        if manifest.get("ghost") != {"commit": GHOST_REVISION, "dirty": False}:
            raise ValueError(f"{platform} Ghost source does not match the clean pinned revision")
        if manifest.get("mmxwallet") != {"commit": WALLET_REVISION, "dirty": False}:
            raise ValueError(f"{platform} wallet source does not match the clean pinned revision")
        expected_target = {"windows_x64": "x86_64-pc-windows-msvc",
                           "linux_x64": "x86_64-unknown-linux-gnu",
                           "macos_universal": "universal-apple-darwin"}[platform]
        if manifest.get("target") != expected_target:
            raise ValueError(f"{platform} build target differs")
        if manifest.get("version") != version:
            raise ValueError(f"{platform} package version differs")
        if platform != "macos_universal":
            suffix = '.exe' if platform == 'windows_x64' else ''
            components = {f'ghostrack-{name}-{expected_target}{suffix}' for name in ('ghost', 'mmxwallet')}
            hashes = manifest.get('sha256')
            if (not isinstance(hashes, dict) or set(hashes) != components or
                    any(not isinstance(value, str) or not re.fullmatch(r'[0-9a-f]{64}', value)
                        for value in hashes.values())):
                raise ValueError(f'{platform} component hashes are invalid')
        if platform == "macos_universal":
            components = {"ghostrack-desktop", "ghostrack-ghost", "ghostrack-mmxwallet"}
            if manifest.get("architectures") != {name: ["arm64", "x86_64"] for name in components}:
                raise ValueError("macOS must have universal architecture metadata for every component")
            hashes = manifest.get("sha256", {})
            if (not isinstance(hashes, dict) or set(hashes) != components or
                    any(not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{64}", value)
                        for value in hashes.values())):
                raise ValueError("macOS component hashes are invalid")
            if (manifest.get("minimum_macos") != "11.0" or manifest.get("signing") != "adhoc" or
                    manifest.get("notarized") is not False):
                raise ValueError("macOS preview compatibility/signing metadata differs")
        sums_name = {"windows_x64": "sha256sums-windows-x64", "linux_x64": "sha256sums",
                     "macos_universal": "sha256sums-macos-universal"}[platform]
        sums = {}
        for line in (directory / sums_name).read_text().splitlines():
            match = re.fullmatch(r"([0-9a-f]{64})  \./([^/]+)", line)
            if not match or match[2] in sums:
                raise ValueError(f"{platform} has invalid package checksums")
            sums[match[2]] = match[1]
        if set(sums) != set(package_names[platform]):
            raise ValueError(f"{platform} checksum list must contain exactly its expected packages")
        for name in package_names[platform]:
            path = directory / name
            if not path.is_file() or path.is_symlink() or path.stat().st_size == 0:
                raise ValueError(f"Missing or invalid package {name}")
            if file_digest(path) != sums[name]:
                raise ValueError(f"Package checksum mismatch: {name}")
            uploads[name] = path
        if platform == "windows_x64":
            with ZipFile(uploads[package_names[platform][0]]) as archive:
                installer = f"ghostrack_{filename_version}_x64-setup.exe"
                if sorted(archive.namelist()) != sorted([installer, "build.json", "install.txt"]):
                    raise ValueError("Windows ZIP contents differ from the expected installer and metadata")
                if archive.getinfo(installer).file_size == 0 or json.loads(archive.read("build.json")) != manifest:
                    raise ValueError("Windows ZIP installer or embedded build record is invalid")
        uploads[f"build-{platform.replace('_', '-')}.json"] = json_bytes(manifest)
    # Aggregate sums cover packages and all supplied build records, with no ambiguous
    # platform build.json name. Bare executables never enter this allowlist.
    hashes = {name: (file_digest(value) if isinstance(value, Path)
                     else hashlib.sha256(value).hexdigest()) for name, value in uploads.items()}
    uploads["sha256sums"] = "".join(f"{hashes[name]}  ./{name}\n" for name in sorted(hashes)).encode()
    hashes["sha256sums"] = hashlib.sha256(uploads["sha256sums"]).hexdigest()
    # Installers include timestamps, so a rebuild of the same revision can
    # legitimately produce different bytes. Include the complete set's digest.
    build = f"{version}-{revision[:12]}-{hashes['sha256sums'][:12]}"
    release_prefix = f"{prefix}/releases/{build}"
    files = {name: {"url": f"{public_base}/{quote(release_prefix)}/{quote(name)}",
                    "sha256": hashes[name],
                    "size": value.stat().st_size if isinstance(value, Path) else len(value)}
             for name, value in uploads.items()}
    latest = {"version": version, "revision": revision, "build": build, "files": files,
              "latest_url": f"{public_base}/{quote(prefix)}/latest.json",
              "downloads": {platform: [files[name]["url"] for name in names]
                            for platform, names in package_names.items()}}
    return uploads, latest, release_prefix


def existing_digest(client, bucket, key):
    try:
        body = client.get_object(Bucket=bucket, Key=key)["Body"]
    except Exception as error:
        response = getattr(error, "response", {})
        if response.get("Error", {}).get("Code") in ("NoSuchKey", "NotFound", "404"):
            return None
        raise
    try:
        return digest(body)
    finally:
        body.close()


def verify_public(url, expected):
    # Verify the actual download bytes through the public CDN before advertising
    # them. No storage credentials are attached to CDN requests.
    for attempt in range(MAX_ATTEMPTS):
        try:
            with urlopen(Request(url, headers={"Accept-Encoding": "identity"}), timeout=120) as response:
                if digest(response) != expected:
                    raise ValueError("Public CDN download checksum mismatch")
            return
        except HTTPError as error:
            status = error.code
            error.close()
            if status not in RETRY_STATUSES | {404} or attempt == MAX_ATTEMPTS - 1:
                raise
        except (URLError, TimeoutError, ConnectionError, HTTPException, ValueError):
            if attempt == MAX_ATTEMPTS - 1:
                raise
        time.sleep(2 ** attempt)


def content_type(name):
    if name.endswith(".zip"):
        return "application/zip"
    if name.endswith(".json"):
        return "application/json"
    if name.endswith(".dmg"):
        return "application/x-apple-diskimage"
    if name.endswith(".deb"):
        return "application/vnd.debian.binary-package"
    return "application/octet-stream"


def publish(client, bucket, prefix, uploads, latest, release_prefix, public_check=verify_public):
    existing = {}
    # Preflight all immutable objects before writing any of them. A rerun may
    # resume identical objects, but cannot replace a published build's bytes.
    for name in uploads:
        key = f"{release_prefix}/{name}"
        existing[name] = existing_digest(client, bucket, key)
        if existing[name] not in (None, latest["files"][name]["sha256"]):
            raise ValueError("Immutable build already exists with different bytes; use a new source revision")
    for name, value in uploads.items():
        key = f"{release_prefix}/{name}"
        if existing[name] is None:
            body = value.open("rb") if isinstance(value, Path) else io.BytesIO(value)
            with body:
                client.put_object(Bucket=bucket, Key=key, Body=body,
                                  ContentType=content_type(name),
                                  CacheControl="public, max-age=31536000, immutable")
        if existing_digest(client, bucket, key) != latest["files"][name]["sha256"]:
            raise ValueError("Uploaded package verification failed")
        public_check(latest["files"][name]["url"], latest["files"][name]["sha256"])
        print(f"Verified {name}")
    pointer = json_bytes(latest)
    key = f"{prefix}/latest.json"
    client.put_object(Bucket=bucket, Key=key, Body=pointer, ContentType="application/json",
                      CacheControl="no-cache, max-age=60")
    if existing_digest(client, bucket, key) != hashlib.sha256(pointer).hexdigest():
        raise ValueError("Latest pointer verification failed")
    public_check(f"{latest['latest_url']}?build={quote(latest['build'])}", hashlib.sha256(pointer).hexdigest())
    print(f"Published desktop build {latest['build']}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--windows-dir", type=Path, required=True)
    parser.add_argument("--linux-dir", type=Path, required=True)
    parser.add_argument("--macos-dir", type=Path, help="Include the verified universal macOS preview")
    parser.add_argument("--version", required=True)
    parser.add_argument("--revision", required=True)
    parser.add_argument("--transport", choices=("s3", "bunny-http"),
                        default=os.environ.get("DESKTOP_UPLOAD_TRANSPORT") or "s3")
    parser.add_argument("--endpoint", default=os.environ.get("DESKTOP_STORAGE_ENDPOINT") or None)
    parser.add_argument("--bucket", default=os.environ.get("DESKTOP_S3_BUCKET", "gigahost-apps"))
    parser.add_argument("--prefix", default=os.environ.get("DESKTOP_S3_PREFIX", "desktop"))
    parser.add_argument("--region", default=os.environ.get("DESKTOP_S3_REGION", "sg"))
    parser.add_argument("--public-base", default=os.environ.get("DESKTOP_PUBLIC_BASE", "https://apps.ghostrack.io"))
    args = parser.parse_args()
    uploads, latest, release_prefix = prepare(args.windows_dir, args.linux_dir, args.version,
                                               args.revision, args.prefix, args.public_base, macos=args.macos_dir)
    client = create_client(args.transport, args.endpoint, args.region)
    publish(client, args.bucket, args.prefix, uploads, latest, release_prefix)
    print(f"Downloads: {args.public_base.rstrip('/')}/{args.prefix}/latest.json")


if __name__ == "__main__":
    try:
        main()
    except ValueError as error:
        sys.exit(f"Publish failed: {error}")
    except Exception as error:
        # Do not dump SDK request details or credentials into CI logs.
        code = getattr(error, "response", {}).get("Error", {}).get("Code", type(error).__name__)
        sys.exit(f"Publish failed ({code}); latest.json was not advanced unless all packages verified")
