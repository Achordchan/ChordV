//! Headless installer maintenance. Restores only ChordV-owned proxy settings,
//! then stops runtime processes whose executable path is exactly our private bin.
use super::*;

pub fn cleanup_legacy_connection(app: &AppHandle) -> Result<(), String> {
    let result: Result<(), String> = with_command_budget(Duration::from_secs(20), || {
        let binary = runtime_binary_path(app);
        let expected = binary.to_string_lossy().to_string();
        let script = format!(
            "$ErrorActionPreference='Stop'; $pids=@(Get-CimInstance Win32_Process -Filter \"Name = 'xray.exe'\" | Where-Object {{ $_.ExecutablePath -eq {} }} | Select-Object -ExpandProperty ProcessId); ConvertTo-Json -InputObject $pids -Compress",
            powershell_quote(&expected)
        );
        let output = Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .creation_flags(CREATE_NO_WINDOW).bounded_output().map_err(|error| error.to_string())?;
        if !output.status.success() { return Err("无法确认旧版运行组件状态，安装已停止".into()); }
        let pids: Vec<u32> = serde_json::from_slice(&output.stdout)
            .map_err(|error| format!("无法读取旧版运行组件状态：{error}"))?;
        // Older builds may have no bypass marker, or one tied to the retired
        // API domain. Prove legacy ownership via the actual listening PID, not
        // just a common loopback address. All inspection above is read-only.
        if legacy_proxy_owned_by_runtime(&pids)? {
            clear_windows_proxy().map_err(|error| error.to_string())?;
        } else if pids.is_empty() {
            clear_system_proxy().map_err(|error| error.to_string())?;
        }
        if legacy_proxy_owned_by_runtime(&pids)? {
            return Err("系统代理仍指向旧版运行组件，已保留监听进程，请重试".into());
        }
        // Restore routing before removing any listener.
        for pid in pids {
            // Recheck the process identity before terminating; do not use a broad
            // image-name kill that could affect another proxy application's core.
            let Some(command) = runtime_process_command(pid)? else { continue; };
            if !command.to_lowercase().contains(&expected.to_lowercase()) {
                return Err("运行组件身份已变化，安装已停止，请重试".into());
            }
            kill_pid(pid)?;
        }
        clear_runtime_pid(app);
        Ok(())
    });
    append_download_diagnostic_log(app, "installer-maintenance", match &result {
        Ok(()) => "旧版连接清理完成".to_string(), Err(error) => error.clone(),
    });
    result
}

fn legacy_proxy_owned_by_runtime(pids: &[u32]) -> Result<bool, String> {
    if pids.is_empty() { return Ok(false); }
    let ids = pids.iter().map(u32::to_string).collect::<Vec<_>>().join(",");
    let script = format!(
        r#"$ErrorActionPreference='Stop'; $owned=@({ids}); $proxy=Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'; $ownsProxy=$false; if ($proxy.ProxyEnable -eq 1 -and ([string]$proxy.ProxyServer -match '^127\.0\.0\.1:([0-9]+)$')) {{ $proxyPort=[int]$Matches[1]; $ownsProxy=@(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object {{ $_.LocalPort -eq $proxyPort -and (@('127.0.0.1','0.0.0.0') -contains $_.LocalAddress) -and ($owned -contains $_.OwningProcess) }}).Count -gt 0 }}; ConvertTo-Json -InputObject $ownsProxy -Compress"#
    );
    let output = Command::new("powershell.exe").args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .creation_flags(CREATE_NO_WINDOW).bounded_output().map_err(|error| error.to_string())?;
    if !output.status.success() { return Err("无法确认旧版代理监听归属，安装已停止".into()); }
    serde_json::from_slice(&output.stdout).map_err(|error| format!("旧版代理监听归属响应无效：{error}"))
}
