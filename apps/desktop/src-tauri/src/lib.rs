mod android_mobile_plugin;
mod android_runtime;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs::{self, File},
    io::{self, Write},
    net::{SocketAddr, TcpStream, ToSocketAddrs},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    thread,
    time::{Duration, Instant},
};
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder},
    AppHandle, Emitter, Manager, RunEvent, State,
};
use reqwest::Client;
use url::Url;

#[cfg(not(target_os = "android"))]
use native_tls::TlsConnector;
use sha2::{Digest, Sha256};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
use windows_sys::Win32::Networking::WinInet::{InternetSetOptionW, INTERNET_OPTION_REFRESH, INTERNET_OPTION_SETTINGS_CHANGED};

#[cfg(windows)]
use std::io::{BufRead, BufReader};

#[cfg(any(target_os = "windows", target_os = "macos"))]
use tauri::tray::TrayIconBuilder;

#[cfg(windows)]
use tauri::tray::{MouseButton, MouseButtonState, TrayIconEvent};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[cfg(windows)]
const DEFAULT_PROXY_TEST_URL: &str = "http://example.com/";

const ANDROID_TUN_NAME: &str = "chordv-vpn";
const ANDROID_TUN_MTU: u16 = 1500;
const ANDROID_TUN_IPV4_ADDRESS: &str = "172.19.0.2";
const ANDROID_TUN_IPV4_PREFIX: u8 = 30;
const ANDROID_TUN_IPV6_ADDRESS: &str = "fd66:6f72:6463::2";
const ANDROID_TUN_IPV6_PREFIX: u8 = 126;

struct RuntimeState {
    status: String,
    active_session_id: Option<String>,
    active_node_id: Option<String>,
    active_node_name: Option<String>,
    config_path: Option<PathBuf>,
    log_path: Option<PathBuf>,
    xray_binary_path: Option<PathBuf>,
    active_pid: Option<u32>,
    local_http_port: Option<u16>,
    local_socks_port: Option<u16>,
    last_error: Option<String>,
    child: Option<Child>,
}

#[derive(Default)]
struct ShellState {
    status: String,
    signed_in: bool,
    node_name: Option<String>,
    primary_action_label: String,
}

#[derive(Default)]
struct RuntimeComponentDownloadState {
    active: bool,
}

#[derive(Debug, Deserialize, Serialize, Clone, Copy)]
#[serde(rename_all = "snake_case")]
enum RuntimeComponentSourceFormat {
    Direct,
    ZipEntry,
}

#[derive(Debug, Deserialize, Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum RuntimeComponentKindInput {
    Xray,
    Geoip,
    Geosite,
}

fn shell_primary_action_label(status: &str) -> String {
    match status {
        "connected" | "connecting" | "disconnecting" => "断开连接".to_string(),
        "error" => "返回主界面重试".to_string(),
        _ => "打开主界面连接".to_string(),
    }
}

