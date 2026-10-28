# On a disposable Windows runner: verify the distributed ZIP, not a raw build.
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $IsWindows) { throw 'This smoke test requires Windows.' }
$desktop = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$config = Get-Content "$desktop/src-tauri/tauri.conf.json" -Raw | ConvertFrom-Json
$zipName = "gigahost_$($config.version)_windows_x64.zip".ToLowerInvariant()
$packages = Join-Path $desktop 'artifacts/packages'
$expected = (Get-Content "$packages/sha256sums-windows-x64").Split(' ')[0]
$actual = (Get-FileHash "$packages/$zipName" -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $expected) { throw 'Distributed ZIP checksum mismatch.' }
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::OpenRead("$packages/$zipName")
try {
    $entries = @($archive.Entries | ForEach-Object { $_.FullName })
    $expectedEntries = @("gigahost_$($config.version)_x64-setup.exe".ToLowerInvariant(), 'build.json', 'install.txt')
    if (@(Compare-Object $expectedEntries $entries -CaseSensitive).Count -ne 0) {
        throw 'ZIP contents differ from the expected lowercase installer and metadata.'
    }
} finally {
    $archive.Dispose()
}
$root = Join-Path ([IO.Path]::GetTempPath()) ('gigahost-install-smoke-' + [guid]::NewGuid())
$download = Join-Path $root 'extracted download'
$install = Join-Path $root 'installed app'
$savedEnvironment = @{}
foreach ($name in @('HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'GHOST_SEED_FILE', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'MMX_HOME')) {
    $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}
$app = $null
function Wait-Checked([Diagnostics.Process] $Process, [int] $TimeoutMs, [string] $Action) {
    if (-not $Process.WaitForExit($TimeoutMs)) {
        $Process.Kill($true)
        throw "$Action timed out."
    }
    if ($Process.ExitCode -ne 0) { throw "$Action failed (exit $($Process.ExitCode))." }
}
try {
    Expand-Archive "$packages/$zipName" $download
    $installers = @(Get-ChildItem "$download/*-setup.exe")
    if ($installers.Count -ne 1 -or -not (Test-Path "$download/build.json") -or -not (Test-Path "$download/install.txt")) {
        throw 'ZIP is missing installer or installation metadata.'
    }
    # /D must be the last NSIS argument and must not be quoted, even with spaces.
    $setup = Start-Process $installers[0].FullName -ArgumentList "/S /D=$install" -PassThru
    Wait-Checked $setup 300000 'Silent installation'
    foreach ($name in @('gigahost-desktop.exe', 'gigahost-ghost.exe', 'gigahost-mmxwallet.exe', 'vcruntime140.dll', 'uninstall.exe')) {
        if (-not (Test-Path (Join-Path $install $name))) { throw "Installed file missing: $name" }
    }
    # Match an Explorer launch without HOME, and keep all controller key/state
    # paths inside the disposable directory. The smoke launch creates no keys.
    foreach ($name in @('HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'GHOST_SEED_FILE', 'MMX_HOME')) {
        [Environment]::SetEnvironmentVariable($name, $null, 'Process')
    }
    foreach ($entry in @{ APPDATA = 'roaming'; LOCALAPPDATA = 'local'; USERPROFILE = 'profile' }.GetEnumerator()) {
        $path = Join-Path $root $entry.Value
        New-Item -ItemType Directory -Force -Path $path | Out-Null
        [Environment]::SetEnvironmentVariable($entry.Key, $path, 'Process')
    }
    # Launch directly with this process's disposable environment. Shell
    # activation can involve Explorer, which has its own user environment.
    $start = [Diagnostics.ProcessStartInfo]::new("$install/gigahost-desktop.exe")
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $app = [Diagnostics.Process]::Start($start)
    $windowSeen = $false
    $stateReady = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        Start-Sleep -Seconds 1
        $app.Refresh()
        if ($app.HasExited) { throw "Installed app exited during startup (exit $($app.ExitCode))." }
        if ($app.MainWindowHandle -ne [IntPtr]::Zero) { $windowSeen = $true }
        $stateReady = Test-Path "$root/local/gigahost/transactions"
        if ($windowSeen -and $stateReady) { break }
    }
    if (-not $windowSeen) { throw 'Installed app did not create its window.' }
    if (-not $stateReady) { throw 'App did not initialize its Windows state directory within 30 seconds.' }
    Start-Sleep -Seconds 3
    $app.Refresh()
    if ($app.HasExited) { throw 'Installed app exited after opening its window.' }
    Write-Host 'Installed app created its window and initialized Windows state.'
} finally {
    if ($null -ne $app -and -not $app.HasExited) {
        $app.Kill($true)
        $app.WaitForExit()
    }
    foreach ($name in $savedEnvironment.Keys) {
        [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process')
    }
    if (Test-Path "$install/uninstall.exe") {
        # _?= runs the uninstaller in place so waiting observes actual removal.
        $uninstall = Start-Process "$install/uninstall.exe" -ArgumentList "/S _?=$install" -PassThru
        Wait-Checked $uninstall 60000 'Silent uninstall'
        if (Test-Path "$install/gigahost-desktop.exe") { throw 'Uninstaller left the installed application.' }
    }
    if (Test-Path $root) { Remove-Item $root -Recurse -Force }
}
