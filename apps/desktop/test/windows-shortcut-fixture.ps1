$ErrorActionPreference = 'Stop'
$root = Join-Path ([IO.Path]::GetTempPath()) ('chordv-shortcut-' + [Guid]::NewGuid().ToString('N'))
$directory = Join-Path $root '中文安装目录 with spaces'
New-Item -ItemType Directory -Path $directory -Force | Out-Null
try {
  $target = Join-Path $directory 'legacy.exe'
  [IO.File]::WriteAllText($target, 'Shortcut fixture only; this file is never executed.')
  $link = Join-Path $root '自定义入口.lnk'
  . (Join-Path $PSScriptRoot 'windows-shell-link.ps1')
  [ChordVShortcutFixture]::Create([string]$link, [string]$target, [string]$directory)
  if ([ChordVShortcutFixture]::ReadTarget([string]$link) -ne [IO.Path]::GetFullPath([string]$target)) { throw 'Shortcut target roundtrip failed' }
  Write-Output 'PASS: Unicode/custom-path shortcut fixture'
} catch {
  Write-Host "target=$target type=$($target.GetType().FullName) length=$($target.Length)"
  Write-Host $_.Exception.ToString()
  Write-Host $_.ScriptStackTrace
  throw
} finally {
  Remove-Item -LiteralPath $root -Recurse -Force
}
