mod android_mobile_plugin;
mod android_runtime;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs::{self, File, OpenOptions},
    io::{self, Write},
    net::{SocketAddr, TcpStream, ToSocketAddrs},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{mpsc, Mutex},
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};
use tokio::sync::Mutex as AsyncMutex;
use tokio::sync::watch;
#[cfg(not(target_os = "android"))]
use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
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
use std::os::windows::fs::OpenOptionsExt;

#[cfg(windows)]
use std::io::{BufRead, BufReader};

#[cfg(any(target_os = "windows", target_os = "macos"))]
use tauri::tray::TrayIconBuilder;

#[cfg(windows)]
use tauri::tray::{MouseButton, TrayIconEvent};

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
const DOWNLOAD_PROGRESS_SLICE_BYTES: usize = 64 * 1024;
const DOWNLOAD_DIAGNOSTIC_CHECKPOINT_BYTES: u64 = 512 * 1024;
const DOWNLOAD_DIAGNOSTIC_LOG_FILE_NAME: &str = "download-diagnostics.log";

struct RuntimeState {
    status: String,
    active_session_id: Option<String>,
    active_node_id: Option<String>,
    active_node_name: Option<String>,
    active_config: Option<GeneratedRuntimeConfigDto>,
    config_path: Option<PathBuf>,
    log_path: Option<PathBuf>,
    xray_binary_path: Option<PathBuf>,
    active_pid: Option<u32>,
    local_http_port: Option<u16>,
    local_socks_port: Option<u16>,
    last_error: Option<String>,
    child: Option<Child>,
    #[cfg(windows)]
    runtime_component_handles: Vec<File>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct NativeLeaseHeartbeatEvent {
    session_id: String,
    status: String,
    lease_expires_at: Option<String>,
    reason_code: Option<String>,
    message: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct NativeClientEventsOpenEvent {
    elapsed_ms: Option<u64>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct NativeClientEventsErrorEvent {
    status: Option<u16>,
    auth_error: bool,
    message: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionLeaseStatusDto {
    session_id: String,
    status: String,
    lease_expires_at: String,
    evicted_reason: Option<String>,
    reason_code: Option<String>,
    reason_message: Option<String>,
    detail_reason: Option<String>,
}

#[derive(Default)]
struct ShellState {
    status: String,
    signed_in: bool,
    node_name: Option<String>,
    primary_action_label: String,
}

fn shell_state_matches(
    state: &ShellState,
    status: &str,
    signed_in: bool,
    node_name: Option<&str>,
    primary_action_label: &str,
) -> bool {
    state.status == status
        && state.signed_in == signed_in
        && state.node_name.as_deref() == node_name
        && state.primary_action_label == primary_action_label
}

#[derive(Default)]
struct RuntimeComponentDownloadState {
    active: bool,
}

#[derive(Default)]
struct InstallerOperationState {
    active: bool,
}

#[derive(Default)]
struct NativeSessionRefreshState;

struct ClientEventsStreamState {
    generation: u64,
    stop_tx: Option<watch::Sender<u64>>,
}

impl Default for ClientEventsStreamState {
    fn default() -> Self {
        Self {
            generation: 0,
            stop_tx: None,
        }
    }
}

#[derive(Default)]
struct NativeLeaseHeartbeatSignalState {
    tx: Option<mpsc::Sender<()>>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct RuntimePidRecord {
    pid: u32,
    binary_path: Option<String>,
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

#[cfg(not(target_os = "android"))]
fn set_installer_operation_active(app: &AppHandle, active: bool) -> Result<(), String> {
    let state: State<'_, Mutex<InstallerOperationState>> = app.state();
    let mut state = state
        .lock()
        .map_err(|_| "安装器任务状态异常".to_string())?;
    if active && state.active {
        return Err("安装器任务正在处理中，请稍后再试。".into());
    }
    state.active = active;
    Ok(())
}

impl Default for RuntimeState {
    fn default() -> Self {
        Self {
            status: "idle".into(),
            active_session_id: None,
            active_node_id: None,
            active_node_name: None,
            active_config: None,
            config_path: None,
            log_path: None,
            xray_binary_path: None,
            active_pid: None,
            local_http_port: None,
            local_socks_port: None,
            last_error: None,
            child: None,
            #[cfg(windows)]
            runtime_component_handles: Vec::new(),
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
    lease_id: String,
    lease_expires_at: String,
    lease_heartbeat_interval_seconds: u32,
    lease_grace_seconds: u32,
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
struct RuntimeSnapshotResponse {
    runtime: Option<GeneratedRuntimeConfigDto>,
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
    elapsed_ms: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopInstallerDownloadInput {
    url: String,
    file_name: Option<String>,
    expected_total_bytes: Option<u64>,
    expected_hash: Option<String>,
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
    file_size_bytes: Option<u64>,
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

#[derive(Debug, Deserialize, Clone)]
#[serde(untagged)]
enum RuntimeComponentPlanFileSizeValue {
    Number(u64),
    String(String),
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RuntimeComponentPlanItemInput {
    id: String,
    kind: RuntimeComponentKindInput,
    file_name: String,
    file_size_bytes: Option<RuntimeComponentPlanFileSizeValue>,
    archive_entry_name: Option<String>,
    expected_hash: Option<String>,
    resolved_url: String,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RuntimeComponentsPlanInput {
    components: Vec<RuntimeComponentPlanItemInput>,
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
    read_session_from_disk(&app)
}

#[tauri::command]
fn save_session(app: AppHandle, session: AuthSessionDto) -> Result<CommandResult, String> {
    write_session_to_disk(&app, &session)?;

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

fn read_session_from_disk(app: &AppHandle) -> Result<Option<AuthSessionDto>, String> {
    let path = session_path(app)?;
    if !path.exists() {
        return Ok(None);
    }

    let content = fs::read_to_string(path).map_err(|error| error.to_string())?;
    let session = serde_json::from_str::<AuthSessionDto>(&content).map_err(|error| error.to_string())?;
    Ok(Some(session))
}

fn write_session_to_disk(app: &AppHandle, session: &AuthSessionDto) -> Result<(), String> {
    let path = session_path(app)?;
    let parent = path.parent().ok_or_else(|| "会话路径无效".to_string())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let serialized = serde_json::to_string(session).map_err(|error| error.to_string())?;
    fs::write(&path, serialized).map_err(|error| error.to_string())?;
    set_private_permissions(&path)?;
    Ok(())
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
        .no_proxy()
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

    let started_at = Instant::now();
    let response = req.send().await.map_err(|error| format!("请求 API 失败：{error}"))?;
    let status = response.status().as_u16();
    let body = response.text().await.map_err(|error| format!("读取响应失败：{error}"))?;
    let elapsed_ms = started_at.elapsed().as_millis().min(u64::MAX as u128) as u64;
    Ok(ApiResponseOutput {
        status,
        body,
        elapsed_ms,
    })
}

fn api_base_url() -> String {
    std::env::var("CHORDV_API_BASE_URL").unwrap_or_else(|_| "https://v.baymaxgroup.com".to_string())
}

fn api_client() -> Result<Client, String> {
    Client::builder()
        .timeout(Duration::from_secs(15))
        .no_proxy()
        .build()
        .map_err(|error| format!("初始化 API 客户端失败：{error}"))
}

fn api_stream_client() -> Result<Client, String> {
    Client::builder()
        .no_proxy()
        .build()
        .map_err(|error| format!("初始化事件流客户端失败：{error}"))
}

fn parse_api_error_message(body: &str) -> String {
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return "请求失败".into();
    }
    if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
        if let Some(message) = value.get("message").and_then(Value::as_str) {
            return message.to_string();
        }
    }
    trimmed.to_string()
}

async fn refresh_access_session_inner(app: &AppHandle, refresh_token: &str) -> Result<AuthSessionDto, String> {
    let url = format!("{}/api/auth/refresh", api_base_url().trim_end_matches('/'));
    let response = api_client()?
        .post(url)
        .header("Content-Type", "application/json")
        .body(json!({ "refreshToken": refresh_token }).to_string())
        .send()
        .await
        .map_err(|error| format!("刷新登录态失败：{error}"))?;
    let status = response.status().as_u16();
    let body = response.text().await.map_err(|error| format!("读取响应失败：{error}"))?;
    if status < 200 || status >= 300 {
        return Err(parse_api_error_message(&body));
    }
    let session = serde_json::from_str::<AuthSessionDto>(&body).map_err(|error| format!("解析登录态失败：{error}"))?;
    write_session_to_disk(app, &session)?;
    let _ = app.emit("chordv://native-session-refreshed", &session);
    Ok(session)
}

async fn refresh_access_session(app: &AppHandle, refresh_token_hint: Option<&str>) -> Result<AuthSessionDto, String> {
    let refresh_state = app.state::<AsyncMutex<NativeSessionRefreshState>>();
    let _guard = refresh_state.lock().await;

    let session = read_session_from_disk(app)?.ok_or_else(|| "当前没有可用登录态".to_string())?;
    let stored_refresh_token = session.refresh_token.trim().to_string();
    let hinted_refresh_token = refresh_token_hint.map(str::trim).filter(|value| !value.is_empty());

    if let Some(hint) = hinted_refresh_token {
        if hint != stored_refresh_token {
            return Ok(session);
        }
    }

    if stored_refresh_token.is_empty() {
        return Err("当前没有可用刷新令牌".into());
    }

    refresh_access_session_inner(app, &stored_refresh_token).await
}

#[tauri::command]
async fn refresh_session_native(app: AppHandle, refresh_token: Option<String>) -> Result<AuthSessionDto, String> {
    refresh_access_session(&app, refresh_token.as_deref()).await
}

async fn native_heartbeat_once(
    session_id: &str,
    access_token: &str,
) -> Result<SessionLeaseStatusDto, (u16, String)> {
    let url = format!("{}/api/client/session/heartbeat", api_base_url().trim_end_matches('/'));
    let response = api_client()
        .map_err(|error| (0, error))?
        .post(url)
        .header("Authorization", format!("Bearer {access_token}"))
        .header("Content-Type", "application/json")
        .body(json!({ "sessionId": session_id }).to_string())
        .send()
        .await
        .map_err(|error| (0, format!("续租失败：{error}")))?;
    let status = response.status().as_u16();
    let body = response.text().await.map_err(|error| (status, format!("读取响应失败：{error}")))?;
    if status < 200 || status >= 300 {
        return Err((status, parse_api_error_message(&body)));
    }
    serde_json::from_str::<SessionLeaseStatusDto>(&body)
        .map_err(|error| (status, format!("解析续租响应失败：{error}")))
}

fn emit_native_lease_event(app: &AppHandle, event: NativeLeaseHeartbeatEvent) {
    let _ = app.emit("chordv://native-lease-heartbeat", event);
}

fn emit_native_client_event(app: &AppHandle, event: Value) {
    let _ = app.emit("chordv://native-client-event", event);
}

fn emit_native_client_events_open(app: &AppHandle, event: NativeClientEventsOpenEvent) {
    let _ = app.emit("chordv://native-client-events-open", event);
}

fn emit_native_client_events_error(app: &AppHandle, event: NativeClientEventsErrorEvent) {
    let _ = app.emit("chordv://native-client-events-error", event);
}

fn notify_native_lease_heartbeat(app: &AppHandle) {
    if let Ok(signal_state) = app.state::<Mutex<NativeLeaseHeartbeatSignalState>>().lock() {
        if let Some(tx) = signal_state.tx.as_ref() {
            let _ = tx.send(());
        }
    }
}

fn start_native_lease_heartbeat_loop(app: AppHandle) {
    let (tx, rx) = mpsc::channel::<()>();
    if let Ok(mut signal_state) = app.state::<Mutex<NativeLeaseHeartbeatSignalState>>().lock() {
        signal_state.tx = Some(tx);
    }

    thread::spawn(move || loop {
        let (session_id, should_heartbeat, interval_seconds) = {
            let runtime_state = app.state::<Mutex<RuntimeState>>();
            let snapshot = match runtime_state.lock() {
                Ok(guard) => (
                    guard.active_session_id.clone(),
                    guard.status == "connected" && guard.active_session_id.is_some(),
                    guard
                        .active_config
                        .as_ref()
                        .map(|config| config.lease_heartbeat_interval_seconds.max(5))
                        .unwrap_or(30),
                ),
                Err(_) => (None, false, 30),
            };
            snapshot
        };

        if should_heartbeat {
            if let Some(session_id) = session_id {
                if let Ok(Some(session)) = read_session_from_disk(&app) {
                    let result = tauri::async_runtime::block_on(async {
                        match native_heartbeat_once(&session_id, &session.access_token).await {
                            Ok(lease) => Ok(lease),
                            Err((401, _)) => {
                                let refreshed = refresh_access_session(&app, Some(&session.refresh_token))
                                    .await
                                    .map_err(|error| (401, error))?;
                                native_heartbeat_once(&session_id, &refreshed.access_token).await
                            }
                            Err(error) => Err(error),
                        }
                    });

                    match result {
                        Ok(lease) => emit_native_lease_event(
                            &app,
                            NativeLeaseHeartbeatEvent {
                                session_id: lease.session_id,
                                status: "ok".into(),
                                lease_expires_at: Some(lease.lease_expires_at),
                                reason_code: lease.reason_code,
                                message: lease.reason_message,
                            },
                        ),
                        Err((status, message)) => {
                            let reason_code = if status == 403 || status == 404 {
                                Some("session_invalid".to_string())
                            } else if status == 401 {
                                Some("auth_invalid".to_string())
                            } else {
                                Some("heartbeat_failed".to_string())
                            };
                            emit_native_lease_event(
                                &app,
                                NativeLeaseHeartbeatEvent {
                                    session_id,
                                    status: "error".into(),
                                    lease_expires_at: None,
                                    reason_code,
                                    message: Some(message),
                                },
                            );
                        }
                    }
                }
            }
        }

        match rx.recv_timeout(Duration::from_secs(interval_seconds.into())) {
            Ok(_) | Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    });
}

async fn run_native_client_events_stream_once(
    app: &AppHandle,
    access_token: &str,
    stop_rx: &mut watch::Receiver<u64>,
) -> Result<bool, NativeClientEventsErrorEvent> {
    let started_at = Instant::now();
    let url = format!("{}/api/client/events/stream", api_base_url().trim_end_matches('/'));
    let response = api_stream_client()
        .map_err(|error| NativeClientEventsErrorEvent {
            status: None,
            auth_error: false,
            message: error,
        })?
        .get(url)
        .header("Authorization", format!("Bearer {access_token}"))
        .header("Accept", "text/event-stream")
        .send()
        .await
        .map_err(|error| NativeClientEventsErrorEvent {
            status: None,
            auth_error: false,
            message: format!("事件流连接失败：{error}"),
        })?;

    let status = response.status().as_u16();
    if status < 200 || status >= 300 {
        let body = response
            .text()
            .await
            .unwrap_or_else(|_| "事件流连接失败".to_string());
        return Err(NativeClientEventsErrorEvent {
            status: Some(status),
            auth_error: status == 401,
            message: parse_api_error_message(&body),
        });
    }

    emit_native_client_events_open(
        app,
        NativeClientEventsOpenEvent {
            elapsed_ms: Some(started_at.elapsed().as_millis().min(u64::MAX as u128) as u64),
        },
    );

    let mut buffer = String::new();

    let mut response = response;
    loop {
        let next = tokio::select! {
            _ = stop_rx.changed() => {
                return Ok(true);
            }
            next = response.chunk() => next.map_err(|error| NativeClientEventsErrorEvent {
                status: None,
                auth_error: false,
                message: format!("读取事件流失败：{error}"),
            })?
        };
        let Some(chunk) = next else {
            break;
        };
        buffer.push_str(&String::from_utf8_lossy(&chunk));

        loop {
            let Some(index) = buffer.find("\n\n") else {
                break;
            };
            let raw_chunk = buffer[..index].to_string();
            buffer = buffer[index + 2..].to_string();
            let data_lines = raw_chunk
                .lines()
                .map(|line| line.trim_end_matches('\r'))
                .filter(|line| !line.is_empty() && line.starts_with("data:"))
                .map(|line| line[5..].trim())
                .collect::<Vec<_>>();

            if data_lines.is_empty() {
                continue;
            }

            let payload = data_lines.join("\n");
            match serde_json::from_str::<Value>(&payload) {
                Ok(value) => emit_native_client_event(app, value),
                Err(error) => emit_native_client_events_error(
                    app,
                    NativeClientEventsErrorEvent {
                        status: None,
                        auth_error: false,
                        message: format!("解析事件失败：{error}"),
                    },
                ),
            }
        }
    }

    Ok(false)
}

#[tauri::command]
async fn start_client_events_stream(app: AppHandle, access_token: String) -> Result<CommandResult, String> {
    let state = app.state::<AsyncMutex<ClientEventsStreamState>>();
    let generation = {
        let mut state = state.lock().await;
        state.generation = state.generation.saturating_add(1);
        if let Some(stop_tx) = state.stop_tx.take() {
            let _ = stop_tx.send(state.generation);
        }
        let (stop_tx, _stop_rx) = watch::channel(state.generation);
        state.stop_tx = Some(stop_tx);
        state.generation
    };
    let mut stop_rx = {
        let state = app.state::<AsyncMutex<ClientEventsStreamState>>();
        let state = state.lock().await;
        state
            .stop_tx
            .as_ref()
            .map(watch::Sender::subscribe)
            .ok_or_else(|| "事件流控制器初始化失败".to_string())?
    };

    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            let current_generation = {
                let state = app_handle.state::<AsyncMutex<ClientEventsStreamState>>();
                let state = state.lock().await;
                state.generation
            };
            if current_generation != generation {
                break;
            }

            match run_native_client_events_stream_once(&app_handle, &access_token, &mut stop_rx).await {
                Ok(should_reconnect) => {
                    if should_reconnect {
                        break;
                    }
                    if current_generation != generation {
                        break;
                    }
                    if *stop_rx.borrow() != generation {
                        break;
                    }
                    if !should_reconnect {
                        tokio::time::sleep(Duration::from_secs(3)).await;
                    }
                }
                Err(error) => {
                    let terminal = matches!(error.status, Some(401 | 403));
                    let auth_error = error.auth_error;
                    emit_native_client_events_error(&app_handle, error);
                    if auth_error || terminal {
                        break;
                    }
                    tokio::time::sleep(Duration::from_secs(3)).await;
                }
            }
        }
    });

    Ok(CommandResult {
        ok: true,
        config_path: None,
        log_path: None,
        active_pid: None,
    })
}

#[tauri::command]
async fn stop_client_events_stream(app: AppHandle) -> Result<CommandResult, String> {
    let state = app.state::<AsyncMutex<ClientEventsStreamState>>();
    let mut state = state.lock().await;
    state.generation = state.generation.saturating_add(1);
    if let Some(stop_tx) = state.stop_tx.take() {
        let _ = stop_tx.send(state.generation);
    }
    Ok(CommandResult {
        ok: true,
        config_path: None,
        log_path: None,
        active_pid: None,
    })
}

fn api_proxy_bypass_hosts() -> Vec<String> {
    let mut hosts = vec![
        "localhost".to_string(),
        "127.0.0.1".to_string(),
    ];

    let base = std::env::var("CHORDV_API_BASE_URL").unwrap_or_else(|_| "https://v.baymaxgroup.com".to_string());
    if let Ok(url) = Url::parse(base.trim()) {
        if let Some(host) = url.host_str() {
            let host = host.trim().to_string();
            if !host.is_empty() && !hosts.iter().any(|candidate| candidate.eq_ignore_ascii_case(&host)) {
                hosts.push(host);
            }
        }
    }

    hosts
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
        set_installer_operation_active(&app, true)?;
        let result = async {
            let url = Url::parse(input.url.trim()).map_err(|error| format!("下载地址无效：{error}"))?;
            if !installer_download_url_allowed(&url) {
                return Err("安装器下载地址仅支持 HTTPS，开发环境仅允许 localhost/127.0.0.1".into());
            }

            let file_name = resolve_installer_file_name(&url, input.file_name.as_deref());
            let expected_hash = normalize_optional_sha256(input.expected_hash.as_deref());
            append_download_diagnostic_log(
                &app,
                "update-download",
                format!(
                    "start url={} file_name={} expected_total_bytes={:?} expected_hash={}",
                    url,
                    file_name,
                    input.expected_total_bytes,
                    expected_hash.as_deref().unwrap_or("none")
                ),
            );
            emit_update_download_progress(
                &app,
                DesktopInstallerDownloadProgress {
                    phase: "preparing".into(),
                    file_name: Some(file_name.clone()),
                    downloaded_bytes: 0,
                    total_bytes: input.expected_total_bytes,
                    local_path: None,
                    message: Some("正在准备下载安装器…".into()),
                },
            );

            let download_dir = ensure_installer_download_dir(&app)?;
            let final_path = download_dir.join(&file_name);
            let temp_path = installer_temp_path(&final_path);
            if final_path.exists() {
                if installer_file_matches_expectation(
                    &final_path,
                    input.expected_total_bytes,
                    expected_hash.as_deref(),
                )? {
                    let metadata = fs::metadata(&final_path)
                        .map_err(|error| format!("读取安装器文件状态失败：{error}"))?;
                    let local_path = final_path.to_string_lossy().into_owned();
                    append_download_diagnostic_log(
                        &app,
                        "update-download",
                        format!(
                            "reuse-cache path={} size={} expected_total_bytes={:?}",
                            local_path,
                            metadata.len(),
                            input.expected_total_bytes
                        ),
                    );
                    emit_update_download_progress(
                        &app,
                        DesktopInstallerDownloadProgress {
                            phase: "completed".into(),
                            file_name: Some(file_name.clone()),
                            downloaded_bytes: metadata.len(),
                            total_bytes: input.expected_total_bytes.or(Some(metadata.len())),
                            local_path: Some(local_path.clone()),
                            message: Some("已复用本地安装器，正在打开安装程序…".into()),
                        },
                    );
                    return Ok(DesktopInstallerDownloadResult {
                        file_name,
                        local_path,
                        total_bytes: input.expected_total_bytes.or(Some(metadata.len())),
                    });
                }
                append_download_diagnostic_log(
                    &app,
                    "update-download",
                    format!("discard-stale-cache path={}", final_path.to_string_lossy()),
                );
                let _ = fs::remove_file(&final_path);
            }
            if temp_path.exists() {
                let _ = fs::remove_file(&temp_path);
            }

            let client = Client::builder()
                .timeout(Duration::from_secs(600))
                .build()
                .map_err(|error| format!("初始化下载器失败：{error}"))?;
            let mut response = client
                .get(url.clone())
                .send()
                .await
                .map_err(|error| format!("下载安装器失败：{error}"))?;
            let response_status = response.status().as_u16();
            let response_content_length = response.content_length();
            append_download_diagnostic_log(
                &app,
                "update-download",
                format!(
                    "response status={} content_length={:?} expected_total_bytes={:?}",
                    response_status, response_content_length, input.expected_total_bytes
                ),
            );

            if !response.status().is_success() {
                return Err(format!("下载安装器失败：HTTP {}", response.status().as_u16()));
            }

            let total_bytes = response_content_length.or(input.expected_total_bytes);
            let mut downloaded_bytes = 0_u64;
            let mut last_logged_bytes = 0_u64;
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
                for slice in chunk.chunks(DOWNLOAD_PROGRESS_SLICE_BYTES) {
                    file.write_all(slice)
                        .map_err(|error| format!("写入安装器文件失败：{error}"))?;
                    downloaded_bytes += slice.len() as u64;
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
                    maybe_log_download_checkpoint(
                        &app,
                        "update-download",
                        downloaded_bytes,
                        total_bytes,
                        &mut last_logged_bytes,
                    );
                }
            }

            file.flush().map_err(|error| format!("写入安装器文件失败：{error}"))?;
            validate_installer_file(
                &temp_path,
                downloaded_bytes,
                input.expected_total_bytes,
                expected_hash.as_deref(),
            )?;
            fs::rename(&temp_path, &final_path).map_err(|error| format!("保存安装器文件失败：{error}"))?;

            let local_path = final_path.to_string_lossy().into_owned();
            append_download_diagnostic_log(
                &app,
                "update-download",
                format!(
                    "completed path={} downloaded_bytes={} total_bytes={:?}",
                    local_path, downloaded_bytes, total_bytes
                ),
            );
            emit_update_download_progress(
                &app,
                DesktopInstallerDownloadProgress {
                    phase: "completed".into(),
                    file_name: Some(file_name.clone()),
                    downloaded_bytes,
                    total_bytes: input.expected_total_bytes.or(total_bytes).or(Some(downloaded_bytes)),
                    local_path: Some(local_path.clone()),
                    message: Some("安装器下载完成，正在打开安装程序…".into()),
                },
            );

            Ok(DesktopInstallerDownloadResult {
                file_name,
                local_path,
                total_bytes: input.expected_total_bytes.or(total_bytes).or(Some(downloaded_bytes)),
            })
        }
        .await;
        let _ = set_installer_operation_active(&app, false);
        if let Err(error) = &result {
            append_download_diagnostic_log(
                &app,
                "update-download",
                format!("failed error={error}"),
            );
        }
        if result.is_err() {
            if let Ok(download_dir) = ensure_installer_download_dir(&app) {
                if let Ok(entries) = fs::read_dir(&download_dir) {
                    for entry in entries.flatten() {
                        let path = entry.path();
                        if path
                            .extension()
                            .and_then(|value| value.to_str())
                            .map(|value| value.ends_with("part"))
                            .unwrap_or(false)
                        {
                            let _ = fs::remove_file(path);
                        }
                    }
                }
            }
        }
        result
    }
}

#[tauri::command]
fn open_desktop_installer(app: AppHandle, path: String) -> Result<CommandResult, String> {
    #[cfg(target_os = "android")]
    {
        let _ = (app, path);
        return Err("安卓端不支持桌面安装器打开".into());
    }

    #[cfg(not(target_os = "android"))]
    {
        set_installer_operation_active(&app, true)?;
        let installer_path = PathBuf::from(path);
        if !installer_path.exists() {
            let _ = set_installer_operation_active(&app, false);
            return Err("安装器文件不存在".into());
        }
        let current_pid = std::process::id();
        if let Err(error) = spawn_deferred_installer_open(&installer_path, current_pid) {
            let _ = set_installer_operation_active(&app, false);
            return Err(error);
        }
        let exit_handle = app.clone();
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(150));
            exit_handle.exit(0);
        });

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
        let runtime_bin_dir = installed_runtime_bin_dir(&app)?;
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
        let _ = ensure_runtime_component_from_bundle(&app, component.component, &target_path)?;
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
        let mut last_downloaded_bytes = 0_u64;
        let mut last_total_bytes = input.component.file_size_bytes;
        let result = async {
            let download_url =
                Url::parse(input.url.trim()).map_err(|error| runtime_component_error("download_failed", format!("下载地址无效：{error}")))?;
            if !matches!(download_url.scheme(), "https" | "http") {
                return Err(runtime_component_error("download_failed", "下载地址仅支持 HTTP 或 HTTPS".into()));
            }
            append_download_diagnostic_log(
                &app,
                "runtime-download",
                format!(
                    "start component={} id={} url={} file_name={} expected_total_bytes={:?} expected_hash={}",
                    component_name,
                    input.component.id,
                    download_url,
                    input.component.file_name,
                    input.component.file_size_bytes,
                    input.component.checksum_sha256.as_deref().unwrap_or("none")
                ),
            );

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
                    total_bytes: input.component.file_size_bytes,
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
            let response_status = response.status().as_u16();
            let response_content_length = response.content_length();
            append_download_diagnostic_log(
                &app,
                "runtime-download",
                format!(
                    "response component={} status={} content_length={:?} expected_total_bytes={:?}",
                    component_name, response_status, response_content_length, input.component.file_size_bytes
                ),
            );

            if !response.status().is_success() {
                return Err(runtime_component_error(
                    "download_failed",
                    format!("下载 {} 失败：HTTP {}", runtime_component_display_name(component), response.status().as_u16()),
                ));
            }

            let total_bytes = response_content_length.or(input.component.file_size_bytes);
            let mut downloaded_bytes = 0_u64;
            last_total_bytes = total_bytes;
            let mut last_logged_bytes = 0_u64;
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
            last_downloaded_bytes = downloaded_bytes;

            while let Some(chunk) = response
                .chunk()
                .await
                .map_err(|error| runtime_component_error("download_failed", format!("下载 {} 失败：{error}", runtime_component_display_name(component))))?
            {
                for slice in chunk.chunks(DOWNLOAD_PROGRESS_SLICE_BYTES) {
                    archive_file
                        .write_all(slice)
                        .map_err(|error| runtime_component_error("write_failed", format!("写入组件文件失败：{error}")))?;
                    downloaded_bytes += slice.len() as u64;
                    last_downloaded_bytes = downloaded_bytes;
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
                    maybe_log_download_checkpoint(
                        &app,
                        "runtime-download",
                        downloaded_bytes,
                        total_bytes,
                        &mut last_logged_bytes,
                    );
                }
            }

            archive_file
                .flush()
                .map_err(|error| runtime_component_error("write_failed", format!("写入组件文件失败：{error}")))?;
            append_download_diagnostic_log(
                &app,
                "runtime-download",
                format!(
                    "extracting component={} archive_path={} downloaded_bytes={} total_bytes={:?}",
                    component_name,
                    archive_path.to_string_lossy(),
                    downloaded_bytes,
                    total_bytes
                ),
            );

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
            append_download_diagnostic_log(
                &app,
                "runtime-download",
                format!(
                    "completed component={} path={} downloaded_bytes={} total_bytes={:?}",
                    component_name, local_path, downloaded_bytes, total_bytes
                ),
            );
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
                    downloaded_bytes,
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
            append_download_diagnostic_log(
                &app,
                "runtime-download",
                format!(
                    "failed component={} downloaded_bytes={} total_bytes={:?} error={}",
                    component_name, last_downloaded_bytes, last_total_bytes, error
                ),
            );
            emit_runtime_component_failed(
                &app,
                component_name,
                Some(input.component.file_name.clone()),
                last_downloaded_bytes,
                last_total_bytes,
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
    let next_primary_action_label = summary
        .primary_action_label
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "连接/断开".to_string());
    let next_signed_in = summary.signed_in.unwrap_or(false);
    let next_node_name = summary.node_name;
    let next_status = summary.status;
    let mut should_refresh = false;
    {
        let mut state = shell_state
            .lock()
            .map_err(|_| "桌面壳层状态异常".to_string())?;
        if !shell_state_matches(
            &state,
            &next_status,
            next_signed_in,
            next_node_name.as_deref(),
            &next_primary_action_label,
        ) {
            state.status = next_status;
            state.signed_in = next_signed_in;
            state.node_name = next_node_name;
            state.primary_action_label = next_primary_action_label;
            should_refresh = true;
        }
    }

    if should_refresh {
        refresh_shell_ui(&app)?;
    }

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
fn runtime_status(_app: AppHandle, state: State<'_, Mutex<RuntimeState>>) -> RuntimeStatusResponse {
    let mut state = state.lock().expect("runtime state lock");
    refresh_child_state(&mut state);
    #[cfg(not(target_os = "android"))]
    sync_shell_from_runtime(&_app, &state);
    to_runtime_status_response(&state)
}

#[tauri::command]
fn runtime_logs(app: AppHandle, state: State<'_, Mutex<RuntimeState>>) -> RuntimeLogResponse {
    let mut state = state.lock().expect("runtime state lock");
    refresh_child_state(&mut state);

    let runtime_log = state
        .log_path
        .as_ref()
        .map(|path| tail_log(path, 80))
        .unwrap_or_default();
    let download_log = download_diagnostics_log_path(&app)
        .ok()
        .map(|path| tail_log(&path, 120))
        .unwrap_or_default();
    let log = match (download_log.trim().is_empty(), runtime_log.trim().is_empty()) {
        (true, true) => String::new(),
        (false, true) => format!("=== 下载诊断日志 ===\n{download_log}"),
        (true, false) => runtime_log,
        (false, false) => format!(
            "=== 下载诊断日志 ===\n{download_log}\n\n=== 运行时日志 ===\n{runtime_log}"
        ),
    };

    RuntimeLogResponse { log }
}

#[tauri::command]
fn runtime_snapshot(state: State<'_, Mutex<RuntimeState>>) -> Result<RuntimeSnapshotResponse, String> {
    let state = state.lock().map_err(|_| "运行时状态异常".to_string())?;
    Ok(RuntimeSnapshotResponse {
        runtime: state.active_config.clone(),
    })
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
            state.active_config = None;
            state.last_error = Some(error.clone());
            #[cfg(not(target_os = "android"))]
            sync_shell_from_runtime(&app, &state);
            return Err(error);
        }

        state.status = "starting".into();
        state.active_session_id = Some(config.session_id.clone());
        state.active_node_id = Some(config.node.id.clone());
        state.active_node_name = Some(config.node.name.clone());
        state.active_config = Some(config.clone());
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
            state.active_config = None;
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
    state.active_config = Some(config.clone());
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
        state.active_config = None;
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

    #[cfg(windows)]
    {
        let runtime_bin_dir = match installed_runtime_bin_dir(&app) {
            Ok(path) => path,
            Err(error) => {
                rollback_connect_failure(&app, &mut state, &mut child, error.clone());
                return Err(error);
            }
        };
        if let Err(error) = lock_runtime_component_files(&mut state, &runtime_bin_dir) {
            rollback_connect_failure(&app, &mut state, &mut child, error.clone());
            return Err(error);
        }
    }

    state.status = "connected".into();
    state.config_path = Some(config_path.clone());
    state.log_path = Some(log_path.clone());
    state.xray_binary_path = Some(xray_binary_path.clone());
    state.active_pid = Some(child.id());
    persist_runtime_pid(&app, child.id(), &xray_binary_path);
    state.child = Some(child);
    sync_shell_from_runtime(&app, &state);
    notify_native_lease_heartbeat(&app);

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

fn download_diagnostics_log_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(ensure_runtime_dir(app)?.join(DOWNLOAD_DIAGNOSTIC_LOG_FILE_NAME))
}

fn append_download_diagnostic_log(app: &AppHandle, category: &str, message: impl AsRef<str>) {
    let Ok(path) = download_diagnostics_log_path(app) else {
        return;
    };
    let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) else {
        return;
    };
    let _ = writeln!(file, "[{}] [{}] {}", chrono_like_now(), category, message.as_ref());
}

fn ensure_runtime_bin_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let bin_dir = ensure_runtime_dir(app)?.join("bin");
    fs::create_dir_all(&bin_dir).map_err(|error| error.to_string())?;
    Ok(bin_dir)
}

fn installed_runtime_bin_dir(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            let bin_dir = exe_dir.join("bin");
            fs::create_dir_all(&bin_dir).map_err(|error| error.to_string())?;
            return Ok(bin_dir);
        }
    }

    let manifest_bin = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("bin");
    if manifest_bin.exists() {
        fs::create_dir_all(&manifest_bin).map_err(|error| error.to_string())?;
        return Ok(manifest_bin);
    }

    ensure_runtime_bin_dir(app)
}

fn ensure_xray_binary(app: &AppHandle, _runtime_dir: &Path) -> Result<PathBuf, String> {
    let installed_path = installed_runtime_bin_dir(app)?.join(runtime_binary_name());
    if ensure_runtime_component_from_bundle(app, RuntimeComponentKindInput::Xray, &installed_path)? {
        ensure_executable(&installed_path)?;
    }
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

fn ensure_geo_data(app: &AppHandle, _runtime_dir: &Path) -> Result<(), String> {
    let runtime_bin_dir = installed_runtime_bin_dir(app)?;
    for kind in [RuntimeComponentKindInput::Geoip, RuntimeComponentKindInput::Geosite] {
        let target = runtime_bin_dir.join(runtime_component_file_name(kind));
        let _ = ensure_runtime_component_from_bundle(app, kind, &target)?;
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

#[cfg(windows)]
fn lock_runtime_component_files(state: &mut RuntimeState, runtime_bin_dir: &Path) -> Result<(), String> {
    state.runtime_component_handles.clear();

    for file_name in ["geoip.dat", "geosite.dat"] {
        let path = runtime_bin_dir.join(file_name);
        let handle = OpenOptions::new()
            .read(true)
            .share_mode(0x0000_0001)
            .open(&path)
            .map_err(|error| format!("锁定运行时文件失败（{}）：{error}", path.to_string_lossy()))?;
        state.runtime_component_handles.push(handle);
    }

    Ok(())
}

fn normalize_runtime_component_plan_file_size(value: Option<RuntimeComponentPlanFileSizeValue>) -> Option<u64> {
    match value {
        Some(RuntimeComponentPlanFileSizeValue::Number(raw)) => Some(raw),
        Some(RuntimeComponentPlanFileSizeValue::String(raw)) => raw
            .trim()
            .parse::<u64>()
            .ok()
            .filter(|parsed| *parsed > 0),
        None => None,
    }
}

async fn fetch_runtime_components_plan_once(
    access_token: &str,
) -> Result<RuntimeComponentsPlanInput, (u16, String)> {
    let base = api_base_url();
    let url = format!(
        "{}/api/client/runtime-components/plan?platform={}&architecture={}",
        base.trim_end_matches('/'),
        runtime_platform_name(),
        detect_runtime_component_architecture()
    );
    let response = api_client()
        .map_err(|error| (0, error))?
        .get(url)
        .header("Authorization", format!("Bearer {access_token}"))
        .send()
        .await
        .map_err(|error| (0, format!("获取运行时组件计划失败：{error}")))?;
    let status = response.status().as_u16();
    let body = response
        .text()
        .await
        .map_err(|error| (status, format!("读取运行时组件计划失败：{error}")))?;
    if status < 200 || status >= 300 {
        return Err((status, parse_api_error_message(&body)));
    }
    serde_json::from_str::<RuntimeComponentsPlanInput>(&body)
        .map_err(|error| (status, format!("解析运行时组件计划失败：{error}")))
}

async fn fetch_runtime_components_plan_for_connect(app: &AppHandle) -> Result<RuntimeComponentsPlanInput, String> {
    let session = read_session_from_disk(app)?.ok_or_else(|| "当前没有可用登录态".to_string())?;
    match fetch_runtime_components_plan_once(&session.access_token).await {
        Ok(plan) => Ok(plan),
        Err((401, _)) => {
            let refreshed = refresh_access_session(app, Some(&session.refresh_token)).await?;
            fetch_runtime_components_plan_once(&refreshed.access_token)
                .await
                .map_err(|(_, message)| format!("获取运行时组件计划失败：{message}"))
        }
        Err((_, message)) => Err(format!("获取运行时组件计划失败：{message}")),
    }
}

async fn auto_repair_runtime_components_for_connect(app: &AppHandle) -> Result<(), String> {
    let plan = fetch_runtime_components_plan_for_connect(app).await?;
    if plan.components.is_empty() {
        return Err("运行时组件计划为空，无法自动修复。".into());
    }

    for item in plan.components {
        let component = RuntimeComponentDownloadItemInput {
            id: item.id.clone(),
            component: item.kind,
            file_name: item.file_name.clone(),
            file_size_bytes: normalize_runtime_component_plan_file_size(item.file_size_bytes.clone()),
            source_format: if item
                .archive_entry_name
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .is_some()
            {
                RuntimeComponentSourceFormat::ZipEntry
            } else {
                RuntimeComponentSourceFormat::Direct
            },
            archive_entry_name: item.archive_entry_name.clone(),
            checksum_sha256: item.expected_hash.clone(),
        };

        emit_runtime_component_progress(
            app,
            RuntimeComponentDownloadProgress {
                phase: "checking".into(),
                component: runtime_component_key(component.component).into(),
                file_name: Some(component.file_name.clone()),
                downloaded_bytes: 0,
                total_bytes: component.file_size_bytes,
                message: Some(format!(
                    "连接前正在校验 {}…",
                    runtime_component_display_name(component.component)
                )),
            },
        );

        let status = check_runtime_component_file(app.clone(), component.clone())?;
        if status.ready {
            continue;
        }

        append_download_diagnostic_log(
            app,
            "runtime-download",
            format!(
                "connect-auto-repair component={} reason={} message={}",
                runtime_component_key(component.component),
                status
                    .reason_code
                    .clone()
                    .unwrap_or_else(|| "unknown".into()),
                status.message.clone().unwrap_or_else(|| "none".into())
            ),
        );

        download_runtime_component(
            app.clone(),
            RuntimeComponentDownloadInput {
                component,
                url: item.resolved_url.clone(),
            },
        )
        .await?;
    }

    Ok(())
}

async fn prepare_desktop_runtime_components(app: &AppHandle, runtime_dir: &Path) -> Result<PathBuf, String> {
    match ensure_xray_binary(app, runtime_dir).and_then(|xray_path| {
        ensure_geo_data(app, runtime_dir)?;
        Ok(xray_path)
    }) {
        Ok(xray_path) => Ok(xray_path),
        Err(initial_error) => {
            append_download_diagnostic_log(
                app,
                "runtime-download",
                format!("connect-preflight-failed initial_error={initial_error}"),
            );
            auto_repair_runtime_components_for_connect(app)
                .await
                .map_err(|error| format!("运行时组件自动修复失败：{error}"))?;
            let xray_path = ensure_xray_binary(app, runtime_dir)?;
            ensure_geo_data(app, runtime_dir)?;
            Ok(xray_path)
        }
    }
}

fn runtime_component_target_path(app: &AppHandle, component: RuntimeComponentKindInput) -> Result<PathBuf, String> {
    Ok(installed_runtime_bin_dir(app)?.join(runtime_component_file_name(component)))
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

fn bundled_runtime_component_resource_name(component: RuntimeComponentKindInput) -> &'static str {
    match component {
        RuntimeComponentKindInput::Xray => bundled_runtime_binary_resource_name(),
        RuntimeComponentKindInput::Geoip => "geoip.dat",
        RuntimeComponentKindInput::Geosite => "geosite.dat",
    }
}

fn bundled_runtime_binary_resource_name() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        if detect_runtime_component_architecture() == "arm64" {
            return "xray-aarch64-apple-darwin";
        }
        return "xray-x86_64-apple-darwin";
    }

    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        "xray.exe"
    }

    #[cfg(not(any(target_os = "macos", all(target_os = "windows", target_arch = "x86_64"))))]
    {
        runtime_binary_name()
    }
}

fn bundled_runtime_component_source_path(app: &AppHandle, component: RuntimeComponentKindInput) -> Option<PathBuf> {
    let resource_name = bundled_runtime_component_resource_name(component);
    let resource_dir = app.path().resource_dir().ok();
    if let Some(resource_dir) = resource_dir {
        let direct_path = resource_dir.join(resource_name);
        if direct_path.exists() {
            return Some(direct_path);
        }
        let nested_path = resource_dir.join("bin").join(resource_name);
        if nested_path.exists() {
            return Some(nested_path);
        }
    }

    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            let sibling_bin_path = exe_dir.join("bin").join(resource_name);
            if sibling_bin_path.exists() {
                return Some(sibling_bin_path);
            }
        }
    }

    let manifest_bin = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("bin").join(resource_name);
    if manifest_bin.exists() {
        return Some(manifest_bin);
    }
    None
}

fn ensure_runtime_component_from_bundle(
    app: &AppHandle,
    component: RuntimeComponentKindInput,
    target_path: &Path,
) -> Result<bool, String> {
    if let Ok(metadata) = fs::metadata(target_path) {
        if metadata.len() > 0 {
            return Ok(false);
        }
    }

    let Some(source_path) = bundled_runtime_component_source_path(app, component) else {
        return Ok(false);
    };

    if let Some(parent) = target_path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::copy(&source_path, target_path).map_err(|error| {
        format!(
            "复制内置{}失败：{error}",
            runtime_component_display_name(component)
        )
    })?;
    if component == RuntimeComponentKindInput::Xray {
        ensure_executable(target_path)?;
    }
    Ok(true)
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

fn sha256_file_plain(path: &Path) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|error| format!("读取安装器文件失败：{error}"))?;
    Ok(hex::encode(Sha256::digest(bytes)))
}