impl Default for RuntimeState {
    fn default() -> Self {
        Self {
            status: "idle".into(),
            active_session_id: None,
            active_node_id: None,
            active_node_name: None,
            config_path: None,
            log_path: None,
            xray_binary_path: None,
            active_pid: None,
            local_http_port: None,
            local_socks_port: None,
            last_error: None,
            child: None,
        }
    }
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct NodeSummaryDto {
    id: String,
    name: String,
    region: String,
    provider: String,
    tags: Vec<String>,
    recommended: bool,
    latency_ms: u32,
    protocol: String,
    security: String,
    server_host: Option<String>,
    server_port: Option<u16>,
    server_name: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RuntimeOutboundDto {
    protocol: String,
    server: String,
    port: u16,
    uuid: String,
    flow: String,
    reality_public_key: String,
    short_id: String,
    server_name: String,
    fingerprint: String,
    spider_x: String,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct GeneratedRuntimeConfigDto {
    session_id: String,
    node: NodeSummaryDto,
    mode: String,
    local_http_port: u16,
    local_socks_port: u16,
    routing_profile: String,
    generated_at: String,
    features: RuntimePolicyFeaturesDto,
    outbound: RuntimeOutboundDto,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RuntimePolicyFeaturesDto {
    block_ads: bool,
    china_direct: bool,
    ai_services_proxy: bool,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct UserProfileDto {
    id: String,
    email: String,
    display_name: String,
    role: String,
    status: String,
    last_seen_at: String,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AuthSessionDto {
    access_token: String,
    refresh_token: String,
    user: UserProfileDto,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct NodeProbeResultDto {
    node_id: String,
    status: String,
    latency_ms: Option<u32>,
    checked_at: String,
    error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeStatusResponse {
    status: String,
    active_session_id: Option<String>,
    active_node_id: Option<String>,
    active_node_name: Option<String>,
    config_path: Option<String>,
    log_path: Option<String>,
    xray_binary_path: Option<String>,
    active_pid: Option<u32>,
    last_error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeLogResponse {
    log: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CommandResult {
    ok: bool,
    config_path: Option<String>,
    log_path: Option<String>,
    active_pid: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShellSummaryInput {
    status: String,
    signed_in: Option<bool>,
    node_name: Option<String>,
    primary_action_label: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApiRequestInput {
    method: String,
    path: String,
    headers: Option<HashMap<String, String>>,
    body: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ApiResponseOutput {
    status: u16,
    body: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopInstallerDownloadInput {
    url: String,
    file_name: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DesktopInstallerDownloadResult {
    file_name: String,
    local_path: String,
    total_bytes: Option<u64>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DesktopInstallerDownloadProgress {
    phase: String,
    file_name: Option<String>,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
    local_path: Option<String>,
    message: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopRuntimeEnvironment {
    platform: String,
    architecture: String,
    runtime_bin_dir: Option<String>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RuntimeComponentDownloadItemInput {
    id: String,
    component: RuntimeComponentKindInput,
    file_name: String,
    source_format: RuntimeComponentSourceFormat,
    archive_entry_name: Option<String>,
    checksum_sha256: Option<String>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RuntimeComponentDownloadInput {
    component: RuntimeComponentDownloadItemInput,
    url: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeComponentDownloadResult {
    component: String,
    local_path: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeComponentFileStatus {
    ready: bool,
    exists: bool,
    path: Option<String>,
    reason_code: Option<String>,
    message: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RuntimeComponentDownloadProgress {
    phase: String,
    component: String,
    file_name: Option<String>,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
    message: Option<String>,
}

#[tauri::command]
fn load_session(app: AppHandle) -> Result<Option<AuthSessionDto>, String> {
    let path = session_path(&app)?;
    if !path.exists() {
        return Ok(None);
    }

    let content = fs::read_to_string(path).map_err(|error| error.to_string())?;
    let session = serde_json::from_str::<AuthSessionDto>(&content).map_err(|error| error.to_string())?;
    Ok(Some(session))
}

#[tauri::command]
fn save_session(app: AppHandle, session: AuthSessionDto) -> Result<CommandResult, String> {
    let path = session_path(&app)?;
    let parent = path.parent().ok_or_else(|| "会话路径无效".to_string())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let serialized = serde_json::to_string(&session).map_err(|error| error.to_string())?;
    fs::write(&path, serialized).map_err(|error| error.to_string())?;
    set_private_permissions(&path)?;

    Ok(CommandResult {
        ok: true,
        config_path: None,
        log_path: None,
        active_pid: None,
    })
}

#[tauri::command]
fn clear_session(app: AppHandle) -> Result<CommandResult, String> {
    let state: State<'_, Mutex<RuntimeState>> = app.state();
    if let Ok(mut state) = state.lock() {
        shutdown_runtime(&app, &mut state);
    } else {
        let _ = clear_system_proxy();
    }

    let path = session_path(&app)?;
    if path.exists() {
        fs::remove_file(path).map_err(|error| error.to_string())?;
    }

    Ok(CommandResult {
        ok: true,
        config_path: None,
        log_path: None,
        active_pid: None,
    })
}

#[tauri::command]
async fn api_request(request: ApiRequestInput) -> Result<ApiResponseOutput, String> {
    let base = std::env::var("CHORDV_API_BASE_URL").unwrap_or_else(|_| "https://v.baymaxgroup.com".to_string());
    let base = base.trim_end_matches('/');
    let api_path = if request.path.starts_with("/api/") {
        request.path.clone()
    } else {
        format!("/api{}", request.path)
    };
    let full_url = format!("{base}{api_path}");
    let url = Url::parse(&full_url).map_err(|error| format!("API 地址无效：{error}"))?;

    let force_https = std::env::var("CHORDV_DESKTOP_FORCE_HTTPS")
        .unwrap_or_else(|_| if cfg!(debug_assertions) { "false".into() } else { "true".into() })
        .to_lowercase()
        == "true";
    if force_https && url.scheme() != "https" {
        return Err("生产环境仅允许 HTTPS API".into());
    }

    let pinned_fingerprint = std::env::var("CHORDV_API_CERT_SHA256")
        .ok()
        .map(|value| value.trim().to_lowercase())
        .filter(|value| !value.is_empty());
    if let Some(expected) = pinned_fingerprint {
        verify_server_certificate_fingerprint(&url, &expected)?;
    }

    let method = reqwest::Method::from_bytes(request.method.trim().to_uppercase().as_bytes())
        .map_err(|error| format!("HTTP 方法无效：{error}"))?;

    let mut req = Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|error| format!("初始化 API 客户端失败：{error}"))?
        .request(method, url);

    if let Some(headers) = request.headers {
        for (name, value) in headers {
            req = req.header(name, value);
        }
    }

    if let Some(body) = request.body {
        req = req.body(body);
    }

    let response = req.send().await.map_err(|error| format!("请求 API 失败：{error}"))?;
    let status = response.status().as_u16();
    let body = response.text().await.map_err(|error| format!("读取响应失败：{error}"))?;
    Ok(ApiResponseOutput { status, body })
}

#[tauri::command]
async fn download_desktop_installer(
    app: AppHandle,
    input: DesktopInstallerDownloadInput,
) -> Result<DesktopInstallerDownloadResult, String> {
    #[cfg(target_os = "android")]
    {
        let _ = (app, input);
        return Err("安卓端不支持桌面安装器下载".into());
    }

    #[cfg(not(target_os = "android"))]
    {
        let url = Url::parse(input.url.trim()).map_err(|error| format!("下载地址无效：{error}"))?;
        if !matches!(url.scheme(), "https" | "http") {
            return Err("下载地址仅支持 HTTP 或 HTTPS".into());
        }

        let file_name = resolve_installer_file_name(&url, input.file_name.as_deref());
        emit_update_download_progress(
            &app,
            DesktopInstallerDownloadProgress {
                phase: "preparing".into(),
                file_name: Some(file_name.clone()),
                downloaded_bytes: 0,
                total_bytes: None,
                local_path: None,
                message: Some("正在准备下载安装器…".into()),
            },
        );

        let download_dir = ensure_installer_download_dir(&app)?;
        let final_path = unique_download_path(&download_dir, &file_name);
        let temp_path = final_path.with_extension(format!(
            "{}part",
            final_path
                .extension()
                .and_then(|value| value.to_str())
                .map(|value| format!("{value}."))
                .unwrap_or_default()
        ));

        let client = Client::builder()
            .timeout(Duration::from_secs(600))
            .build()
            .map_err(|error| format!("初始化下载器失败：{error}"))?;
        let mut response = client
            .get(url.clone())
            .send()
            .await
            .map_err(|error| format!("下载安装器失败：{error}"))?;

        if !response.status().is_success() {
            return Err(format!("下载安装器失败：HTTP {}", response.status().as_u16()));
        }

        let total_bytes = response.content_length();
        let mut downloaded_bytes = 0_u64;
        let mut file = File::create(&temp_path).map_err(|error| format!("创建安装器文件失败：{error}"))?;
        emit_update_download_progress(
            &app,
            DesktopInstallerDownloadProgress {
                phase: "downloading".into(),
                file_name: Some(file_name.clone()),
                downloaded_bytes,
                total_bytes,
                local_path: None,
                message: Some("正在下载安装器…".into()),
            },
        );

        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|error| format!("下载安装器失败：{error}"))?
        {
            file.write_all(&chunk)
                .map_err(|error| format!("写入安装器文件失败：{error}"))?;
            downloaded_bytes += chunk.len() as u64;
            emit_update_download_progress(
                &app,
                DesktopInstallerDownloadProgress {
                    phase: "downloading".into(),
                    file_name: Some(file_name.clone()),
                    downloaded_bytes,
                    total_bytes,
                    local_path: None,
                    message: Some("正在下载安装器…".into()),
                },
            );
        }

        file.flush().map_err(|error| format!("写入安装器文件失败：{error}"))?;
        fs::rename(&temp_path, &final_path).map_err(|error| format!("保存安装器文件失败：{error}"))?;

        let local_path = final_path.to_string_lossy().into_owned();
        emit_update_download_progress(
            &app,
            DesktopInstallerDownloadProgress {
                phase: "completed".into(),
                file_name: Some(file_name.clone()),
                downloaded_bytes,
                total_bytes,
                local_path: Some(local_path.clone()),
                message: Some("安装器下载完成，正在打开安装程序…".into()),
            },
        );

        Ok(DesktopInstallerDownloadResult {
            file_name,
            local_path,
            total_bytes: total_bytes.or(Some(downloaded_bytes)),
        })
    }
}

#[tauri::command]
fn open_desktop_installer(path: String) -> Result<CommandResult, String> {
    #[cfg(target_os = "android")]
    {
        let _ = path;
        return Err("安卓端不支持桌面安装器打开".into());
    }

    #[cfg(not(target_os = "android"))]
    {
        let installer_path = PathBuf::from(path);
        if !installer_path.exists() {
            return Err("安装器文件不存在".into());
        }

        #[cfg(target_os = "macos")]
        {
            let status = Command::new("open")
                .arg(&installer_path)
                .status()
                .map_err(|error| format!("打开安装器失败：{error}"))?;
            if !status.success() {
                return Err("打开安装器失败".into());
            }
        }

        #[cfg(windows)]
        {
            let mut command = Command::new("cmd");
            command.creation_flags(CREATE_NO_WINDOW);
            command.args(["/C", "start", "", &installer_path.to_string_lossy()]);
            let status = command.status().map_err(|error| format!("打开安装器失败：{error}"))?;
            if !status.success() {
                return Err("打开安装器失败".into());
            }
        }

        Ok(CommandResult {
            ok: true,
            config_path: Some(installer_path.to_string_lossy().into_owned()),
            log_path: None,
            active_pid: None,
        })
    }
}

#[tauri::command]
fn desktop_runtime_environment(app: AppHandle) -> Result<DesktopRuntimeEnvironment, String> {
    #[cfg(target_os = "android")]
    {
        let _ = app;
        return Err("安卓端不支持桌面运行时环境".into());
    }

    #[cfg(not(target_os = "android"))]
    {
        let runtime_bin_dir = ensure_runtime_bin_dir(&app)?;
        Ok(DesktopRuntimeEnvironment {
            platform: runtime_platform_name().into(),
            architecture: detect_runtime_component_architecture().into(),
            runtime_bin_dir: Some(runtime_bin_dir.to_string_lossy().into_owned()),
        })
    }
}

#[tauri::command]
fn check_runtime_component_file(
    app: AppHandle,
    component: RuntimeComponentDownloadItemInput,
) -> Result<RuntimeComponentFileStatus, String> {
    #[cfg(target_os = "android")]
    {
        let _ = (app, component);
        return Err("安卓端不支持桌面内核组件检查".into());
    }

    #[cfg(not(target_os = "android"))]
    {
        let target_path = runtime_component_target_path(&app, component.component)?;
        if !target_path.exists() {
            return Ok(RuntimeComponentFileStatus {
                ready: false,
                exists: false,
                path: None,
                reason_code: Some("component_missing".into()),
                message: Some(format!("{} 尚未下载。", runtime_component_display_name(component.component))),
            });
        }
        let metadata = fs::metadata(&target_path)
            .map_err(|error| runtime_component_error("write_failed", format!("读取组件文件状态失败：{error}")))?;
        if metadata.len() == 0 {
            return Ok(RuntimeComponentFileStatus {
                ready: false,
                exists: true,
                path: Some(target_path.to_string_lossy().into_owned()),
                reason_code: Some("component_empty".into()),
                message: Some(format!("{} 文件为空，请重新下载。", runtime_component_display_name(component.component))),
            });
        }

        if component.component == RuntimeComponentKindInput::Xray {
            ensure_executable(&target_path)?;
        }

        if let Some(expected_hash) = component
            .checksum_sha256
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            let actual = sha256_file(&target_path)?;
            if actual != normalize_sha256(expected_hash) {
                return Ok(RuntimeComponentFileStatus {
                    ready: false,
                    exists: true,
                    path: Some(target_path.to_string_lossy().into_owned()),
                    reason_code: Some("hash_mismatch".into()),
                    message: Some(format!("{} 校验失败，请重新下载。", runtime_component_display_name(component.component))),
                });
            }
        }

        Ok(RuntimeComponentFileStatus {
            ready: true,
            exists: true,
            path: Some(target_path.to_string_lossy().into_owned()),
            reason_code: None,
            message: Some(format!("{} 已准备完成。", runtime_component_display_name(component.component))),
        })
    }
}

#[tauri::command]
async fn download_runtime_component(
    app: AppHandle,
    input: RuntimeComponentDownloadInput,
) -> Result<RuntimeComponentDownloadResult, String> {
    #[cfg(target_os = "android")]
    {
        let _ = (app, input);
        return Err("安卓端不支持桌面内核组件下载".into());
    }

    #[cfg(not(target_os = "android"))]
    {
        set_runtime_component_download_active(&app, true)?;
        let component = input.component.component;
        let component_name = runtime_component_key(component);
        let result = async {
            let download_url =
                Url::parse(input.url.trim()).map_err(|error| runtime_component_error("download_failed", format!("下载地址无效：{error}")))?;
            if !matches!(download_url.scheme(), "https" | "http") {
                return Err(runtime_component_error("download_failed", "下载地址仅支持 HTTP 或 HTTPS".into()));
            }

            let runtime_dir = ensure_runtime_dir(&app)?;
            let downloads_dir = runtime_dir.join("downloads");
            fs::create_dir_all(&downloads_dir)
                .map_err(|error| runtime_component_error("write_failed", format!("创建组件下载目录失败：{error}")))?;

            let download_name = sanitize_runtime_download_file_name(&input.component.file_name);
            let archive_path = downloads_dir.join(format!(
                "{}-{}-{}.download",
                component_name, input.component.id, download_name
            ));
            let target_path = runtime_component_target_path(&app, component)?;
            let temp_target_path = target_path.with_extension("part");

            emit_runtime_component_progress(
                &app,
                RuntimeComponentDownloadProgress {
                    phase: "preparing".into(),
                    component: component_name.into(),
                    file_name: Some(input.component.file_name.clone()),
                    downloaded_bytes: 0,
                    total_bytes: None,
                    message: Some(format!("正在准备 {}…", runtime_component_display_name(component))),
                },
            );

            let client = Client::builder()
                .timeout(Duration::from_secs(600))
                .build()
                .map_err(|error| runtime_component_error("download_failed", format!("初始化组件下载器失败：{error}")))?;
            let mut response = client
                .get(download_url.clone())
                .send()
                .await
                .map_err(|error| runtime_component_error("download_failed", format!("下载 {} 失败：{error}", runtime_component_display_name(component))))?;

            if !response.status().is_success() {
                return Err(runtime_component_error(
                    "download_failed",
                    format!("下载 {} 失败：HTTP {}", runtime_component_display_name(component), response.status().as_u16()),
                ));
            }

            let total_bytes = response.content_length();
            let mut downloaded_bytes = 0_u64;
            let mut archive_file = File::create(&archive_path)
                .map_err(|error| runtime_component_error("write_failed", format!("创建组件缓存文件失败：{error}")))?;

            emit_runtime_component_progress(
                &app,
                RuntimeComponentDownloadProgress {
                    phase: "downloading".into(),
                    component: component_name.into(),
                    file_name: Some(input.component.file_name.clone()),
                    downloaded_bytes,
                    total_bytes,
                    message: Some(format!("正在下载 {}…", runtime_component_display_name(component))),
                },
            );

            while let Some(chunk) = response
                .chunk()
                .await
                .map_err(|error| runtime_component_error("download_failed", format!("下载 {} 失败：{error}", runtime_component_display_name(component))))?
            {
                archive_file
                    .write_all(&chunk)
                    .map_err(|error| runtime_component_error("write_failed", format!("写入组件文件失败：{error}")))?;
                downloaded_bytes += chunk.len() as u64;
                emit_runtime_component_progress(
                    &app,
                    RuntimeComponentDownloadProgress {
                        phase: "downloading".into(),
                        component: component_name.into(),
                        file_name: Some(input.component.file_name.clone()),
                        downloaded_bytes,
                        total_bytes,
                        message: Some(format!("正在下载 {}…", runtime_component_display_name(component))),
                    },
                );
            }

            archive_file
                .flush()
                .map_err(|error| runtime_component_error("write_failed", format!("写入组件文件失败：{error}")))?;

            emit_runtime_component_progress(
                &app,
                RuntimeComponentDownloadProgress {
                    phase: "extracting".into(),
                    component: component_name.into(),
                    file_name: Some(input.component.file_name.clone()),
                    downloaded_bytes,
                    total_bytes,
                    message: Some(format!("正在整理 {}…", runtime_component_display_name(component))),
                },
            );

            match input.component.source_format {
                RuntimeComponentSourceFormat::Direct => {
                    fs::copy(&archive_path, &temp_target_path)
                        .map_err(|error| runtime_component_error("write_failed", format!("写入 {} 失败：{error}", runtime_component_display_name(component))))?;
                }
                RuntimeComponentSourceFormat::ZipEntry => {
                    let entry_name = input
                        .component
                        .archive_entry_name
                        .clone()
                        .filter(|value| !value.trim().is_empty())
                        .unwrap_or_else(|| input.component.file_name.clone());
                    extract_zip_entry(&archive_path, &temp_target_path, &entry_name)
                        .map_err(|error| runtime_component_error("extract_failed", error))?;
                }
            }

            if let Some(expected_hash) = input
                .component
                .checksum_sha256
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                let actual = sha256_file(&temp_target_path)?;
                if actual != normalize_sha256(expected_hash) {
                    let _ = fs::remove_file(&temp_target_path);
                    let _ = fs::remove_file(&archive_path);
                    return Err(runtime_component_error(
                        "hash_mismatch",
                        format!("{} 校验失败，请检查下载源。", runtime_component_display_name(component)),
                    ));
                }
            }

            if component == RuntimeComponentKindInput::Xray {
                ensure_executable(&temp_target_path)?;
            }

            if target_path.exists() {
                let _ = fs::remove_file(&target_path);
            }
            fs::rename(&temp_target_path, &target_path)
                .map_err(|error| runtime_component_error("write_failed", format!("保存 {} 失败：{error}", runtime_component_display_name(component))))?;
            let _ = fs::remove_file(&archive_path);

            let local_path = target_path.to_string_lossy().into_owned();
            emit_runtime_component_progress(
                &app,
                RuntimeComponentDownloadProgress {
                    phase: "completed".into(),
                    component: component_name.into(),
                    file_name: Some(target_path
                        .file_name()
                        .and_then(|value| value.to_str())
                        .unwrap_or(&input.component.file_name)
                        .to_string()),
                    downloaded_bytes: total_bytes.unwrap_or(downloaded_bytes),
                    total_bytes: total_bytes.or(Some(downloaded_bytes)),
                    message: Some(format!("{} 已准备完成。", runtime_component_display_name(component))),
                },
            );
            Ok(RuntimeComponentDownloadResult {
                component: component_name.into(),
                local_path: Some(local_path),
            })
        }
        .await;

        if let Err(error) = &result {
            emit_runtime_component_failed(
                &app,
                component_name,
                Some(input.component.file_name.clone()),
                0,
                None,
                error,
            );
        }
        let _ = set_runtime_component_download_active(&app, false);
        result
    }
}

#[tauri::command]
fn probe_nodes(nodes: Vec<NodeSummaryDto>) -> Vec<NodeProbeResultDto> {
    nodes.into_iter().map(probe_single_node).collect()
}

#[tauri::command]
fn show_main_window(app: AppHandle) -> Result<CommandResult, String> {
    show_main_window_internal(&app)?;
    Ok(CommandResult {
        ok: true,
        config_path: None,
        log_path: None,
        active_pid: None,
    })
}

#[tauri::command]
fn hide_main_window(app: AppHandle) -> Result<CommandResult, String> {
    hide_main_window_internal(&app)?;
    Ok(CommandResult {
        ok: true,
        config_path: None,
        log_path: None,
        active_pid: None,
    })
}

#[tauri::command]
fn quit_application(app: AppHandle) -> Result<CommandResult, String> {
    app.exit(0);
    Ok(CommandResult {
        ok: true,
        config_path: None,
        log_path: None,
        active_pid: None,
    })
}

#[tauri::command]
fn update_shell_summary(
    app: AppHandle,
    shell_state: State<'_, Mutex<ShellState>>,
    summary: ShellSummaryInput,
) -> Result<CommandResult, String> {
    {
        let mut state = shell_state
            .lock()
            .map_err(|_| "桌面壳层状态异常".to_string())?;
        state.status = summary.status;
        state.signed_in = summary.signed_in.unwrap_or(false);
        state.node_name = summary.node_name;
        state.primary_action_label = summary
            .primary_action_label
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "连接/断开".to_string());
    }

    refresh_shell_ui(&app)?;

    Ok(CommandResult {
        ok: true,
        config_path: None,
        log_path: None,
        active_pid: None,
    })
}

#[tauri::command]
fn app_ready(_app: AppHandle) -> Result<CommandResult, String> {
    #[cfg(not(target_os = "android"))]
    if let Some(window) = _app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
        let _ = disable_context_menu(&window);
        let _ = refresh_shell_ui(&_app);
    }

    Ok(CommandResult {
        ok: true,
        config_path: None,
        log_path: None,
        active_pid: None,
    })
}

#[tauri::command]
fn runtime_status(app: AppHandle, state: State<'_, Mutex<RuntimeState>>) -> RuntimeStatusResponse {
    let mut state = state.lock().expect("runtime state lock");
    refresh_child_state(&mut state);
    #[cfg(not(target_os = "android"))]
    sync_shell_from_runtime(&app, &state);
    to_runtime_status_response(&state)
}

#[tauri::command]
fn runtime_logs(state: State<'_, Mutex<RuntimeState>>) -> RuntimeLogResponse {
    let mut state = state.lock().expect("runtime state lock");
    refresh_child_state(&mut state);

    let log = state
        .log_path
        .as_ref()
        .map(|path| tail_log(path, 80))
        .unwrap_or_default();

    RuntimeLogResponse { log }
}

#[tauri::command]
fn connect_runtime(
    app: AppHandle,
    config: GeneratedRuntimeConfigDto,
    state: State<'_, Mutex<RuntimeState>>,
) -> Result<CommandResult, String> {
    {
        let mut state = state.lock().map_err(|_| "运行时状态异常".to_string())?;
        let had_runtime = state.active_session_id.is_some() || state.active_pid.is_some();
        stop_runtime_process(&app, &mut state);

        if had_runtime {
            let _ = clear_system_proxy();
        }

        if let Err(error) = detect_external_network_conflict(config.local_http_port, config.local_socks_port) {
            state.status = "error".into();
            state.active_session_id = None;
            state.active_node_id = None;
            state.active_node_name = None;
            state.last_error = Some(error.clone());
            #[cfg(not(target_os = "android"))]
            sync_shell_from_runtime(&app, &state);
            return Err(error);
        }

        state.status = "starting".into();
        state.active_session_id = Some(config.session_id.clone());
        state.active_node_id = Some(config.node.id.clone());
        state.active_node_name = Some(config.node.name.clone());
        state.local_http_port = Some(config.local_http_port);
        state.local_socks_port = Some(config.local_socks_port);
        state.last_error = None;
        #[cfg(not(target_os = "android"))]
        sync_shell_from_runtime(&app, &state);
    }

    let runtime_dir = ensure_runtime_dir(&app)?;
    let xray_binary_path = match tauri::async_runtime::block_on(prepare_desktop_runtime_components(&app, &runtime_dir)) {
        Ok(path) => path,
        Err(error) => {
            let mut state = state.lock().map_err(|_| "运行时状态异常".to_string())?;
            state.status = "error".into();
            state.active_session_id = None;
            state.active_node_id = None;
            state.active_node_name = None;
            state.local_http_port = None;
            state.local_socks_port = None;
            state.last_error = Some(error.clone());
            #[cfg(not(target_os = "android"))]
            sync_shell_from_runtime(&app, &state);
            return Err(error);
        }
    };

    let mut state = state.lock().map_err(|_| "运行时状态异常".to_string())?;
    state.status = "connecting".into();
    state.active_session_id = Some(config.session_id.clone());
    state.active_node_id = Some(config.node.id.clone());
    state.active_node_name = Some(config.node.name.clone());
    state.local_http_port = Some(config.local_http_port);
    state.local_socks_port = Some(config.local_socks_port);
    state.last_error = None;
    #[cfg(not(target_os = "android"))]
    sync_shell_from_runtime(&app, &state);
    let config_path = runtime_dir.join(format!("{}.json", config.session_id));
    let log_path = runtime_dir.join(format!("{}.log", config.session_id));

    write_xray_config(&config, &config_path, &log_path)?;

    let stdout = File::create(&log_path).map_err(|error| error.to_string())?;
    let stderr = stdout.try_clone().map_err(|error| error.to_string())?;

    let mut command = Command::new(&xray_binary_path);
    command
        .arg("run")
        .arg("-config")
        .arg(&config_path)
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr));

    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    let mut child = command
        .spawn()
        .map_err(|error| format!("启动内核失败：{error}"))?;

    thread::sleep(Duration::from_millis(900));

    if let Some(exit_status) = child.try_wait().map_err(|error| error.to_string())? {
        let log = tail_log(&log_path, 40);
        state.status = "error".into();
        state.active_session_id = None;
        state.config_path = Some(config_path.clone());
        state.log_path = Some(log_path.clone());
        state.xray_binary_path = Some(xray_binary_path.clone());
        state.active_pid = None;
        state.local_http_port = None;
        state.local_socks_port = None;
        state.last_error = Some(format!("内核已退出：{exit_status}"));
        sync_shell_from_runtime(&app, &state);

        return Err(if log.is_empty() {
            format!("内核启动失败：{exit_status}")
        } else {
            format!("内核启动失败：{exit_status}\n{log}")
        });
    }

    if let Err(error) = set_system_proxy(config.local_http_port, config.local_socks_port) {
        rollback_connect_failure(&app, &mut state, &mut child, format!("设置系统代理失败：{error}"));
        return Err(format!("设置系统代理失败：{error}"));
    }

    if let Err(error) = verify_runtime_ready(config.local_http_port, config.local_socks_port) {
        rollback_connect_failure(&app, &mut state, &mut child, error.clone());
        return Err(error);
    }

    state.status = "connected".into();
    state.config_path = Some(config_path.clone());
    state.log_path = Some(log_path.clone());
    state.xray_binary_path = Some(xray_binary_path.clone());
    state.active_pid = Some(child.id());
    persist_runtime_pid(&app, child.id());
    state.child = Some(child);
    sync_shell_from_runtime(&app, &state);

    Ok(CommandResult {
        ok: true,
        config_path: Some(config_path.to_string_lossy().into_owned()),
        log_path: Some(log_path.to_string_lossy().into_owned()),
        active_pid: state.active_pid,
    })
}

#[tauri::command]
fn disconnect_runtime(app: AppHandle, state: State<'_, Mutex<RuntimeState>>) -> Result<CommandResult, String> {
    let _ = state;
    disconnect_runtime_internal(&app)?;

    Ok(CommandResult {
        ok: true,
        config_path: None,
        log_path: None,
        active_pid: None,
    })
}

fn ensure_runtime_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let mut path = app
        .path()
        .app_local_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("chordv-desktop"));
    path.push("runtime");
    fs::create_dir_all(&path).map_err(|error| error.to_string())?;
    Ok(path)
}

fn ensure_runtime_bin_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let bin_dir = ensure_runtime_dir(app)?.join("bin");
    fs::create_dir_all(&bin_dir).map_err(|error| error.to_string())?;
    Ok(bin_dir)
}

fn ensure_xray_binary(_app: &AppHandle, runtime_dir: &Path) -> Result<PathBuf, String> {
    let installed_path = runtime_dir.join("bin").join(runtime_binary_name());
    if !installed_path.exists() {
        return Err("必要内核组件未就绪，请先等待组件下载完成后再连接。".into());
    }
    let metadata = fs::metadata(&installed_path).map_err(|error| error.to_string())?;
    if metadata.len() == 0 {
        return Err("Xray 内核文件损坏，请重新下载必要内核组件。".into());
    }
    ensure_executable(&installed_path)?;
    Ok(installed_path)
}

fn runtime_binary_name() -> &'static str {
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        "xray.exe"
    }

    #[cfg(not(all(target_os = "windows", target_arch = "x86_64")))]
    {
        "xray"
    }
}

fn ensure_executable(_path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        let mut permissions = fs::metadata(_path)
            .map_err(|error| error.to_string())?
            .permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(_path, permissions).map_err(|error| error.to_string())?;
    }

    Ok(())
}

fn set_private_permissions(_path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        let mut permissions = fs::metadata(_path)
            .map_err(|error| error.to_string())?
            .permissions();
        permissions.set_mode(0o600);
        fs::set_permissions(_path, permissions).map_err(|error| error.to_string())?;
    }

    Ok(())
}

fn ensure_geo_data(app: &AppHandle, runtime_dir: &Path) -> Result<(), String> {
    let _ = app;
    for kind in [RuntimeComponentKindInput::Geoip, RuntimeComponentKindInput::Geosite] {
        let target = runtime_dir.join("bin").join(runtime_component_file_name(kind));
        if !target.exists() {
            return Err(format!(
                "{} 未就绪，请先等待组件下载完成后再连接。",
                runtime_component_display_name(kind)
            ));
        }
        let metadata = fs::metadata(&target).map_err(|error| error.to_string())?;
        if metadata.len() == 0 {
            return Err(format!(
                "{} 文件损坏，请重新下载必要内核组件。",
                runtime_component_display_name(kind)
            ));
        }
    }
    Ok(())
}

async fn prepare_desktop_runtime_components(app: &AppHandle, runtime_dir: &Path) -> Result<PathBuf, String> {
    let xray_path = ensure_xray_binary(app, runtime_dir)?;
    ensure_geo_data(app, runtime_dir)?;
    Ok(xray_path)
}

fn runtime_component_target_path(app: &AppHandle, component: RuntimeComponentKindInput) -> Result<PathBuf, String> {
    Ok(ensure_runtime_bin_dir(app)?.join(runtime_component_file_name(component)))
}

fn runtime_component_file_name(component: RuntimeComponentKindInput) -> &'static str {
    match component {
        RuntimeComponentKindInput::Xray => runtime_binary_name(),
        RuntimeComponentKindInput::Geoip => "geoip.dat",
        RuntimeComponentKindInput::Geosite => "geosite.dat",
    }
}

fn runtime_component_display_name(component: RuntimeComponentKindInput) -> &'static str {
    match component {
        RuntimeComponentKindInput::Xray => "Xray 内核",
        RuntimeComponentKindInput::Geoip => "GeoIP 数据",
        RuntimeComponentKindInput::Geosite => "GeoSite 数据",
    }
}

fn runtime_component_key(component: RuntimeComponentKindInput) -> &'static str {
    match component {
        RuntimeComponentKindInput::Xray => "xray",
        RuntimeComponentKindInput::Geoip => "geoip",
        RuntimeComponentKindInput::Geosite => "geosite",
    }
}

fn runtime_platform_name() -> &'static str {
    #[cfg(target_os = "windows")]
    {
        "windows"
    }

    #[cfg(target_os = "macos")]
    {
        "macos"
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        "unsupported"
    }
}

fn detect_runtime_component_architecture() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        if let Ok(output) = Command::new("uname").arg("-m").output() {
            let architecture = String::from_utf8_lossy(&output.stdout).trim().to_lowercase();
            if architecture.contains("arm") || architecture.contains("aarch64") {
                return "arm64";
            }
            return "x64";
        }
    }

    #[cfg(windows)]
    {
        if let Ok(value) = std::env::var("PROCESSOR_ARCHITECTURE") {
            let normalized = value.trim().to_lowercase();
            if normalized.contains("arm") {
                return "arm64";
            }
        }
        if let Ok(value) = std::env::var("PROCESSOR_ARCHITEW6432") {
            let normalized = value.trim().to_lowercase();
            if normalized.contains("arm") {
                return "arm64";
            }
        }
        return "x64";
    }

    #[allow(unreachable_code)]
    "x64"
}

fn emit_runtime_component_progress(app: &AppHandle, progress: RuntimeComponentDownloadProgress) {
    let _ = app.emit("chordv://runtime-component-download-progress", progress);
}

fn runtime_component_error(code: &str, message: String) -> String {
    format!("runtime_component_error:{code}:{message}")
}

fn emit_runtime_component_failed(
    app: &AppHandle,
    component: &str,
    file_name: Option<String>,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
    message: &str,
) {
    emit_runtime_component_progress(
        app,
        RuntimeComponentDownloadProgress {
            phase: "failed".into(),
            component: component.into(),
            file_name,
            downloaded_bytes,
            total_bytes,
            message: Some(message.to_string()),
        },
    );
}

fn set_runtime_component_download_active(app: &AppHandle, active: bool) -> Result<(), String> {
    let state: State<'_, Mutex<RuntimeComponentDownloadState>> = app.state();
    let mut state = state
        .lock()
        .map_err(|_| "运行时组件下载状态异常".to_string())?;
    if active && state.active {
        return Err("必要内核组件正在下载，请稍后再试。".into());
    }
    state.active = active;
    Ok(())
}

fn sanitize_runtime_download_file_name(file_name: &str) -> String {
    sanitize_desktop_download_file_name(file_name)
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|error| runtime_component_error("write_failed", format!("读取组件文件失败：{error}")))?;
    Ok(hex::encode(Sha256::digest(bytes)))
}

