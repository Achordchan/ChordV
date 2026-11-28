#requires -Version 7.4
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$count = 0
foreach ($file in (Get-ChildItem -LiteralPath $PSScriptRoot -File | Where-Object Extension -In '.ps1', '.psm1')) {
    $tokens = $null
    $errors = $null
    $null = [Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$tokens, [ref]$errors)
    if ($errors.Count -gt 0) { throw ($errors | Out-String) }
    $count++
}
Add-Type -Path (Join-Path $PSScriptRoot 'InstallerObservation.cs')
Import-Module (Join-Path $PSScriptRoot 'InstallerSandbox.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'InstallerCases.psm1') -Force
foreach ($pair in @(@('', '""'), @('中文 参数', '"中文 参数"'), @('/路径/参数', '"/路径/参数"'), @('plain', 'plain'), @('a"b', 'a\"b'), @('a b\', '"a b\\"'))) {
    $actual = ConvertTo-LegacyArgument $pair[0]
    if ($actual -cne $pair[1]) { throw "锁定旧NSIS参数编码合同不匹配：$actual" }
}
if (-not $IsWindows) {
    $rejected = $false
    try { New-InstallerSandbox 'S-1-5-21-1-2-3-1001' ('a' * 32) }
    catch { $rejected = $_.Exception.Message.Contains('只能在 Windows') }
    if (-not $rejected) { throw '非Windows环境没有在创建目录或启动进程前拒绝。' }
}
Write-Output "PowerShell原生解析$count 个文件、只读观察器C#编译、旧参数编码合同通过；未执行Windows安装验收。"
