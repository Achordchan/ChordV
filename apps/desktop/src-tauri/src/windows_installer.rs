//! Headless installer maintenance. Restores only ChordV-owned proxy settings,
//! then stops runtime processes whose executable path is exactly our private bin.
use super::*;

pub fn cleanup_legacy_connection(app: &AppHandle) -> Result<(), String> {
    let result: Result<(), String> = with_command_budget(Duration::from_secs(20), || {
        // Restore routing first: never remove a listener while Windows still
        // points its system proxy at that listener.
        clear_system_proxy().map_err(|error| error.to_string())?;
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