fn normalize_sha256(value: &str) -> String {
    value.trim().replace(':', "").to_lowercase()
}

fn extract_zip_entry(archive_path: &Path, target_path: &Path, entry_name: &str) -> Result<(), String> {
    let file = File::open(archive_path).map_err(|error| format!("打开组件压缩包失败：{error}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|error| format!("解析组件压缩包失败：{error}"))?;
    let normalized_entry = entry_name.replace('\\', "/");

    let mut index = None;
    for idx in 0..archive.len() {
        let Ok(file) = archive.by_index(idx) else {
            continue;
        };
        let candidate = file.name().replace('\\', "/");
        if candidate == normalized_entry || candidate.ends_with(&format!("/{normalized_entry}")) {
            index = Some(idx);
            break;
        }
    }

    let idx = index.ok_or_else(|| format!("压缩包内缺少指定文件：{entry_name}"))?;
    let mut entry = archive
        .by_index(idx)
        .map_err(|error| format!("读取压缩包内容失败：{error}"))?;
    if let Some(parent) = target_path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建目标目录失败：{error}"))?;
    }
    let mut target = File::create(target_path).map_err(|error| format!("创建目标文件失败：{error}"))?;
    io::copy(&mut entry, &mut target).map_err(|error| format!("写入解压文件失败：{error}"))?;
    target.flush().map_err(|error| format!("写入解压文件失败：{error}"))?;
    Ok(())
}

fn ensure_installer_download_dir(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(download_dir) = app.path().download_dir() {
        let target = download_dir.join("ChordV 安装包");
        fs::create_dir_all(&target).map_err(|error| format!("创建下载目录失败：{error}"))?;
        return Ok(target);
    }

    let fallback = app
        .path()
        .app_local_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("chordv-desktop"))
        .join("downloads");
    fs::create_dir_all(&fallback).map_err(|error| format!("创建下载目录失败：{error}"))?;
    Ok(fallback)
}