fn normalize_sha256(value: &str) -> String {
    value.trim().replace(':', "").to_lowercase()
}

fn normalize_optional_sha256(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(normalize_sha256)
}

fn maybe_log_download_checkpoint(
    app: &AppHandle,
    category: &str,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
    last_logged_bytes: &mut u64,
) {
    if downloaded_bytes == 0 {
        return;
    }

    let should_log = *last_logged_bytes == 0
        || downloaded_bytes.saturating_sub(*last_logged_bytes) >= DOWNLOAD_DIAGNOSTIC_CHECKPOINT_BYTES
        || total_bytes.map(|value| downloaded_bytes >= value).unwrap_or(false);
    if !should_log {
        return;
    }

    let total_label = total_bytes
        .map(|value| value.to_string())
        .unwrap_or_else(|| "unknown".to_string());
    let percent_label = total_bytes
        .filter(|value| *value > 0)
        .map(|value| format!(" ({:.1}%)", downloaded_bytes as f64 * 100.0 / value as f64))
        .unwrap_or_default();
    append_download_diagnostic_log(
        app,
        category,
        format!(
            "checkpoint downloaded={} total={}{}",
            downloaded_bytes, total_label, percent_label
        ),
    );
    *last_logged_bytes = downloaded_bytes;
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
    let fallback = app
        .path()
        .app_local_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("chordv-desktop"))
        .join("installer-cache");
    fs::create_dir_all(&fallback).map_err(|error| format!("创建安装器缓存目录失败：{error}"))?;
    Ok(fallback)
}

