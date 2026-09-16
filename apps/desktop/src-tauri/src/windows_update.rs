//! Signed Windows updates: Tauri verifies the package and delegates installation
//! to NSIS. No application-directory copying or PowerShell execution occurs here.
use super::*;
use tauri_plugin_updater::{Update, UpdaterExt};

#[cfg(windows)]
pub fn installation_in_progress() -> bool {
    mutex_is_present(r"Local\ChordV.Update.InProgress")
}

#[cfg(windows)]
fn mutex_is_present(name: &str) -> bool {
    use windows_sys::Win32::{Foundation::{CloseHandle, GetLastError, ERROR_ACCESS_DENIED}, System::Threading::OpenMutexW};
    let name: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
    let handle = unsafe { OpenMutexW(0x0010_0000, 0, name.as_ptr()) };
    if handle.is_null() { return unsafe { GetLastError() } == ERROR_ACCESS_DENIED; }
    unsafe { CloseHandle(handle); }
    true
}

struct PreparedUpdate { update: Update, bytes: Vec<u8>, path: PathBuf }
#[derive(Default)]
pub struct PreparedState(Mutex<Option<PreparedUpdate>>);

pub async fn download(app: &AppHandle, channel: &Channel<DesktopInstallerDownloadProgress>, expected_version: Option<&str>) -> Result<DesktopInstallerDownloadResult, String> {
    set_installer_operation_active(app, true)?;
    let result = download_inner(app, channel, expected_version).await;
    let _ = set_installer_operation_active(app, false);
    result
}

async fn download_inner(app: &AppHandle, channel: &Channel<DesktopInstallerDownloadProgress>, expected_version: Option<&str>) -> Result<DesktopInstallerDownloadResult, String> {
    let mut endpoint = api_base_url_parsed()?.join("/api/client/update/tauri").map_err(|e| e.to_string())?;
    endpoint.query_pairs_mut().append_pair("currentVersion", &app.package_info().version.to_string());
    if !cfg!(debug_assertions) && endpoint.scheme() != "https" { return Err("更新服务必须使用 HTTPS".into()); }
    let updater = app.updater_builder().endpoints(vec![endpoint]).map_err(|e| e.to_string())?
        .timeout(Duration::from_secs(30)).build().map_err(|e| e.to_string())?;
    let mut update = updater.check().await.map_err(|e| format!("检查签名更新失败：{e}"))?
        .ok_or("当前没有可安装的签名更新，请重新检查版本")?;
    if expected_version.is_some_and(|version| version != update.version) {
        return Err("发布版本已变化，请重新检查更新后再下载".into());
    }
    update.timeout = Some(Duration::from_secs(DOWNLOAD_TOTAL_TIMEOUT_SECS));
    let expected_size = require_desktop_update_download_size(json_u64_field(&update.raw_json, &["fileSizeBytes"]))?;
    let file_name = format!("ChordV_{}_x64-setup.exe", update.version);
    let path = ensure_installer_download_dir(app)?.join(&file_name);
    let progress = |phase: &str, bytes, message: &str| send_update_download_progress(app, channel, DesktopInstallerDownloadProgress {
        phase: phase.into(), file_name: Some(file_name.clone()), downloaded_bytes: bytes,
        total_bytes: Some(expected_size), local_path: None, message: Some(message.into()),
    });
    progress("preparing", 0, "正在准备签名安装包…");
    let mut downloaded = 0u64;
    let mut last_emit = Instant::now();
    let (limit_sender, mut limit_receiver) = tokio::sync::mpsc::channel::<()>(1);
    let download = update.download(|bytes, _| {
        downloaded = downloaded.saturating_add(bytes as u64);
        if downloaded > expected_size { let _ = limit_sender.try_send(()); }
        if last_emit.elapsed() >= Duration::from_millis(120) || downloaded == expected_size {
            progress("downloading", downloaded, "正在下载安装包…"); last_emit = Instant::now();
        }
    }, || {});
    let bytes = tokio::select! {
        result = download => result.map_err(|e| format!("下载或签名校验失败：{e}"))?,
        _ = limit_receiver.recv() => return Err("安装包超过清单声明的大小，已取消下载".into()),
    };
    if bytes.len() as u64 != expected_size { return Err("安装包大小与发布清单不一致".into()); }
    progress("verifying", expected_size, "签名已验证，正在保存安装包…");
    fs::write(&path, &bytes).map_err(|e| format!("保存安装包失败：{e}"))?;
    if let Some(hash) = json_string_field(&update.raw_json, &["fileHash"]) {
        verify_file_sha256(&path, &hash, "Windows installer")?;
    }
    *app.state::<PreparedState>().0.lock().map_err(|_| "更新状态异常")? = Some(PreparedUpdate { update, bytes, path: path.clone() });
    progress("completed", expected_size, "安装包已验证，点击安装并重启。");
    Ok(DesktopInstallerDownloadResult { file_name, local_path: path.to_string_lossy().into_owned(), total_bytes: Some(expected_size) })
}

