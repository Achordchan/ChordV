$ErrorActionPreference = 'Stop'
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$vs = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
$dumpbin = Get-ChildItem "$vs\VC\Tools\MSVC\*\bin\Hostx64\x64\dumpbin.exe" | Sort-Object FullName -Descending | Select-Object -First 1
$binary = Get-ChildItem 'apps/desktop/src-tauri/target/debug/deps/chordv_desktop-*.exe' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (!$binary -or !$dumpbin) { throw 'No completed native test binary or dumpbin found' }
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class ImportProbe {
 [DllImport("kernel32", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr LoadLibraryW(string path);
 [DllImport("kernel32", CharSet=CharSet.Ansi, ExactSpelling=true, SetLastError=true)] public static extern IntPtr GetProcAddress(IntPtr module, string name);
 [DllImport("kernel32")] public static extern bool FreeLibrary(IntPtr module);
}
'@
$imports = & $dumpbin.FullName /imports $binary.FullName
$module = [IntPtr]::Zero
$dll = ''
foreach ($line in $imports) {
  if ($line -match '^\s{4}(\S+\.dll)\s*$') {
    if ($module -ne [IntPtr]::Zero) { [void][ImportProbe]::FreeLibrary($module) }
    $dll = $matches[1]
    $module = [ImportProbe]::LoadLibraryW($dll)
    if ($module -eq [IntPtr]::Zero) { Write-Output "MISSING DLL: $dll Win32=$([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
  } elseif ($module -ne [IntPtr]::Zero -and $line -match '^\s{12,}[0-9A-Fa-f]{1,6}\s+([a-zA-Z_?][a-zA-Z0-9_?@$]+)\s*$') {
    $name = $matches[1]
    if ([ImportProbe]::GetProcAddress($module, $name) -eq [IntPtr]::Zero) { Write-Output "MISSING ENTRYPOINT: $dll!$name" }
  }
}
if ($module -ne [IntPtr]::Zero) { [void][ImportProbe]::FreeLibrary($module) }
Write-Output 'Direct import inspection complete'
Get-WinEvent -FilterHashtable @{ LogName='Application'; StartTime=(Get-Date).AddMinutes(-10) } -ErrorAction SilentlyContinue |
  Where-Object { $_.Message -match 'chordv_desktop|entry point|procedure entry' } | Select-Object TimeCreated,Id,Message | Format-List