fn installer_download_url_allowed(url: &Url) -> bool {
    if url.scheme() == "https" {
        return true;
    }
    if url.scheme() != "http" {
        return false;
    }

    matches!(
        url.host_str().map(|value| value.to_ascii_lowercase()).as_deref(),
        Some("localhost") | Some("127.0.0.1") | Some("::1")
    )
}

fn installer_file_matches_expectation(
    path: &Path,
    expected_total_bytes: Option<u64>,
    expected_hash: Option<&str>,
) -> Result<bool, String> {
    let metadata = fs::metadata(path).map_err(|error| format!("读取安装器文件状态失败：{error}"))?;
    if metadata.len() == 0 {
        return Ok(false);
    }
    if let Some(expected_total_bytes) = expected_total_bytes {
        if metadata.len() != expected_total_bytes {
            return Ok(false);
        }
    }
    if let Some(expected_hash) = expected_hash {
        let actual_hash = sha256_file_plain(path)?;
        if actual_hash != expected_hash {
            return Ok(false);
        }
    }
    Ok(true)
}

fn validate_installer_file(
    path: &Path,
    downloaded_bytes: u64,
    expected_total_bytes: Option<u64>,
    expected_hash: Option<&str>,
) -> Result<(), String> {
    if downloaded_bytes == 0 {
        let _ = fs::remove_file(path);
        return Err("下载安装器失败：下载结果为空文件".into());
    }
    if let Some(expected_total_bytes) = expected_total_bytes {
        if downloaded_bytes != expected_total_bytes {
            let _ = fs::remove_file(path);
            return Err(format!(
                "下载安装器失败：文件大小与预期不一致（预期 {} 字节，实际 {} 字节）",
                expected_total_bytes, downloaded_bytes
            ));
        }
    }
    if let Some(expected_hash) = expected_hash {
        let actual_hash = sha256_file_plain(path)?;
        if actual_hash != expected_hash {
            let _ = fs::remove_file(path);
            return Err("下载安装器失败：文件校验未通过，请重新获取安装包。".into());
        }
    }
    Ok(())
}

