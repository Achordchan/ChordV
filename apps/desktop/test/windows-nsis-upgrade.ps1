param([Parameter(Mandatory=$true)][string]$Installer, [Parameter(Mandatory=$true)][string]$ExpectedVersion)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows') { throw 'This installer test is restricted to disposable Windows CI runners.' }
$root = Join-Path $env:RUNNER_TEMP ('chordv-upgrade-' + [Guid]::NewGuid().ToString('N'))
$installDir = Join-Path $root '中文安装目录 with spaces'
New-Item -ItemType Directory -Path $root | Out-Null
$env:CHORDV_API_BASE_URL = 'https://127.0.0.1:9'
function Stop-TestClient {
  Get-Process -Name ChordV,chordv-desktop,chordv_desktop -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -and $_.Path.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) } | Stop-Process -Force
}
function Run-Installer([string]$Path, [string]$Arguments) {
  $process = Start-Process -FilePath $Path -ArgumentList $Arguments -PassThru
  if (!$process.WaitForExit(180000)) { $process.Kill(); throw 'Installer timed out' }
  if ($process.ExitCode -ne 0) { throw "Installer failed: $($process.ExitCode)" }
}
try {
  $oldInstaller = Join-Path $root 'old-1.1.7-setup.exe'
  Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/Achordchan/ChordV/releases/download/v1.1.7/ChordV_1.1.7_x64-setup.exe' -OutFile $oldInstaller
  if ((Get-FileHash $oldInstaller -Algorithm SHA256).Hash -ne 'c0f7a4c7914dcfdc600a20156d548230c369b205a77183e2ec390d73bacb8340') { throw 'Legacy installer digest mismatch' }
  Run-Installer $oldInstaller "/S /NS /D=$installDir"
  Stop-TestClient
  $oldExe = Join-Path $installDir 'chordv-desktop.exe'
  if (!(Test-Path $oldExe)) { $oldExe = Join-Path $installDir 'ChordV.exe' }
  if (!(Test-Path $oldExe) -or !([Diagnostics.FileVersionInfo]::GetVersionInfo($oldExe).ProductVersion.StartsWith('1.1.7'))) { throw 'Legacy baseline installation did not produce version 1.1.7' }

  # These are the passive and restart flags used by the official Tauri updater.
  Run-Installer (Resolve-Path $Installer).Path '/P /UPDATE /R'
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

  $gate = New-Object Threading.Mutex($false, 'Local\ChordV.Update.InProgress')
  try {
    $blocked = Start-Process -FilePath $exe -PassThru
    if (!$blocked.WaitForExit(10000)) { $blocked.Kill(); throw 'Client remained running during installer gate' }
  } finally { $gate.Dispose() }
  $after = Start-Process -FilePath $exe -PassThru
  if ($after.WaitForExit(5000)) { throw 'Client could not start after installer lock was released' }
  Write-Output 'PASS: real 1.1.7 -> current NSIS upgrade, custom Chinese path, installed version/resources, automatic restart and launch gate'
} finally {
  Stop-TestClient
  $uninstaller = Join-Path $installDir 'uninstall.exe'
  if (Test-Path $uninstaller) { Run-Installer $uninstaller '/S' }
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
