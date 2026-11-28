Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:UninstallKeys = @('Software\Microsoft\Windows\CurrentVersion\Uninstall\ChordV', 'Software\Microsoft\Windows\CurrentVersion\Uninstall\app.chordv.desktop')

function Assert-NoReparse([string]$Path) {
    $item = [IO.Path]::GetFullPath($Path)
    while ($item) {
        if (Test-Path -LiteralPath $item) {
            if ((Get-Item -LiteralPath $item -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "测试路径含链接：$item" }
        }
        $parent = [IO.Path]::GetDirectoryName($item)
        if ($parent -eq $item) { break }
        $item = $parent
    }
}

function Get-ChordVRegistry {
    $result = [ordered]@{}
    foreach ($view in @([Microsoft.Win32.RegistryView]::Registry32, [Microsoft.Win32.RegistryView]::Registry64)) {
        $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, $view)
        try {
            foreach ($name in $script:UninstallKeys) {
                $key = $base.OpenSubKey($name)
                $values = $null
                if ($key) {
                    try {
                        $values = [ordered]@{}
                        foreach ($value in ($key.GetValueNames() | Sort-Object)) { $values[$value] = $key.GetValue($value) }
                    } finally { $key.Dispose() }
                }
                $result["$view|$name"] = $values
            }
        } finally { $base.Dispose() }
    }
    return $result
}

function Assert-NoChordVRegistration {
    foreach ($value in (Get-ChordVRegistry).Values) { if ($null -ne $value) { throw '发现现有 ChordV HKCU 安装记录，未启动任何安装器。' } }
}

function Get-ProxySnapshot {
    $result = [ordered]@{}
    foreach ($name in @('Software\Microsoft\Windows\CurrentVersion\Internet Settings', 'Software\Microsoft\Windows\CurrentVersion\Internet Settings\Connections')) {
        $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($name)
        try {
            $values = [ordered]@{}
            if ($key) {
                foreach ($value in @('ProxyEnable', 'ProxyServer', 'ProxyOverride', 'AutoConfigURL', 'AutoDetect', 'DefaultConnectionSettings', 'SavedLegacySettings')) {
                    if ($key.GetValueNames() -contains $value) { $values[$value] = $key.GetValue($value) }
                }
            }
            $result[$name] = $values
        } finally { if ($key) { $key.Dispose() } }
    }
    return ($result | ConvertTo-Json -Depth 12 -Compress)
}