fn installer_temp_path(path: &Path) -> PathBuf {
    path.with_extension(format!(
        "{}part",
        path.extension()
            .and_then(|value| value.to_str())
            .map(|value| format!("{value}."))
            .unwrap_or_default()
    ))
}

fn cleanup_outdated_installer_packages(app: &AppHandle) -> Result<(), String> {
    let download_dir = ensure_installer_download_dir(app)?;
    let current_version = app.package_info().version.to_string();
    let current_version = parse_installer_version(&current_version).ok_or_else(|| "当前应用版本号无效".to_string())?;
    let entries = fs::read_dir(&download_dir).map_err(|error| format!("读取安装包目录失败：{error}"))?;

    for entry in entries {
        let entry = match entry {
            Ok(value) => value,
            Err(_) => continue,
        };
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(file_name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        let Some(version) = installer_package_version(file_name) else {
            continue;
        };
        if compare_version_parts(&version, &current_version).is_lt() {
            let _ = fs::remove_file(&path);
        }
    }

    Ok(())
}

fn installer_package_version(file_name: &str) -> Option<Vec<u32>> {
    let prefix = "ChordV_";
    let rest = file_name.strip_prefix(prefix)?;

    if let Some(version) = rest.strip_suffix(".dmg") {
        return parse_installer_version(version);
    }

    if let Some(version) = rest.strip_suffix(".exe") {
        let version = version.split('_').next().unwrap_or(version);
        return parse_installer_version(version);
    }

    None
}

fn parse_installer_version(raw: &str) -> Option<Vec<u32>> {
    let trimmed = raw.trim().trim_start_matches('v');
    if trimmed.is_empty() {
        return None;
    }

    trimmed
        .split('.')
        .map(|part| {
            if part.is_empty() {
                return None;
            }
            part.parse::<u32>().ok()
        })
        .collect()
}

fn compare_version_parts(left: &[u32], right: &[u32]) -> std::cmp::Ordering {
    let max_len = left.len().max(right.len());
    for index in 0..max_len {
        let left_part = *left.get(index).unwrap_or(&0);
        let right_part = *right.get(index).unwrap_or(&0);
        match left_part.cmp(&right_part) {
            std::cmp::Ordering::Equal => continue,
            ordering => return ordering,
        }
    }
    std::cmp::Ordering::Equal
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

#[cfg(target_os = "macos")]
fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', r#"'"'"'"#))
}

#[cfg(windows)]
fn powershell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

#[cfg(target_os = "macos")]
fn spawn_deferred_installer_open(installer_path: &Path, current_pid: u32) -> Result<(), String> {
    let script = format!(
        "pid={current_pid}; while kill -0 \"$pid\" 2>/dev/null; do sleep 0.2; done; open {}",
        shell_quote(installer_path.to_string_lossy().as_ref())
    );
    Command::new("sh")
        .args(["-c", &script])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("准备打开安装器失败：{error}"))?;
    Ok(())
}