fn unique_download_path(dir: &Path, file_name: &str) -> PathBuf {
    let candidate = dir.join(file_name);
    if !candidate.exists() {
        return candidate;
    }

    let stem = Path::new(file_name)
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("ChordV");
    let extension = Path::new(file_name)
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| format!(".{value}"))
        .unwrap_or_default();

    for index in 1..=999 {
        let next = dir.join(format!("{stem}-{index}{extension}"));
        if !next.exists() {
            return next;
        }
    }

    dir.join(format!("{stem}-{}{}", chrono::Utc::now().timestamp(), extension))
}

fn resolve_installer_file_name(url: &Url, preferred: Option<&str>) -> String {
    let preferred_name = preferred
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(sanitize_desktop_download_file_name);
    if let Some(value) = preferred_name {
        return value;
    }

    let from_url = url
        .path_segments()
        .and_then(|segments| segments.filter(|value| !value.is_empty()).last())
        .map(sanitize_desktop_download_file_name)
        .filter(|value| !value.is_empty());
    if let Some(value) = from_url {
        return value;
    }

    #[cfg(target_os = "macos")]
    {
        return "ChordV.dmg".into();
    }

    #[cfg(windows)]
    {
        return "ChordV-setup.exe".into();
    }

    #[allow(unreachable_code)]
    "ChordV-installer.bin".into()
}