function New-InstallerSandbox([string]$ExpectedSid, [string]$LeaseId) {
    if (-not $IsWindows) { throw '安装验收只能在 Windows 执行。' }
    if ($ExpectedSid -notmatch '^S-1-5-21-\d+-\d+-\d+-\d+$' -or $LeaseId -notmatch '^[a-f0-9]{32}$') { throw '必须提供受保护配置中的测试账户 SID 和32位租约ID。' }
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    if ($identity.User.Value -ne $ExpectedSid -or ($identity.Name.Split('\')[-1] -notmatch '^ChordVQa-[a-f0-9]{8,12}$')) { throw '当前账户不是指定的临时 ChordVQa 测试账户。' }
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) -or ($identity.Groups | Where-Object Value -EQ 'S-1-5-32-544')) { throw '必须使用不属于管理员组的普通测试用户。' }
    if (-not [Environment]::UserInteractive -or [Diagnostics.Process]::GetCurrentProcess().SessionId -eq 0) { throw '需要专用交互桌面会话，不能在服务会话运行。' }
    $user = Get-LocalUser -SID $identity.User
    if (-not $user.Enabled -or $identity.Name.Split('\')[0] -ne $env:COMPUTERNAME) { throw '需要本机启用的临时账户，不接受域账户。' }
    $profile = [IO.Path]::GetFullPath([Environment]::GetFolderPath('UserProfile'))
    if ([IO.Path]::GetFullPath($env:USERPROFILE) -ne $profile -or [IO.Path]::GetFullPath($env:LOCALAPPDATA) -ne [IO.Path]::GetFullPath([Environment]::GetFolderPath('LocalApplicationData')) -or [IO.Path]::GetFullPath($env:APPDATA) -ne [IO.Path]::GetFullPath([Environment]::GetFolderPath('ApplicationData'))) { throw '进程环境中的用户目录与当前令牌的Windows已知目录不一致。' }
    $leaseFile = Join-Path $profile '.chordv-installer-qa-lease.json'
    Assert-NoReparse $leaseFile
    $lease = Get-Content -LiteralPath $leaseFile -Raw | ConvertFrom-Json
    $expires = [DateTimeOffset]::Parse($lease.ExpiresUtc)
    if ($lease.SchemaVersion -ne 1 -or $lease.Disposable -ne $true -or $lease.Sid -ne $ExpectedSid -or $lease.LeaseId -ne $LeaseId -or [IO.Path]::GetFullPath($lease.ProfilePath) -ne $profile -or $expires -le [DateTimeOffset]::UtcNow -or $expires -gt [DateTimeOffset]::UtcNow.AddHours(8)) { throw '测试账户租约无效、过期或不是短期专用环境。' }
    Assert-NoChordVRegistration
    foreach ($key in @('HKCU:\Software\chordv\ChordV', 'HKCU:\Software\achordchan\ChordV', 'HKCU:\Software\app.chordv.desktop\ChordV')) {
        if (Test-Path -LiteralPath $key) { throw '发现旧版制造商安装记录，未猜测归属。' }
    }
    $default = Join-Path $env:LOCALAPPDATA 'ChordV'
    $root = Join-Path $profile "ChordV-Installer-QA\$LeaseId"
    foreach ($directory in @($root, $default, (Join-Path $env:LOCALAPPDATA 'Programs\ChordV'), (Join-Path $env:APPDATA 'app.chordv.desktop'), (Join-Path $env:LOCALAPPDATA 'app.chordv.desktop'), (Join-Path $env:APPDATA 'ChordV'), (Join-Path $env:APPDATA 'ChordV-MyGo-Local'))) {
        Assert-NoReparse $directory
        if (Test-Path -LiteralPath $directory) { throw "测试前目录必须不存在：$directory" }
    }
    if (Get-Process -Name 'ChordV', 'chordv-desktop', 'chordv_desktop' -ErrorAction SilentlyContinue) { throw '已存在同名进程，不进行安装验收。' }
    foreach ($directory in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) {
        if (Get-ChildItem -LiteralPath $directory -Filter '*ChordV*' -ErrorAction SilentlyContinue) { throw '已有ChordV快捷方式或菜单目录，未覆盖任何入口。' }
    }
    $null = New-Item -ItemType Directory -Path $root
    @{ Sid = $ExpectedSid; LeaseId = $LeaseId; Profile = $profile } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $root 'qa-owner.json') -Encoding utf8
    return @{ Root = $root; DefaultRoot = $default; MyGoDefaultRoot = (Join-Path $env:LOCALAPPDATA 'Programs\ChordV'); Sid = $ExpectedSid; Profile = $profile; ProxyBefore = Get-ProxySnapshot }
}

function Assert-ArtifactHash($Artifact) {
    Assert-NoReparse $Artifact.file
    if ((Get-FileHash -LiteralPath $Artifact.file -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Artifact.sha256) { throw '安装输入在检查后发生变化，未执行。' }
}

function Assert-AppVersion([string]$File, [string]$ExpectedVersion) {
    $version = [Diagnostics.FileVersionInfo]::GetVersionInfo($File)
    if ($version.ProductName -ne 'ChordV' -or $version.ProductVersion -notmatch ('^' + [regex]::Escape($ExpectedVersion) + '(?:\.0)?$')) { throw "真实应用PE产品/版本不匹配：$File" }
    return @{ ProductName = $version.ProductName; ProductVersion = $version.ProductVersion; FileVersion = $version.FileVersion; SHA256 = (Get-FileHash -LiteralPath $File).Hash.ToLowerInvariant(); Signature = (Get-AuthenticodeSignature -LiteralPath $File).Status.ToString() }
}

Export-ModuleMember -Function New-InstallerSandbox, Assert-NoReparse, Get-ChordVRegistry, Assert-NoChordVRegistration, Get-ProxySnapshot, Assert-ArtifactHash, Assert-AppVersion