#[cfg(windows)]
fn spawn_deferred_installer_open(installer_path: &Path, current_pid: u32) -> Result<(), String> {
    let script = format!(
        "$pidToWait = {current_pid}; while (Get-Process -Id $pidToWait -ErrorAction SilentlyContinue) {{ Start-Sleep -Milliseconds 200 }}; Start-Sleep -Milliseconds 200; Start-Process -FilePath {} -ArgumentList '/UPDATE'",
        powershell_quote(installer_path.to_string_lossy().as_ref())
    );
    let mut command = Command::new("powershell");
    command.creation_flags(CREATE_NO_WINDOW);
    command
        .args(["-NoProfile", "-WindowStyle", "Hidden", "-Command", &script])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("准备打开安装器失败：{error}"))?;
    Ok(())
}

#[cfg(all(not(target_os = "android"), not(target_os = "macos"), not(windows)))]
fn spawn_deferred_installer_open(installer_path: &Path, current_pid: u32) -> Result<(), String> {
    let script = format!(
        "pid={current_pid}; while kill -0 \"$pid\" 2>/dev/null; do sleep 0.2; done; xdg-open {}",
        shell_quote(installer_path.to_string_lossy().as_ref())
    );
    Command::new("sh")
        .args(["-c", &script])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("准备打开安装器失败：{error}"))?;
    Ok(())
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
            "tag": "socks-in",
            "listen": "127.0.0.1",
            "port": config.local_socks_port,
            "protocol": "socks",
            "sniffing": {
              "enabled": true,
              "destOverride": ["http", "tls"]
            },
            "settings": {
              "auth": "noauth",
              "udp": true,
              "userLevel": 8
            }
          },
          {
            "tag": "tun-in",
            "protocol": "tun",
            "port": 0,
            "sniffing": {
              "enabled": true,
              "routeOnly": false,
              "destOverride": ["http", "tls"]
            },
            "settings": {
              "name": ANDROID_TUN_NAME,
              "MTU": ANDROID_TUN_MTU,
              "userLevel": 8
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
                #[cfg(windows)]
                state.runtime_component_handles.clear();
                state.status = "error".into();
                state.active_pid = None;
                state.child = None;
                state.active_config = None;
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
                #[cfg(windows)]
                state.runtime_component_handles.clear();
                state.status = "error".into();
                state.active_pid = None;
                state.child = None;
                state.active_config = None;
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
            #[cfg(windows)]
            state.runtime_component_handles.clear();
            state.status = "error".into();
            state.active_pid = None;
            state.child = None;
            state.active_config = None;
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

    #[cfg(windows)]
    state.runtime_component_handles.clear();

    if let Some(record) = load_runtime_pid_record(app) {
        if runtime_pid_belongs_to_chordv(app, &record) {
            let _ = kill_pid(record.pid);
        }
    }

    if let Some(path) = state.config_path.take() {
        let _ = fs::remove_file(path);
    }

    clear_runtime_pid(app);
    state.active_pid = None;
    state.active_config = None;
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

fn runtime_binary_path(app: &AppHandle) -> PathBuf {
    installed_runtime_bin_dir(app)
        .unwrap_or_else(|_| std::env::temp_dir().join("chordv-desktop").join("bin"))
        .join(runtime_binary_name())
}

fn legacy_runtime_bin_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .app_local_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("chordv-desktop"))
        .join("runtime")
        .join("bin")
}

