$ErrorActionPreference = 'Stop'
# Tauri embeds its Common Controls manifest into application binaries, but Cargo
# lib-test executables are separate targets. The updater's mock-app tests also
# link Wry's TaskDialogIndirect import, which requires Common Controls v6.
$output = & cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --lib --locked --no-run --message-format=json
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$binaries = @($output | ForEach-Object {
  try { $entry = $_ | ConvertFrom-Json } catch { return }
  if ($entry.reason -eq 'compiler-artifact' -and $entry.profile.test -and $entry.executable) { $entry.executable }
})
if (!$binaries.Count) { throw 'Cargo did not report a test executable' }
$kits = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows Kits\Installed Roots').KitsRoot10
$manifestTool = Get-ChildItem "$kits\bin\*\x64\mt.exe" | Sort-Object FullName -Descending | Select-Object -First 1
if (!$manifestTool) { throw 'Windows SDK manifest tool is unavailable' }
$manifest = Join-Path $PSScriptRoot 'windows-test.manifest'
foreach ($binary in $binaries) {
  & $manifestTool.FullName -nologo -manifest $manifest "-outputresource:$binary;#1"
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  & $binary
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