fn sanitize_desktop_download_file_name(file_name: &str) -> String {
    let trimmed = file_name.trim();
    let safe = trimmed
        .chars()
        .map(|ch| {
            if ch.is_alphanumeric() || matches!(ch, '.' | '_' | '-') {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>();
    let normalized = safe.trim_matches('_').replace("__", "_");
    if normalized.is_empty() {
        "ChordV-installer.bin".into()
    } else {
        normalized
    }
}

fn emit_update_download_progress(app: &AppHandle, progress: DesktopInstallerDownloadProgress) {
    let _ = app.emit("chordv://update-download-progress", progress);
}

fn write_xray_config(
    config: &GeneratedRuntimeConfigDto,
    config_path: &Path,
    log_path: &Path,
) -> Result<(), String> {
    let content = build_xray_config(config, log_path, false);
    let serialized = serde_json::to_string_pretty(&content).map_err(|error| error.to_string())?;
    fs::write(config_path, serialized).map_err(|error| error.to_string())
}

pub(crate) fn build_xray_config(
    config: &GeneratedRuntimeConfigDto,
    log_path: &Path,
    android_runtime: bool,
) -> Value {
    json!({
      "log": {
        "loglevel": if android_runtime { "info" } else { "warning" },
        "error": log_path.to_string_lossy().to_string()
      },
      "dns": build_dns_config(android_runtime),
      "inbounds": build_inbounds(config, android_runtime),
      "outbounds": build_outbounds(config),
      "routing": {
        "domainMatcher": "hybrid",
        "domainStrategy": if android_runtime { "IPIfNonMatch" } else { "AsIs" },
        "rules": routing_rules(config.mode.as_str(), &config.features)
      }
    })
}

fn build_dns_config(android_runtime: bool) -> Value {
    let mut servers = vec![
        json!({
          "address": "223.5.5.5",
          "domains": ["geosite:cn"],
          "expectIPs": ["geoip:cn"]
        }),
        json!({
          "address": "1.1.1.1",
          "domains": ["geosite:geolocation-!cn"]
        }),
    ];

    if !android_runtime {
        servers.push(json!("localhost"));
    }

    json!({
      "disableCache": false,
      "queryStrategy": if android_runtime { "UseIP" } else { "UseIPv4" },
      "servers": servers
    })
}

fn build_inbounds(config: &GeneratedRuntimeConfigDto, android_runtime: bool) -> Value {
    if android_runtime {
        json!([
          {
            "tag": "tun-in",
            "protocol": "tun",
            "port": 0,
            "sniffing": {
              "enabled": true,
              "routeOnly": false,
              "destOverride": ["http", "tls", "quic"]
            },
            "settings": {
              "name": ANDROID_TUN_NAME,
              "MTU": ANDROID_TUN_MTU,
              "inet4_address": [format!("{}/{}", ANDROID_TUN_IPV4_ADDRESS, ANDROID_TUN_IPV4_PREFIX)],
              "inet6_address": [format!("{}/{}", ANDROID_TUN_IPV6_ADDRESS, ANDROID_TUN_IPV6_PREFIX)],
              "stack": "system"
            }
          }
        ])
    } else {
        json!([
          {
            "tag": "http-in",
            "listen": "127.0.0.1",
            "port": config.local_http_port,
            "protocol": "http",
            "sniffing": {
              "enabled": true,
              "destOverride": ["http", "tls", "quic"]
            },
            "settings": {}
          },
          {
            "tag": "socks-in",
            "listen": "127.0.0.1",
            "port": config.local_socks_port,
            "protocol": "socks",
            "sniffing": {
              "enabled": true,
              "destOverride": ["http", "tls", "quic"]
            },
            "settings": {
              "auth": "noauth",
              "udp": true
            }
          }
        ])
    }
}

fn build_outbounds(config: &GeneratedRuntimeConfigDto) -> Value {
    json!([
      {
        "tag": "proxy",
        "protocol": "vless",
        "settings": {
          "vnext": [
            {
              "address": config.outbound.server,
              "port": config.outbound.port,
              "users": [
                {
                  "id": config.outbound.uuid,
                  "encryption": "none",
                  "flow": config.outbound.flow
                }
              ]
            }
          ]
        },
        "streamSettings": {
          "network": "tcp",
          "security": "reality",
          "realitySettings": {
            "serverName": config.outbound.server_name,
            "fingerprint": config.outbound.fingerprint,
            "publicKey": config.outbound.reality_public_key,
            "shortId": config.outbound.short_id,
            "spiderX": config.outbound.spider_x
          }
        }
      },
      {
        "tag": "direct",
        "protocol": "freedom"
      },
      {
        "tag": "block",
        "protocol": "blackhole"
      }
    ])
}

fn routing_rules(mode: &str, features: &RuntimePolicyFeaturesDto) -> Value {
    match mode {
        "global" => json!([
          {
            "type": "field",
            "network": "tcp,udp",
            "outboundTag": "proxy"
          }
        ]),
        "direct" => json!([
          {
            "type": "field",
            "network": "tcp,udp",
            "outboundTag": "direct"
          }
        ]),
        _ => {
            let mut rules = vec![json!({
                "type": "field",
                "ip": ["geoip:private"],
                "outboundTag": "direct"
            })];

            if features.block_ads {
                rules.push(json!({
                    "type": "field",
                    "domain": ["geosite:category-ads-all"],
                    "outboundTag": "block"
                }));
            }

            if features.china_direct {
                rules.push(json!({
                    "type": "field",
                    "domain": ["geosite:cn"],
                    "outboundTag": "direct"
                }));
                rules.push(json!({
                    "type": "field",
                    "ip": ["geoip:cn"],
                    "outboundTag": "direct"
                }));
            }

            rules.push(json!({
                "type": "field",
                "domain": ai_service_domains(),
                "outboundTag": if features.ai_services_proxy { "proxy" } else { "direct" }
            }));

            rules.push(json!({
                "type": "field",
                "domain": [
                    "domain:google.com",
                    "domain:youtube.com",
                    "domain:github.com",
                    "domain:telegram.org",
                    "domain:t.me",
                    "domain:twitter.com",
                    "domain:x.com",
                    "domain:discord.com",
                    "domain:discord.gg",
                    "domain:netflix.com",
                    "geosite:geolocation-!cn"
                ],
                "outboundTag": "proxy"
            }));

            rules.push(json!({
                "type": "field",
                "network": "tcp,udp",
                "outboundTag": "proxy"
            }));

            Value::Array(rules)
        }
    }
}

fn ai_service_domains() -> Value {
    json!([
        "domain:openai.com",
        "domain:chatgpt.com",
        "domain:oaistatic.com",
        "domain:oaiusercontent.com",
        "domain:anthropic.com",
        "domain:claude.ai",
        "domain:perplexity.ai",
        "domain:x.ai",
        "domain:grok.com",
        "domain:ai.google.dev",
        "domain:gemini.google.com",
        "domain:makersuite.google.com"
    ])
}

fn refresh_child_state(state: &mut RuntimeState) {
    if let Some(child) = state.child.as_mut() {
        match child.try_wait() {
            Ok(Some(status)) => {
                let _ = clear_system_proxy();
                state.status = "error".into();
                state.active_pid = None;
                state.child = None;
                state.config_path = None;
                state.local_http_port = None;
                state.local_socks_port = None;
                state.active_node_name = None;
                state.last_error = Some(format!("内核已退出：{status}"));
            }
            Ok(None) => {
                if state.status == "connecting" {
                    state.status = "connected".into();
                }
            }
            Err(error) => {
                let _ = clear_system_proxy();
                state.status = "error".into();
                state.active_pid = None;
                state.child = None;
                state.config_path = None;
                state.local_http_port = None;
                state.local_socks_port = None;
                state.active_node_name = None;
                state.last_error = Some(format!("读取 xray 状态失败：{error}"));
            }
        }
    }

    if let (Some(http_port), Some(socks_port)) = (state.local_http_port, state.local_socks_port) {
        if (state.status == "connected" || state.status == "connecting")
            && (!is_port_open(http_port) && !is_port_open(socks_port))
        {
            let _ = clear_system_proxy();
            state.status = "error".into();
            state.active_pid = None;
            state.child = None;
            state.config_path = None;
            state.local_http_port = None;
            state.local_socks_port = None;
            state.active_node_name = None;
            state.last_error = Some("内核未运行".into());
        }
    }
}

fn stop_runtime_process(app: &AppHandle, state: &mut RuntimeState) {
    if let Some(mut child) = state.child.take() {
        let _ = child.kill();
        let _ = child.wait();
    }

    if let Some(pid) = load_runtime_pid(app) {
        let _ = kill_pid(pid);
    }

    if let Some(path) = state.config_path.take() {
        let _ = fs::remove_file(path);
    }

    clear_runtime_pid(app);
    state.active_pid = None;
    state.local_http_port = None;
    state.local_socks_port = None;
}

fn session_path(app: &AppHandle) -> Result<PathBuf, String> {
    let mut path = app
        .path()
        .app_local_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("chordv-desktop"));
    path.push("session.json");
    Ok(path)
}

fn runtime_pid_path(app: &AppHandle) -> PathBuf {
    app.path()
        .app_local_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("chordv-desktop"))
        .join("runtime")
        .join("xray.pid")
}

fn persist_runtime_pid(app: &AppHandle, pid: u32) {
    let path = runtime_pid_path(app);
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::write(path, pid.to_string());
}

fn load_runtime_pid(app: &AppHandle) -> Option<u32> {
    let path = runtime_pid_path(app);
    let content = fs::read_to_string(path).ok()?;
    content.trim().parse::<u32>().ok()
}

fn clear_runtime_pid(app: &AppHandle) {
    let path = runtime_pid_path(app);
    let _ = fs::remove_file(path);
}

fn kill_pid(pid: u32) -> Result<(), String> {
    #[cfg(unix)]
    {
        let status = Command::new("kill")
            .args(["-9", &pid.to_string()])
            .status()
            .map_err(|error| error.to_string())?;
        if status.success() {
            return Ok(());
        }
        return Err(format!("结束进程失败：{pid}"));
    }

    #[cfg(windows)]
    {
        let mut command = Command::new("taskkill");
        command.args(["/PID", &pid.to_string(), "/T", "/F"]);
        command.creation_flags(CREATE_NO_WINDOW);
        let status = command.status().map_err(|error| error.to_string())?;
        if status.success() {
            return Ok(());
        }
        return Err(format!("结束进程失败：{pid}"));
    }

    #[allow(unreachable_code)]
    Err(format!("当前平台不支持结束进程：{pid}"))
}

fn probe_single_node(node: NodeSummaryDto) -> NodeProbeResultDto {
    let checked_at = chrono_like_now();
    let Some(server_host) = node.server_host.as_deref() else {
        return NodeProbeResultDto {
            node_id: node.id,
            status: "offline".into(),
            latency_ms: None,
            checked_at,
            error: Some("节点缺少测速地址".into()),
        };
    };
    let Some(server_port) = node.server_port else {
        return NodeProbeResultDto {
            node_id: node.id,
            status: "offline".into(),
            latency_ms: None,
            checked_at,
            error: Some("节点缺少测速端口".into()),
        };
    };
    let start = Instant::now();
    let outcome = resolve_socket_addr(server_host, server_port)
        .and_then(|address| TcpStream::connect_timeout(&address, Duration::from_secs(4)).map_err(|error| error.to_string()));

    match outcome {
        Ok(_) => NodeProbeResultDto {
            node_id: node.id,
            status: "healthy".into(),
            latency_ms: Some((start.elapsed().as_millis().max(1)).min(u128::from(u32::MAX)) as u32),
            checked_at,
            error: None,
        },
        Err(error) => NodeProbeResultDto {
            node_id: node.id,
            status: "offline".into(),
            latency_ms: None,
            checked_at,
            error: Some(error),
        },
    }
}

fn resolve_socket_addr(host: &str, port: u16) -> Result<SocketAddr, String> {
    let mut addresses = (host, port)
        .to_socket_addrs()
        .map_err(|error| error.to_string())?;
    addresses
        .next()
        .ok_or_else(|| format!("无法解析地址：{host}:{port}"))
}

fn verify_server_certificate_fingerprint(url: &Url, expected: &str) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        let _ = (url, expected);
        return Ok(());
    }

    #[cfg(not(target_os = "android"))]
    {
    let host = url
        .host_str()
        .ok_or_else(|| "API 地址缺少主机名".to_string())?;
    let port = url.port_or_known_default().unwrap_or(443);
    let tcp = TcpStream::connect((host, port)).map_err(|error| format!("建立 TLS 连接失败：{error}"))?;
    let connector = TlsConnector::builder()
        .danger_accept_invalid_certs(true)
        .build()
        .map_err(|error| format!("初始化 TLS 连接器失败：{error}"))?;
    let tls = connector
        .connect(host, tcp)
        .map_err(|error| format!("TLS 握手失败：{error}"))?;
    let cert = tls
        .peer_certificate()
        .map_err(|error| format!("读取服务端证书失败：{error}"))?
        .ok_or_else(|| "服务端未返回证书".to_string())?;
    let der = cert
        .to_der()
        .map_err(|error| format!("解析服务端证书失败：{error}"))?;
    let hash = Sha256::digest(der);
    let actual = hex::encode(hash);
    let normalized = expected.replace(':', "").to_lowercase();
    if actual != normalized {
        return Err("API 证书指纹校验失败".into());
    }
    Ok(())
    }
}

fn chrono_like_now() -> String {
    let now = std::time::SystemTime::now();
    let datetime: chrono::DateTime<chrono::Utc> = now.into();
    datetime.to_rfc3339()
}

fn shutdown_runtime(app: &AppHandle, state: &mut RuntimeState) {
    let _ = clear_system_proxy();

    stop_runtime_process(app, state);
    state.status = "idle".into();
    state.active_session_id = None;
    state.active_node_id = None;
    state.active_node_name = None;
    state.config_path = None;
    state.log_path = None;
    state.xray_binary_path = None;
    state.local_http_port = None;
    state.local_socks_port = None;
    state.last_error = None;
}

fn tail_log(path: &Path, lines: usize) -> String {
    let Ok(content) = fs::read_to_string(path) else {
        return String::new();
    };

    let collected = content
        .lines()
        .rev()
        .take(lines)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>();

    collected.join("\n")
}

fn is_port_open(port: u16) -> bool {
    TcpStream::connect(("127.0.0.1", port)).is_ok()
}

fn to_runtime_status_response(state: &RuntimeState) -> RuntimeStatusResponse {
    RuntimeStatusResponse {
        status: state.status.clone(),
        active_session_id: state.active_session_id.clone(),
        active_node_id: state.active_node_id.clone(),
        active_node_name: state.active_node_name.clone(),
        config_path: state
            .config_path
            .as_ref()
            .map(|path| path.to_string_lossy().into_owned()),
        log_path: state
            .log_path
            .as_ref()
            .map(|path| path.to_string_lossy().into_owned()),
        xray_binary_path: state
            .xray_binary_path
            .as_ref()
            .map(|path| path.to_string_lossy().into_owned()),
        active_pid: state.active_pid,
        last_error: state.last_error.clone(),
    }
}

fn rollback_connect_failure(
    app: &AppHandle,
    state: &mut RuntimeState,
    child: &mut Child,
    message: String,
) {
    let _ = child.kill();
    let _ = child.wait();
    let _ = clear_system_proxy();
    stop_runtime_process(app, state);
    state.status = "error".into();
    state.active_session_id = None;
    state.active_node_id = None;
    state.active_node_name = None;
    state.config_path = None;
    state.log_path = None;
    state.xray_binary_path = None;
    state.active_pid = None;
    state.local_http_port = None;
    state.local_socks_port = None;
    state.last_error = Some(message);
    #[cfg(not(target_os = "android"))]
    sync_shell_from_runtime(app, state);
}