fn cleanup_legacy_runtime_component_copies(app: &AppHandle) {
    let legacy_bin_dir = legacy_runtime_bin_dir(app);
    for file_name in [runtime_binary_name(), "geoip.dat", "geosite.dat"] {
        let path = legacy_bin_dir.join(file_name);
        if path.exists() {
            let _ = fs::remove_file(path);
        }
    }
}

fn cleanup_legacy_installed_runtime_names(app: &AppHandle) {
    if let Ok(bin_dir) = installed_runtime_bin_dir(app) {
        for file_name in ["xray-x86_64-pc-windows-msvc.exe"] {
            let path = bin_dir.join(file_name);
            if path.exists() {
                let _ = fs::remove_file(path);
            }
        }
    }
}

fn persist_runtime_pid(app: &AppHandle, pid: u32, binary_path: &Path) {
    let path = runtime_pid_path(app);
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let record = RuntimePidRecord {
        pid,
        binary_path: Some(binary_path.to_string_lossy().into_owned()),
    };
    let content = serde_json::to_string(&record).unwrap_or_else(|_| pid.to_string());
    let _ = fs::write(path, content);
}

fn load_runtime_pid_record(app: &AppHandle) -> Option<RuntimePidRecord> {
    let path = runtime_pid_path(app);
    let content = fs::read_to_string(path).ok()?;
    serde_json::from_str::<RuntimePidRecord>(&content)
        .ok()
        .or_else(|| {
            content.trim().parse::<u32>().ok().map(|pid| RuntimePidRecord {
                pid,
                binary_path: None,
            })
        })
}

