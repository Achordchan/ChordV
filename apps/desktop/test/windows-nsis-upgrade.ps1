param([Parameter(Mandatory=$true)][string]$Installer, [Parameter(Mandatory=$true)][string]$ExpectedVersion)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows') { throw 'This installer test is restricted to disposable Windows CI runners.' }
$root = Join-Path $env:RUNNER_TEMP ('chordv-upgrade-' + [Guid]::NewGuid().ToString('N'))
$installDir = Join-Path $root '中文安装目录 with spaces'
New-Item -ItemType Directory -Path $root | Out-Null
$env:CHORDV_API_BASE_URL = 'https://127.0.0.1:9'
$proxyKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
$originalProxy = Get-ItemProperty $proxyKey
$ownedCore = $null
$foreignCore = $null
function Stop-TestClient {
  Get-Process -Name ChordV,chordv-desktop,chordv_desktop -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -and $_.Path.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) } | Stop-Process -Force
}
function Run-Installer([string]$Path, [string]$Arguments) {
  $process = Start-Process -FilePath $Path -ArgumentList $Arguments -PassThru
  if (!$process.WaitForExit(180000)) { $process.Kill(); throw 'Installer timed out' }
  if ($process.ExitCode -ne 0) { throw "Installer failed: $($process.ExitCode)" }
}
function Wait-CoreListener($Process, [int]$Port) {
  $deadline = (Get-Date).AddSeconds(15)
  do {
    $Process.Refresh()
    if ($Process.HasExited) { throw "Core exited before listening on $Port" }
    $listener = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -eq $Process.Id }
    if ($listener) { return }
    Start-Sleep -Milliseconds 100
  } while ((Get-Date) -lt $deadline)
  throw "Core did not bind $Port before the fixture deadline"
}
try {
  $oldInstaller = Join-Path $root 'old-1.1.7-setup.exe'
  Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/Achordchan/ChordV/releases/download/v1.1.7/ChordV_1.1.7_x64-setup.exe' -OutFile $oldInstaller
  if ((Get-FileHash $oldInstaller -Algorithm SHA256).Hash -ne 'c0f7a4c7914dcfdc600a20156d548230c369b205a77183e2ec390d73bacb8340') { throw 'Legacy installer digest mismatch' }
  Write-Host 'PHASE: installing legacy baseline'
  Run-Installer $oldInstaller "/S /NS /D=$installDir"
  Stop-TestClient
  $oldExe = Join-Path $installDir 'chordv-desktop.exe'
  if (!(Test-Path $oldExe)) { $oldExe = Join-Path $installDir 'ChordV.exe' }
  if (!(Test-Path $oldExe) -or !([Diagnostics.FileVersionInfo]::GetVersionInfo($oldExe).ProductVersion.StartsWith('1.1.7'))) { throw 'Legacy baseline installation did not produce version 1.1.7' }

  Write-Host 'PHASE: creating legacy shortcut'
  $shortcutPath = Join-Path $root '自定义启动入口.lnk'
  . (Join-Path $PSScriptRoot 'windows-shell-link.ps1')
  [ChordVShortcutFixture]::Create([string]$shortcutPath, [string]$oldExe, [string]$installDir)

  $oldReadyMarker = Join-Path $env:LOCALAPPDATA 'app.chordv.desktop\updater\startup-ready.marker'
  Remove-Item -LiteralPath $oldReadyMarker -Force -ErrorAction SilentlyContinue
  Write-Host 'PHASE: starting legacy client'
  $oldClient = Start-Process -FilePath $oldExe -PassThru
  $deadline = (Get-Date).AddSeconds(30)
  do {
    if ($oldClient.HasExited) { throw 'Legacy client exited before upgrade process-guard test' }
    $ready = Test-Path $oldReadyMarker
    if ($ready) { $ready = (Get-Content -LiteralPath $oldReadyMarker -Raw) -match ('(?m)^pid=' + $oldClient.Id + '\r?$') }
    if ($ready) { break }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $deadline)
  if (!$ready) { throw 'Legacy baseline startup did not finish before seeding orphan core' }

  # Simulate a crashed legacy client: a private orphaned core without a PID file
  # and a ChordV-owned system proxy. An unrelated same-name core must survive.
  Write-Host 'PHASE: seeding orphan and unrelated cores'
  $runtimeDir = Join-Path $env:LOCALAPPDATA 'app.chordv.desktop\runtime'
  $ownedBin = Join-Path $runtimeDir 'bin'
  $foreignBin = Join-Path $root 'foreign-core'
  New-Item -ItemType Directory -Path $ownedBin,$foreignBin -Force | Out-Null
  foreach ($bin in @($ownedBin,$foreignBin)) {
    Copy-Item (Join-Path $installDir 'bin\xray.exe') (Join-Path $bin 'xray.exe') -Force
  }
  $ownedConfig = Join-Path $root 'owned.json'
  $foreignConfig = Join-Path $root 'foreign.json'
  [IO.File]::WriteAllText($ownedConfig,'{"inbounds":[{"listen":"127.0.0.1","port":17890,"protocol":"http","settings":{}}],"outbounds":[{"protocol":"freedom","settings":{}}]}')
  [IO.File]::WriteAllText($foreignConfig,'{"inbounds":[{"listen":"127.0.0.1","port":17899,"protocol":"http","settings":{}}],"outbounds":[{"protocol":"freedom","settings":{}}]}')
  $ownedCore = Start-Process (Join-Path $ownedBin 'xray.exe') -ArgumentList ('run -c "' + $ownedConfig + '"') -PassThru
  $foreignCore = Start-Process (Join-Path $foreignBin 'xray.exe') -ArgumentList ('run -c "' + $foreignConfig + '"') -PassThru
  Wait-CoreListener $ownedCore 17890
  Wait-CoreListener $foreignCore 17899
  Set-ItemProperty $proxyKey ProxyOverride '<local>;retired.example'
  Set-ItemProperty $proxyKey ProxyEnable 1
  Set-ItemProperty $proxyKey ProxyServer '127.0.0.1:17899'
  $maintenanceExe = (Resolve-Path 'apps/desktop/src-tauri/target/x86_64-pc-windows-msvc/release/ChordV.exe').Path
  Run-Installer $maintenanceExe '--installer-maintenance'
  $ownedCore.Refresh(); $foreignCore.Refresh()
  if (!$ownedCore.HasExited -or $foreignCore.HasExited) { throw 'Maintenance did not scope core cleanup to the private runtime path' }
  $foreignProxy = Get-ItemProperty $proxyKey
  if ($foreignProxy.ProxyEnable -ne 1 -or $foreignProxy.ProxyServer -ne '127.0.0.1:17899') { throw 'Maintenance changed an unrelated system proxy' }
  Write-Host 'PASS: maintenance preserves unrelated proxy and core'
  $ownedCore = Start-Process (Join-Path $ownedBin 'xray.exe') -ArgumentList ('run -c "' + $ownedConfig + '"') -PassThru
  Wait-CoreListener $ownedCore 17890
  Set-ItemProperty $proxyKey ProxyServer '127.0.0.1:17890'

  # These are the passive and restart flags used by the official Tauri updater.
  Write-Host 'PHASE: applying new installer'
  Run-Installer (Resolve-Path $Installer).Path '/P /UPDATE /R'
  $oldClient.Refresh()
  if (!$oldClient.HasExited) { throw 'Installer process guard failed to close the running legacy client' }
  $ownedCore.Refresh(); $foreignCore.Refresh()
  if (!$ownedCore.HasExited) { throw 'Legacy orphaned ChordV core survived the upgrade' }
  if ($foreignCore.HasExited) { throw 'Upgrade stopped an unrelated same-name core' }
  if ((Get-ItemProperty $proxyKey).ProxyEnable -ne 0) { throw 'Upgrade left the ChordV-owned system proxy enabled' }
  $legacyTarget = [ChordVShortcutFixture]::ReadTarget([string]$shortcutPath)
  if (!(Test-Path $legacyTarget) -or !([Diagnostics.FileVersionInfo]::GetVersionInfo($legacyTarget).ProductVersion.StartsWith($ExpectedVersion))) { throw 'User-created legacy shortcut no longer points at the current version' }
  $exe = Join-Path $installDir 'ChordV.exe'
  if (!(Test-Path $exe)) { throw 'Upgrade did not preserve the custom installation directory' }
  if (![Diagnostics.FileVersionInfo]::GetVersionInfo($exe).ProductVersion.StartsWith($ExpectedVersion)) { throw 'Upgrade left the old executable version installed' }
  foreach ($resource in @('bin\xray.exe','bin\geoip.dat','bin\geosite.dat')) {
    if (!(Test-Path (Join-Path $installDir $resource))) { throw "Missing bundled resource: $resource" }
  }
  $deadline = (Get-Date).AddSeconds(45)
  $running = $null
  do {
    $running = Get-Process -Name ChordV -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1
    if ($running) { break }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $deadline)
  if (!$running) { throw 'Updated client did not restart with a visible main window' }
  Stop-TestClient
  Start-Process -FilePath $shortcutPath | Out-Null
  $deadline = (Get-Date).AddSeconds(30)
  do {
    $legacyRunning = Get-Process -Name ChordV,chordv-desktop,chordv_desktop -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($installDir,[StringComparison]::OrdinalIgnoreCase) -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1
    if ($legacyRunning) { break }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $deadline)
  if (!$legacyRunning) { throw 'Legacy shortcut could not launch the updated client' }
  Stop-TestClient

  $gate = New-Object Threading.Mutex($false, 'Local\ChordV.Update.InProgress')
  try {
    $blocked = Start-Process -FilePath $exe -PassThru
    if (!$blocked.WaitForExit(10000)) { $blocked.Kill(); throw 'Client remained running during installer gate' }
  } finally { $gate.Dispose() }
  $after = Start-Process -FilePath $exe -PassThru
  if ($after.WaitForExit(5000)) { throw 'Client could not start after installer lock was released' }
  Write-Output 'PASS: real 1.1.7 -> current NSIS upgrade, custom Chinese path, installed version/resources, automatic restart and launch gate'
} catch {
  Write-Host $_.Exception.ToString()
  Write-Host $_.ScriptStackTrace
  throw
} finally {
  Stop-TestClient
  foreach ($core in @($ownedCore,$foreignCore)) {
    if ($core) { $core.Refresh(); if (!$core.HasExited) { $core.Kill(); $core.WaitForExit(5000) | Out-Null } }
  }
  if ($null -ne $originalProxy.ProxyEnable) { Set-ItemProperty $proxyKey ProxyEnable $originalProxy.ProxyEnable }
  else { Remove-ItemProperty $proxyKey ProxyEnable -ErrorAction SilentlyContinue }
  if ($null -ne $originalProxy.ProxyServer) { Set-ItemProperty $proxyKey ProxyServer $originalProxy.ProxyServer }
  else { Remove-ItemProperty $proxyKey ProxyServer -ErrorAction SilentlyContinue }
  if ($null -ne $originalProxy.ProxyOverride) { Set-ItemProperty $proxyKey ProxyOverride $originalProxy.ProxyOverride }
  else { Remove-ItemProperty $proxyKey ProxyOverride -ErrorAction SilentlyContinue }
  $uninstaller = Join-Path $installDir 'uninstall.exe'
  if (Test-Path $uninstaller) {
    Run-Installer $uninstaller '/S'
    # NSIS may relaunch its uninstaller from TEMP so it can delete itself.
    $deadline = (Get-Date).AddSeconds(60)
    while ((Test-Path $installDir) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 250 }
    foreach ($name in @('ChordV.exe','chordv-desktop.exe','chordv_desktop.exe')) {
      if (Test-Path (Join-Path $installDir $name)) { throw "Uninstall left executable entry point: $name" }
    }
    if (Test-Path $installDir) { throw 'Uninstall left the installation directory behind' }
    Write-Output 'PASS: uninstall removes generated compatibility entries and installation directory'
  }
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