fn verify_runtime_ready(http_port: u16, socks_port: u16) -> Result<(), String> {
    let start = Instant::now();
    let timeout = Duration::from_secs(6);
    let mut http_ready = false;
    let mut socks_ready = false;

    while start.elapsed() < timeout {
        http_ready = is_port_open(http_port);
        socks_ready = is_port_open(socks_port);
        if http_ready && socks_ready {
            break;
        }
        thread::sleep(Duration::from_millis(200));
    }

    if !http_ready || !socks_ready {
        return Err("本地代理端口启动失败".into());
    }

    #[cfg(windows)]
    verify_http_proxy_flow(http_port)?;

    Ok(())
}

#[cfg(windows)]
fn verify_http_proxy_flow(http_port: u16) -> Result<(), String> {
    let address = ("127.0.0.1", http_port);
    let mut stream = TcpStream::connect_timeout(
        &address
            .to_socket_addrs()
            .map_err(|error| format!("解析本地代理地址失败：{error}"))?
            .next()
            .ok_or_else(|| "解析本地代理地址失败".to_string())?,
        Duration::from_secs(4),
    )
    .map_err(|error| format!("连接本地代理失败：{error}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(6)))
        .map_err(|error| error.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(6)))
        .map_err(|error| error.to_string())?;

    let request = format!(
        "GET {DEFAULT_PROXY_TEST_URL} HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\nUser-Agent: ChordV-SelfCheck\r\n\r\n"
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|error| format!("写入本地代理失败：{error}"))?;
    stream.flush().map_err(|error| error.to_string())?;

    let mut reader = BufReader::new(stream);
    let mut first_line = String::new();
    reader
        .read_line(&mut first_line)
        .map_err(|error| format!("读取本地代理响应失败：{error}"))?;

    if !first_line.starts_with("HTTP/1.1 ") && !first_line.starts_with("HTTP/1.0 ") {
        return Err("本地代理连通性校验失败".into());
    }

    let status = first_line
        .split_whitespace()
        .nth(1)
        .and_then(|value| value.parse::<u16>().ok())
        .ok_or_else(|| "本地代理返回了无效状态码".to_string())?;

    if (200..400).contains(&status) {
        Ok(())
    } else {
        Err(format!("本地代理连通性校验失败：HTTP {status}"))
    }
}

fn set_system_proxy(http_port: u16, socks_port: u16) -> Result<(), io::Error> {
    #[cfg(target_os = "macos")]
    {
        set_proxy(http_port, socks_port)
    }

    #[cfg(windows)]
    {
        set_windows_proxy(http_port, socks_port)
    }

    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = (http_port, socks_port);
        Ok(())
    }
}

fn clear_system_proxy() -> Result<(), io::Error> {
    #[cfg(target_os = "macos")]
    {
        clear_proxy()
    }

    #[cfg(windows)]
    {
        clear_windows_proxy()
    }

    #[cfg(not(any(target_os = "macos", windows)))]
    {
        Ok(())
    }
}

fn detect_external_network_conflict(http_port: u16, socks_port: u16) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        detect_macos_external_network_conflict(http_port, socks_port)
    }

    #[cfg(windows)]
    {
        detect_windows_external_network_conflict(http_port, socks_port)
    }

    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = (http_port, socks_port);
        Ok(())
    }
}

#[cfg(target_os = "macos")]
fn detect_macos_external_network_conflict(http_port: u16, socks_port: u16) -> Result<(), String> {
    if let Some(vpn_name) = detect_connected_macos_vpn_name() {
        return Err(format!(
            "external_vpn_conflict: 检测到系统中已有 VPN 正在运行（{}），请先断开后再连接 ChordV。",
            vpn_name
        ));
    }

    if let Some(proxy_summary) = detect_macos_proxy_conflict(http_port, socks_port) {
        return Err(format!(
            "external_proxy_conflict: 检测到系统代理已由其他应用占用（{}），请先关闭后再连接 ChordV。",
            proxy_summary
        ));
    }

    Ok(())
}

#[cfg(target_os = "macos")]
fn detect_connected_macos_vpn_name() -> Option<String> {
    let output = Command::new("scutil").args(["--nc", "list"]).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    text.lines().find_map(|line| {
        let trimmed = line.trim();
        if !trimmed.contains("(Connected)") {
            return None;
        }
        let quoted = trimmed
            .split('"')
            .nth(1)
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        quoted.or_else(|| Some(trimmed.to_string()))
    })
}

#[cfg(target_os = "macos")]
fn detect_macos_proxy_conflict(http_port: u16, socks_port: u16) -> Option<String> {
    let output = Command::new("scutil").arg("--proxy").output().ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);

    let http_enabled = proxy_dict_flag(&text, "HTTPEnable");
    let https_enabled = proxy_dict_flag(&text, "HTTPSEnable");
    let socks_enabled = proxy_dict_flag(&text, "SOCKSEnable");

    let http_proxy = proxy_dict_value(&text, "HTTPProxy");
    let https_proxy = proxy_dict_value(&text, "HTTPSProxy");
    let socks_proxy = proxy_dict_value(&text, "SOCKSProxy");

    let http_conflict = http_enabled
        && !matches_our_proxy(http_proxy.as_deref(), proxy_dict_u16(&text, "HTTPPort"), http_port);
    let https_conflict = https_enabled
        && !matches_our_proxy(https_proxy.as_deref(), proxy_dict_u16(&text, "HTTPSPort"), http_port);
    let socks_conflict = socks_enabled
        && !matches_our_proxy(socks_proxy.as_deref(), proxy_dict_u16(&text, "SOCKSPort"), socks_port);

    if http_conflict {
        return Some(format!(
            "HTTP {}:{}",
            http_proxy.unwrap_or_else(|| "未知地址".to_string()),
            proxy_dict_u16(&text, "HTTPPort").unwrap_or_default()
        ));
    }
    if https_conflict {
        return Some(format!(
            "HTTPS {}:{}",
            https_proxy.unwrap_or_else(|| "未知地址".to_string()),
            proxy_dict_u16(&text, "HTTPSPort").unwrap_or_default()
        ));
    }
    if socks_conflict {
        return Some(format!(
            "SOCKS {}:{}",
            socks_proxy.unwrap_or_else(|| "未知地址".to_string()),
            proxy_dict_u16(&text, "SOCKSPort").unwrap_or_default()
        ));
    }

    None
}

#[cfg(target_os = "macos")]
fn proxy_dict_flag(text: &str, key: &str) -> bool {
    proxy_dict_value(text, key)
        .and_then(|value| value.parse::<u8>().ok())
        .unwrap_or(0)
        == 1
}

#[cfg(target_os = "macos")]
fn proxy_dict_u16(text: &str, key: &str) -> Option<u16> {
    proxy_dict_value(text, key)?.parse::<u16>().ok()
}

#[cfg(target_os = "macos")]
fn proxy_dict_value(text: &str, key: &str) -> Option<String> {
    text.lines().find_map(|line| {
        let trimmed = line.trim();
        let (found_key, value) = trimmed.split_once(':')?;
        if found_key.trim() == key {
            Some(value.trim().to_string())
        } else {
            None
        }
    })
}

fn matches_our_proxy(host: Option<&str>, port: Option<u16>, expected_port: u16) -> bool {
    matches!(host, Some("127.0.0.1") | Some("localhost")) && port == Some(expected_port)
}

#[cfg(windows)]
fn detect_windows_external_network_conflict(http_port: u16, socks_port: u16) -> Result<(), String> {
    if let Some(vpn_name) = detect_connected_windows_vpn_name() {
        return Err(format!(
            "external_vpn_conflict: 检测到系统中已有 VPN 正在运行（{}），请先断开后再连接 ChordV。",
            vpn_name
        ));
    }

    let expected = format!("http=127.0.0.1:{http_port};https=127.0.0.1:{http_port};socks=127.0.0.1:{socks_port}");
    if let Some(proxy_server) = detect_windows_proxy_conflict(&expected) {
        return Err(format!(
            "external_proxy_conflict: 检测到系统代理已由其他应用占用（{}），请先关闭后再连接 ChordV。",
            proxy_server
        ));
    }

    Ok(())
}

