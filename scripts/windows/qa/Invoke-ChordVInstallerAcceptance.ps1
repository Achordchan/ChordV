#requires -Version 7.4
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$InputDirectory,
    [Parameter(Mandatory)][string]$ExpectedUserSid,
    [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{32}$')][string]$LeaseId
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'InstallerSandbox.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'InstallerCases.psm1') -Force

$sandbox = New-InstallerSandbox $ExpectedUserSid $LeaseId
$originalEnvironment = @{}
$originalFailure = $null
foreach ($name in @('CHORDV_API_BASE_URL', 'CHORDV_MYGO_DATA_DIR')) { $originalEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
$report = [ordered]@{
    SchemaVersion = 1
    Purpose = 'dedicated-windows-installer-runtime-observations'
    Status = 'not-complete'
    ProductionTransitionEnabled = $false
    Cases = @()
    Unverified = @(
        'Actual old official updater check/download/install invocation; this harness launches the genuine installers directly using its locked argument contract.',
        'Arguments reported inside the real Go application; Win32 command-line parsing is only an external observation.',
        'Progress percentage advancement and visual correctness; observing an instfiles control is not a complete passive UI acceptance.',
        'Real ChordV application health/authentication, sessions, connections, and proxy restoration.',
        'Proving no finish page was ever briefly rendered; window events can miss a frame.',
        'Launching every historical shortcut/alias, old executable mapping delays and graceful exit variants.',
        'Two actual competing installers; named mutex contention here is only one controlled failure case.',
        'Cancellation, disk-full/locked-file partial writes, registry failures, failed restart recovery, UAC denial and rollback.',
        'Windows ARM64 runtime, non-profile custom roots and machine-wide installs.',
        'Production Authenticode/legacy transition signing and release authority.'
    )
}
try {
    if (-not (Get-ChildItem -Path (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\EdgeWebView\Application\*\msedgewebview2.exe') -File -ErrorAction SilentlyContinue)) { throw '需要预装系统WebView2，不由旧安装器下载运行时。' }
    $project = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
    $node = (Get-Command node -CommandType Application).Source
    $inspected = Join-Path $sandbox.Root 'checked-inputs'
    & $node (Join-Path $project 'scripts\mygo-windows-acceptance.mjs') $InputDirectory $inspected
    if ($LASTEXITCODE -ne 0) { throw '真实旧签名/PE/当前Go构建身份/完整NSIS输入检查失败，尚未启动安装器。' }
    $inputs = Get-Content -LiteralPath (Join-Path $inspected 'inputs-report.json') -Raw | ConvertFrom-Json
    $report.Inputs = $inputs
    $report.LegacyPayloadPE = Assert-AppVersion $inputs.payloads.legacy.file $inputs.legacyContract.version
    $report.CurrentPayloadPE = Assert-AppVersion $inputs.payloads.current.file $inputs.currentIdentity.version
    Add-Type -Path (Join-Path $PSScriptRoot 'InstallerObservation.cs')
    $report.MissingInstallationFailure = Invoke-ActualInstaller $inputs.currentInstaller '/S /UPDATE' $null 2
    Assert-NoChordVRegistration
    if ((Test-Path -LiteralPath $sandbox.DefaultRoot) -or (Test-Path -LiteralPath $sandbox.MyGoDefaultRoot)) { throw '没有旧安装的更新负控仍创建默认目录。' }
    $report.Cases += Invoke-InstallerCase $sandbox $inputs 'default-passive' $sandbox.DefaultRoot '/P' @('qa-begin', '中文 参数', '/路径/参数', '', 'qa-end')
    $custom = Join-Path $sandbox.Root 'custom 中文 install'
    $report.Cases += Invoke-InstallerCase $sandbox $inputs 'custom-silent-quoted-edge' $custom '/S' @('中文 参数', '/路径/参数', '')
    $report.Status = 'partial-runtime-observations-passed'
} catch {
    $originalFailure = $_
    $report.Status = 'failed'
    $report.Error = $_.Exception.Message
    throw
} finally {
    foreach ($entry in $originalEnvironment.GetEnumerator()) { [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, 'Process') }
    $proxyFailure = $null
    try { $report.ProxyUnchanged = (Get-ProxySnapshot) -eq $sandbox.ProxyBefore }
    catch { $report.ProxyUnchanged = $false; $proxyFailure = $_ }
    if (-not $report.ProxyUnchanged) {
        $report.Status = 'failed'
        $report.ProxyError = '测试账户代理快照变化或无法读取；未自动恢复或改写代理。'
        if (-not $proxyFailure) { $proxyFailure = [InvalidOperationException]::new($report.ProxyError) }
    }
    try { $report | ConvertTo-Json -Depth 24 | Set-Content -LiteralPath (Join-Path $sandbox.Root 'acceptance-report.json') -Encoding utf8 }
    catch {
        if (-not $originalFailure -and -not $proxyFailure) { throw }
        Write-Warning '验收记录保存失败；保留最初失败，不把本次运行计为通过。'
    }
    Write-Output "验收记录：$($sandbox.Root)；不作为生产legacy解锁凭据。"
    if ($proxyFailure -and -not $originalFailure) { throw $proxyFailure }
}
