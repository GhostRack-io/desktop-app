# Build from a native Windows x64 MSVC shell. Only the ZIP is distributed.
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Invoke-Native([scriptblock] $Command) {
    & $Command
    if ($LASTEXITCODE -ne 0) { throw "Native command failed (exit $LASTEXITCODE): $Command" }
}
function Write-Utf8([string] $Path, [string] $Text) {
    [IO.File]::WriteAllText($Path, $Text, [Text.UTF8Encoding]::new($false))
}
if (-not $IsWindows) { throw 'This script requires PowerShell 7 on Windows.' }
$desktop = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$version = Invoke-Native { python (Join-Path $desktop 'scripts/build-support.py') version }
if ($env:GITHUB_REF_TYPE -eq 'tag' -and $env:GITHUB_REF_NAME -cne "desktop-v$version") { throw 'Release tag version differs.' }
$rustVersion = Invoke-Native { rustc -vV }
$target = ($rustVersion | Select-String '^host: (.+)$').Matches.Groups[1].Value
if ($target -ne 'x86_64-pc-windows-msvc') { throw 'This preview packages Windows x64 MSVC only.' }
$buildRoot = if ($env:DESKTOP_BUILD_DIR) { $env:DESKTOP_BUILD_DIR } else { Join-Path $desktop 'artifacts/build' }
$binaries = Join-Path $desktop 'src-tauri/binaries'
$packages = Join-Path $desktop 'artifacts/packages'
New-Item -ItemType Directory -Force -Path $buildRoot, $binaries, $packages | Out-Null
$buildRoot = (Resolve-Path $buildRoot).Path
$desktopTarget = Join-Path $buildRoot 'desktop'
Invoke-Native { python (Join-Path $desktop 'scripts/build-support.py') components --target $target --build-root $buildRoot }
Invoke-Native { python (Join-Path $desktop 'scripts/check-ghost.py') (Join-Path $binaries "gigahost-ghost-$target.exe") }
Invoke-Native { python (Join-Path $desktop 'scripts/build-support.py') manifest --target $target --build-root $buildRoot }
$config = Get-Content "$desktop/src-tauri/tauri.conf.json" -Raw | ConvertFrom-Json

$previousTarget = $env:CARGO_TARGET_DIR
Push-Location $desktop
try {
    Invoke-Native { npm.cmd ci }
    Invoke-Native { npm.cmd run icons }
    $env:CARGO_TARGET_DIR = $desktopTarget
    Invoke-Native { npm.cmd run tauri build -- --target $target --config src-tauri/tauri.windows.conf.json --bundles nsis -- --locked }
} finally {
    $env:CARGO_TARGET_DIR = $previousTarget
    Pop-Location
}
$installers = @(Get-ChildItem "$desktopTarget/$target/release/bundle/nsis/*_$($config.version)_x64-setup.exe")
if ($installers.Count -ne 1) { throw 'Expected exactly one Windows x64 NSIS installer for the configured version.' }
$installerName = "gigahost_$($config.version)_x64-setup.exe".ToLowerInvariant()
$zipName = "gigahost_$($config.version)_windows_x64.zip".ToLowerInvariant()
$stage = Join-Path $packages ('.windows-package-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $stage | Out-Null
try {
    Copy-Item $installers[0].FullName (Join-Path $stage $installerName)
    Copy-Item "$binaries/build-manifest.json" "$stage/build.json"
    Write-Utf8 "$stage/install.txt" @"
Gigahost $($config.version) for Windows 10/11 x64

1. Right-click the downloaded ZIP and choose Extract All.
2. Open $installerName from the extracted folder.
3. Follow the installer, then open Gigahost from the Start menu.

The installer installs for your Windows user. Internet access is needed if
Microsoft WebView2 must be installed. Ghost and mmxwallet are included.
This preview is unsigned; Windows may show a publisher/SmartScreen warning.
Only continue if you trust where you downloaded it. The ZIP accommodates
download policies that reject direct .exe downloads; it does not remove
Windows security checks. Your keys and app state are preserved on uninstall.
"@
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $stagedZip = Join-Path $packages ('.' + [guid]::NewGuid() + '.zip')
    try {
        [IO.Compression.ZipFile]::CreateFromDirectory($stage, $stagedZip)
        Move-Item $stagedZip (Join-Path $packages $zipName) -Force
    } finally {
        if (Test-Path $stagedZip) { Remove-Item $stagedZip }
    }
    Copy-Item "$binaries/build-manifest.json" "$packages/build.json" -Force
    $zipHash = (Get-FileHash (Join-Path $packages $zipName) -Algorithm SHA256).Hash.ToLowerInvariant()
    Write-Utf8 "$packages/sha256sums-windows-x64" "$zipHash  ./$zipName`n"
} finally {
    Remove-Item $stage -Recurse -Force
}
Write-Host "Windows package: $(Join-Path $packages $zipName)"