pub fn install(app: &AppHandle) -> Result<CommandResult, String> {
    set_installer_operation_active(app, true)?;
    let result = (|| {
        let prepared = app.state::<PreparedState>();
        let pending = prepared.0.lock().map_err(|_| "更新状态异常")?;
        let pending = pending.as_ref().ok_or("没有已验证的更新包，请重新下载")?;
        // Only in-memory bytes verified by Update::download reach Update::install;
        // a replaced cache file can never change the executable being installed.
        shutdown_runtime_state(app)?;
        let intent_path = desktop_update_report_path(app)?.with_file_name("official-install-pending.json");
        fs::write(&intent_path, serde_json::json!({"version": pending.update.version}).to_string()).map_err(|e| e.to_string())?;
        if let Err(error) = pending.update.install(&pending.bytes) {
            let _ = fs::remove_file(intent_path);
            return Err(format!("安装器启动失败：{error}"));
        }
        Ok(CommandResult { ok: true, config_path: Some(pending.path.to_string_lossy().into_owned()), log_path: None, active_pid: None })
    })();
    let _ = set_installer_operation_active(app, false);
    result
}

pub fn reconcile_install_result(app: &AppHandle) -> Result<(), String> {
    let path = desktop_update_report_path(app)?.with_file_name("official-install-pending.json");
    if !path.exists() { return Ok(()); }
    let value = crate::update_report::parse(&fs::read_to_string(&path).map_err(|e| e.to_string())?)?;
    let expected = value["version"].as_str().ok_or("更新结果缺少目标版本")?;
    let installed = app.package_info().version.to_string() == expected;
    write_desktop_update_install_report(app, installed, "tauri_nsis",
        if installed { "更新安装完成" } else { "上次更新尚未完成，当前仍在运行原版本，请重试安装。" }, None, None)?;
    fs::remove_file(path).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use tauri::test::{mock_builder, mock_context, noop_assets};

    #[test]
    fn official_plugin_verifies_fixture_and_rejects_tampering() {
        let fixture: Value = serde_json::from_str(include_str!("../../../api/test/fixtures/tauri-signature.json")).unwrap();
        for tamper in [false, true] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let base = format!("http://{}", listener.local_addr().unwrap());
            let body = format!("{}{}", fixture["payload"].as_str().unwrap(), if tamper {"changed"} else {""});
            let descriptor = json!({"version":"99.0.0", "url":format!("{base}/installer"), "signature":fixture["signature"]}).to_string();
            let worker = thread::spawn(move || {
                // Exactly two scoped test requests (check, download), no external network.
                for response in [descriptor, body] {
                    let (mut stream, _) = listener.accept().unwrap();
                    stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
                    let mut request = [0u8; 8192]; let _ = stream.read(&mut request).unwrap();
                    write!(stream,"HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", response.len(), response).unwrap();
                }
            });
            let mut context = mock_context(noop_assets());
            context.config_mut().plugins.0.insert("updater".into(), json!({"pubkey": fixture["publicKey"], "dangerousInsecureTransportProtocol":true}));
            let app = mock_builder().plugin(tauri_plugin_updater::Builder::new().pubkey(fixture["publicKey"].as_str().unwrap()).build())
                .build(context).unwrap();
            let updater = app.updater_builder().endpoints(vec![base.parse().unwrap()]).unwrap().no_proxy().timeout(Duration::from_secs(5)).build().unwrap();
            tauri::async_runtime::block_on(async {
                let update = updater.check().await.unwrap().unwrap();
                let mut received = 0;
                let result = update.download(|count,_| received += count, || {}).await;
                assert_eq!(result.is_err(), tamper);
                if !tamper { assert_eq!(result.unwrap().len(), received); }
            });
            worker.join().unwrap();
        }
    }
    #[cfg(windows)]
    #[test]
    fn installer_gate_follows_kernel_handle_lifetime() {
        use windows_sys::Win32::{Foundation::CloseHandle, System::Threading::CreateMutexW};
        let name = format!("Local\\ChordV.Update.Test.{}", std::process::id());
        assert!(!mutex_is_present(&name));
        let wide: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
        let handle = unsafe { CreateMutexW(std::ptr::null(), 0, wide.as_ptr()) };
        assert!(!handle.is_null());
        assert!(mutex_is_present(&name));
        unsafe { CloseHandle(handle); }
        assert!(!mutex_is_present(&name));
    }

}