fn runtime_pid_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        Command::new("kill")
            .args(["-0", &pid.to_string()])
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }

    #[cfg(windows)]
    {
        let mut command = Command::new("tasklist");
        command.creation_flags(CREATE_NO_WINDOW);
        command
            .args(["/FI", &format!("PID eq {pid}")])
            .output()
            .map(|output| String::from_utf8_lossy(&output.stdout).contains(&pid.to_string()))
            .unwrap_or(false)
    }
}

fn runtime_process_command(pid: u32) -> Option<String> {
    #[cfg(unix)]
    {
        Command::new("ps")
            .args(["-p", &pid.to_string(), "-o", "command="])
            .output()
            .ok()
            .and_then(|output| {
                if output.status.success() {
                    Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
                } else {
                    None
                }
            })
    }

    #[cfg(windows)]
    {
        let mut command = Command::new("powershell");
        command.creation_flags(CREATE_NO_WINDOW);
        command
            .args([
                "-NoProfile",
                "-Command",
                &format!(
                    "$p = Get-CimInstance Win32_Process -Filter \"ProcessId = {pid}\"; if ($p) {{ \"$($p.ExecutablePath)`n$($p.CommandLine)\" }}"
                ),
            ])
            .output()
            .ok()
            .and_then(|output| {
                if output.status.success() {
                    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
                    if text.is_empty() {
                        None
                    } else {
                        Some(text)
                    }
                } else {
                    None
                }
            })
    }
}