#[cfg(windows)]
fn detect_connected_windows_vpn_name() -> Option<String> {
    let mut command = Command::new("powershell");
    command.creation_flags(CREATE_NO_WINDOW);
    let output = command
        .args([
            "-NoProfile",
            "-Command",
            "Get-VpnConnection | Where-Object {$_.ConnectionStatus -eq 'Connected'} | Select-Object -ExpandProperty Name",
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    text.lines()
        .map(str::trim)
        .find(|value| !value.is_empty())
        .map(|value| value.to_string())
}

#[cfg(windows)]
fn detect_windows_proxy_conflict(expected_proxy_server: &str) -> Option<String> {
    let mut enable = Command::new("reg");
    enable.creation_flags(CREATE_NO_WINDOW);
    let enable_output = enable
        .args([
            "query",
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings",
            "/v",
            "ProxyEnable",
        ])
        .output()
        .ok()?;
    let enable_text = String::from_utf8_lossy(&enable_output.stdout).to_lowercase();
    if !enable_output.status.success() || !enable_text.contains("0x1") {
        return None;
    }

    let mut server = Command::new("reg");
    server.creation_flags(CREATE_NO_WINDOW);
    let server_output = server
        .args([
            "query",
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings",
            "/v",
            "ProxyServer",
        ])
        .output()
        .ok()?;
    if !server_output.status.success() {
        return Some("未知代理".to_string());
    }
    let server_text = String::from_utf8_lossy(&server_output.stdout);
    if server_text.contains(expected_proxy_server) {
        return None;
    }
    server_text
        .lines()
        .find_map(|line| {
            let trimmed = line.trim();
            if trimmed.contains("ProxyServer") {
                trimmed.split_whitespace().last().map(|value| value.to_string())
            } else {
                None
            }
        })
        .or_else(|| Some("未知代理".to_string()))
}

#[cfg(target_os = "macos")]
fn set_proxy(http_port: u16, socks_port: u16) -> Result<(), std::io::Error> {
    for service in network_services() {
        let _ = Command::new("networksetup")
            .args(["-setwebproxy", &service, "127.0.0.1", &http_port.to_string()])
            .status();
        let _ = Command::new("networksetup")
            .args(["-setsecurewebproxy", &service, "127.0.0.1", &http_port.to_string()])
            .status();
        let _ = Command::new("networksetup")
            .args(["-setsocksfirewallproxy", &service, "127.0.0.1", &socks_port.to_string()])
            .status();
        let _ = Command::new("networksetup")
            .args(["-setwebproxystate", &service, "on"])
            .status();
        let _ = Command::new("networksetup")
            .args(["-setsecurewebproxystate", &service, "on"])
            .status();
        let _ = Command::new("networksetup")
            .args(["-setsocksfirewallproxystate", &service, "on"])
            .status();
    }

    Ok(())
}

#[cfg(target_os = "macos")]
fn clear_proxy() -> Result<(), std::io::Error> {
    for service in network_services() {
        let _ = Command::new("networksetup")
            .args(["-setwebproxystate", &service, "off"])
            .status();
        let _ = Command::new("networksetup")
            .args(["-setsecurewebproxystate", &service, "off"])
            .status();
        let _ = Command::new("networksetup")
            .args(["-setsocksfirewallproxystate", &service, "off"])
            .status();
    }

    Ok(())
}

#[cfg(windows)]
fn set_windows_proxy(http_port: u16, socks_port: u16) -> Result<(), io::Error> {
    let proxy_server =
        format!("http=127.0.0.1:{http_port};https=127.0.0.1:{http_port};socks=127.0.0.1:{socks_port}");
    run_windows_reg(&[
        "add",
        r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings",
        "/v",
        "ProxyEnable",
        "/t",
        "REG_DWORD",
        "/d",
        "1",
        "/f",
    ])?;
    run_windows_reg(&[
        "add",
        r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings",
        "/v",
        "ProxyServer",
        "/t",
        "REG_SZ",
        "/d",
        &proxy_server,
        "/f",
    ])?;
    run_windows_reg(&[
        "add",
        r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings",
        "/v",
        "ProxyOverride",
        "/t",
        "REG_SZ",
        "/d",
        "<local>",
        "/f",
    ])?;
    refresh_windows_proxy_settings()?;
    verify_windows_proxy_config(&proxy_server)?;
    Ok(())
}

#[cfg(windows)]
fn clear_windows_proxy() -> Result<(), io::Error> {
    run_windows_reg(&[
        "add",
        r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings",
        "/v",
        "ProxyEnable",
        "/t",
        "REG_DWORD",
        "/d",
        "0",
        "/f",
    ])?;
    let _ = run_windows_reg(&[
        "delete",
        r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings",
        "/v",
        "ProxyServer",
        "/f",
    ]);
    let _ = run_windows_reg(&[
        "delete",
        r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings",
        "/v",
        "ProxyOverride",
        "/f",
    ]);
    refresh_windows_proxy_settings()?;
    Ok(())
}

#[cfg(windows)]
fn run_windows_reg(args: &[&str]) -> Result<(), io::Error> {
    let mut command = Command::new("reg");
    command.args(args);
    command.creation_flags(CREATE_NO_WINDOW);
    let status = command.status()?;
    if status.success() {
        Ok(())
    } else {
        Err(io::Error::new(io::ErrorKind::Other, format!("reg 命令执行失败：{:?}", args)))
    }
}

#[cfg(windows)]
fn verify_windows_proxy_config(expected_proxy_server: &str) -> Result<(), io::Error> {
    let mut enable = Command::new("reg");
    enable.creation_flags(CREATE_NO_WINDOW);
    let enable_output = enable
        .args([
            "query",
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings",
            "/v",
            "ProxyEnable",
        ])
        .output()?;
    let enable_text = String::from_utf8_lossy(&enable_output.stdout).to_lowercase();
    if !enable_output.status.success() || !enable_text.contains("0x1") {
        return Err(io::Error::new(io::ErrorKind::Other, "Windows 系统代理未成功启用"));
    }

    let mut server = Command::new("reg");
    server.creation_flags(CREATE_NO_WINDOW);
    let server_output = server
        .args([
            "query",
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings",
            "/v",
            "ProxyServer",
        ])
        .output()?;
    let server_text = String::from_utf8_lossy(&server_output.stdout);
    if !server_output.status.success() || !server_text.contains(expected_proxy_server) {
        return Err(io::Error::new(io::ErrorKind::Other, "Windows 系统代理地址未成功写入"));
    }

    Ok(())
}

#[cfg(windows)]
fn refresh_windows_proxy_settings() -> Result<(), io::Error> {
    unsafe {
        if InternetSetOptionW(std::ptr::null(), INTERNET_OPTION_SETTINGS_CHANGED, std::ptr::null_mut(), 0) == 0 {
            return Err(io::Error::last_os_error());
        }
        if InternetSetOptionW(std::ptr::null(), INTERNET_OPTION_REFRESH, std::ptr::null_mut(), 0) == 0 {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn network_services() -> Vec<String> {
    let output = Command::new("networksetup")
        .arg("-listnetworkserviceorder")
        .output();

    let Ok(output) = output else {
        return vec!["Wi-Fi".into(), "Ethernet".into()];
    };

    let text = String::from_utf8_lossy(&output.stdout);
    let mut services = Vec::new();
    let mut pending_name: Option<String> = None;

    for line in text.lines() {
        let trimmed = line.trim();

        if trimmed.starts_with('(') && trimmed.contains(')') && !trimmed.contains("Hardware Port:") {
            if let Some((_, rest)) = trimmed.split_once(')') {
                pending_name = Some(rest.trim().trim_start_matches('*').trim().to_string());
            }
            continue;
        }

        if trimmed.starts_with("(Hardware Port:") {
            if let Some(name) = pending_name.take() {
                let has_device = trimmed
                    .split("Device:")
                    .nth(1)
                    .map(|value| !value.trim().trim_end_matches(')').trim().is_empty())
                    .unwrap_or(false);

                if has_device && !name.is_empty() {
                    services.push(name);
                }
            }
        }
    }

    if services.is_empty() {
        vec!["Wi-Fi".into(), "Ethernet".into()]
    } else {
        services
    }
}

fn cleanup_stale_runtime(app: &AppHandle) {
    let runtime_dir = app
        .path()
        .app_local_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("chordv-desktop"))
        .join("runtime");

    if let Some(pid) = load_runtime_pid(app) {
        let _ = kill_pid(pid);
        clear_runtime_pid(app);
    }

    let stale_binary = runtime_dir.join("bin").join(runtime_binary_name());
    if stale_binary.exists() {
        #[cfg(unix)]
        let _ = Command::new("pkill")
            .args(["-f", &stale_binary.to_string_lossy()])
            .status();
    }

    let _ = fs::remove_dir_all(runtime_dir.join("bin").join("cache"));

    if let Ok(entries) = fs::read_dir(&runtime_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) == Some("json") {
                let _ = fs::remove_file(&path);
            }
            if path.extension().and_then(|ext| ext.to_str()) == Some("log") {
                let _ = fs::remove_file(&path);
            }
        }
    }

    let _ = clear_system_proxy();
}

#[cfg(not(target_os = "android"))]
fn disable_context_menu(window: &tauri::WebviewWindow) -> Result<(), String> {
    window
        .eval(
            r#"
            window.addEventListener('contextmenu', (event) => {
              event.preventDefault();
            }, { capture: true });
            "#,
        )
        .map_err(|error| error.to_string())
}

#[cfg(not(target_os = "android"))]
fn shell_status_text(status: &str) -> &'static str {
    match status {
        "signed-out" => "未登录",
        "connected" => "已连接",
        "connecting" | "starting" => "连接中",
        "disconnecting" => "断开中",
        "error" => "异常",
        _ => "空闲",
    }
}

#[cfg(not(target_os = "android"))]
fn window_for_shell(app: &AppHandle) -> Result<tauri::WebviewWindow, String> {
    app.get_webview_window("main")
        .ok_or_else(|| "主窗口不存在".to_string())
}

#[cfg(not(target_os = "android"))]
fn show_main_window_internal(app: &AppHandle) -> Result<(), String> {
    let window = window_for_shell(app)?;
    #[cfg(windows)]
    let _ = window.set_skip_taskbar(false);
    window.show().map_err(|error| error.to_string())?;
    window.unminimize().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())?;
    #[cfg(target_os = "macos")]
    {
        let _ = refresh_shell_ui(app);
    }
    Ok(())
}

#[cfg(not(target_os = "android"))]
fn hide_main_window_internal(app: &AppHandle) -> Result<(), String> {
    let window = window_for_shell(app)?;
    #[cfg(windows)]
    let _ = window.set_skip_taskbar(true);
    window.hide().map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(windows)]
