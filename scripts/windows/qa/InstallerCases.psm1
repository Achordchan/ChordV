Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'InstallerSandbox.psm1')

function ConvertTo-LegacyArgument([AllowEmptyString()][string]$Argument) {
    $quote = $Argument.Length -eq 0 -or $Argument.Contains(' ') -or $Argument.Contains("`t") -or $Argument.Contains('/')
    $result = [Text.StringBuilder]::new()
    if ($quote) { $null = $result.Append('"') }
    $backslashes = 0
    foreach ($character in $Argument.ToCharArray()) {
        if ($character -eq '\') { $backslashes++ }
        else {
            if ($character -eq '"') { $null = $result.Append(('\' * ($backslashes + 1))) }
            $backslashes = 0
        }
        $null = $result.Append($character)
    }
    if ($quote) { $null = $result.Append(('\' * $backslashes)); $null = $result.Append('"') }
    return $result.ToString()
}

function Invoke-ActualInstaller($Artifact, [string]$Arguments, $Observer, [int]$ExpectedExit = 0) {
    Assert-ArtifactHash $Artifact
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $Artifact.file
    $start.Arguments = $Arguments
    $start.UseShellExecute = $false
    $process = [Diagnostics.Process]::Start($start)
    try {
        if ($Observer) { $Observer.ObserveInstaller($process.Id) }
        if (-not $process.WaitForExit(90000)) {
            $process.Kill()
            throw '本次直接启动的安装器超时，已终止该进程；不按名称查杀。'
        }
        if ($process.ExitCode -ne $ExpectedExit) { throw "真实安装器退出码 $($process.ExitCode)，预期 $ExpectedExit。" }
        return @{ ProcessId = $process.Id; ExitCode = $process.ExitCode; RawArguments = $Arguments }
    } finally { $process.Dispose() }
}

function Assert-InstalledHash([string]$Root, [string]$ExpectedHash) {
    Assert-NoReparse $Root
    $main = Join-Path $Root 'ChordV.exe'
    Assert-NoReparse $main
    if ((Get-FileHash -LiteralPath $main).Hash.ToLowerInvariant() -ne $ExpectedHash) { throw '安装后的真实主程序与已检查完整包不一致。' }
}

function Assert-NewRegistration([string]$Root) {
    $snapshot = Get-ChordVRegistry
    $found = $false
    foreach ($entry in $snapshot.GetEnumerator()) {
        if ($entry.Key.EndsWith('\Uninstall\ChordV') -and $null -ne $entry.Value) { throw '旧卸载键未退休。' }
        if ($entry.Key.EndsWith('\Uninstall\app.chordv.desktop') -and $null -ne $entry.Value) {
            $found = $true
            if ($entry.Value.InstallLocation -ne $Root -or $entry.Value.DisplayName -ne 'ChordV' -or $entry.Value.UninstallString -ne ('"' + $Root + '\Uninstall.exe"')) { throw '新卸载记录的安装根或入口不匹配。' }
        }
    }
    if (-not $found) { throw '没有新卸载记录。' }
    return $snapshot
}

function Get-ShortcutEvidence([string]$Root) {
    $shell = New-Object -ComObject WScript.Shell
    $items = @()
    try {
        foreach ($directory in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) {
            foreach ($file in (Get-ChildItem -LiteralPath $directory -Filter '*ChordV*.lnk' -File -ErrorAction SilentlyContinue)) {
                $shortcut = $shell.CreateShortcut($file.FullName)
                try {
                    if (-not $shortcut.TargetPath.StartsWith($Root + '\', [StringComparison]::OrdinalIgnoreCase)) { throw '已存在指向其他目录的 ChordV 快捷方式，不改写它。' }
                    $items += @{ File = $file.FullName; Target = $shortcut.TargetPath }
                } finally { $null = [Runtime.InteropServices.Marshal]::ReleaseComObject($shortcut) }
            }
        }
    } finally { $null = [Runtime.InteropServices.Marshal]::ReleaseComObject($shell) }
    return $items
}

function Invoke-InstallerCase($Sandbox, $Inputs, [string]$Name, [string]$Root, [string]$Mode, [string[]]$RestartArguments) {
    Assert-NoChordVRegistration
    if (Test-Path -LiteralPath $Root) { throw '用例安装根必须不存在，不复用或覆盖旧目录。' }
    Assert-NoReparse $Root
    $caseReport = [ordered]@{ Name = $Name; Root = $Root; Status = 'running'; Observations = [ordered]@{} }
    $observer = $null
    try {
        $oldArguments = '/S'
        if ($Root -ne $Sandbox.DefaultRoot) { $oldArguments += ' /D=' + $Root }
        $caseReport.Observations.LegacyInstall = Invoke-ActualInstaller $Inputs.legacyInstaller $oldArguments $null
        Assert-InstalledHash $Root $Inputs.payloads.legacy.sha256
        $caseReport.Observations.LegacyApp = Assert-AppVersion (Join-Path $Root 'ChordV.exe') $Inputs.legacyContract.version
        $oldRegistry = Get-ChordVRegistry
        $oldKeys = @($oldRegistry.GetEnumerator() | Where-Object { $_.Key.EndsWith('\Uninstall\ChordV') -and $null -ne $_.Value })
        if ($oldKeys.Count -eq 0) { throw '真实旧安装器未建立已知卸载记录。' }
        foreach ($entry in $oldKeys) {
            if ($entry.Value.InstallLocation.Trim('"') -ne $Root -or $entry.Value.MainBinaryName -ne 'ChordV.exe') { throw '真实旧安装记录与锁源不一致。' }
        }
        $caseReport.Observations.OldRegistry = $oldRegistry
        $caseReport.Observations.OldShortcuts = @(Get-ShortcutEvidence $Root)
        if ($caseReport.Observations.OldShortcuts.Count -eq 0) { throw '真实旧安装器没有生成可检查的ChordV快捷方式。' }
        $seedDirectory = Join-Path $Root 'qa-unknown'
        $null = New-Item -ItemType Directory -Path $seedDirectory
        $seeds = @((Join-Path $Root 'qa-user-notes.txt'), (Join-Path $seedDirectory '保留 文件.txt'))
        foreach ($file in $seeds) { [IO.File]::WriteAllText($file, "Unknown user data $Name $file", [Text.UTF8Encoding]::new($false)) }
        $seedHashes = @{}
        foreach ($file in $seeds) { $seedHashes[$file] = (Get-FileHash -LiteralPath $file).Hash }
        $before = $oldRegistry | ConvertTo-Json -Depth 12 -Compress
        $wrongRoot = Join-Path $Sandbox.Root 'must-not-install'
        $caseReport.Observations.ConflictingDirectory = Invoke-ActualInstaller $Inputs.currentInstaller ('/S /UPDATE /D=' + $wrongRoot) $null 2
        Assert-InstalledHash $Root $Inputs.payloads.legacy.sha256
        if (Test-Path -LiteralPath $wrongRoot) { throw '冲突目录负控仍写入了目标。' }
        if ((Get-ChordVRegistry | ConvertTo-Json -Depth 12 -Compress) -ne $before) { throw '冲突目录负控修改了安装记录。' }
        $gate = [Threading.Mutex]::new($false, 'Local\ChordV.Update.InProgress')
        try { $caseReport.Observations.ExistingMutex = Invoke-ActualInstaller $Inputs.currentInstaller '/S /UPDATE' $null 2 }
        finally { $gate.Dispose() }
        Assert-InstalledHash $Root $Inputs.payloads.legacy.sha256
        if ((Get-ChordVRegistry | ConvertTo-Json -Depth 12 -Compress) -ne $before) { throw '互斥负控修改了安装记录。' }
        $observer = [ChordVInstallerQA.Observer]::new($Root)
        $encoded = @($RestartArguments | ForEach-Object { ConvertTo-LegacyArgument $_ }) -join ' '
        $env:CHORDV_API_BASE_URL = 'http://127.0.0.1:1'
        $env:CHORDV_MYGO_DATA_DIR = Join-Path $Sandbox.Root ($Name + '-app-data')
        $caseReport.Observations.Update = Invoke-ActualInstaller $Inputs.currentInstaller ("$Mode /UPDATE /R /ARGS $encoded") $observer
        if (-not $observer.WaitForApp(20000)) { throw '未捕获真实新应用窗口/进程，不能把安装器退出当重启成功。' }
        Assert-InstalledHash $Root $Inputs.currentBinary.sha256
        $caseReport.Observations.CurrentApp = Assert-AppVersion (Join-Path $Root 'ChordV.exe') $Inputs.currentIdentity.version
        $caseReport.Observations.NewRegistry = Assert-NewRegistration $Root
        foreach ($alias in @('chordv-desktop.exe', 'chordv_desktop.exe')) {
            if ((Get-FileHash -LiteralPath (Join-Path $Root $alias)).Hash.ToLowerInvariant() -ne $Inputs.currentBinary.sha256) { throw '旧入口仍指向旧版本或缺失。' }
        }
        $caseReport.Observations.NewShortcuts = @(Get-ShortcutEvidence $Root)
        if ($caseReport.Observations.NewShortcuts.Count -eq 0) { throw '更新后没有可检查的ChordV快捷方式。' }
        $apps = @($observer.Apps())
        $app = $apps[-1]
        $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($app.ProcessId)"
        if (-not $process -or $process.ExecutablePath -ne (Join-Path $Root 'ChordV.exe')) { throw '重启进程的实际路径不匹配。' }
        $parsed = @([ChordVInstallerQA.Observer]::ParseCommandLine($process.CommandLine))
        if (($parsed[1..($parsed.Count - 1)] | ConvertTo-Json -Compress) -ne ($RestartArguments | ConvertTo-Json -Compress)) { throw '实际重启命令行的中文/空格/斜杠/空串参数不一致。' }
        $caseReport.Observations.RestartProcess = @{ ProcessId = $app.ProcessId; Executable = $process.ExecutablePath; RawCommandLine = $process.CommandLine; WindowsParsedArguments = $parsed; AppReportedArguments = 'not-observed' }
        $windows = @($observer.Windows())
        $caseReport.Observations.Windows = $windows
        if ($Mode -eq '/P' -and -not ($windows | Where-Object InstallProgress)) { throw '没有观察到真实安装进度控件，不把进程退出当passive UI通过。' }
        if ($Mode -eq '/P' -and ($windows | Where-Object DirectoryEditor)) { throw 'passive用例显示了目录编辑页。' }
        if ($Mode -eq '/S' -and $windows.Count -gt 0) { throw 'silent用例出现了可见安装器界面。' }
        $observer.Dispose(); $observer = $null
        $uninstaller = Join-Path $Root 'Uninstall.exe'
        $uninstall = @{ file = $uninstaller; sha256 = (Get-FileHash -LiteralPath $uninstaller).Hash.ToLowerInvariant() }
        $caseReport.Observations.Uninstall = Invoke-ActualInstaller $uninstall ('/S _?=' + $Root) $null
        Assert-NoChordVRegistration
        if (Test-Path -LiteralPath (Join-Path $Root 'ChordV.exe')) { throw '卸载后主程序仍存在。' }
        foreach ($file in $seeds) { if ((Get-FileHash -LiteralPath $file).Hash -ne $seedHashes[$file]) { throw '未知用户文件在更新/卸载中被删除或改写。' } }
        $caseReport.Observations.UnknownFileHashes = $seedHashes
        $caseReport.Observations.UninstallerFileRemaining = Test-Path -LiteralPath $uninstaller
        if ((Get-ProxySnapshot) -ne $Sandbox.ProxyBefore) { throw '测试账户代理状态发生变化；未自动改写或恢复代理。' }
        $caseReport.Status = 'observations-passed-not-full-migration-acceptance'
    } catch {
        $caseReport.Status = 'failed'
        $caseReport.Error = $_.Exception.Message
        throw
    } finally {
        if ($observer) { $observer.Dispose() }
        $caseReport | ConvertTo-Json -Depth 18 | Set-Content -LiteralPath (Join-Path $Sandbox.Root ($Name + '.json')) -Encoding utf8
    }
    return $caseReport
}

Export-ModuleMember -Function Invoke-ActualInstaller, Invoke-InstallerCase, ConvertTo-LegacyArgument