fn runtime_pid_belongs_to_chordv(app: &AppHandle, record: &RuntimePidRecord) -> bool {
    if !runtime_pid_alive(record.pid) {
        return false;
    }
    let expected_binary = record
        .binary_path
        .as_deref()
        .map(PathBuf::from)
        .unwrap_or_else(|| runtime_binary_path(app));
    let expected_binary_text = expected_binary.to_string_lossy().to_lowercase();
    let expected_runtime_dir_text = expected_binary
        .parent()
        .map(|path| path.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    runtime_process_command(record.pid)
        .map(|command| {
            let normalized = command.to_lowercase();
            normalized.contains(&expected_binary_text)
                || (!expected_runtime_dir_text.is_empty()
                    && normalized.contains(&expected_runtime_dir_text))
        })
        .unwrap_or(false)
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
    state.active_config = None;
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
    state.active_config = None;
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
        if !macos_proxy_owned_by_chordv()? {
            return Ok(());
        }
        clear_proxy()
    }

    #[cfg(windows)]
    {
        if !windows_proxy_owned_by_chordv()? {
            return Ok(());
        }
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

    let _ = socks_port;
    let expected = windows_manual_proxy_server(http_port);
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
    let bypass_hosts = api_proxy_bypass_hosts();
    for service in network_services() {
        run_networksetup(&["-setwebproxy", &service, "127.0.0.1", &http_port.to_string()])?;
        run_networksetup(&["-setsecurewebproxy", &service, "127.0.0.1", &http_port.to_string()])?;
        run_networksetup(&["-setsocksfirewallproxy", &service, "127.0.0.1", &socks_port.to_string()])?;
        run_networksetup(&["-setwebproxystate", &service, "on"])?;
        run_networksetup(&["-setsecurewebproxystate", &service, "on"])?;
        run_networksetup(&["-setsocksfirewallproxystate", &service, "on"])?;
        let mut bypass_command = Command::new("networksetup");
        bypass_command.arg("-setproxybypassdomains").arg(&service);
        for host in &bypass_hosts {
            bypass_command.arg(host);
        }
        let status = bypass_command.status()?;
        if !status.success() {
            return Err(io::Error::new(io::ErrorKind::Other, format!("设置代理绕过域名失败：{service}")));
        }
        verify_macos_proxy_config(&service, http_port, socks_port, &bypass_hosts)?;
    }

    Ok(())
}

#[cfg(target_os = "macos")]
fn clear_proxy() -> Result<(), std::io::Error> {
    for service in network_services() {
        let _ = run_networksetup(&["-setwebproxystate", &service, "off"]);
        let _ = run_networksetup(&["-setsecurewebproxystate", &service, "off"]);
        let _ = run_networksetup(&["-setsocksfirewallproxystate", &service, "off"]);
    }

    Ok(())
}

#[cfg(target_os = "macos")]
fn macos_proxy_owned_by_chordv() -> Result<bool, io::Error> {
    let bypass_hosts = api_proxy_bypass_hosts();
    for service in network_services() {
        let web_proxy = networksetup_output(&["-getwebproxy", &service])?;
        let secure_proxy = networksetup_output(&["-getsecurewebproxy", &service])?;
        let socks_proxy = networksetup_output(&["-getsocksfirewallproxy", &service])?;
        let bypass_output = networksetup_output(&["-getproxybypassdomains", &service])?;
        let proxy_owned =
            macos_proxy_points_to_loopback(&web_proxy)
                || macos_proxy_points_to_loopback(&secure_proxy)
                || macos_proxy_points_to_loopback(&socks_proxy);
        let bypass_owned = bypass_hosts.iter().all(|host| {
            bypass_output
                .lines()
                .any(|line| line.trim().eq_ignore_ascii_case(host))
        });
        if proxy_owned && bypass_owned {
            return Ok(true);
        }
    }
    Ok(false)
}

#[cfg(target_os = "macos")]
fn macos_proxy_points_to_loopback(output: &str) -> bool {
    let enabled = output.lines().any(|line| line.trim().eq_ignore_ascii_case("Enabled: Yes"));
    let server_ok = output
        .lines()
        .any(|line| line.trim().eq_ignore_ascii_case("Server: 127.0.0.1"));
    enabled && server_ok
}

#[cfg(windows)]
fn windows_manual_proxy_server(http_port: u16) -> String {
    format!("127.0.0.1:{http_port}")
}

#[cfg(windows)]
fn set_windows_proxy(http_port: u16, socks_port: u16) -> Result<(), io::Error> {
    let _ = socks_port;
    let proxy_server = windows_manual_proxy_server(http_port);
    let proxy_override = {
        let mut entries = vec!["<local>".to_string()];
        for host in api_proxy_bypass_hosts() {
            if !entries.iter().any(|candidate| candidate.eq_ignore_ascii_case(&host)) {
                entries.push(host);
            }
        }
        entries.join(";")
    };
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
        &proxy_override,
        "/f",
    ])?;
    refresh_windows_proxy_settings()?;
    verify_windows_proxy_config(&proxy_server, &proxy_override)?;
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
fn windows_proxy_owned_by_chordv() -> Result<bool, io::Error> {
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
        return Ok(false);
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
    if !server_output.status.success() {
        return Ok(false);
    }
    let server_text = String::from_utf8_lossy(&server_output.stdout).to_lowercase();
    if !server_text.contains("127.0.0.1:") {
        return Ok(false);
    }

    let mut override_query = Command::new("reg");
    override_query.creation_flags(CREATE_NO_WINDOW);
    let override_output = override_query
        .args([
            "query",
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings",
            "/v",
            "ProxyOverride",
        ])
        .output()?;
    if !override_output.status.success() {
        return Ok(false);
    }
    let override_text = String::from_utf8_lossy(&override_output.stdout).to_lowercase();
    if !override_text.contains("<local>") {
        return Ok(false);
    }
    for host in api_proxy_bypass_hosts() {
        if !override_text.contains(&host.to_lowercase()) {
            return Ok(false);
        }
    }

    Ok(true)
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
fn verify_windows_proxy_config(expected_proxy_server: &str, expected_proxy_override: &str) -> Result<(), io::Error> {
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

    let mut override_query = Command::new("reg");
    override_query.creation_flags(CREATE_NO_WINDOW);
    let override_output = override_query
        .args([
            "query",
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings",
            "/v",
            "ProxyOverride",
        ])
        .output()?;
    let override_text = String::from_utf8_lossy(&override_output.stdout);
    if !override_output.status.success() || !override_text.contains(expected_proxy_override) {
        return Err(io::Error::new(
            io::ErrorKind::Other,
            "Windows 系统代理绕过地址未成功写入",
        ));
    }

    Ok(())
}

#[cfg(target_os = "macos")]
fn run_networksetup(args: &[&str]) -> Result<(), io::Error> {
    let status = Command::new("networksetup").args(args).status()?;
    if status.success() {
        Ok(())
    } else {
        Err(io::Error::new(
            io::ErrorKind::Other,
            format!("networksetup 执行失败：{:?}", args),
        ))
    }
}

#[cfg(target_os = "macos")]
fn networksetup_output(args: &[&str]) -> Result<String, io::Error> {
    let output = Command::new("networksetup").args(args).output()?;
    if !output.status.success() {
        return Err(io::Error::new(
            io::ErrorKind::Other,
            format!("networksetup 查询失败：{:?}", args),
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

#[cfg(target_os = "macos")]
fn verify_macos_proxy_config(
    service: &str,
    http_port: u16,
    socks_port: u16,
    bypass_hosts: &[String],
) -> Result<(), io::Error> {
    let web_proxy = networksetup_output(&["-getwebproxy", service])?;
    verify_macos_named_proxy(&web_proxy, http_port, "网页")?;

    let secure_proxy = networksetup_output(&["-getsecurewebproxy", service])?;
    verify_macos_named_proxy(&secure_proxy, http_port, "HTTPS")?;

    let socks_proxy = networksetup_output(&["-getsocksfirewallproxy", service])?;
    verify_macos_named_proxy(&socks_proxy, socks_port, "SOCKS")?;

    let bypass_output = networksetup_output(&["-getproxybypassdomains", service])?;
    for host in bypass_hosts {
        if !bypass_output.lines().any(|line| line.trim().eq_ignore_ascii_case(host)) {
            return Err(io::Error::new(
                io::ErrorKind::Other,
                format!("代理绕过域名未生效：{service} 缺少 {host}"),
            ));
        }
    }

    Ok(())
}

#[cfg(target_os = "macos")]
fn verify_macos_named_proxy(output: &str, expected_port: u16, label: &str) -> Result<(), io::Error> {
    let enabled = output.lines().any(|line| line.trim().eq_ignore_ascii_case("Enabled: Yes"));
    let server_ok = output
        .lines()
        .any(|line| line.trim().eq_ignore_ascii_case("Server: 127.0.0.1"));
    let port_ok = output.lines().any(|line| line.trim() == format!("Port: {expected_port}"));
    if enabled && server_ok && port_ok {
        return Ok(());
    }
    Err(io::Error::new(
        io::ErrorKind::Other,
        format!("{label} 代理配置未成功生效"),
    ))
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

    if let Some(record) = load_runtime_pid_record(app) {
        if runtime_pid_belongs_to_chordv(app, &record) {
            let _ = kill_pid(record.pid);
        }
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
    cleanup_legacy_runtime_component_copies(app);
    cleanup_legacy_installed_runtime_names(app);
}

fn cleanup_runtime_artifacts_on_startup(app: &AppHandle) {
    if let Some(record) = load_runtime_pid_record(app) {
        if runtime_pid_belongs_to_chordv(app, &record) {
            return;
        }
        clear_runtime_pid(app);
    }

    let runtime_dir = app
        .path()
        .app_local_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("chordv-desktop"))
        .join("runtime");

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
    cleanup_legacy_runtime_component_copies(app);
    cleanup_legacy_installed_runtime_names(app);
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

#[cfg(target_os = "android")]
fn show_main_window_internal(_app: &AppHandle) -> Result<(), String> {
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

#[cfg(target_os = "android")]
fn hide_main_window_internal(_app: &AppHandle) -> Result<(), String> {
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
    let next_primary_action_label = shell_primary_action_label(&runtime.status);
    let mut should_refresh = false;
    if let Ok(mut shell) = app.state::<Mutex<ShellState>>().lock() {
        let next_signed_in = shell.signed_in;
        if !shell_state_matches(
            &shell,
            &runtime.status,
            next_signed_in,
            runtime.active_node_name.as_deref(),
            &next_primary_action_label,
        ) {
            shell.status = runtime.status.clone();
            shell.node_name = runtime.active_node_name.clone();
            shell.primary_action_label = next_primary_action_label;
            should_refresh = true;
        }
    }
    if should_refresh {
        let _ = refresh_shell_ui(app);
    }
}

#[cfg(target_os = "android")]
fn sync_shell_from_runtime(_app: &AppHandle, _runtime: &RuntimeState) {}

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
    notify_native_lease_heartbeat(app);
    Ok(())
}

#[cfg(target_os = "android")]
fn disconnect_runtime_internal(app: &AppHandle) -> Result<(), String> {
    let runtime_state = app.state::<Mutex<RuntimeState>>();
    let mut state = runtime_state
        .lock()
        .map_err(|_| "运行时状态异常".to_string())?;

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
    state.last_error = None;
    notify_native_lease_heartbeat(app);
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

#[cfg(target_os = "android")]
fn refresh_shell_ui(_app: &AppHandle) -> Result<(), String> {
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
                if let TrayIconEvent::DoubleClick {
                    button: MouseButton::Left,
                    ..
                } = event
                {
                    let _ = show_main_window_internal(&tray.app_handle());
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
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default()
        .plugin(android_mobile_plugin::init())
        .manage(Mutex::new(RuntimeState::default()))
        .manage(Mutex::new(ShellState {
            status: "idle".into(),
            signed_in: false,
            node_name: None,
            primary_action_label: "连接/断开".into(),
        }))
        .manage(Mutex::new(InstallerOperationState::default()))
        .manage(Mutex::new(RuntimeComponentDownloadState::default()))
        .manage(Mutex::new(NativeLeaseHeartbeatSignalState::default()))
        .manage(AsyncMutex::new(NativeSessionRefreshState::default()))
        .manage(AsyncMutex::new(ClientEventsStreamState::default()))
        .manage(Mutex::new(android_runtime::AndroidRuntimeState::default()));

    #[cfg(not(target_os = "android"))]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            let _ = show_main_window_internal(app);
        }));
    }

    let app = builder
        .setup(|app| {
            cleanup_runtime_artifacts_on_startup(&app.handle());
            start_native_lease_heartbeat_loop(app.handle().clone());
            #[cfg(not(target_os = "android"))]
            {
                let _ = ensure_runtime_bin_dir(&app.handle());
                let _ = cleanup_outdated_installer_packages(&app.handle());
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
            refresh_session_native,
            start_client_events_stream,
            stop_client_events_stream,
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
            runtime_snapshot,
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