fn toggle_main_window_internal(app: &AppHandle) -> Result<(), String> {
    let window = window_for_shell(app)?;
    if window.is_visible().map_err(|error| error.to_string())? {
        let _ = window.set_skip_taskbar(true);
        window.hide().map_err(|error| error.to_string())?;
    } else {
        let _ = window.set_skip_taskbar(false);
        window.show().map_err(|error| error.to_string())?;
        window.unminimize().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(not(target_os = "android"))]
fn sync_shell_from_runtime(app: &AppHandle, runtime: &RuntimeState) {
    if let Ok(mut shell) = app.state::<Mutex<ShellState>>().lock() {
        shell.status = runtime.status.clone();
        shell.signed_in = true;
        shell.node_name = runtime.active_node_name.clone();
        shell.primary_action_label = shell_primary_action_label(&runtime.status);
    }
    let _ = refresh_shell_ui(app);
}

#[cfg(not(target_os = "android"))]
fn emit_shell_action(app: &AppHandle, action: &str) -> Result<(), String> {
    let window = window_for_shell(app)?;
    let script = match action {
        "toggle-connection" => {
            "(function(){ const bridge = window.__CHORDV_DESKTOP_SHELL__; if (!bridge || typeof bridge.toggleConnection !== 'function') { throw new Error('shell bridge toggleConnection unavailable'); } bridge.toggleConnection(); })();"
        }
        "open-logs" => {
            "(function(){ const bridge = window.__CHORDV_DESKTOP_SHELL__; if (!bridge || typeof bridge.openLogs !== 'function') { throw new Error('shell bridge openLogs unavailable'); } bridge.openLogs(); })();"
        }
        _ => return Err(format!("未知壳层动作：{action}")),
    };

    window.eval(script).map_err(|error| format!("壳层动作派发失败：{error}"))
}

#[cfg(not(target_os = "android"))]
fn disconnect_runtime_internal(app: &AppHandle) -> Result<(), String> {
    let runtime_state = app.state::<Mutex<RuntimeState>>();
    let mut state = runtime_state
        .lock()
        .map_err(|_| "运行时状态异常".to_string())?;
    state.status = "disconnecting".into();
    let mut proxy_error: Option<String> = None;

    if let Err(error) = clear_system_proxy() {
        proxy_error = Some(error.to_string());
    }

    stop_runtime_process(app, &mut state);

    state.status = "idle".into();
    state.active_session_id = None;
    state.active_node_id = None;
    state.active_node_name = None;
    state.config_path = None;
    state.active_pid = None;
    state.log_path = None;
    state.xray_binary_path = None;
    state.local_http_port = None;
    state.local_socks_port = None;
    state.last_error = proxy_error.map(|error| format!("已停止内核，但清理系统代理失败：{error}"));

    sync_shell_from_runtime(app, &state);
    Ok(())
}

#[cfg(not(target_os = "android"))]
fn build_shell_menu(app: &AppHandle, state: &ShellState) -> Result<tauri::menu::Menu<tauri::Wry>, String> {
    let status_text = format!("当前状态：{}", shell_status_text(&state.status));
    let node_text = format!(
        "当前节点：{}",
        if state.signed_in {
            state.node_name.as_deref().unwrap_or("未选择")
        } else {
            "请先登录"
        }
    );
    let primary_action = if state.primary_action_label.trim().is_empty() {
        "连接/断开".to_string()
    } else {
        state.primary_action_label.clone()
    };

    #[cfg(target_os = "macos")]
    {
        let about = MenuItemBuilder::with_id("shell.about", "关于 ChordV")
            .enabled(false)
            .build(app)
            .map_err(|error| error.to_string())?;
        let show_app = MenuItemBuilder::with_id("shell.show", "显示主界面")
            .build(app)
            .map_err(|error| error.to_string())?;
        let action = MenuItemBuilder::with_id("shell.toggle", primary_action.clone())
            .build(app)
            .map_err(|error| error.to_string())?;
        let status = MenuItemBuilder::with_id("shell.status", status_text.clone())
            .enabled(false)
            .build(app)
            .map_err(|error| error.to_string())?;
        let node = MenuItemBuilder::with_id("shell.node", node_text.clone())
            .enabled(false)
            .build(app)
            .map_err(|error| error.to_string())?;
        let logs = MenuItemBuilder::with_id("shell.logs", "打开连接诊断")
            .build(app)
            .map_err(|error| error.to_string())?;
        let logs_help = MenuItemBuilder::with_id("shell.logs", "打开连接诊断")
            .build(app)
            .map_err(|error| error.to_string())?;
        let hide_app = MenuItemBuilder::with_id("shell.hide", "隐藏窗口")
            .build(app)
            .map_err(|error| error.to_string())?;
        let show_window = MenuItemBuilder::with_id("shell.show", "显示主界面")
            .build(app)
            .map_err(|error| error.to_string())?;
        let hide_window = MenuItemBuilder::with_id("shell.hide", "隐藏窗口")
            .build(app)
            .map_err(|error| error.to_string())?;
        let quit = MenuItemBuilder::with_id("shell.quit", "退出 ChordV")
            .build(app)
            .map_err(|error| error.to_string())?;

        let app_menu = SubmenuBuilder::new(app, "ChordV")
            .item(&about)
            .separator()
            .item(&show_app)
            .item(&hide_app)
            .separator()
            .item(&quit)
            .build()
            .map_err(|error| error.to_string())?;

        let connection_menu = SubmenuBuilder::new(app, "连接")
            .item(&status)
            .item(&node)
            .separator()
            .item(&action)
            .item(&logs)
            .build()
            .map_err(|error| error.to_string())?;

        let window_menu = SubmenuBuilder::new(app, "窗口")
            .item(&show_window)
            .item(&hide_window)
            .build()
            .map_err(|error| error.to_string())?;

        let help_menu = SubmenuBuilder::new(app, "帮助")
            .item(&logs_help)
            .build()
            .map_err(|error| error.to_string())?;

        MenuBuilder::new(app)
            .item(&app_menu)
            .item(&connection_menu)
            .item(&window_menu)
            .item(&help_menu)
            .build()
            .map_err(|error| error.to_string())
    }

    #[cfg(not(target_os = "macos"))]
    {
        let show = MenuItemBuilder::with_id("shell.show", "显示主界面")
            .build(app)
            .map_err(|error| error.to_string())?;
        let status = MenuItemBuilder::with_id("shell.status", status_text)
            .enabled(false)
            .build(app)
            .map_err(|error| error.to_string())?;
        let node = MenuItemBuilder::with_id("shell.node", node_text)
            .enabled(false)
            .build(app)
            .map_err(|error| error.to_string())?;
        let action = MenuItemBuilder::with_id("shell.toggle", primary_action)
            .enabled(state.signed_in)
            .build(app)
            .map_err(|error| error.to_string())?;
        let logs = MenuItemBuilder::with_id("shell.logs", "打开连接诊断")
            .enabled(state.signed_in)
            .build(app)
            .map_err(|error| error.to_string())?;
        let quit = MenuItemBuilder::with_id("shell.quit", "退出 ChordV")
            .build(app)
            .map_err(|error| error.to_string())?;

        MenuBuilder::new(app)
            .item(&show)
            .item(&status)
            .item(&node)
            .separator()
            .item(&action)
            .item(&logs)
            .separator()
            .item(&quit)
            .build()
            .map_err(|error| error.to_string())
    }
}

#[cfg(not(target_os = "android"))]
fn build_shell_tray_menu(app: &AppHandle, state: &ShellState) -> Result<tauri::menu::Menu<tauri::Wry>, String> {
    #[cfg(target_os = "macos")]
    let _ = state;

    #[cfg(target_os = "macos")]
    {
        let show = MenuItemBuilder::with_id("shell.show", "显示主界面")
            .build(app)
            .map_err(|error| error.to_string())?;
        let action = MenuItemBuilder::with_id("shell.toggle", "连接/断开")
            .build(app)
            .map_err(|error| error.to_string())?;
        let logs = MenuItemBuilder::with_id("shell.logs", "打开连接诊断")
            .build(app)
            .map_err(|error| error.to_string())?;
        let hide = MenuItemBuilder::with_id("shell.hide", "隐藏窗口")
            .build(app)
            .map_err(|error| error.to_string())?;
        let quit = MenuItemBuilder::with_id("shell.quit", "退出 ChordV")
            .build(app)
            .map_err(|error| error.to_string())?;

        return MenuBuilder::new(app)
            .item(&show)
            .item(&action)
            .item(&logs)
            .item(&hide)
            .separator()
            .item(&quit)
            .build()
            .map_err(|error| error.to_string());
    }

    #[cfg(not(target_os = "macos"))]
    {
    let status_text = format!("当前状态：{}", shell_status_text(&state.status));
    let node_text = format!(
        "当前节点：{}",
        state.node_name.as_deref().unwrap_or("未选择")
    );
    let primary_action = if state.primary_action_label.trim().is_empty() {
        "连接/断开".to_string()
    } else {
        state.primary_action_label.clone()
    };

    let show = MenuItemBuilder::with_id("shell.show", "显示主界面")
        .build(app)
        .map_err(|error| error.to_string())?;
    let status = MenuItemBuilder::with_id("shell.status", status_text)
        .enabled(false)
        .build(app)
        .map_err(|error| error.to_string())?;
    let node = MenuItemBuilder::with_id("shell.node", node_text)
        .enabled(false)
        .build(app)
        .map_err(|error| error.to_string())?;
    let action = MenuItemBuilder::with_id("shell.toggle", primary_action)
        .enabled(state.signed_in)
        .build(app)
        .map_err(|error| error.to_string())?;
    let logs = MenuItemBuilder::with_id("shell.logs", "打开连接诊断")
        .enabled(state.signed_in)
        .build(app)
        .map_err(|error| error.to_string())?;
    let hide = MenuItemBuilder::with_id("shell.hide", "隐藏窗口")
        .build(app)
        .map_err(|error| error.to_string())?;
    let quit = MenuItemBuilder::with_id("shell.quit", "退出 ChordV")
        .build(app)
        .map_err(|error| error.to_string())?;

    MenuBuilder::new(app)
        .item(&show)
        .item(&status)
        .item(&node)
        .separator()
        .item(&action)
        .item(&logs)
        .item(&hide)
        .separator()
        .item(&quit)
        .build()
        .map_err(|error| error.to_string())
    }
}

#[cfg(not(target_os = "android"))]
fn refresh_shell_ui(app: &AppHandle) -> Result<(), String> {
    let shell_binding = app
        .state::<Mutex<ShellState>>();
    let shell = shell_binding
        .lock()
        .map_err(|_| "桌面壳层状态异常".to_string())?;
    let menu = build_shell_menu(app, &shell)?;
    #[cfg(target_os = "windows")]
    let tray_menu = build_shell_tray_menu(app, &shell)?;

    #[cfg(target_os = "macos")]
    menu.set_as_app_menu().map_err(|error| error.to_string())?;

    #[cfg(target_os = "windows")]
    {
        if let Some(tray) = app.tray_by_id("main-tray") {
            tray.set_menu(Some(tray_menu))
                .map_err(|error| error.to_string())?;
            tray.set_tooltip(Some(&format!(
                "ChordV · {}{}",
                shell_status_text(&shell.status),
                shell
                    .node_name
                    .as_deref()
                    .map(|value| format!(" · {value}"))
                    .unwrap_or_default()
            )))
            .map_err(|error| error.to_string())?;
        }
    }

    Ok(())
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
fn setup_desktop_tray(app: &AppHandle) -> Result<(), String> {
    let shell_binding = app
        .state::<Mutex<ShellState>>();
    let shell = shell_binding
        .lock()
        .map_err(|_| "桌面壳层状态异常".to_string())?;
    let menu = build_shell_tray_menu(app, &shell)?;
    let icon = app
        .default_window_icon()
        .ok_or_else(|| "缺少默认应用图标".to_string())?
        .clone();

    let mut builder = TrayIconBuilder::with_id("main-tray");
    builder = builder
        .icon(icon)
        .tooltip("ChordV")
        .menu(&menu);

    #[cfg(target_os = "windows")]
    {
        builder = builder
            .show_menu_on_left_click(false)
            .on_tray_icon_event(|tray, event| {
                if let TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } = event
                {
                    let _ = toggle_main_window_internal(&tray.app_handle());
                }
            });
    }

    #[cfg(target_os = "macos")]
    {
        builder = builder.show_menu_on_left_click(true);
    }

    builder
        .build(app)
        .map_err(|error| error.to_string())?;

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(android_mobile_plugin::init())
        .manage(Mutex::new(RuntimeState::default()))
        .manage(Mutex::new(ShellState {
            status: "idle".into(),
            signed_in: false,
            node_name: None,
            primary_action_label: "连接/断开".into(),
        }))
        .manage(Mutex::new(RuntimeComponentDownloadState::default()))
        .manage(Mutex::new(android_runtime::AndroidRuntimeState::default()))
        .setup(|app| {
            cleanup_stale_runtime(&app.handle());
            #[cfg(not(target_os = "android"))]
            {
                let _ = ensure_runtime_bin_dir(&app.handle());
            }
            #[cfg(not(target_os = "android"))]
            {
                refresh_shell_ui(&app.handle())?;
            }
            #[cfg(any(target_os = "windows", target_os = "macos"))]
            {
                setup_desktop_tray(&app.handle())?;
            }
            #[cfg(target_os = "macos")]
            {
                let _ = show_main_window_internal(&app.handle());
                let _ = refresh_shell_ui(&app.handle());
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_ready,
            api_request,
            load_session,
            save_session,
            clear_session,
            probe_nodes,
            show_main_window,
            hide_main_window,
            quit_application,
            download_desktop_installer,
            open_desktop_installer,
            desktop_runtime_environment,
            check_runtime_component_file,
            download_runtime_component,
            update_shell_summary,
            runtime_status,
            runtime_logs,
            connect_runtime,
            disconnect_runtime,
            android_runtime::android_runtime_status,
            android_runtime::start_android_runtime,
            android_runtime::stop_android_runtime
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| match event {
        #[cfg(not(target_os = "android"))]
        RunEvent::MenuEvent(event) => match event.id.as_ref() {
            "shell.show" => {
                let _ = show_main_window_internal(app_handle);
            }
            "shell.hide" => {
                let _ = hide_main_window_internal(app_handle);
            }
            "shell.toggle" => {
                let status = {
                    let runtime_binding = app_handle.state::<Mutex<RuntimeState>>();
                    runtime_binding
                        .lock()
                        .ok()
                        .map(|runtime| runtime.status.clone())
                };
                if !matches!(status.as_deref(), Some("connected" | "connecting" | "disconnecting")) {
                    let _ = show_main_window_internal(app_handle);
                }
                let _ = emit_shell_action(app_handle, "toggle-connection");
            }
            "shell.logs" => {
                let _ = show_main_window_internal(app_handle);
                let _ = emit_shell_action(app_handle, "open-logs");
            }
            "shell.quit" => {
                app_handle.exit(0);
            }
            _ => {}
        },
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => {
            let _ = show_main_window_internal(app_handle);
        }
        #[cfg(not(target_os = "android"))]
        RunEvent::WindowEvent { event, .. } => {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = hide_main_window_internal(app_handle);
            }
        }
        RunEvent::ExitRequested { .. } | RunEvent::Exit => {
            let state: State<'_, Mutex<RuntimeState>> = app_handle.state();
            if let Ok(mut state) = state.lock() {
                shutdown_runtime(app_handle, &mut state);
            } else {
                let _ = clear_system_proxy();
            }
            cleanup_stale_runtime(app_handle);
        }
        _ => {}
    });
}
