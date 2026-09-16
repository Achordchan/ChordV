mod update_report;
#[cfg(any(windows, test))]
mod windows_update;
#[cfg(windows)]
mod windows_installer;
mod process_identity;
mod exit_gate;
mod proxy_cleanup;
mod log_tail;
mod startup_gate;
static STARTUP_READY: startup_gate::StartupGate = startup_gate::StartupGate::new();
static EXIT_CLEANUP: exit_gate::ExitGate = exit_gate::ExitGate::new();
#[cfg(not(target_os = "android"))]
mod tls_fingerprint;
mod session_store;
static NATIVE_SESSION_STORE: session_store::SessionStore = session_store::SessionStore::new();
mod bounded_command;
use bounded_command::{ChildGuard, CommandDeadlineExt, with_command_budget};
mod connection_generation;
mod node_probe;
mod android_mobile_plugin;
mod android_runtime;
mod routing_diagnostics;
mod window_transition;

use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    net::TcpStream,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{mpsc, Mutex, OnceLock},
    thread,
    time::{Duration, Instant},
};
#[cfg(not(target_os = "android"))]
use tauri::menu::{MenuBuilder, MenuItemBuilder};
#[cfg(target_os = "macos")]
use tauri::menu::{PredefinedMenuItem, SubmenuBuilder};
#[cfg(target_os = "macos")]
use tauri::ActivationPolicy;
use tauri::{ipc::Channel, AppHandle, Emitter, Manager, RunEvent, State};
use tokio::sync::{oneshot, Mutex as AsyncMutex};
use url::Url;

use sha2::{Digest, Sha256};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
use windows_sys::Win32::Networking::WinInet::{
    InternetSetOptionW, INTERNET_OPTION_REFRESH, INTERNET_OPTION_SETTINGS_CHANGED,
};

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

static CONNECTION_GENERATION: connection_generation::ConnectionGeneration = connection_generation::ConnectionGeneration::new();

const ANDROID_TUN_NAME: &str = "chordv-vpn";
const ANDROID_TUN_MTU: u16 = 1500;
const ANDROID_TUN_IPV4_ADDRESS: &str = "172.19.0.2";
const ANDROID_TUN_IPV4_PREFIX: u8 = 30;
const ANDROID_TUN_IPV6_ADDRESS: &str = "fd66:6f72:6463::2";
const ANDROID_TUN_IPV6_PREFIX: u8 = 126;
const DOWNLOAD_PROGRESS_SLICE_BYTES: usize = 64 * 1024;
const DOWNLOAD_PROGRESS_EMIT_INTERVAL_MS: u64 = 120;
const DOWNLOAD_PROGRESS_EMIT_PERCENT_STEP: u64 = 1;
const DOWNLOAD_PROGRESS_EMIT_BYTES_STEP: u64 = 1024 * 1024;
const DOWNLOAD_DIAGNOSTIC_CHECKPOINT_BYTES: u64 = 512 * 1024;
const DOWNLOAD_DIAGNOSTIC_LOG_FILE_NAME: &str = "download-diagnostics.log";
const DOWNLOAD_TOTAL_TIMEOUT_SECS: u64 = 180;
const DOWNLOAD_CONNECT_TIMEOUT_SECS: u64 = 15;
const DOWNLOAD_IDLE_TIMEOUT_SECS: u64 = 20;
const SHARED_UPDATE_LIMITS_JSON: &str =
    include_str!("../../../../packages/shared/src/update-limits.data.json");
const MAX_RUNTIME_COMPONENT_DOWNLOAD_BYTES: u64 = 512 * 1024 * 1024;
const MAX_XRAY_RUNTIME_COMPONENT_DOWNLOAD_BYTES: u64 = 256 * 1024 * 1024;
const MAX_RUNTIME_COMPONENT_EXTRACTED_BYTES: u64 = 512 * 1024 * 1024;
const MAX_XRAY_RUNTIME_COMPONENT_EXTRACTED_BYTES: u64 = 256 * 1024 * 1024;
const CLIENT_EVENT_STREAM_IDLE_TIMEOUT_SECS: u64 = 45;
const MIN_WINDOWS_PE_BYTES: u64 = 1024 * 1024;
const MIN_GEO_DATA_BYTES: u64 = 64 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SharedUpdateLimits {
    max_desktop_update_download_bytes: u64,
}

fn max_desktop_update_download_bytes() -> u64 {
    static LIMIT: OnceLock<u64> = OnceLock::new();
    *LIMIT.get_or_init(|| {
        let limits: SharedUpdateLimits = serde_json::from_str(SHARED_UPDATE_LIMITS_JSON)
            .expect("shared update-limits.data.json must be valid");
        assert!(
            limits.max_desktop_update_download_bytes > 0,
            "shared desktop update download limit must be positive"
        );
        limits.max_desktop_update_download_bytes
    })
}

struct RuntimeState {
    status: String,
    active_session_id: Option<String>,
    active_attempt: Option<u64>,
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

#[derive(Default, Clone)]
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
    cancel_requested: bool,
}

#[derive(Default)]
struct InstallerOperationState {
    active: bool,
}

#[derive(Default)]
struct PendingInstallerState {
    path: Option<PathBuf>,
    expected_hash: Option<String>,
    expected_total_bytes: Option<u64>,
    package_kind: Option<String>,
}

#[derive(Default)]
struct NativeSessionRefreshState;

#[derive(Default)]
struct NativeLeaseHeartbeatSignalState {
    tx: Option<mpsc::Sender<()>>,
}

#[derive(Default)]
struct NativeClientEventStreamState {
    stops: HashMap<String, oneshot::Sender<()>>,
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
    let mut state = state.lock().map_err(|_| "安装器任务状态异常".to_string())?;
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
            active_attempt: None,
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
    country_code: Option<String>,
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
    mldsa65_verify: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ClientRoutingRuleDto {
    id: String,
    user_id: String,
    name: Option<String>,
    value: String,
    match_type: String,
    action: String,
    enabled: bool,
    created_at: String,
    updated_at: String,
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
    custom_routing_rules: Vec<ClientRoutingRuleDto>,
    outbound: RuntimeOutboundDto,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RuntimePolicyFeaturesDto {
    block_ads: bool,
    china_direct: bool,
    ai_services_proxy: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RoutingRuleTestInput {
    value: String,
    mode: String,
    features: RuntimePolicyFeaturesDto,
    custom_routing_rules: Vec<ClientRoutingRuleDto>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RoutingRuleTestResultDto {
    input: String,
    normalized_value: String,
    match_type: String,
    action: String,
    matched_rule: Option<ClientRoutingRuleDto>,
    message: String,
    reconnect_required: bool,
    test_host: String,
    elapsed_ms: u128,
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

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DesktopUpdateInstallReportDto {
    ok: bool,
    platform: String,
    mode: String,
    summary: Option<String>,
    detail: Option<String>,
    log_path: Option<String>,
    created_at: Option<String>,
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
struct ClientEventStreamInput {
    stream_id: String,
    access_token: String,
    last_event_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ClientEventStreamStartResponse {
    stream_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClientDiagnosticInput {
    category: String,
    message: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct NativeClientEventPayload {
    stream_id: String,
    event_id: Option<String>,
    event: Value,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct NativeClientEventOpenedPayload {
    stream_id: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct NativeClientEventErrorPayload {
    stream_id: String,
    message: String,
    status: Option<u16>,
    auth_error: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopInstallerDownloadInput {
    expected_version: Option<String>,
    file_name: Option<String>,
    package_kind: Option<String>,
    current_version: Option<String>,
    channel: Option<String>,
    preferred_candidate: Option<String>,
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BundledRuntimeComponentsStatus {
    ready: bool,
    runtime_bin_dir: Option<String>,
    copied_components: Vec<String>,
    missing_components: Vec<String>,
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeComponentLocalInfo {
    kind: String,
    exists: bool,
    path: Option<String>,
    size_bytes: Option<u64>,
    checksum_sha256: Option<String>,
    version_label: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteTextFetchResult {
    url: String,
    status: u16,
    body: String,
}

#[tauri::command]
async fn load_session(app: AppHandle) -> Result<Option<AuthSessionDto>, String> {
    tauri::async_runtime::spawn_blocking(move || load_session_blocking(app))
        .await.map_err(|error| error.to_string())?
}

fn load_session_blocking(app: AppHandle) -> Result<Option<AuthSessionDto>, String> {
    read_session_from_disk(&app)
}

#[tauri::command]
async fn save_session(app: AppHandle, session: AuthSessionDto) -> Result<CommandResult, String> {
    let epoch=NATIVE_SESSION_STORE.reserve_save();
    tauri::async_runtime::spawn_blocking(move || save_session_blocking(app, session, epoch))
        .await.map_err(|error| error.to_string())?
}

fn save_session_blocking(app: AppHandle, session: AuthSessionDto, epoch:session_store::SaveTicket) -> Result<CommandResult, String> {
    write_session_to_disk(&app, &session, epoch)?;

    Ok(CommandResult {
        ok: true,
        config_path: None,
        log_path: None,
        active_pid: None,
    })
}

#[tauri::command]
async fn clear_session(app: AppHandle) -> Result<CommandResult, String> {
    CONNECTION_GENERATION.invalidate();
    let epoch=NATIVE_SESSION_STORE.invalidate();
    tauri::async_runtime::spawn_blocking(move || clear_session_blocking(&app, epoch))
        .await.map_err(|error| error.to_string())?
}

fn clear_session_blocking(app: &AppHandle, epoch:u64) -> Result<CommandResult, String> {
    NATIVE_SESSION_STORE.clear_with(&session_path(app)?,epoch,||shutdown_runtime_state(app))?;

    Ok(CommandResult {
        ok: true,
        config_path: None,
        log_path: None,
        active_pid: None,
    })
}

fn read_session_from_disk(app: &AppHandle) -> Result<Option<AuthSessionDto>, String> {
    NATIVE_SESSION_STORE.read(&session_path(app)?).map(|(session,_)|session)
}

fn write_session_to_disk(app: &AppHandle, session: &AuthSessionDto, epoch:session_store::SaveTicket) -> Result<(), String> {
    let path=session_path(app)?;
    NATIVE_SESSION_STORE.save(&path,session,epoch)?;
    set_private_permissions(&path)
}

#[tauri::command]
async fn api_request(request: ApiRequestInput) -> Result<ApiResponseOutput, String> {
    let base = std::env::var("CHORDV_API_BASE_URL")
        .unwrap_or_else(|_| "https://v.achord.cn".to_string());
    let base = base.trim_end_matches('/');
    let api_path = if request.path.starts_with("/api/") {
        request.path.clone()
    } else {
        format!("/api{}", request.path)
    };
    let full_url = format!("{base}{api_path}");
    let url = Url::parse(&full_url).map_err(|error| format!("API 地址无效：{error}"))?;

    let force_https = std::env::var("CHORDV_DESKTOP_FORCE_HTTPS")
        .unwrap_or_else(|_| {
            if cfg!(debug_assertions) {
                "false".into()
            } else {
                "true".into()
            }
        })
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
        verify_server_certificate_fingerprint(&url, &expected).await?;
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
    let response = req
        .send()
        .await
        .map_err(|error| format!("请求 API 失败：{error}"))?;
    let status = response.status().as_u16();
    let body = response
        .text()
        .await
        .map_err(|error| format!("读取响应失败：{error}"))?;
    let elapsed_ms = started_at.elapsed().as_millis().min(u64::MAX as u128) as u64;
    Ok(ApiResponseOutput {
        status,
        body,
        elapsed_ms,
    })
}

#[tauri::command]
fn start_client_event_stream(
    app: AppHandle,
    input: ClientEventStreamInput,
    state: State<'_, Mutex<NativeClientEventStreamState>>,
) -> Result<ClientEventStreamStartResponse, String> {
    let access_token = input.access_token.trim().to_string();
    if access_token.is_empty() {
        return Err("access token is required".into());
    }
    let stream_id = input.stream_id.trim().to_string();
    if stream_id.is_empty() {
        return Err("stream id is required".into());
    }

    let (stop_tx, stop_rx) = oneshot::channel::<()>();
    {
        let mut state = state.lock().map_err(|_| "SSE 状态异常".to_string())?;
        if state.stops.contains_key(&stream_id) {
            return Err("stream id already exists".into());
        }
        state.stops.insert(stream_id.clone(), stop_tx);
    }

    let task_stream_id = stream_id.clone();
    tauri::async_runtime::spawn(async move {
        run_client_event_stream(
            app,
            task_stream_id,
            access_token,
            input.last_event_id,
            stop_rx,
        )
        .await;
    });

    Ok(ClientEventStreamStartResponse { stream_id })
}

#[tauri::command]
fn stop_client_event_stream(
    stream_id: String,
    state: State<'_, Mutex<NativeClientEventStreamState>>,
) -> Result<CommandResult, String> {
    let sender = {
        let mut state = state.lock().map_err(|_| "SSE 状态异常".to_string())?;
        state.stops.remove(stream_id.trim())
    };
    if let Some(sender) = sender {
        let _ = sender.send(());
    }
    Ok(CommandResult {
        ok: true,
        config_path: None,
        log_path: None,
        active_pid: None,
    })
}

#[tauri::command]
async fn record_client_diagnostic(app: AppHandle, input: ClientDiagnosticInput) -> Result<CommandResult, String> {
    tauri::async_runtime::spawn_blocking(move || record_client_diagnostic_blocking(app,input))
        .await.map_err(|error|error.to_string())?
}

fn record_client_diagnostic_blocking(app: AppHandle, input: ClientDiagnosticInput) -> Result<CommandResult, String> {
    let category = input.category.trim();
    let message = input.message.trim();
    if !category.is_empty() && !message.is_empty() {
        append_download_diagnostic_log(&app, category, message);
    }
    Ok(CommandResult {
        ok: true,
        config_path: None,
        log_path: None,
        active_pid: None,
    })
}

async fn run_client_event_stream(
    app: AppHandle,
    stream_id: String,
    access_token: String,
    last_event_id: Option<String>,
    mut stop_rx: oneshot::Receiver<()>,
) {
    let url = format!(
        "{}/api/client/events/stream",
        api_base_url().trim_end_matches('/')
    );
    append_download_diagnostic_log(&app, "client-sse", format!("starting stream {stream_id}"));
    let client = match Client::builder()
        .no_proxy()
        .connect_timeout(Duration::from_secs(15))
        .build()
    {
        Ok(client) => client,
        Err(error) => {
            append_download_diagnostic_log(
                &app,
                "client-sse",
                format!("stream {stream_id} client build failed: {error}"),
            );
            emit_client_event_stream_error(
                &app,
                &stream_id,
                format!("初始化 SSE 客户端失败：{error}"),
                None,
            );
            return;
        }
    };

    let mut request = client
        .get(url)
        .header("Authorization", format!("Bearer {access_token}"))
        .header("Accept", "text/event-stream")
        .header("Cache-Control", "no-cache");
    if let Some(last_event_id) = last_event_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        request = request.header("Last-Event-ID", last_event_id);
    }

    let mut response = match request.send().await {
        Ok(response) => response,
        Err(error) => {
            append_download_diagnostic_log(
                &app,
                "client-sse",
                format!("stream {stream_id} connect failed: {error}"),
            );
            emit_client_event_stream_error(
                &app,
                &stream_id,
                format!("连接 SSE 失败：{error}"),
                None,
            );
            return;
        }
    };

    let status = response.status();
    append_download_diagnostic_log(
        &app,
        "client-sse",
        format!("stream {stream_id} opened with status {}", status.as_u16()),
    );
    if !status.is_success() {
        let status_code = status.as_u16();
        let body = response.text().await.unwrap_or_default();
        append_download_diagnostic_log(
            &app,
            "client-sse",
            format!("stream {stream_id} rejected with status {status_code}: {body}"),
        );
        emit_client_event_stream_error(
            &app,
            &stream_id,
            parse_api_error_message(&body),
            Some(status_code),
        );
        return;
    }
    emit_client_event_stream_opened(&app, &stream_id);

    let mut buffer = Vec::<u8>::new();
    let idle_timeout = Duration::from_secs(CLIENT_EVENT_STREAM_IDLE_TIMEOUT_SECS);
    let idle_sleep = tokio::time::sleep(idle_timeout);
    tokio::pin!(idle_sleep);
    loop {
        tokio::select! {
            _ = &mut stop_rx => {
                append_download_diagnostic_log(&app, "client-sse", format!("stream {stream_id} stopped"));
                return;
            }
            _ = &mut idle_sleep => {
                append_download_diagnostic_log(&app, "client-sse", format!("stream {stream_id} idle timeout"));
                emit_client_event_stream_error(&app, &stream_id, "SSE idle timeout", None);
                return;
            }
            chunk = response.chunk() => {
                match chunk {
                    Ok(Some(bytes)) => {
                        buffer.extend_from_slice(&bytes);
                        drain_client_event_stream_buffer(&app, &stream_id, &mut buffer);
                        idle_sleep
                            .as_mut()
                            .reset(tokio::time::Instant::now() + idle_timeout);
                    }
                    Ok(None) => {
                        append_download_diagnostic_log(&app, "client-sse", format!("stream {stream_id} ended"));
                        emit_client_event_stream_error(&app, &stream_id, "SSE 连接已结束", None);
                        return;
                    }
                    Err(error) => {
                        append_download_diagnostic_log(
                            &app,
                            "client-sse",
                            format!("stream {stream_id} read failed: {error}"),
                        );
                        emit_client_event_stream_error(&app, &stream_id, format!("读取 SSE 失败：{error}"), None);
                        return;
                    }
                }
            }
        }
    }
}

fn drain_client_event_stream_buffer(app: &AppHandle, stream_id: &str, buffer: &mut Vec<u8>) {
    while let Some(chunk) = take_sse_chunk(buffer) {
        if let Some((event_id, event)) = parse_sse_event_chunk(&chunk) {
            let event_type = event
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            if event_type != "keepalive" {
                append_download_diagnostic_log(
                    app,
                    "client-sse",
                    format!(
                        "stream {stream_id} event {event_type} id {}",
                        event_id.as_deref().unwrap_or("-")
                    ),
                );
            }
            let _ = app.emit(
                "chordv://client-runtime-event",
                NativeClientEventPayload {
                    stream_id: stream_id.to_string(),
                    event_id,
                    event,
                },
            );
        }
    }
}

fn take_sse_chunk(buffer: &mut Vec<u8>) -> Option<Vec<u8>> {
    let lf_index = find_byte_sequence(buffer, b"\n\n").map(|index| (index, 2));
    let crlf_index = find_byte_sequence(buffer, b"\r\n\r\n").map(|index| (index, 4));
    let cr_index = find_byte_sequence(buffer, b"\r\r").map(|index| (index, 2));
    let (index, separator_len) = [lf_index, crlf_index, cr_index]
        .into_iter()
        .flatten()
        .min_by_key(|(index, _)| *index)?;
    let rest = buffer.split_off(index + separator_len);
    let mut chunk = std::mem::replace(buffer, rest);
    chunk.truncate(index);
    Some(chunk)
}

fn find_byte_sequence(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn parse_sse_event_chunk(chunk: &[u8]) -> Option<(Option<String>, Value)> {
    let chunk = String::from_utf8(chunk.to_vec()).ok()?;
    let mut event_id = None;
    let mut data_lines = Vec::new();
    for line in chunk.lines() {
        let line = line.trim_end_matches('\r');
        if let Some(value) = line.strip_prefix("id:") {
            let value = value.trim();
            if !value.is_empty() {
                event_id = Some(value.to_string());
            }
        } else if let Some(value) = line.strip_prefix("data:") {
            data_lines.push(value.trim().to_string());
        }
    }
    if data_lines.is_empty() {
        return None;
    }
    serde_json::from_str::<Value>(&data_lines.join("\n"))
        .ok()
        .map(|event| (event_id, event))
}

fn emit_client_event_stream_opened(app: &AppHandle, stream_id: &str) {
    let _ = app.emit(
        "chordv://client-runtime-event-open",
        NativeClientEventOpenedPayload {
            stream_id: stream_id.to_string(),
        },
    );
}

fn emit_client_event_stream_error(
    app: &AppHandle,
    stream_id: &str,
    message: impl Into<String>,
    status: Option<u16>,
) {
    let status = status.filter(|value| *value > 0);
    let _ = app.emit(
        "chordv://client-runtime-event-error",
        NativeClientEventErrorPayload {
            stream_id: stream_id.to_string(),
            message: message.into(),
            status,
            auth_error: matches!(status, Some(401 | 403)),
        },
    );
}

fn api_base_url() -> String {
    std::env::var("CHORDV_API_BASE_URL").unwrap_or_else(|_| "https://v.achord.cn".to_string())
}

fn api_client() -> Result<Client, String> {
    Client::builder()
        .timeout(Duration::from_secs(15))
        .no_proxy()
        .build()
        .map_err(|error| format!("初始化 API 客户端失败：{error}"))
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

async fn refresh_access_session_inner(
    app: &AppHandle,
    refresh_token: &str,
    epoch: session_store::SaveTicket,
    previous: &AuthSessionDto,
) -> Result<AuthSessionDto, String> {
    let url = format!("{}/api/auth/refresh", api_base_url().trim_end_matches('/'));
    let response = api_client()?
        .post(url)
        .header("Content-Type", "application/json")
        .body(json!({ "refreshToken": refresh_token }).to_string())
        .send()
        .await
        .map_err(|error| format!("刷新登录态失败：{error}"))?;
    let status = response.status().as_u16();
    let body = response
        .text()
        .await
        .map_err(|error| format!("读取响应失败：{error}"))?;
    if status < 200 || status >= 300 {
        return Err(parse_api_error_message(&body));
    }
    let session = serde_json::from_str::<AuthSessionDto>(&body)
        .map_err(|error| format!("解析登录态失败：{error}"))?;
    let path=session_path(app)?;
    NATIVE_SESSION_STORE.rotate(&path,&session,epoch,previous)?;
    set_private_permissions(&path)?;
    let mut event=serde_json::to_value(&session).map_err(|error|error.to_string())?;
    event["previousRefreshToken"]=json!(refresh_token);
    let _ = app.emit("chordv://native-session-refreshed", &event);
    Ok(session)
}

async fn refresh_access_session(
    app: &AppHandle,
    refresh_token_hint: Option<&str>,
) -> Result<AuthSessionDto, String> {
    let refresh_state = app.state::<AsyncMutex<NativeSessionRefreshState>>();
    let _guard = refresh_state.lock().await;

    let (session, epoch)=NATIVE_SESSION_STORE.read::<AuthSessionDto>(&session_path(app)?)?;
    let session=session.ok_or_else(|| "当前没有可用登录态".to_string())?;
    let stored_refresh_token = session.refresh_token.trim().to_string();
    let hinted_refresh_token = refresh_token_hint
        .map(str::trim)
        .filter(|value| !value.is_empty());

    if let Some(hint) = hinted_refresh_token {
        if hint != stored_refresh_token {
            return Ok(session);
        }
    }

    if stored_refresh_token.is_empty() {
        return Err("当前没有可用刷新令牌".into());
    }

    refresh_access_session_inner(app, &stored_refresh_token, epoch, &session).await
}

#[tauri::command]
async fn refresh_session_native(
    app: AppHandle,
    refresh_token: Option<String>,
) -> Result<AuthSessionDto, String> {
    refresh_access_session(&app, refresh_token.as_deref()).await
}

async fn native_heartbeat_once(
    session_id: &str,
    access_token: &str,
) -> Result<SessionLeaseStatusDto, (u16, String)> {
    let url = format!(
        "{}/api/client/session/heartbeat",
        api_base_url().trim_end_matches('/')
    );
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
    let body = response
        .text()
        .await
        .map_err(|error| (status, format!("读取响应失败：{error}")))?;
    if status < 200 || status >= 300 {
        return Err((status, parse_api_error_message(&body)));
    }
    serde_json::from_str::<SessionLeaseStatusDto>(&body)
        .map_err(|error| (status, format!("解析续租响应失败：{error}")))
}

fn emit_native_lease_event(app: &AppHandle, event: NativeLeaseHeartbeatEvent) {
    let _ = app.emit("chordv://native-lease-heartbeat", event);
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
                                let refreshed =
                                    refresh_access_session(&app, Some(&session.refresh_token))
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

fn api_proxy_bypass_hosts() -> Vec<String> {
    let mut hosts = vec!["localhost".to_string(), "127.0.0.1".to_string()];

    let base = std::env::var("CHORDV_API_BASE_URL")
        .unwrap_or_else(|_| "https://v.achord.cn".to_string());
    if let Ok(url) = Url::parse(base.trim()) {
        if let Some(host) = url.host_str() {
            let host = host.trim().to_string();
            if !host.is_empty()
                && !hosts
                    .iter()
                    .any(|candidate| candidate.eq_ignore_ascii_case(&host))
            {
                hosts.push(host);
            }
        }
    }

    hosts
}

#[derive(Debug, Clone)]
struct TrustedDesktopUpdatePackage {
    url: Url,
    file_name: Option<String>,
    expected_total_bytes: Option<u64>,
    expected_hash: Option<String>,
    package_kind: String,
}

fn api_base_url_parsed() -> Result<Url, String> {
    let base = api_base_url().trim_end_matches('/').to_string();
    Url::parse(&base).map_err(|error| format!("API 地址无效：{error}"))
}

fn is_url_under_api_base(url: &Url, api_base: &Url) -> bool {
    if url.scheme() != api_base.scheme() {
        return false;
    }
    if url.host_str().map(|value| value.to_ascii_lowercase())
        != api_base.host_str().map(|value| value.to_ascii_lowercase())
    {
        return false;
    }
    if url.port_or_known_default() != api_base.port_or_known_default() {
        return false;
    }
    let base_path = api_base.path().trim_end_matches('/');
    let path = url.path();
    path == base_path || path.starts_with(&format!("{base_path}/")) || path.starts_with("/api/")
}

fn json_string_field(value: &serde_json::Value, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(raw) = value.get(*key).and_then(|item| item.as_str()) {
            let trimmed = raw.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

fn json_u64_field(value: &serde_json::Value, keys: &[&str]) -> Option<u64> {
    for key in keys {
        if let Some(number) = value.get(*key).and_then(|item| item.as_u64()) {
            return Some(number);
        }
        if let Some(raw) = value.get(*key).and_then(|item| item.as_str()) {
            if let Ok(number) = raw.trim().parse::<u64>() {
                return Some(number);
            }
        }
    }
    None
}

fn resolve_trusted_desktop_update_url(
    api_base: &Url,
    download_url: &str,
    origin_download_url: Option<&str>,
    preferred_candidate: &str,
) -> Result<Url, String> {
    let (candidate_label, candidate_url) = match preferred_candidate {
        "mirror" => ("更新", download_url),
        "origin" => (
            "原始更新",
            origin_download_url
                .ok_or_else(|| "服务端更新清单缺少 originDownloadUrl".to_string())?,
        ),
        _ => return Err("更新下载候选仅支持 mirror 或 origin".into()),
    };
    let url = Url::parse(candidate_url)
        .or_else(|_| api_base.join(candidate_url))
        .map_err(|error| format!("服务端{candidate_label}地址无效：{error}"))?;
    if !installer_download_url_allowed(&url) {
        return Err(format!("服务端{candidate_label}地址协议不被允许"));
    }
    Ok(url)
}
async fn fetch_trusted_desktop_update_package(
    app: &AppHandle,
    current_version: &str,
    channel: &str,
    package_kind: &str,
    preferred_candidate: &str,
) -> Result<TrustedDesktopUpdatePackage, String> {
    let api_base = api_base_url_parsed()?;
    let check_url = api_base
        .join("/api/client/update/check")
        .map_err(|error| format!("更新检查地址无效：{error}"))?;
    let force_https = std::env::var("CHORDV_DESKTOP_FORCE_HTTPS")
        .unwrap_or_else(|_| {
            if cfg!(debug_assertions) {
                "false".into()
            } else {
                "true".into()
            }
        })
        .to_lowercase()
        == "true";
    if force_https && check_url.scheme() != "https" {
        return Err("生产环境仅允许 HTTPS API".into());
    }

    let access_token = read_session_from_disk(app)?
        .map(|session| session.access_token)
        .filter(|value| !value.trim().is_empty());

    let artifact_type = match package_kind {
        _ => {
            if cfg!(target_os = "macos") {
                "dmg"
            } else if cfg!(target_os = "windows") {
                "zip"
            } else {
                "external"
            }
        }
    };
    let platform = if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "linux"
    };

    let body = serde_json::json!({
        "currentVersion": current_version,
        "platform": platform,
        "channel": channel,
        "artifactType": artifact_type
    });

    let client = Client::builder()
        .connect_timeout(Duration::from_secs(DOWNLOAD_CONNECT_TIMEOUT_SECS))
        .timeout(Duration::from_secs(DOWNLOAD_TOTAL_TIMEOUT_SECS))
        .build()
        .map_err(|error| format!("初始化更新检查客户端失败：{error}"))?;
    let mut request = client
        .post(check_url.clone())
        .header("Content-Type", "application/json")
        .header("Accept", "application/json")
        .json(&body);
    if let Some(token) = access_token.as_deref() {
        request = request.bearer_auth(token);
    }
    let response = request
        .send()
        .await
        .map_err(|error| format!("查询桌面更新清单失败：{error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "查询桌面更新清单失败：HTTP {}",
            response.status().as_u16()
        ));
    }
    let payload: serde_json::Value = response
        .json()
        .await
        .map_err(|error| format!("解析桌面更新清单失败：{error}"))?;

    let delivery_mode = json_string_field(&payload, &["deliveryMode", "delivery_mode"])
        .unwrap_or_else(|| "none".into());
    let expected_delivery = "desktop_installer_download";
    if delivery_mode != expected_delivery {
        return Err(format!(
            "服务端更新清单不匹配：expected deliveryMode={expected_delivery}, got={delivery_mode}"
        ));
    }

    let artifact = payload
        .get("recommendedArtifact")
        .or_else(|| payload.get("artifact"))
        .cloned()
        .unwrap_or(serde_json::Value::Null);

    let download_url = json_string_field(&artifact, &["downloadUrl", "download_url"])
        .or_else(|| json_string_field(&payload, &["downloadUrl", "download_url"]))
        .ok_or_else(|| "服务端更新清单缺少 downloadUrl".to_string())?;
    let expected_hash = json_string_field(&artifact, &["fileHash", "file_hash"])
        .or_else(|| json_string_field(&payload, &["fileHash", "file_hash"]))
        .as_deref()
        .and_then(normalize_sha256_hex);
    let expected_total_bytes = Some(require_desktop_update_download_size(
        json_u64_field(&artifact, &["fileSizeBytes", "file_size_bytes", "fileSize"]).or_else(
            || json_u64_field(&payload, &["fileSizeBytes", "file_size_bytes", "fileSize"]),
        ),
    )?);
    let file_name = json_string_field(&artifact, &["fileName", "file_name"])
        .or_else(|| json_string_field(&payload, &["fileName", "file_name"]));
    let origin_download_url =
        json_string_field(&artifact, &["originDownloadUrl", "origin_download_url"]);

    let url = resolve_trusted_desktop_update_url(
        &api_base,
        &download_url,
        origin_download_url.as_deref(),
        preferred_candidate,
    )?;
    let _ = is_url_under_api_base(&url, &api_base);

    Ok(TrustedDesktopUpdatePackage {
        url,
        file_name,
        expected_total_bytes,
        expected_hash,
        package_kind: package_kind.to_string(),
    })
}

async fn fetch_trusted_desktop_installer_package(
    app: &AppHandle,
    current_version: &str,
    channel: &str,
    preferred_candidate: &str,
) -> Result<TrustedDesktopUpdatePackage, String> {
    fetch_trusted_desktop_update_package(
        app,
        current_version,
        channel,
        "installer",
        preferred_candidate,
    )
    .await
}

#[tauri::command]
async fn download_desktop_installer(
    app: AppHandle,
    input: DesktopInstallerDownloadInput,
    progress_channel: Channel<DesktopInstallerDownloadProgress>,
) -> Result<DesktopInstallerDownloadResult, String> {
    tauri::async_runtime::spawn_blocking(move || tauri::async_runtime::block_on(download_desktop_installer_inner(app, input, progress_channel)))
        .await.map_err(|error| error.to_string())?
}

async fn download_desktop_installer_inner(
    app: AppHandle,
    input: DesktopInstallerDownloadInput,
    progress_channel: Channel<DesktopInstallerDownloadProgress>,
) -> Result<DesktopInstallerDownloadResult, String> {
    ensure_startup_ready(&app)?;
    #[cfg(windows)]
    return windows_update::download(&app, &progress_channel, input.expected_version.as_deref(), input.preferred_candidate.as_deref()).await;
    #[cfg(target_os = "android")]
    {
        let _ = (app, input, progress_channel);
        return Err("安卓端不支持桌面安装器下载".into());
    }

    #[cfg(not(any(target_os = "android", windows)))]
    {
        set_installer_operation_active(&app, true)?;
        let result = async {
            let preferred_candidate = match input
                .preferred_candidate
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or("mirror")
            {
                "mirror" => "mirror",
                "origin" => "origin",
                _ => return Err("更新下载候选仅支持 mirror 或 origin".into()),
            };
            let (url, file_name_hint, expected_total_bytes, expected_hash, package_kind) =
                {
                    let current_version = input
                        .current_version
                        .as_deref()
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .map(|value| value.to_string())
                        .unwrap_or_else(|| app.package_info().version.to_string());
                    let channel = input
                        .channel
                        .as_deref()
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .unwrap_or("stable");
                    // Classic installers must also come from the trusted update-check API.
                    // Frontend-supplied URL/hash is intentionally ignored to prevent RCE via WebView.
                    let trusted =
                        fetch_trusted_desktop_installer_package(&app, &current_version, channel, preferred_candidate)
                            .await?;
                    (
                        trusted.url,
                        trusted.file_name.or(input.file_name.clone()),
                        trusted.expected_total_bytes,
                        trusted.expected_hash,
                        Some(trusted.package_kind),
                    )
                };

            let package_label = desktop_update_package_label(package_kind.as_deref());
            let file_name = resolve_installer_file_name(
                &url,
                file_name_hint.as_deref(),
                package_kind.as_deref(),
            );
            append_download_diagnostic_log(
                &app,
                "update-download",
                format!(
                    "start package={} url={} file_name={} expected_total_bytes={:?}",
                    package_label,
                    url,
                    file_name,
                    expected_total_bytes
                ),
            );
            send_update_download_progress(
                &app,
                &progress_channel,
                DesktopInstallerDownloadProgress {
                    phase: "preparing".into(),
                    file_name: Some(file_name.clone()),
                    downloaded_bytes: 0,
                    total_bytes: expected_total_bytes,
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
                    expected_total_bytes,
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
                            expected_total_bytes
                        ),
                    );
                    send_update_download_progress(
                        &app,
                        &progress_channel,
                        DesktopInstallerDownloadProgress {
                            phase: "completed".into(),
                            file_name: Some(file_name.clone()),
                            downloaded_bytes: metadata.len(),
                            total_bytes: expected_total_bytes.or(Some(metadata.len())),
                            local_path: Some(local_path.clone()),
                            message: Some("已复用本地安装器，正在打开安装程序…".into()),
                        },
                    );
                    remember_pending_installer_package(
                        &app,
                        final_path.clone(),
                        expected_hash.clone(),
                        Some(metadata.len()),
                        package_kind.clone(),
                    )?;
                    return Ok(DesktopInstallerDownloadResult {
                        file_name,
                        local_path,
                        total_bytes: expected_total_bytes.or(Some(metadata.len())),
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
                .connect_timeout(Duration::from_secs(
                    DOWNLOAD_CONNECT_TIMEOUT_SECS,
                ))
                .timeout(Duration::from_secs(
                    DOWNLOAD_TOTAL_TIMEOUT_SECS,
                ))
                .build()
                .map_err(|error| format!("初始化下载器失败：{error}"))?;
            append_download_diagnostic_log(
                &app,
                "update-download",
                "request-start".to_string(),
            );
            send_update_download_progress(
                &app,
                &progress_channel,
                DesktopInstallerDownloadProgress {
                    phase: "downloading".into(),
                    file_name: Some(file_name.clone()),
                    downloaded_bytes: 0,
                    total_bytes: expected_total_bytes,
                    local_path: None,
                    message: Some("正在连接下载服务器…".into()),
                },
            );
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
                    response_status, response_content_length, expected_total_bytes
                ),
            );

            if !response.status().is_success() {
                return Err(format!("下载安装器失败：HTTP {}", response.status().as_u16()));
            }

            let expected_download_bytes = expected_total_bytes
                .filter(|value| *value > 0)
                .ok_or_else(|| "trusted update package is missing file size metadata".to_string())?;
            let max_download_bytes = max_desktop_update_download_bytes();
            if expected_download_bytes > max_download_bytes {
                return Err(format!(
                    "update package exceeds the maximum download size: {expected_download_bytes} bytes"
                ));
            }
            if let Some(content_length) = response_content_length {
                if content_length == 0
                    || content_length > max_download_bytes
                    || content_length != expected_download_bytes
                {
                    return Err(format!(
                        "update package Content-Length mismatch: expected {expected_download_bytes}, got {content_length}"
                    ));
                }
            }
            let total_bytes = response_content_length.or(expected_total_bytes);
            let mut downloaded_bytes = 0_u64;
            let mut last_logged_bytes = 0_u64;
            let mut last_emitted_bytes = 0_u64;
            let mut first_chunk_logged = false;
            let mut last_progress_emit_at = Instant::now();
            let mut file = File::create(&temp_path).map_err(|error| format!("创建安装器文件失败：{error}"))?;
            send_update_download_progress(
                &app,
                &progress_channel,
                DesktopInstallerDownloadProgress {
                    phase: "downloading".into(),
                    file_name: Some(file_name.clone()),
                    downloaded_bytes,
                    total_bytes,
                    local_path: None,
                    message: Some("正在下载安装器…".into()),
                },
            );

            while let Some(chunk) = tokio::time::timeout(
                Duration::from_secs(DOWNLOAD_IDLE_TIMEOUT_SECS),
                response.chunk(),
            )
            .await
            .map_err(|_| {
                format!(
                    "download stalled with no data for {} seconds.",
                    DOWNLOAD_IDLE_TIMEOUT_SECS
                )
            })?
                .map_err(|error| format!("下载安装器失败：{error}"))?
            {
                for slice in chunk.chunks(DOWNLOAD_PROGRESS_SLICE_BYTES) {
                    let next_downloaded_bytes = match checked_desktop_update_download_size(
                        downloaded_bytes,
                        slice.len() as u64,
                        expected_download_bytes,
                    ) {
                        Ok(value) => value,
                        Err(error) => {
                            drop(file);
                            let _ = fs::remove_file(&temp_path);
                            return Err(error);
                        }
                    };
                    file.write_all(slice)
                        .map_err(|error| format!("写入安装器文件失败：{error}"))?;
                    downloaded_bytes = next_downloaded_bytes;
                    if !first_chunk_logged {
                        append_download_diagnostic_log(
                            &app,
                            "update-download",
                            format!("first-chunk bytes={}", slice.len()),
                        );
                        first_chunk_logged = true;
                    }
                    let progress_emit_due = should_emit_update_download_progress(
                        downloaded_bytes,
                        total_bytes,
                        last_emitted_bytes,
                        last_progress_emit_at,
                    );
                    if progress_emit_due {
                        send_update_download_progress(
                            &app,
                            &progress_channel,
                            DesktopInstallerDownloadProgress {
                                phase: "downloading".into(),
                                file_name: Some(file_name.clone()),
                                downloaded_bytes,
                                total_bytes,
                                local_path: None,
                                message: Some("正在下载安装器…".into()),
                            },
                        );
                        last_emitted_bytes = downloaded_bytes;
                        last_progress_emit_at = Instant::now();
                        tokio::task::yield_now().await;
                    }
                    maybe_log_download_checkpoint(
                        &app,
                        "update-download",
                        downloaded_bytes,
                        total_bytes,
                        &mut last_logged_bytes,
                    );
                }
                tokio::task::yield_now().await;
            }
            if downloaded_bytes > 0 {
                send_update_download_progress(
                    &app,
                    &progress_channel,
                    DesktopInstallerDownloadProgress {
                        phase: "downloading".into(),
                        file_name: Some(file_name.clone()),
                        downloaded_bytes,
                        total_bytes,
                        local_path: None,
                        message: Some("正在下载安装器…".into()),
                    },
                );
                tokio::task::yield_now().await;
            }

            file.flush().map_err(|error| format!("写入安装器文件失败：{error}"))?;
            send_update_download_progress(&app, &progress_channel, DesktopInstallerDownloadProgress {
                phase: "verifying".into(), file_name: Some(file_name.clone()), downloaded_bytes,
                total_bytes, local_path: None, message: Some("正在校验客户端更新包…".into()),
            });
            validate_installer_file(
                &temp_path,
                downloaded_bytes,
                expected_total_bytes,
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
            send_update_download_progress(
                &app,
                &progress_channel,
                DesktopInstallerDownloadProgress {
                    phase: "completed".into(),
                    file_name: Some(file_name.clone()),
                    downloaded_bytes,
                    total_bytes: expected_total_bytes.or(total_bytes).or(Some(downloaded_bytes)),
                    local_path: Some(local_path.clone()),
                    message: Some("安装器下载完成，正在打开安装程序…".into()),
                },
            );
            remember_pending_installer_package(
                &app,
                final_path.clone(),
                expected_hash.clone(),
                Some(downloaded_bytes),
                package_kind.clone(),
            )?;

            Ok(DesktopInstallerDownloadResult {
                file_name,
                local_path,
                total_bytes: expected_total_bytes.or(total_bytes).or(Some(downloaded_bytes)),
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

fn remember_pending_installer_package(
    app: &AppHandle,
    path: PathBuf,
    expected_hash: Option<String>,
    expected_total_bytes: Option<u64>,
    package_kind: Option<String>,
) -> Result<(), String> {
    let state: State<'_, Mutex<PendingInstallerState>> = app.state();
    let mut pending = state
        .lock()
        .map_err(|_| "installer pending state lock failed".to_string())?;
    pending.path = Some(path);
    pending.expected_hash = expected_hash;
    pending.expected_total_bytes = expected_total_bytes;
    pending.package_kind = package_kind;
    Ok(())
}

#[tauri::command]
async fn open_desktop_installer(app: AppHandle, path: String) -> Result<CommandResult, String> {
    tauri::async_runtime::spawn_blocking(move || open_desktop_installer_blocking(app, path))
        .await.map_err(|error| error.to_string())?
}

fn open_desktop_installer_blocking(app: AppHandle, path: String) -> Result<CommandResult, String> {
    #[cfg(target_os = "android")]
    {
        let _ = (app, path);
        return Err("安卓端不支持桌面安装器打开".into());
    }

    #[cfg(not(target_os = "android"))]
    {
        let installer_path = PathBuf::from(&path);
        if !installer_path.exists() {
            return Err("安装器文件不存在".into());
        }
        let download_dir = ensure_installer_download_dir(&app)?;
        let canonical_installer = installer_path
            .canonicalize()
            .map_err(|error| format!("无法解析安装器路径：{error}"))?;
        let canonical_download_dir = download_dir
            .canonicalize()
            .map_err(|error| format!("无法解析安装器缓存目录：{error}"))?;
        if !canonical_installer.starts_with(&canonical_download_dir) {
            return Err("只允许打开已由原生层校验的安装器缓存文件".into());
        }

        let state: State<'_, Mutex<PendingInstallerState>> = app.state();
        let pending = state.lock().map_err(|_| "安装器状态异常".to_string())?;
        let Some(pending_path) = pending.path.as_ref() else {
            return Err("没有已校验的待安装文件，请先完成原生下载".into());
        };
        let canonical_pending = pending_path
            .canonicalize()
            .map_err(|error| format!("无法解析待安装路径：{error}"))?;
        if canonical_pending != canonical_installer {
            return Err("安装器路径与原生校验记录不一致".into());
        }
        // Do not accept arbitrary local paths. Only acknowledge already-verified pending.
        Ok(CommandResult {
            ok: true,
            config_path: Some(installer_path.to_string_lossy().into_owned()),
            log_path: None,
            active_pid: None,
        })
    }
}

#[tauri::command]
async fn open_external_url(url: String) -> Result<CommandResult, String> {
    tauri::async_runtime::spawn_blocking(move || open_external_url_blocking(url))
        .await.map_err(|error| error.to_string())?
}

fn open_external_url_blocking(url: String) -> Result<CommandResult, String> {
    let parsed_url =
        Url::parse(url.trim()).map_err(|error| format!("外部链接格式无效：{error}"))?;
    if !matches!(parsed_url.scheme(), "http" | "https") {
        return Err("只允许打开 http 或 https 外部链接".into());
    }
    open_external_url_with_system(parsed_url.as_str())?;
    Ok(CommandResult {
        ok: true,
        config_path: None,
        log_path: None,
        active_pid: None,
    })
}

#[tauri::command]
async fn test_routing_rule(
    app: AppHandle,
    input: RoutingRuleTestInput,
) -> Result<RoutingRuleTestResultDto, String> {
    tauri::async_runtime::spawn_blocking(move || test_routing_rule_blocking(app, input))
        .await.map_err(|error| error.to_string())?
}

fn test_routing_rule_blocking(
    app: AppHandle,
    input: RoutingRuleTestInput,
) -> Result<RoutingRuleTestResultDto, String> {
    ensure_startup_ready(&app)?;
    let started_at = Instant::now();
    let target = normalize_routing_test_target(&input.value)?;
    let host = if target.match_type == "domain" {
        target.normalized_value.clone()
    } else {
        format!("{}.com", target.normalized_value)
    };

    if input.mode == "global" {
        return Ok(build_routing_test_result(
            &target,
            "proxy",
            None,
            "当前是全局代理模式，所有流量走代理。",
            &host,
            started_at,
        ));
    }
    if input.mode == "direct" {
        return Ok(build_routing_test_result(
            &target,
            "direct",
            None,
            "当前是直连模式，所有流量直连。",
            &host,
            started_at,
        ));
    }

    if let Some(rule) = input
        .custom_routing_rules
        .iter()
        .find(|rule| routing_test_rule_matches(rule, &target.normalized_value, &host))
    {
        let action_label = if rule.action == "proxy" {
            "强制代理"
        } else {
            "强制直连"
        };
        return Ok(build_routing_test_result(
            &target,
            rule.action.as_str(),
            Some(rule.clone()),
            format!(
                "命中自定义规则 {}:{}，会覆盖内置 GEO 规则并{action_label}。",
                rule.match_type, rule.value
            ),
            &host,
            started_at,
        ));
    }

    let geosite_path = installed_runtime_bin_dir(&app)?.join("geosite.dat");
    let geo = routing_diagnostics::query_geosite_routing(&geosite_path, &host)?;

    if input.features.block_ads && geo.ads {
        return Ok(build_routing_test_result(
            &target,
            "direct",
            None,
            "命中 geosite:category-ads-all 广告拦截规则；该目标会被阻断。",
            &host,
            started_at,
        ));
    }

    if input.features.china_direct && geo.cn {
        return Ok(build_routing_test_result(
            &target,
            "direct",
            None,
            "命中 geosite:cn 国内直连规则。",
            &host,
            started_at,
        ));
    }

    if routing_test_domain_matches_any(&host, &ai_service_domain_values()) {
        let action = if input.features.ai_services_proxy {
            "proxy"
        } else {
            "direct"
        };
        return Ok(build_routing_test_result(
            &target,
            action,
            None,
            format!(
                "命中 AI 服务规则，当前配置为{}。",
                if action == "proxy" {
                    "代理"
                } else {
                    "直连"
                }
            ),
            &host,
            started_at,
        ));
    }

    if routing_test_domain_matches_any(&host, &built_in_proxy_domain_values())
        || geo.geolocation_non_cn
    {
        return Ok(build_routing_test_result(
            &target,
            "proxy",
            None,
            "命中内置海外代理规则或 geosite:geolocation-!cn。",
            &host,
            started_at,
        ));
    }

    Ok(build_routing_test_result(
        &target,
        "proxy",
        None,
        "未命中特殊直连规则，按默认规则走代理。",
        &host,
        started_at,
    ))
}

fn desktop_update_report_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("failed to resolve app data directory: {error}"))?
        .join("updater");
    fs::create_dir_all(&dir)
        .map_err(|error| format!("failed to create updater directory: {error}"))?;
    Ok(dir.join("last-install-report.json"))
}

fn write_desktop_update_install_report(
    app: &AppHandle,
    ok: bool,
    mode: &str,
    summary: &str,
    detail: Option<&str>,
    log_path: Option<&Path>,
) -> Result<(), String> {
    let path = desktop_update_report_path(app)?;
    let platform = runtime_platform_name();
    let payload = serde_json::json!({
        "ok": ok,
        "platform": platform,
        "mode": mode,
        "summary": summary,
        "detail": detail,
        "logPath": log_path.map(|value| value.to_string_lossy().into_owned()),
        "createdAt": chrono::Utc::now().to_rfc3339(),
    });
    fs::write(&path, payload.to_string())
        .map_err(|error| format!("failed to write update install report: {error}"))
}

#[tauri::command]
async fn consume_desktop_update_install_report(
    app: AppHandle,
) -> Result<Option<DesktopUpdateInstallReportDto>, String> {
    tauri::async_runtime::spawn_blocking(move || consume_desktop_update_install_report_blocking(app))
        .await.map_err(|error| error.to_string())?
}

fn consume_desktop_update_install_report_blocking(
    app: AppHandle,
) -> Result<Option<DesktopUpdateInstallReportDto>, String> {
    #[cfg(windows)]
    windows_update::reconcile_install_result(&app)?;
    let path = desktop_update_report_path(&app)?;
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&path)
        .map_err(|error| format!("failed to read update install report: {error}"))?;
    // Windows PowerShell 5.1 reports may contain a UTF-8 BOM. Preserve the
    // report if parsing fails so diagnostics are not destroyed on first launch.
    let value = update_report::parse(&raw)?;
    fs::remove_file(&path)
        .map_err(|error| format!("failed to consume update install report: {error}"))?;
    Ok(Some(DesktopUpdateInstallReportDto {
        ok: value
            .get("ok")
            .and_then(|item| item.as_bool())
            .unwrap_or(false),
        platform: value
            .get("platform")
            .and_then(|item| item.as_str())
            .unwrap_or("unknown")
            .to_string(),
        mode: value
            .get("mode")
            .and_then(|item| item.as_str())
            .unwrap_or("unknown")
            .to_string(),
        summary: value
            .get("summary")
            .and_then(|item| item.as_str())
            .map(|item| item.to_string()),
        detail: value
            .get("detail")
            .and_then(|item| item.as_str())
            .map(|item| item.to_string()),
        log_path: value
            .get("logPath")
            .and_then(|item| item.as_str())
            .map(|item| item.to_string()),
        created_at: value
            .get("createdAt")
            .and_then(|item| item.as_str())
            .map(|item| item.to_string()),
    }))
}

#[tauri::command]
async fn quit_for_update(app: AppHandle) -> Result<CommandResult, String> {
    tauri::async_runtime::spawn_blocking(move || quit_for_update_blocking(app))
        .await.map_err(|error| error.to_string())?
}

fn quit_for_update_blocking(app: AppHandle) -> Result<CommandResult, String> {
    #[cfg(target_os = "android")]
    {
        let _ = app;
        return Err("安卓端不支持桌面安装器".into());
    }

    #[cfg(not(target_os = "android"))]
    {
        let (installer_path, expected_hash, expected_total_bytes, package_kind) = {
            let state: State<'_, Mutex<PendingInstallerState>> = app.state();
            let pending = state.lock().map_err(|_| "安装器状态异常".to_string())?;
            let path = pending
                .path
                .clone()
                .ok_or_else(|| "没有待安装的安装器文件".to_string())?;
            let expected_hash = pending.expected_hash.clone();
            let expected_total_bytes = pending.expected_total_bytes;
            let package_kind = pending.package_kind.clone();
            (path, expected_hash, expected_total_bytes, package_kind)
        };
        if !installer_path.exists() {
            return Err("安装器文件不存在，请重新下载".into());
        }
        let download_dir = ensure_installer_download_dir(&app)?;
        let canonical_installer = installer_path
            .canonicalize()
            .map_err(|error| format!("无法解析安装器路径：{error}"))?;
        let canonical_download_dir = download_dir
            .canonicalize()
            .map_err(|error| format!("无法解析安装器缓存目录：{error}"))?;
        if !canonical_installer.starts_with(&canonical_download_dir) {
            return Err("安装器路径不在原生缓存目录内".into());
        }
        if !installer_file_matches_expectation(
            &installer_path,
            expected_total_bytes,
            expected_hash.as_deref(),
        )? {
            return Err("安装器校验失败，请重新下载".into());
        }
        set_installer_operation_active(&app, true)?;
        if let Err(error)=shutdown_runtime_state(&app) {
            let _=set_installer_operation_active(&app,false);return Err(error);
        }
        let current_pid = std::process::id();
        if let Err(error) = spawn_deferred_installer_open(&app, &installer_path, current_pid) {
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
async fn install_windows_update(app: AppHandle) -> Result<CommandResult, String> {
    #[cfg(windows)]
    return tauri::async_runtime::spawn_blocking(move || windows_update::install(&app))
        .await.map_err(|error| error.to_string())?;
    #[cfg(not(windows))]
    { let _ = app; Err("此安装方式仅支持 Windows".into()) }
}

#[tauri::command]
async fn desktop_runtime_environment(app: AppHandle) -> Result<DesktopRuntimeEnvironment, String> {
    tauri::async_runtime::spawn_blocking(move || desktop_runtime_environment_blocking(app))
        .await.map_err(|error| error.to_string())?
}

fn desktop_runtime_environment_blocking(app: AppHandle) -> Result<DesktopRuntimeEnvironment, String> {
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
async fn get_runtime_component_local_info(
    app: AppHandle,
    component: RuntimeComponentKindInput,
) -> Result<RuntimeComponentLocalInfo, String> {
    tauri::async_runtime::spawn_blocking(move || get_runtime_component_local_info_blocking(app, component))
        .await.map_err(|error| error.to_string())?
}

fn get_runtime_component_local_info_blocking(
    app: AppHandle,
    component: RuntimeComponentKindInput,
) -> Result<RuntimeComponentLocalInfo, String> {
    ensure_startup_ready(&app)?;
    #[cfg(target_os = "android")]
    {
        let _ = (app, component);
        return Ok(RuntimeComponentLocalInfo {
            kind: runtime_component_key(component).into(),
            exists: false,
            path: None,
            size_bytes: None,
            checksum_sha256: None,
            version_label: None,
        });
    }

    #[cfg(not(target_os = "android"))]
    {
        let target_path = runtime_component_target_path(&app, component)?;
        // 本地信息查询只看存在性与大小，不触发 bundle 复制/哈希，避免启动卡 UI。
        if !target_path.exists() {
            return Ok(RuntimeComponentLocalInfo {
                kind: runtime_component_key(component).into(),
                exists: false,
                path: None,
                size_bytes: None,
                checksum_sha256: None,
            version_label: None,
            });
        }
        let metadata = fs::metadata(&target_path).map_err(|error| {
            runtime_component_error("write_failed", format!("读取组件文件状态失败：{error}"))
        })?;
        let size_bytes = metadata.len();
        if size_bytes == 0 {
            return Ok(RuntimeComponentLocalInfo {
                kind: runtime_component_key(component).into(),
                exists: true,
                path: Some(target_path.to_string_lossy().into_owned()),
                size_bytes: Some(0),
                checksum_sha256: None,
            version_label: None,
            });
        }
        // 检测更新/启动巡检只需要存在性与大小；GEO 大文件每次全量 sha256 会明显卡 UI。
        // 精确校验仍由 check_runtime_component_file / 下载落盘逻辑负责。
        Ok(RuntimeComponentLocalInfo {
            kind: runtime_component_key(component).into(),
            exists: true,
            path: Some(target_path.to_string_lossy().into_owned()),
            size_bytes: Some(size_bytes),
            checksum_sha256: None,
            version_label: if component == RuntimeComponentKindInput::Xray {
                detect_xray_version_label(&target_path)
            } else {
                None
            },
        })
    }
}

fn detect_xray_version_label(path: &Path) -> Option<String> {
    let mut command = Command::new(path);
    command.arg("version");
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    let output = command.bounded_output().ok()?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    parse_xray_version_output(&format!("{stdout}\n{stderr}"))
}

fn parse_xray_version_output(output: &str) -> Option<String> {
    output.split_whitespace().find_map(|token| {
        let candidate = token
            .trim_matches(|ch: char| !(ch.is_ascii_alphanumeric() || ch == '.' || ch == '-' || ch == '_'))
            .trim_start_matches(['v', 'V']);
        let mut parts = candidate.split('.');
        let major = parts.next()?;
        let minor = parts.next()?;
        let patch = parts.next()?.split(['-', '_']).next()?;
        if major.chars().all(|ch| ch.is_ascii_digit())
            && minor.chars().all(|ch| ch.is_ascii_digit())
            && patch.chars().all(|ch| ch.is_ascii_digit())
        {
            Some(candidate.to_string())
        } else {
            None
        }
    })
}

#[tauri::command]
async fn fetch_remote_text(url: String) -> Result<RemoteTextFetchResult, String> {
    let parsed = Url::parse(url.trim()).map_err(|error| format!("远程地址无效：{error}"))?;
    if !installer_download_url_allowed(&parsed) {
        return Err("远程地址仅支持 HTTP 或 HTTPS".into());
    }
    let client = Client::builder()
        .connect_timeout(Duration::from_secs(12))
        .timeout(Duration::from_secs(20))
        .user_agent("ChordV-Desktop-GEO-Update/1.0")
        .build()
        .map_err(|error| format!("初始化远程请求失败：{error}"))?;
    let response = client
        .get(parsed.clone())
        .header("Accept", "application/vnd.github+json, text/plain, */*")
        .send()
        .await
        .map_err(|error| format!("请求远程资源失败：{error}"))?;
    let status = response.status().as_u16();
    let body = response
        .text()
        .await
        .map_err(|error| format!("读取远程响应失败：{error}"))?;
    if !(200..300).contains(&status) {
        return Err(format!("请求远程资源失败：HTTP {status}"));
    }
    Ok(RemoteTextFetchResult {
        url: parsed.to_string(),
        status,
        body,
    })
}

#[tauri::command]
async fn check_runtime_component_file(
    app: AppHandle,
    component: RuntimeComponentDownloadItemInput,
) -> Result<RuntimeComponentFileStatus, String> {
    tauri::async_runtime::spawn_blocking(move || check_runtime_component_file_blocking(app, component))
        .await.map_err(|error| error.to_string())?
}

fn check_runtime_component_file_blocking(
    app: AppHandle,
    component: RuntimeComponentDownloadItemInput,
) -> Result<RuntimeComponentFileStatus, String> {
    ensure_startup_ready(&app)?;
    #[cfg(target_os = "android")]
    {
        let _ = (app, component);
        return Err("安卓端不支持桌面内核组件检查".into());
    }

    #[cfg(not(target_os = "android"))]
    {
        let target_path = runtime_component_target_path(&app, component.component)?;
        // 检查状态时不要回填 bundle，否则会把刚更新的远端文件状态掩盖掉。
        if !target_path.exists() {
            return Ok(RuntimeComponentFileStatus {
                ready: false,
                exists: false,
                path: None,
                reason_code: Some("component_missing".into()),
                message: Some(format!(
                    "{} 尚未下载。",
                    runtime_component_display_name(component.component)
                )),
            });
        }
        let metadata = fs::metadata(&target_path).map_err(|error| {
            runtime_component_error("write_failed", format!("读取组件文件状态失败：{error}"))
        })?;
        if metadata.len() == 0 {
            return Ok(RuntimeComponentFileStatus {
                ready: false,
                exists: true,
                path: Some(target_path.to_string_lossy().into_owned()),
                reason_code: Some("component_empty".into()),
                message: Some(format!(
                    "{} 文件为空，请重新下载。",
                    runtime_component_display_name(component.component)
                )),
            });
        }

        if component.component == RuntimeComponentKindInput::Xray {
            ensure_executable(&target_path)?;
        }

        let local_checksum = runtime_component_local_checksum(
            component.source_format,
            component.checksum_sha256.as_deref(),
        );
        if let Err(message) = validate_runtime_component_file_content_with_checksum(
            &target_path,
            component.component,
            local_checksum,
        ) {
            return Ok(RuntimeComponentFileStatus {
                ready: false,
                exists: true,
                path: Some(target_path.to_string_lossy().into_owned()),
                reason_code: Some("content_invalid".into()),
                message: Some(message),
            });
        }

        Ok(RuntimeComponentFileStatus {
            ready: true,
            exists: true,
            path: Some(target_path.to_string_lossy().into_owned()),
            reason_code: None,
            message: Some(format!(
                "{} 已准备完成。",
                runtime_component_display_name(component.component)
            )),
        })
    }
}

#[tauri::command]
async fn ensure_bundled_runtime_components(
    app: AppHandle,
) -> Result<BundledRuntimeComponentsStatus, String> {
    tauri::async_runtime::spawn_blocking(move || ensure_bundled_runtime_components_blocking(app))
        .await.map_err(|error| error.to_string())?
}

fn ensure_bundled_runtime_components_blocking(
    app: AppHandle,
) -> Result<BundledRuntimeComponentsStatus, String> {
    ensure_startup_ready(&app)?;
    #[cfg(target_os = "android")]
    {
        let _ = app;
        return Ok(BundledRuntimeComponentsStatus {
            ready: true,
            runtime_bin_dir: None,
            copied_components: Vec::new(),
            missing_components: Vec::new(),
            message: Some("安卓端不使用桌面内置组件。".into()),
        });
    }

    #[cfg(not(target_os = "android"))]
    {
        let runtime_bin_dir = installed_runtime_bin_dir(&app)?;
        let mut copied_components = Vec::new();
        let mut missing_components = Vec::new();

        for component in [
            RuntimeComponentKindInput::Xray,
            RuntimeComponentKindInput::Geoip,
            RuntimeComponentKindInput::Geosite,
        ] {
            let target_path = runtime_bin_dir.join(runtime_component_file_name(component));
            if ensure_runtime_component_from_bundle(&app, component, &target_path)? {
                copied_components.push(runtime_component_key(component).to_string());
            }

            let ready = fs::metadata(&target_path)
                .map(|metadata| metadata.len() > 0)
                .unwrap_or(false);
            if !ready {
                missing_components.push(runtime_component_key(component).to_string());
                continue;
            }

            if component == RuntimeComponentKindInput::Xray {
                ensure_executable(&target_path)?;
            }
        }

        let ready = missing_components.is_empty();
        let message = if ready {
            Some("内置内核组件已准备完成。".into())
        } else {
            Some(format!("缺少内置组件：{}", missing_components.join("、")))
        };

        Ok(BundledRuntimeComponentsStatus {
            ready,
            runtime_bin_dir: Some(runtime_bin_dir.to_string_lossy().into_owned()),
            copied_components,
            missing_components,
            message,
        })
    }
}

#[tauri::command]
async fn download_runtime_component(
    app: AppHandle,
    input: RuntimeComponentDownloadInput,
) -> Result<RuntimeComponentDownloadResult, String> {
    tauri::async_runtime::spawn_blocking(move || tauri::async_runtime::block_on(download_runtime_component_inner(app, input)))
        .await.map_err(|error| error.to_string())?
}

async fn download_runtime_component_inner(
    app: AppHandle,
    input: RuntimeComponentDownloadInput,
) -> Result<RuntimeComponentDownloadResult, String> {
    ensure_startup_ready(&app)?;
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
            if !installer_download_url_allowed(&download_url) {
                return Err(runtime_component_error("download_failed", "下载地址仅支持 HTTP 或 HTTPS".into()));
            }
            let max_download_bytes = runtime_component_max_download_bytes(component);
            let expected_total_bytes = input
                .component
                .file_size_bytes
                .filter(|value| *value > 0);
            if let Some(expected) = expected_total_bytes {
                if expected > max_download_bytes {
                    return Err(runtime_component_error(
                        "metadata_invalid",
                        format!(
                            "{} file size metadata is too large: {} bytes (max {}).",
                            runtime_component_display_name(component),
                            expected,
                            max_download_bytes
                        ),
                    ));
                }
            }
            // Prefer known size for progress/mismatch checks; remote plans may omit size and fall back to response Content-Length / max cap.
            append_download_diagnostic_log(
                &app,
                "runtime-download",
                format!(
                    "start component={} id={} url={} file_name={} expected_total_bytes={:?}",
                    component_name,
                    input.component.id,
                    download_url,
                    input.component.file_name,
                    input.component.file_size_bytes
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
                .connect_timeout(Duration::from_secs(DOWNLOAD_CONNECT_TIMEOUT_SECS))
                .timeout(Duration::from_secs(DOWNLOAD_TOTAL_TIMEOUT_SECS))
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

            if let (Some(content_length), Some(expected)) = (response_content_length, expected_total_bytes) {
                if content_length != expected {
                    return Err(runtime_component_error(
                        "metadata_mismatch",
                        format!(
                            "{} Content-Length mismatch: expected {expected}, got {content_length}",
                            runtime_component_display_name(component)
                        ),
                    ));
                }
            }
            if let Some(content_length) = response_content_length {
                if content_length == 0 {
                    return Err(runtime_component_error(
                        "metadata_invalid",
                        format!(
                            "{} Content-Length is empty.",
                            runtime_component_display_name(component)
                        ),
                    ));
                }
                if content_length > max_download_bytes {
                    return Err(runtime_component_error(
                        "metadata_invalid",
                        format!(
                            "{} Content-Length is too large: {} bytes (max {}).",
                            runtime_component_display_name(component),
                            content_length,
                            max_download_bytes
                        ),
                    ));
                }
            }
            let total_bytes = expected_total_bytes.or(response_content_length);
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

            ensure_runtime_component_download_not_cancelled(&app)?;
            while let Some(chunk) = tokio::time::timeout(
                Duration::from_secs(DOWNLOAD_IDLE_TIMEOUT_SECS),
                response.chunk(),
            )
            .await
            .map_err(|_| {
                runtime_component_error(
                    "download_timeout",
                    format!(
                        "{} download stalled with no data for {} seconds.",
                        runtime_component_display_name(component),
                        DOWNLOAD_IDLE_TIMEOUT_SECS
                    ),
                )
            })?
                .map_err(|error| runtime_component_error("download_failed", format!("下载 {} 失败：{error}", runtime_component_display_name(component))))?
            {
                for slice in chunk.chunks(DOWNLOAD_PROGRESS_SLICE_BYTES) {
                    archive_file
                        .write_all(slice)
                        .map_err(|error| runtime_component_error("write_failed", format!("写入组件文件失败：{error}")))?;
                    downloaded_bytes += slice.len() as u64;
                    if downloaded_bytes > max_download_bytes
                        || total_bytes.is_some_and(|expected| downloaded_bytes > expected)
                    {
                        let _ = fs::remove_file(&archive_path);
                        return Err(runtime_component_error(
                            "metadata_mismatch",
                            format!(
                                "{} download exceeded allowed size: got {downloaded_bytes} bytes (limit {}).",
                                runtime_component_display_name(component),
                                total_bytes.unwrap_or(max_download_bytes)
                            ),
                        ));
                    }
                    last_downloaded_bytes = downloaded_bytes;
                    ensure_runtime_component_download_not_cancelled(&app)?;
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
            if downloaded_bytes == 0 {
                let _ = fs::remove_file(&archive_path);
                return Err(runtime_component_error(
                    "download_failed",
                    format!(
                        "{} download returned an empty file.",
                        runtime_component_display_name(component)
                    ),
                ));
            }
            if let Some(expected) = expected_total_bytes {
                if downloaded_bytes != expected {
                    let _ = fs::remove_file(&archive_path);
                    return Err(runtime_component_error(
                        "metadata_mismatch",
                        format!(
                            "{} size mismatch: expected {expected}, got {downloaded_bytes}",
                            runtime_component_display_name(component)
                        ),
                    ));
                }
            } else if let Some(content_length) = response_content_length {
                if downloaded_bytes != content_length {
                    let _ = fs::remove_file(&archive_path);
                    return Err(runtime_component_error(
                        "metadata_mismatch",
                        format!(
                            "{} size mismatch: expected {content_length}, got {downloaded_bytes}",
                            runtime_component_display_name(component)
                        ),
                    ));
                }
            }
            emit_runtime_component_progress(
                &app,
                RuntimeComponentDownloadProgress {
                    phase: "verifying".into(),
                    component: component_name.into(),
                    file_name: Some(input.component.file_name.clone()),
                    downloaded_bytes,
                    total_bytes,
                    message: Some(format!("正在校验 {}…", runtime_component_display_name(component))),
                },
            );

            let archive_checksum = runtime_component_download_checksum(
                component,
                input.component.checksum_sha256.as_deref(),
            )
            .map_err(|message| runtime_component_error("metadata_invalid", message))?;
            if let Some(expected_hash) = archive_checksum.as_deref() {
                verify_file_sha256(
                    &archive_path,
                    expected_hash,
                    runtime_component_display_name(component),
                )
                .map_err(|message| runtime_component_error("hash_mismatch", message))?;
            }

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
                    extract_zip_entry(&archive_path, &temp_target_path, &entry_name, runtime_component_max_extracted_bytes(component))
                        .map_err(|error| runtime_component_error("extract_failed", error))?;
                }
            }

            validate_runtime_component_file_content_with_checksum(
                &temp_target_path,
                component,
                None,
            )
            .map_err(|message| runtime_component_error("content_invalid", message))?;

            if component == RuntimeComponentKindInput::Xray {
                ensure_executable(&temp_target_path)?;
            }

            // Preserve the working file if the final replacement fails.
            let previous_path = target_path.with_extension("previous");
            let had_previous = target_path.exists();
            if had_previous {
                if previous_path.exists() {
                    fs::remove_file(&previous_path).map_err(|error| runtime_component_error("write_failed", format!("清理组件备份失败：{error}")))?;
                }
                fs::rename(&target_path, &previous_path).map_err(|error| runtime_component_error("write_failed", format!("备份组件失败：{error}")))?;
            }
            if let Err(error) = fs::rename(&temp_target_path, &target_path) {
                if had_previous {
                    fs::rename(&previous_path, &target_path).map_err(|restore_error| runtime_component_error("write_failed", format!("保存失败：{error}；恢复旧组件失败：{restore_error}")))?;
                }
                return Err(runtime_component_error("write_failed", format!("保存 {} 失败：{error}", runtime_component_display_name(component))));
            }
            if had_previous { let _ = fs::remove_file(&previous_path); }
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
fn cancel_runtime_component_download(app: AppHandle) -> Result<CommandResult, String> {
    request_runtime_component_download_cancel(&app)?;
    Ok(CommandResult {
        ok: true,
        config_path: None,
        log_path: None,
        active_pid: None,
    })
}

#[tauri::command]
async fn probe_nodes(nodes: Vec<NodeSummaryDto>) -> Result<Vec<NodeProbeResultDto>, String> {
    node_probe::probe_nodes(nodes).await
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
    CONNECTION_GENERATION.invalidate();
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
        let _ = set_main_window_title(&window, &_app);
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
async fn runtime_status(app: AppHandle) -> Result<RuntimeStatusResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let binding = app.state::<Mutex<RuntimeState>>();
        let mut state = binding.lock().map_err(|_| "运行时状态异常".to_string())?;
        refresh_child_state(&mut state);
        #[cfg(not(target_os = "android"))]
        sync_shell_from_runtime(&app, &state);
        Ok(to_runtime_status_response(&state))
    }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
async fn runtime_logs(app: AppHandle) -> Result<RuntimeLogResponse, String> {
    tauri::async_runtime::spawn_blocking(move || runtime_logs_blocking(&app))
        .await.map_err(|error| error.to_string())?
}

fn runtime_logs_blocking(app: &AppHandle) -> Result<RuntimeLogResponse, String> {
    let log_path = {
        let binding = app.state::<Mutex<RuntimeState>>();
        let mut state = binding.lock().map_err(|_| "运行时状态异常".to_string())?;
        refresh_child_state(&mut state);
        state.log_path.clone()
    };
    let runtime_log = log_path.as_ref().map(|path| tail_log(path, 80)).unwrap_or_default();
    let download_log = download_diagnostics_log_path(&app)
        .ok()
        .map(|path| tail_log(&path, 120))
        .unwrap_or_default();
    let log = match (
        download_log.trim().is_empty(),
        runtime_log.trim().is_empty(),
    ) {
        (true, true) => String::new(),
        (false, true) => format!("=== 下载诊断日志 ===\n{download_log}"),
        (true, false) => runtime_log,
        (false, false) => {
            format!("=== 下载诊断日志 ===\n{download_log}\n\n=== 运行时日志 ===\n{runtime_log}")
        }
    };

    Ok(RuntimeLogResponse { log })
}

#[tauri::command]
async fn runtime_snapshot(app: AppHandle) -> Result<RuntimeSnapshotResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let binding = app.state::<Mutex<RuntimeState>>();
        let state = binding.lock().map_err(|_| "运行时状态异常".to_string())?;
        Ok(RuntimeSnapshotResponse { runtime: state.active_config.clone() })
    }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
async fn check_network_conflict(app: AppHandle) -> Result<(), String> {
    // Startup cleanup has its own bounded wait; do not spend the inspection's
    // three-second budget while waiting for our stale proxy to be restored.
    let startup_app=app.clone();
    tauri::async_runtime::spawn_blocking(move||ensure_startup_ready(&startup_app))
        .await.map_err(|error|error.to_string())??;
    let check = tauri::async_runtime::spawn_blocking(move || {
        let runtime = app.state::<Mutex<RuntimeState>>();
        let (http, socks) = {
            let state = runtime.try_lock().map_err(|_| "连接状态正在切换，请稍后重试。".to_string())?;
            if state.active_pid.is_some() {
                (state.local_http_port.unwrap_or(0), state.local_socks_port.unwrap_or(0))
            } else { (0, 0) }
        };
        detect_external_network_conflict(http, socks)
    });
    tokio::time::timeout(Duration::from_secs(3), check).await
        .map_err(|_| "本机网络占用检查超时，请稍后重试。".to_string())?
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn connect_runtime(app: AppHandle, config: GeneratedRuntimeConfigDto) -> Result<CommandResult, String> {
    EXIT_CLEANUP.ensure_running()?;
    let generation = CONNECTION_GENERATION.capture();
    tauri::async_runtime::spawn_blocking(move || connect_runtime_blocking(&app, config, generation))
        .await.map_err(|error| error.to_string())?
}

fn connect_runtime_blocking(app: &AppHandle, config: GeneratedRuntimeConfigDto, generation: u64) -> Result<CommandResult, String> {
    ensure_startup_ready(&app)?;
    let session_id = config.session_id.clone();
    static NEXT_ATTEMPT:std::sync::atomic::AtomicU64=std::sync::atomic::AtomicU64::new(0);
    let attempt=NEXT_ATTEMPT.fetch_add(1,std::sync::atomic::Ordering::Relaxed)+1;
    let result = connect_runtime_inner(app, config, generation, attempt);
    if let Err(error) = &result {
        let binding = app.state::<Mutex<RuntimeState>>();
        if let Ok(mut state) = binding.lock() {
            if owns_failed_connection(&state,attempt,&session_id) {
                if let Err(stop_error)=shutdown_runtime(app, &mut state) {
                    state.status="error".into();state.last_error=Some(stop_error.clone());
                    return Err(format!("{error}；{stop_error}"));
                }
                mark_failed_runtime_start(&mut state,error);
                sync_shell_from_runtime(app, &state);
            }
        };
    }
    result
}

fn mark_failed_runtime_start(state: &mut RuntimeState, error:&str) {
    state.status="error".into();
    state.active_session_id=None;
    state.active_node_id=None;
    state.active_node_name=None;
    state.active_config=None;
    state.active_pid=None;
    state.local_http_port=None;
    state.local_socks_port=None;
    state.last_error=Some(error.into());
}

fn owns_failed_connection(state:&RuntimeState,attempt:u64,session:&str)->bool {
    state.active_attempt==Some(attempt) && state.active_session_id.as_deref()==Some(session) && state.status!="connected"
}

fn connect_runtime_inner(app: &AppHandle, config: GeneratedRuntimeConfigDto, generation: u64, attempt:u64) -> Result<CommandResult, String> {
    let state = app.state::<Mutex<RuntimeState>>();
    {
        let mut state = state.lock().map_err(|_| "运行时状态异常".to_string())?;
        EXIT_CLEANUP.ensure_running()?;
        CONNECTION_GENERATION.ensure_current(generation)?;
        if state.status == "starting" || state.status == "connecting" {
            return Err("连接正在进行中".into());
        }
        // Same lock order as starting an asset download: runtime, then download.
        // A tray connection must not launch files being replaced by an update.
        let downloads: State<'_, Mutex<RuntimeComponentDownloadState>> = app.state();
        if downloads.lock().map_err(|_| "组件更新状态异常".to_string())?.active {
            return Err("组件正在更新，请完成后再连接。".into());
        }
        let had_runtime = state.active_session_id.is_some() || state.active_pid.is_some();
        stop_runtime_process(&app, &mut state)?;

        if had_runtime {
            let _ = clear_system_proxy();
        }

        if let Err(error) =
            detect_external_network_conflict(config.local_http_port, config.local_socks_port)
        {
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

        EXIT_CLEANUP.ensure_running()?;
        CONNECTION_GENERATION.ensure_current(generation)?;
        state.active_attempt=Some(attempt);
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
    let xray_binary_path = match tauri::async_runtime::block_on(prepare_desktop_runtime_components(
        &app,
        &runtime_dir,
    )) {
        Ok(path) => path,
        Err(error) => {
            let mut state = state.lock().map_err(|_| "运行时状态异常".to_string())?;
            EXIT_CLEANUP.ensure_running()?;
        CONNECTION_GENERATION.ensure_current(generation)?;
            if state.active_session_id.as_deref() != Some(config.session_id.as_str()) {
                return Err("连接已取消".into());
            }
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
    EXIT_CLEANUP.ensure_running()?;
        CONNECTION_GENERATION.ensure_current(generation)?;
    if state.status != "starting" || state.active_session_id.as_deref() != Some(config.session_id.as_str()) {
        return Err("连接已取消".into());
    }
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

    let child=ChildGuard::new(command.spawn().map_err(|error|format!("启动内核失败：{error}"))?);
    state.config_path=Some(config_path.clone());state.log_path=Some(log_path.clone());
    state.xray_binary_path=Some(xray_binary_path.clone());state.active_pid=Some(child.id());
    persist_runtime_pid(app,child.id(),&xray_binary_path);
    state.child=Some(child.into_inner());
    if let Some(exit_status)=state.child.as_mut().unwrap().try_wait().map_err(|error|error.to_string())? {
        let log=tail_log(&log_path,40);
        return Err(format!("内核启动失败：{exit_status}\n{log}"));
    }
    verify_runtime_ready(app,config.local_http_port,config.local_socks_port,generation)?;
    set_system_proxy(config.local_http_port,config.local_socks_port).map_err(|error|format!("设置系统代理失败：{error}"))?;
    #[cfg(windows)]
    {let runtime_bin_dir=installed_runtime_bin_dir(app)?;lock_runtime_component_files(&mut state,&runtime_bin_dir)?;}
    EXIT_CLEANUP.ensure_running()?;
    CONNECTION_GENERATION.ensure_current(generation)?;
    state.status = "connected".into();
    state.config_path = Some(config_path.clone());
    state.log_path = Some(log_path.clone());
    state.xray_binary_path = Some(xray_binary_path.clone());

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
async fn disconnect_runtime(app: AppHandle) -> Result<CommandResult, String> {
    CONNECTION_GENERATION.invalidate();
    tauri::async_runtime::spawn_blocking(move || disconnect_runtime_internal(&app))
        .await.map_err(|error| error.to_string())??;

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
    let line=format!("[{}] [{}] {}\n",chrono_like_now(),category,message.as_ref());
    let _=file.write_all(line.as_bytes());
}

fn ensure_runtime_bin_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let bin_dir = ensure_runtime_dir(app)?.join("bin");
    fs::create_dir_all(&bin_dir).map_err(|error| error.to_string())?;
    Ok(bin_dir)
}

fn installed_runtime_bin_dir(app: &AppHandle) -> Result<PathBuf, String> {
    #[cfg(target_os = "macos")]
    {
        ensure_runtime_bin_dir(app)
    }

    #[cfg(target_os = "windows")]
    {
        ensure_runtime_bin_dir(app)
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
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
}

fn ensure_xray_binary(app: &AppHandle, _runtime_dir: &Path) -> Result<PathBuf, String> {
    let installed_path = installed_runtime_bin_dir(app)?.join(runtime_binary_name());
    if ensure_runtime_component_from_bundle(app, RuntimeComponentKindInput::Xray, &installed_path)?
    {
        ensure_executable(&installed_path)?;
    }
    if !installed_path.exists() {
        return Err("必要内核组件未就绪，请先等待组件下载完成后再连接。".into());
    }
    let metadata = fs::metadata(&installed_path).map_err(|error| error.to_string())?;
    if metadata.len() == 0 {
        return Err("Xray 内核文件损坏，请重新下载必要内核组件。".into());
    }
    validate_runtime_component_file_content(&installed_path, RuntimeComponentKindInput::Xray)?;
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

fn runtime_component_max_extracted_bytes(component: RuntimeComponentKindInput) -> u64 {
    match component {
        RuntimeComponentKindInput::Xray => MAX_XRAY_RUNTIME_COMPONENT_EXTRACTED_BYTES,
        RuntimeComponentKindInput::Geoip | RuntimeComponentKindInput::Geosite => {
            MAX_RUNTIME_COMPONENT_EXTRACTED_BYTES
        }
    }
}

fn runtime_component_max_download_bytes(component: RuntimeComponentKindInput) -> u64 {
    match component {
        RuntimeComponentKindInput::Xray => MAX_XRAY_RUNTIME_COMPONENT_DOWNLOAD_BYTES,
        RuntimeComponentKindInput::Geoip | RuntimeComponentKindInput::Geosite => {
            MAX_RUNTIME_COMPONENT_DOWNLOAD_BYTES
        }
    }
}

fn runtime_component_min_size(component: RuntimeComponentKindInput) -> u64 {
    match component {
        RuntimeComponentKindInput::Xray => MIN_WINDOWS_PE_BYTES,
        RuntimeComponentKindInput::Geoip | RuntimeComponentKindInput::Geosite => MIN_GEO_DATA_BYTES,
    }
}

fn validate_runtime_component_file_content(
    path: &Path,
    component: RuntimeComponentKindInput,
) -> Result<(), String> {
    validate_runtime_component_file_content_with_checksum(path, component, None)
}

fn validate_runtime_component_file_content_with_checksum(
    path: &Path,
    component: RuntimeComponentKindInput,
    expected_hash: Option<&str>,
) -> Result<(), String> {
    let metadata = fs::metadata(path).map_err(|error| error.to_string())?;
    let min_size = runtime_component_min_size(component);
    if metadata.len() < min_size {
        return Err(format!(
            "{} is too small: expected at least {min_size} bytes, got {}",
            runtime_component_display_name(component),
            metadata.len()
        ));
    }
    #[cfg(windows)]
    if component == RuntimeComponentKindInput::Xray {
        validate_mz_header(path, runtime_component_display_name(component))?;
    }
    if let Some(expected_hash) = expected_hash
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let expected_hash = require_sha256_hex(
            Some(expected_hash),
            runtime_component_display_name(component),
        )?;
        verify_file_sha256(
            path,
            &expected_hash,
            runtime_component_display_name(component),
        )?;
    }
    Ok(())
}

fn validate_mz_header(path: &Path, label: &str) -> Result<(), String> {
    let mut file = File::open(path).map_err(|error| format!("failed to open {label}: {error}"))?;
    let mut magic = [0_u8; 2];
    file.read_exact(&mut magic)
        .map_err(|error| format!("failed to read {label} header: {error}"))?;
    if magic != *b"MZ" {
        return Err(format!("{label} is not a Windows PE file"));
    }
    Ok(())
}

fn ensure_geo_data(app: &AppHandle, _runtime_dir: &Path) -> Result<(), String> {
    let runtime_bin_dir = installed_runtime_bin_dir(app)?;
    for kind in [
        RuntimeComponentKindInput::Geoip,
        RuntimeComponentKindInput::Geosite,
    ] {
        let target = runtime_bin_dir.join(runtime_component_file_name(kind));
        let _ = ensure_runtime_component_from_bundle(app, kind, &target)?;
        if !target.exists() {
            return Err(format!(
                "{} 未就绪，请先等待组件下载完成后再连接。",
                runtime_component_display_name(kind)
            ));
        }
        let metadata = fs::metadata(&target).map_err(|error| error.to_string())?;
        validate_runtime_component_file_content(&target, kind)?;
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
fn lock_runtime_component_files(
    state: &mut RuntimeState,
    runtime_bin_dir: &Path,
) -> Result<(), String> {
    state.runtime_component_handles.clear();

    for file_name in ["geoip.dat", "geosite.dat"] {
        let path = runtime_bin_dir.join(file_name);
        let handle = OpenOptions::new()
            .read(true)
            .share_mode(0x0000_0001)
            .open(&path)
            .map_err(|error| {
                format!("锁定运行时文件失败（{}）：{error}", path.to_string_lossy())
            })?;
        state.runtime_component_handles.push(handle);
    }

    Ok(())
}

fn normalize_runtime_component_plan_file_size(
    value: Option<RuntimeComponentPlanFileSizeValue>,
) -> Option<u64> {
    match value {
        Some(RuntimeComponentPlanFileSizeValue::Number(raw)) => Some(raw),
        Some(RuntimeComponentPlanFileSizeValue::String(raw)) => {
            raw.trim().parse::<u64>().ok().filter(|parsed| *parsed > 0)
        }
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

async fn fetch_runtime_components_plan_for_connect(
    app: &AppHandle,
) -> Result<RuntimeComponentsPlanInput, String> {
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

fn runtime_component_download_item_from_plan(
    item: &RuntimeComponentPlanItemInput,
) -> RuntimeComponentDownloadItemInput {
    let archive_entry_name = resolve_runtime_component_archive_entry_name(item);
    RuntimeComponentDownloadItemInput {
        id: item.id.clone(),
        component: item.kind,
        file_name: item.file_name.clone(),
        file_size_bytes: normalize_runtime_component_plan_file_size(item.file_size_bytes.clone()),
        source_format: if archive_entry_name
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .is_some()
        {
            RuntimeComponentSourceFormat::ZipEntry
        } else {
            RuntimeComponentSourceFormat::Direct
        },
        archive_entry_name,
        checksum_sha256: item.expected_hash.clone(),
    }
}

fn resolve_runtime_component_archive_entry_name(
    item: &RuntimeComponentPlanItemInput,
) -> Option<String> {
    if let Some(value) = item
        .archive_entry_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return Some(value.to_string());
    }

    let file_name = item.file_name.trim();
    let lower = file_name.to_ascii_lowercase();
    let looks_like_zip = lower.ends_with(".zip") || lower.contains(".zip");
    if !looks_like_zip {
        return None;
    }

    match item.kind {
        RuntimeComponentKindInput::Xray => {
            #[cfg(target_os = "windows")]
            {
                Some("xray.exe".into())
            }
            #[cfg(not(target_os = "windows"))]
            {
                Some("xray".into())
            }
        }
        RuntimeComponentKindInput::Geoip => Some("geoip.dat".into()),
        RuntimeComponentKindInput::Geosite => Some("geosite.dat".into()),
    }
}

fn verify_runtime_component_for_connect(
    app: &AppHandle,
    item: &RuntimeComponentPlanItemInput,
) -> Result<(), String> {
    let component = runtime_component_download_item_from_plan(item);
    let target_path = runtime_component_target_path(app, component.component)?;
    let _ = ensure_runtime_component_from_bundle(app, component.component, &target_path)?;

    if !target_path.exists() {
        return Err(format!(
            "{} is missing after bundled runtime restore.",
            runtime_component_key(component.component)
        ));
    }

    validate_runtime_component_file_content_with_checksum(
        &target_path,
        component.component,
        component.checksum_sha256.as_deref(),
    )
    .map_err(|error| {
        format!(
            "{} failed local validation: {error}",
            runtime_component_key(component.component)
        )
    })?;

    if component.component == RuntimeComponentKindInput::Xray {
        ensure_executable(&target_path)?;
    }

    Ok(())
}

async fn verify_runtime_components_for_connect(app: &AppHandle) -> Result<(), String> {
    let plan = fetch_runtime_components_plan_for_connect(app).await?;
    if plan.components.is_empty() {
        return Err("runtime component plan is empty".into());
    }

    for required_component in [
        RuntimeComponentKindInput::Xray,
        RuntimeComponentKindInput::Geoip,
        RuntimeComponentKindInput::Geosite,
    ] {
        if !plan
            .components
            .iter()
            .any(|item| item.kind == required_component)
        {
            return Err(format!(
                "runtime component plan is missing {}",
                runtime_component_key(required_component)
            ));
        }
    }

    for required_component in [
        RuntimeComponentKindInput::Xray,
        RuntimeComponentKindInput::Geoip,
        RuntimeComponentKindInput::Geosite,
    ] {
        let item = plan
            .components
            .iter()
            .find(|item| item.kind == required_component)
            .ok_or_else(|| {
                format!(
                    "runtime component plan is missing {}",
                    runtime_component_key(required_component)
                )
            })?;
        verify_runtime_component_for_connect(app, item).map_err(|error| {
            append_download_diagnostic_log(
                app,
                "runtime-verify",
                format!(
                    "connect-verify component={} error={error}",
                    runtime_component_key(required_component)
                ),
            );
            error
        })?;
    }

    Ok(())
}

async fn prepare_desktop_runtime_components(
    app: &AppHandle,
    runtime_dir: &Path,
) -> Result<PathBuf, String> {
    if let Err(repair_error) = verify_runtime_components_for_connect(app).await {
        append_download_diagnostic_log(
            app,
            "runtime-verify",
            format!("connect-verify-unavailable error={repair_error}"),
        );
        return Err(format!(
            "runtime component verification failed before connect: {repair_error}"
        ));
    }

    match ensure_xray_binary(app, runtime_dir).and_then(|xray_path| {
        ensure_geo_data(app, runtime_dir)?;
        Ok(xray_path)
    }) {
        Ok(xray_path) => Ok(xray_path),
        Err(initial_error) => {
            append_download_diagnostic_log(
                app,
                "runtime-verify",
                format!("connect-preflight-failed initial_error={initial_error}"),
            );
            verify_runtime_components_for_connect(app)
                .await
                .map_err(|error| format!("runtime component verification failed: {error}"))?;
            let xray_path = ensure_xray_binary(app, runtime_dir)?;
            ensure_geo_data(app, runtime_dir)?;
            Ok(xray_path)
        }
    }
}

fn runtime_component_target_path(
    app: &AppHandle,
    component: RuntimeComponentKindInput,
) -> Result<PathBuf, String> {
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

    #[cfg(not(any(
        target_os = "macos",
        all(target_os = "windows", target_arch = "x86_64")
    )))]
    {
        runtime_binary_name()
    }
}

fn bundled_runtime_component_source_path(
    app: &AppHandle,
    component: RuntimeComponentKindInput,
) -> Option<PathBuf> {
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

    let manifest_bin = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("bin")
        .join(resource_name);
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
    // 内置包只用于“首次补齐 / 本地损坏回退”。
    // 绝不能因为本地文件与 bundle 大小不同就覆盖：用户可能已从远端更新了更新的 GEO/Xray。
    if target_path.exists() {
        match fs::metadata(target_path) {
            Ok(metadata) if metadata.len() > 0 => {
                if validate_runtime_component_file_content(target_path, component).is_ok() {
                    if component == RuntimeComponentKindInput::Xray {
                        let _ = ensure_executable(target_path);
                    }
                    return Ok(false);
                }
                // 本地文件损坏（过小/非 PE 等）时才允许用内置包覆盖。
            }
            _ => {}
        }
    }

    let Some(source_path) = bundled_runtime_component_source_path(app, component) else {
        return Ok(false);
    };
    validate_runtime_component_file_content(&source_path, component)?;

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

fn restore_runtime_component_from_verified_bundle(
    app: &AppHandle,
    component: RuntimeComponentKindInput,
    target_path: &Path,
    expected_hash: Option<&str>,
) -> Result<bool, String> {
    let Some(source_path) = bundled_runtime_component_source_path(app, component) else {
        return Ok(false);
    };
    if let Some(parent) = target_path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::copy(&source_path, target_path).map_err(|error| {
        format!(
            "failed to restore bundled {}: {error}",
            runtime_component_display_name(component)
        )
    })?;
    if let Some(expected_hash) = expected_hash
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let expected_hash = require_sha256_hex(
            Some(expected_hash),
            runtime_component_display_name(component),
        )?;
        verify_file_sha256(
            target_path,
            &expected_hash,
            runtime_component_display_name(component),
        )?;
    } else {
        validate_runtime_component_file_content(target_path, component)?;
    }
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
        if let Ok(output) = Command::new("uname").arg("-m").bounded_output() {
            let architecture = String::from_utf8_lossy(&output.stdout)
                .trim()
                .to_lowercase();
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
    let runtime: State<'_, Mutex<RuntimeState>> = app.state();
    let runtime = runtime.lock().map_err(|_| "运行时状态异常".to_string())?;
    if active && (runtime.active_pid.is_some() || runtime.active_session_id.is_some() || runtime.child.is_some()) {
        return Err("当前连接正在使用组件，请断开后更新。".into());
    }
    let state: State<'_, Mutex<RuntimeComponentDownloadState>> = app.state();
    let mut state = state
        .lock()
        .map_err(|_| "运行时组件下载状态异常".to_string())?;
    if active && state.active {
        return Err("必要核心组件正在下载，请稍后再试。".into());
    }
    state.active = active;
    if active {
        state.cancel_requested = false;
    }
    Ok(())
}

fn request_runtime_component_download_cancel(app: &AppHandle) -> Result<(), String> {
    let state: State<'_, Mutex<RuntimeComponentDownloadState>> = app.state();
    let mut state = state
        .lock()
        .map_err(|_| "运行时组件下载状态异常".to_string())?;
    if state.active {
        state.cancel_requested = true;
    }
    Ok(())
}

fn is_runtime_component_download_cancel_requested(app: &AppHandle) -> bool {
    let state: State<'_, Mutex<RuntimeComponentDownloadState>> = app.state();
    state
        .lock()
        .map(|value| value.cancel_requested)
        .unwrap_or(false)
}

fn ensure_runtime_component_download_not_cancelled(app: &AppHandle) -> Result<(), String> {
    if is_runtime_component_download_cancel_requested(app) {
        return Err(runtime_component_error(
            "download_cancelled",
            "下载已取消".into(),
        ));
    }
    Ok(())
}

fn sanitize_runtime_download_file_name(file_name: &str) -> String {
    sanitize_desktop_download_file_name(file_name)
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
        || downloaded_bytes.saturating_sub(*last_logged_bytes)
            >= DOWNLOAD_DIAGNOSTIC_CHECKPOINT_BYTES
        || total_bytes
            .map(|value| downloaded_bytes >= value)
            .unwrap_or(false);
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

fn extract_zip_entry(
    archive_path: &Path,
    target_path: &Path,
    entry_name: &str,
    max_bytes: u64,
) -> Result<(), String> {
    let file = File::open(archive_path).map_err(|error| format!("打开组件压缩包失败：{error}"))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|error| format!("解析组件压缩包失败：{error}"))?;
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
    let declared_size = entry.size();
    if declared_size == 0 {
        return Err(format!("压缩包内文件为空：{entry_name}"));
    }
    if declared_size > max_bytes {
        return Err(format!(
            "压缩包内文件过大：{entry_name} declares {declared_size} bytes (max {max_bytes})"
        ));
    }
    if let Some(parent) = target_path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建目标目录失败：{error}"))?;
    }
    let mut target =
        File::create(target_path).map_err(|error| format!("创建目标文件失败：{error}"))?;
    let mut written = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = entry
            .read(&mut buffer)
            .map_err(|error| format!("读取解压内容失败：{error}"))?;
        if read == 0 {
            break;
        }
        written = written
            .checked_add(read as u64)
            .ok_or_else(|| format!("解压写入计数溢出：{entry_name}"))?;
        if written > max_bytes {
            drop(target);
            let _ = fs::remove_file(target_path);
            return Err(format!(
                "解压结果超过上限：{entry_name} wrote {written} bytes (max {max_bytes})"
            ));
        }
        target
            .write_all(&buffer[..read])
            .map_err(|error| format!("写入解压文件失败：{error}"))?;
    }
    if written == 0 {
        drop(target);
        let _ = fs::remove_file(target_path);
        return Err(format!("解压结果为空：{entry_name}"));
    }
    if declared_size > 0 && written != declared_size {
        drop(target);
        let _ = fs::remove_file(target_path);
        return Err(format!(
            "解压大小与声明不一致：{entry_name} declared {declared_size}, got {written}"
        ));
    }
    target
        .flush()
        .map_err(|error| format!("写入解压文件失败：{error}"))?;
    Ok(())
}

fn desktop_update_zip_entry_path_is_safe(entry_name: &str) -> bool {
    let normalized = entry_name.replace('\\', "/");
    if normalized.trim().is_empty()
        || normalized.starts_with('/')
        || normalized.starts_with('\\')
        || normalized.contains(':')
    {
        return false;
    }
    normalized
        .split('/')
        .filter(|part| !part.is_empty())
        .all(|part| part != "." && part != "..")
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
        url.host_str()
            .map(|value| value.to_ascii_lowercase())
            .as_deref(),
        Some("localhost") | Some("127.0.0.1") | Some("::1")
    )
}

fn normalize_sha256_hex(value: &str) -> Option<String> {
    let normalized = value
        .trim()
        .to_ascii_lowercase()
        .chars()
        .filter(|ch| *ch != ':')
        .collect::<String>();
    if normalized.len() != 64 || !normalized.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return None;
    }
    Some(normalized)
}

fn require_sha256_hex(expected_hash: Option<&str>, label: &str) -> Result<String, String> {
    let raw = expected_hash
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("{label} missing SHA-256 checksum"))?;
    normalize_sha256_hex(raw).ok_or_else(|| format!("{label} has invalid SHA-256 checksum"))
}

fn runtime_component_local_checksum<'a>(
    source_format: RuntimeComponentSourceFormat,
    expected_hash: Option<&'a str>,
) -> Option<&'a str> {
    match source_format {
        RuntimeComponentSourceFormat::Direct => expected_hash,
        RuntimeComponentSourceFormat::ZipEntry => None,
    }
}

fn runtime_component_download_checksum(
    component: RuntimeComponentKindInput,
    expected_hash: Option<&str>,
) -> Result<Option<String>, String> {
    match component {
        RuntimeComponentKindInput::Geoip | RuntimeComponentKindInput::Geosite => {
            // 开发者明确要求：GEO 延续 2026-07-14 的生产行为。缺少 SHA-256 不属于 P0/P1，
            // 不得仅因哈希缺失阻断更新；仍保留 HTTPS、正数文件大小和内容格式校验。
            Ok(None)
        }
        // 开发者明确授权恢复 2026-07-14 行为：Xray 的 SHA-256 是可选附加校验，不是下载门禁。
        RuntimeComponentKindInput::Xray => Ok(expected_hash.and_then(normalize_sha256_hex)),
    }
}

fn require_desktop_update_download_size(value: Option<u64>) -> Result<u64, String> {
    let size = value
        .filter(|value| *value > 0)
        .ok_or_else(|| "server update package missing positive fileSizeBytes".to_string())?;
    let max_download_bytes = max_desktop_update_download_bytes();
    if size > max_download_bytes {
        return Err(format!(
            "server update package is too large: {size} bytes (max {max_download_bytes})"
        ));
    }
    Ok(size)
}
fn checked_desktop_update_download_size(
    downloaded_bytes: u64,
    chunk_bytes: u64,
    expected_total_bytes: u64,
) -> Result<u64, String> {
    let next = downloaded_bytes
        .checked_add(chunk_bytes)
        .ok_or_else(|| "update package download size overflow".to_string())?;
    if next > expected_total_bytes || next > max_desktop_update_download_bytes() {
        return Err(format!(
            "update package exceeded the trusted size limit: {next} bytes"
        ));
    }
    Ok(next)
}
fn sha256_file_hex(path: &Path) -> Result<String, String> {
    let mut file =
        File::open(path).map_err(|error| format!("failed to open file for checksum: {error}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 65_536];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("failed to read file for checksum: {error}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex::encode(hasher.finalize()))
}

fn verify_file_sha256(path: &Path, expected_hash: &str, label: &str) -> Result<(), String> {
    let actual = sha256_file_hex(path)?;
    if actual != expected_hash {
        return Err(format!(
            "{label} SHA-256 mismatch: expected {expected_hash}, got {actual}"
        ));
    }
    Ok(())
}

fn installer_file_matches_expectation(
    path: &Path,
    expected_total_bytes: Option<u64>,
    expected_hash: Option<&str>,
) -> Result<bool, String> {
    let metadata = fs::metadata(path)
        .map_err(|error| format!("failed to read installer metadata: {error}"))?;
    if metadata.len() == 0 {
        return Ok(false);
    }
    if expected_total_bytes
        .filter(|expected| *expected > 0)
        .is_some_and(|expected| metadata.len() != expected)
    {
        return Ok(false);
    }
    if let Some(expected_hash) = expected_hash
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .and_then(normalize_sha256_hex)
    {
        return match verify_file_sha256(path, &expected_hash, "installer package") {
            Ok(()) => Ok(true),
            Err(_) => Ok(false),
        };
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
        return Err("download failed: empty installer file".into());
    }
    let metadata = fs::metadata(path)
        .map_err(|error| format!("read downloaded file metadata failed: {error}"))?;
    if metadata.len() != downloaded_bytes {
        let _ = fs::remove_file(path);
        return Err(format!(
            "downloaded file size mismatch: wrote {} bytes but file contains {} bytes",
            downloaded_bytes,
            metadata.len()
        ));
    }
    if let Some(expected_total_bytes) = expected_total_bytes.filter(|value| *value > 0) {
        if downloaded_bytes != expected_total_bytes {
            let _ = fs::remove_file(path);
            return Err(format!(
                "downloaded file size mismatch: expected {} bytes but got {} bytes",
                expected_total_bytes, downloaded_bytes
            ));
        }
    }
    if let Some(expected_hash) = expected_hash.and_then(normalize_sha256_hex) {
        if let Err(error) = verify_file_sha256(path, &expected_hash, "installer package") {
            let _ = fs::remove_file(path);
            return Err(error);
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
    let current_version = parse_installer_version(&current_version)
        .ok_or_else(|| "当前应用版本号无效".to_string())?;
    let entries =
        fs::read_dir(&download_dir).map_err(|error| format!("读取安装包目录失败：{error}"))?;

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

    if let Some(version) = rest.strip_suffix(".zip") {
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

fn desktop_update_package_label(package_kind: Option<&str>) -> &'static str {
    let _ = package_kind;
    "installer"
}

fn resolve_installer_file_name(
    url: &Url,
    preferred: Option<&str>,
    package_kind: Option<&str>,
) -> String {
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

#[cfg(windows)]
fn open_external_url_with_system(url: &str) -> Result<(), String> {
    let script = format!("$ErrorActionPreference = 'Stop'; Start-Process -FilePath {}", powershell_quote(url));
    let mut command = Command::new("powershell");
    command.creation_flags(CREATE_NO_WINDOW);
    let status = command
        .args(["-NoProfile", "-WindowStyle", "Hidden", "-Command", &script])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .bounded_status()
        .map_err(|error| format!("打开外部链接失败：{error}"))?;
    if !status.success() {
        return Err("系统浏览器未能打开链接，请检查默认浏览器设置。".into());
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn open_external_url_with_system(url: &str) -> Result<(), String> {
    let status = Command::new("open")
        .arg(url)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .bounded_status()
        .map_err(|error| format!("打开外部链接失败：{error}"))?;
    if !status.success() {
        return Err("系统浏览器未能打开链接，请检查默认浏览器设置。".into());
    }
    Ok(())
}

#[cfg(all(not(target_os = "android"), not(target_os = "macos"), not(windows)))]
fn open_external_url_with_system(url: &str) -> Result<(), String> {
    // xdg-open may own a foreground browser for its entire lifetime. A successful
    // spawn acknowledges dispatch; do not time out and kill an active launcher.
    let mut child = Command::new("xdg-open")
        .arg(url)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("打开外部链接失败：{error}"))?;
    thread::spawn(move || { let _ = child.wait(); });
    Ok(())
}

#[cfg(target_os = "android")]
fn open_external_url_with_system(_url: &str) -> Result<(), String> {
    Err("安卓端暂不支持打开外部链接".into())
}

#[cfg(target_os = "macos")]
fn current_macos_app_bundle_path() -> Option<PathBuf> {
    let exe_path = std::env::current_exe().ok()?;
    exe_path
        .ancestors()
        .find(|path| path.extension().and_then(|value| value.to_str()) == Some("app"))
        .map(Path::to_path_buf)
}

#[cfg(target_os = "macos")]
fn should_remove_installer_after_update(app: &AppHandle, installer_path: &Path) -> bool {
    let Ok(download_dir) = ensure_installer_download_dir(app) else {
        return false;
    };
    let Ok(download_dir) = download_dir.canonicalize() else {
        return false;
    };
    let Ok(installer_path) = installer_path.canonicalize() else {
        return false;
    };
    installer_path.starts_with(download_dir)
}

#[cfg(target_os = "macos")]
fn cleanup_mounted_installer_volumes(_app: &AppHandle) -> Result<(), String> {
    let current_app_path = current_macos_app_bundle_path()
        .map(|path| shell_quote(path.to_string_lossy().as_ref()))
        .unwrap_or_else(|| "''".into());
    let script = format!(
        r#"current_app={}
/usr/bin/hdiutil info | /usr/bin/awk '
  /^image-path[[:space:]]*:/ {{
    image=$0
    sub(/^[^:]*:[[:space:]]*/, "", image)
    next
  }}
  /\/Volumes\/ChordV/ && image ~ /\/ChordV([^\/]*).dmg$/ {{
    mount=substr($0, index($0, "/Volumes/"))
    print mount
  }}
' | while IFS= read -r mount_point; do
  case "$current_app" in
    "$mount_point"/*) continue ;;
  esac
  /usr/bin/hdiutil detach "$mount_point" -quiet >/dev/null 2>&1 || true
done
"#,
        current_app_path
    );
    Command::new("sh")
        .args(["-c", &script])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("清理已挂载安装卷失败：{error}"))?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn spawn_deferred_installer_open(
    app: &AppHandle,
    installer_path: &Path,
    current_pid: u32,
) -> Result<(), String> {
    let target_app_path = current_macos_app_bundle_path()
        .filter(|path| !path.starts_with("/Volumes"))
        .unwrap_or_else(|| PathBuf::from("/Applications/ChordV.app"));
    let runtime_dir =
        ensure_runtime_dir(app).unwrap_or_else(|_| std::env::temp_dir().join("chordv-desktop"));
    let log_path = runtime_dir.join("update-installer.log");
    let report_path = desktop_update_report_path(app)
        .unwrap_or_else(|_| runtime_dir.join("last-install-report.json"));
    let remove_installer = if should_remove_installer_after_update(app, installer_path) {
        "1"
    } else {
        "0"
    };
    let script = format!(
        r#"pid={current_pid}
dmg={}
target_app={}
log_path={}
report_path={}
remove_installer={remove_installer}
while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done
exec >>"$log_path" 2>&1
write_report() {{
  status_ok="$1"
  summary="$2"
  detail="$3"
  /usr/bin/python3 - "$report_path" "$status_ok" "$summary" "$detail" "$log_path" <<'PY'
import json, sys, datetime
path, ok, summary, detail, log_path = sys.argv[1:6]
payload = {{
  "ok": ok == "1",
  "platform": "macos",
  "mode": "desktop_installer_download",
  "summary": summary,
  "detail": detail or None,
  "logPath": log_path,
  "createdAt": datetime.datetime.utcnow().replace(microsecond=0).isoformat() + "Z",
}}
with open(path, "w", encoding="utf-8") as fh:
  json.dump(payload, fh, ensure_ascii=False)
PY
}}
echo "mac update start dmg=$dmg target=$target_app"
detach_chordv_volumes() {{
  /usr/bin/hdiutil info | /usr/bin/awk '
    /^image-path[[:space:]]*:/ {{
      image=$0
      sub(/^[^:]*:[[:space:]]*/, "", image)
      next
    }}
    /\/Volumes\/ChordV/ && image ~ /\/ChordV([^\/]*).dmg$/ {{
      mount=substr($0, index($0, "/Volumes/"))
      print mount
    }}
  ' | while IFS= read -r mount_point; do
    /usr/bin/hdiutil detach "$mount_point" -quiet >/dev/null 2>&1 || true
  done
}}
detach_chordv_volumes
mount_dir="$(/usr/bin/mktemp -d /tmp/chordv-update.XXXXXX)"
cleanup_mount() {{
  /usr/bin/hdiutil detach "$mount_dir" -quiet >/dev/null 2>&1 || true
  /bin/rmdir "$mount_dir" >/dev/null 2>&1 || true
}}
if /usr/bin/hdiutil attach "$dmg" -mountpoint "$mount_dir" -nobrowse -readonly -quiet; then
  source_app="$mount_dir/ChordV.app"
  if [ ! -d "$source_app" ]; then
    source_app="$(/usr/bin/find "$mount_dir" -maxdepth 1 -name '*.app' -type d | /usr/bin/head -n 1)"
  fi
  if [ -d "$source_app" ]; then
    tmp_target="${{target_app}}.updating"
    /bin/rm -rf "$tmp_target"
    if /usr/bin/ditto "$source_app" "$tmp_target" && /bin/rm -rf "$target_app" && /bin/mv "$tmp_target" "$target_app"; then
      cleanup_mount
      if [ "$remove_installer" = "1" ]; then
        /bin/rm -f "$dmg" >/dev/null 2>&1 || true
      fi
      write_report 1 "更新安装完成" "已替换应用并重新打开。"
      /usr/bin/open "$target_app"
      exit 0
    fi
    /bin/rm -rf "$tmp_target" >/dev/null 2>&1 || true
    echo "ditto/replace failed for $target_app"
  else
    echo "source app missing in dmg"
  fi
else
  echo "hdiutil attach failed"
fi
cleanup_mount
write_report 0 "自动替换失败，已打开安装包" "请手动把 ChordV.app 拖到应用程序，或检查安装目录权限。"
/usr/bin/open "$dmg"
"#,
        shell_quote(installer_path.to_string_lossy().as_ref()),
        shell_quote(target_app_path.to_string_lossy().as_ref()),
        shell_quote(log_path.to_string_lossy().as_ref()),
        shell_quote(report_path.to_string_lossy().as_ref())
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
fn spawn_deferred_installer_open(
    _app: &AppHandle,
    installer_path: &Path,
    current_pid: u32,
) -> Result<(), String> {
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
fn spawn_deferred_installer_open(
    _app: &AppHandle,
    installer_path: &Path,
    current_pid: u32,
) -> Result<(), String> {
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

fn send_update_download_progress(
    app: &AppHandle,
    channel: &Channel<DesktopInstallerDownloadProgress>,
    progress: DesktopInstallerDownloadProgress,
) {
    emit_update_download_progress(app, progress.clone());
    let _ = channel.send(progress);
}

fn should_emit_update_download_progress(
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
    last_emitted_bytes: u64,
    last_progress_emit_at: Instant,
) -> bool {
    if total_bytes
        .map(|value| downloaded_bytes >= value)
        .unwrap_or(false)
    {
        return true;
    }

    if let Some(total) = total_bytes.filter(|value| *value > 0) {
        let current_percent = downloaded_bytes.saturating_mul(100) / total;
        let last_percent = last_emitted_bytes.saturating_mul(100) / total;
        if current_percent >= last_percent + DOWNLOAD_PROGRESS_EMIT_PERCENT_STEP {
            return true;
        }
    } else if downloaded_bytes.saturating_sub(last_emitted_bytes)
        >= DOWNLOAD_PROGRESS_EMIT_BYTES_STEP
    {
        return true;
    }

    last_progress_emit_at.elapsed() >= Duration::from_millis(DOWNLOAD_PROGRESS_EMIT_INTERVAL_MS)
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
        "access": log_path.to_string_lossy().to_string(),
        "error": log_path.to_string_lossy().to_string()
      },
      "dns": build_dns_config(android_runtime),
      "inbounds": build_inbounds(config, android_runtime),
      "outbounds": build_outbounds(config),
      "routing": {
        "domainMatcher": "hybrid",
        "domainStrategy": if android_runtime { "IPIfNonMatch" } else { "AsIs" },
        "rules": routing_rules(config.mode.as_str(), &config.features, &config.custom_routing_rules)
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
    let mut reality_settings = json!({
      "serverName": config.outbound.server_name,
      "fingerprint": config.outbound.fingerprint,
      "publicKey": config.outbound.reality_public_key,
      "shortId": config.outbound.short_id,
      "spiderX": config.outbound.spider_x
    });
    if let Some(mldsa65_verify) = config
        .outbound
        .mldsa65_verify
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        reality_settings["mldsa65Verify"] = json!(mldsa65_verify);
    }

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
          "realitySettings": reality_settings
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

fn routing_rules(
    mode: &str,
    features: &RuntimePolicyFeaturesDto,
    custom_rules: &[ClientRoutingRuleDto],
) -> Value {
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
            let mut rules: Vec<Value> = custom_rules
                .iter()
                .filter(|rule| rule.enabled && (rule.action == "proxy" || rule.action == "direct"))
                .filter_map(|rule| {
                    let value = rule.value.trim();
                    if value.is_empty() {
                        return None;
                    }
                    let matcher = if rule.match_type == "domain" {
                        format!("domain:{value}")
                    } else if rule.match_type == "keyword" {
                        format!("keyword:{value}")
                    } else {
                        return None;
                    };
                    Some(json!({
                        "type": "field",
                        "domain": [matcher],
                        "outboundTag": rule.action
                    }))
                })
                .collect();

            rules.push(json!({
                "type": "field",
                "ip": ["geoip:private"],
                "outboundTag": "direct"
            }));

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

struct NormalizedRoutingTestTarget {
    input: String,
    normalized_value: String,
    match_type: String,
}

fn normalize_routing_test_target(input: &str) -> Result<NormalizedRoutingTestTarget, String> {
    let raw_input = input.trim();
    let normalized_value = raw_input.to_lowercase().trim_start_matches('.').to_string();
    if normalized_value.is_empty() {
        return Err("请输入域名或名称。".into());
    }
    if normalized_value.contains("://")
        || normalized_value.len() > 128
        || normalized_value.chars().any(|character| {
            matches!(character, '/' | '?' | '#' | '\\') || character.is_whitespace()
        })
    {
        return Err("只支持域名或名称，不要包含协议、路径或空格。".into());
    }

    if normalized_value.contains('.') {
        if !is_valid_routing_test_domain(&normalized_value) {
            return Err("请输入有效域名，例如 example.com。".into());
        }
        return Ok(NormalizedRoutingTestTarget {
            input: raw_input.into(),
            normalized_value,
            match_type: "domain".into(),
        });
    }

    if !normalized_value.chars().all(|character| {
        character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-'
    }) || normalized_value.len() > 64
    {
        return Err("名称只能包含小写字母、数字和短横线。".into());
    }

    Ok(NormalizedRoutingTestTarget {
        input: raw_input.into(),
        normalized_value,
        match_type: "keyword".into(),
    })
}

fn build_routing_test_result(
    target: &NormalizedRoutingTestTarget,
    action: &str,
    matched_rule: Option<ClientRoutingRuleDto>,
    reason: impl Into<String>,
    test_host: &str,
    started_at: Instant,
) -> RoutingRuleTestResultDto {
    RoutingRuleTestResultDto {
        input: target.input.clone(),
        normalized_value: target.normalized_value.clone(),
        match_type: target.match_type.clone(),
        action: action.into(),
        matched_rule,
        message: format!(
            "规则查询：{} 当前规则为{}。{}",
            target.normalized_value,
            if action == "proxy" {
                "代理"
            } else {
                "直连"
            },
            reason.into()
        ),
        reconnect_required: false,
        test_host: test_host.into(),
        elapsed_ms: started_at.elapsed().as_millis().max(1),
    }
}

fn routing_test_rule_matches(rule: &ClientRoutingRuleDto, value: &str, host: &str) -> bool {
    if !rule.enabled || (rule.action != "proxy" && rule.action != "direct") {
        return false;
    }
    let rule_value = rule.value.trim().to_lowercase();
    if rule_value.is_empty() {
        return false;
    }
    match rule.match_type.as_str() {
        "domain" => host == rule_value || host.ends_with(&format!(".{rule_value}")),
        "keyword" => value.contains(&rule_value) || host.contains(&rule_value),
        _ => false,
    }
}

fn is_valid_routing_test_domain(value: &str) -> bool {
    let labels: Vec<&str> = value.split('.').collect();
    labels.len() >= 2
        && labels.iter().all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && label.chars().enumerate().all(|(index, character)| {
                    let valid = character.is_ascii_lowercase()
                        || character.is_ascii_digit()
                        || character == '-';
                    let edge_dash = character == '-' && (index == 0 || index + 1 == label.len());
                    valid && !edge_dash
                })
        })
}

fn routing_test_domain_matches_any(host: &str, domains: &[&str]) -> bool {
    domains
        .iter()
        .any(|domain| host == *domain || host.ends_with(&format!(".{domain}")))
}

fn ai_service_domain_values() -> [&'static str; 12] {
    [
        "openai.com",
        "chatgpt.com",
        "oaistatic.com",
        "oaiusercontent.com",
        "anthropic.com",
        "claude.ai",
        "perplexity.ai",
        "x.ai",
        "grok.com",
        "ai.google.dev",
        "gemini.google.com",
        "makersuite.google.com",
    ]
}

fn built_in_proxy_domain_values() -> [&'static str; 10] {
    [
        "google.com",
        "youtube.com",
        "github.com",
        "telegram.org",
        "t.me",
        "twitter.com",
        "x.com",
        "discord.com",
        "discord.gg",
        "netflix.com",
    ]
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

fn stop_runtime_process(app: &AppHandle, state: &mut RuntimeState) -> Result<(),String> {
    let stopped_pid = state.child.as_ref().map(Child::id);
    if let Some(mut child) = state.child.take() {
        let result=(||->std::io::Result<()> {
            if child.try_wait()?.is_none(){child.kill()?;child.wait()?;}
            Ok(())
        })();
        if let Err(error)=result {state.child=Some(child);return Err(format!("停止内核失败：{error}"));}
    }

    #[cfg(windows)]
    state.runtime_component_handles.clear();

    if let Some(record) = load_runtime_pid_record(app) {
        if stopped_pid != Some(record.pid) && runtime_pid_belongs_to_chordv(app, &record)? {
            kill_pid(record.pid)?;
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
    Ok(())
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

fn normalized_path_text(path: &Path) -> String {
    path.canonicalize()
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .replace('\\', "/")
        .to_lowercase()
}

fn cleanup_legacy_runtime_component_copies(app: &AppHandle) {
    let legacy_bin_dir = legacy_runtime_bin_dir(app);
    if installed_runtime_bin_dir(app)
        .map(|current_bin_dir| {
            normalized_path_text(&current_bin_dir) == normalized_path_text(&legacy_bin_dir)
        })
        .unwrap_or(false)
    {
        return;
    }

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
            content
                .trim()
                .parse::<u32>()
                .ok()
                .map(|pid| RuntimePidRecord {
                    pid,
                    binary_path: None,
                })
        })
}

fn runtime_process_command(pid:u32)->Result<Option<String>,String>{
    #[cfg(unix)]
    {process_identity::unix_query(Command::new("ps").args(["-p",&pid.to_string(),"-o","command="]).bounded_output())}
    #[cfg(windows)]
    {
        let mut command=Command::new("powershell");command.creation_flags(CREATE_NO_WINDOW);
        let script=format!("$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $p=Get-CimInstance Win32_Process -Filter \"ProcessId = {pid}\"; if ($p) {{ @{{exists=$true;command=\"$($p.ExecutablePath)`n$($p.CommandLine)\"}} | ConvertTo-Json -Compress }} else {{ @{{exists=$false}} | ConvertTo-Json -Compress }}");
        process_identity::windows_query(command.args(["-NoProfile","-NonInteractive","-Command",&script]).bounded_output())
    }
}

fn runtime_pid_belongs_to_chordv(app: &AppHandle, record: &RuntimePidRecord) -> Result<bool,String> {
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
    Ok(runtime_process_command(record.pid)?
        .map(|command| {
            let normalized = command.to_lowercase();
            normalized.contains(&expected_binary_text)
                || (!expected_runtime_dir_text.is_empty()
                    && normalized.contains(&expected_runtime_dir_text))
        })
        .unwrap_or(false))
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
            .bounded_status()
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
        let status = command.bounded_status().map_err(|error| error.to_string())?;
        if status.success() {
            return Ok(());
        }
        return Err(format!("结束进程失败：{pid}"));
    }

    #[allow(unreachable_code)]
    Err(format!("当前平台不支持结束进程：{pid}"))
}


async fn verify_server_certificate_fingerprint(url: &Url, expected: &str) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {let _=(url,expected);Ok(())}
    #[cfg(not(target_os = "android"))]
    {tls_fingerprint::verify(url,expected).await}
}


fn chrono_like_now() -> String {
    let now = std::time::SystemTime::now();
    let datetime: chrono::DateTime<chrono::Utc> = now.into();
    datetime.to_rfc3339()
}

fn shutdown_runtime(app: &AppHandle, state: &mut RuntimeState) -> Result<(),String> {
    CONNECTION_GENERATION.invalidate();
    // Runtime state may be empty after failed startup maintenance. Proxy
    // ownership is an OS fact, so always reconcile it before permitting exit.
    let restore=clear_system_proxy().map_err(|error|format!("系统代理清理失败，请重试退出：{error}"));
    proxy_cleanup::stop_after_restore(restore,||stop_runtime_process(app,state))
        .map_err(|error|{state.last_error=Some(error.clone());error})?;
    state.status="idle".into();state.active_session_id=None;state.active_node_id=None;
    state.active_node_name=None;state.active_config=None;state.config_path=None;state.log_path=None;
    state.xray_binary_path=None;state.local_http_port=None;state.local_socks_port=None;state.last_error=None;
    Ok(())
}

fn shutdown_runtime_state(app:&AppHandle)->Result<(),String>{
    let binding=app.state::<Mutex<RuntimeState>>();
    let mut state=binding.lock().map_err(|_|"运行时状态异常".to_string())?;
    shutdown_runtime(app,&mut state)
}

fn tail_log(path: &Path, lines: usize) -> String { log_tail::read_tail(path,lines) }

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

fn verify_runtime_ready(_app: &AppHandle, http_port: u16, socks_port: u16, generation: u64) -> Result<(), String> {
    let start = Instant::now();
    let timeout = Duration::from_secs(6);
    let mut http_ready = false;
    let mut socks_ready = false;

    while start.elapsed() < timeout {
        CONNECTION_GENERATION.ensure_current(generation)?;
        http_ready = is_port_open(http_port);
        socks_ready = is_port_open(socks_port);
        if http_ready && socks_ready {
            break;
        }
        thread::sleep(Duration::from_millis(25));
    }

    if !http_ready || !socks_ready {
        return Err("本地代理端口启动失败".into());
    }

    Ok(())
}



fn set_system_proxy(http_port: u16, socks_port: u16) -> Result<(), io::Error> {
    with_command_budget(Duration::from_secs(15), || set_system_proxy_within_budget(http_port, socks_port))
}

fn set_system_proxy_within_budget(http_port: u16, socks_port: u16) -> Result<(), io::Error> {
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
    with_command_budget(Duration::from_secs(15), || clear_system_proxy_within_budget())
}

fn clear_system_proxy_within_budget() -> Result<(), io::Error> {
    #[cfg(target_os = "macos")]
    {
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
    with_command_budget(Duration::from_millis(2500), || detect_external_network_conflict_within_budget(http_port, socks_port))
}

fn detect_external_network_conflict_within_budget(http_port: u16, socks_port: u16) -> Result<(), String> {
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
    if let Some(vpn_name) = detect_connected_macos_vpn_name()? {
        return Err(format!(
            "external_vpn_conflict: 检测到系统中已有 VPN 正在运行（{}），请先断开后再连接 ChordV。",
            vpn_name
        ));
    }

    if let Some(proxy_summary) = detect_macos_proxy_conflict(http_port, socks_port)? {
        return Err(format!(
            "external_proxy_conflict: 检测到系统代理已由其他应用占用（{}），请先关闭后再连接 ChordV。",
            proxy_summary
        ));
    }

    Ok(())
}

#[cfg(target_os = "macos")]
fn detect_connected_macos_vpn_name() -> Result<Option<String>, String> {
    let output = Command::new("scutil")
        .args(["--nc", "list"])
        .bounded_output()
        .map_err(|error| format!("无法完成系统网络检查：{error}"))?;
    if !output.status.success() {
        return Err("无法读取系统 VPN 状态".into());
    }
    let text = String::from_utf8_lossy(&output.stdout);
    Ok(text.lines().find_map(|line| {
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
    }))
}

#[cfg(target_os = "macos")]
fn detect_macos_proxy_conflict(http_port: u16, socks_port: u16) -> Result<Option<String>, String> {
    let output = Command::new("scutil").arg("--proxy").bounded_output().map_err(|error| format!("无法读取系统代理：{error}"))?;
    if !output.status.success() {
        return Err("无法读取系统代理状态".into());
    }
    let text = String::from_utf8_lossy(&output.stdout);

    let http_enabled = proxy_dict_flag(&text, "HTTPEnable");
    let https_enabled = proxy_dict_flag(&text, "HTTPSEnable");
    let socks_enabled = proxy_dict_flag(&text, "SOCKSEnable");

    let http_proxy = proxy_dict_value(&text, "HTTPProxy");
    let https_proxy = proxy_dict_value(&text, "HTTPSProxy");
    let socks_proxy = proxy_dict_value(&text, "SOCKSProxy");

    let http_conflict = http_enabled
        && !matches_our_proxy(
            http_proxy.as_deref(),
            proxy_dict_u16(&text, "HTTPPort"),
            http_port,
        );
    let https_conflict = https_enabled
        && !matches_our_proxy(
            https_proxy.as_deref(),
            proxy_dict_u16(&text, "HTTPSPort"),
            http_port,
        );
    let socks_conflict = socks_enabled
        && !matches_our_proxy(
            socks_proxy.as_deref(),
            proxy_dict_u16(&text, "SOCKSPort"),
            socks_port,
        );

    if http_conflict {
        return Ok(Some(format!(
            "HTTP {}:{}",
            http_proxy.unwrap_or_else(|| "未知地址".to_string()),
            proxy_dict_u16(&text, "HTTPPort").unwrap_or_default()
        )));
    }
    if https_conflict {
        return Ok(Some(format!(
            "HTTPS {}:{}",
            https_proxy.unwrap_or_else(|| "未知地址".to_string()),
            proxy_dict_u16(&text, "HTTPSPort").unwrap_or_default()
        )));
    }
    if socks_conflict {
        return Ok(Some(format!(
            "SOCKS {}:{}",
            socks_proxy.unwrap_or_else(|| "未知地址".to_string()),
            proxy_dict_u16(&text, "SOCKSPort").unwrap_or_default()
        )));
    }

    Ok(None)
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
    if let Some(vpn_name) = detect_connected_windows_vpn_name()? {
        return Err(format!(
            "external_vpn_conflict: 检测到系统中已有 VPN 正在运行（{}），请先断开后再连接 ChordV。",
            vpn_name
        ));
    }

    let _ = socks_port;
    let expected = windows_manual_proxy_server(http_port);
    if let Some(proxy_server) = detect_windows_proxy_conflict(&expected)? {
        return Err(format!(
            "external_proxy_conflict: 检测到系统代理已由其他应用占用（{}），请先关闭后再连接 ChordV。",
            proxy_server
        ));
    }

    Ok(())
}

#[cfg(windows)]
fn detect_connected_windows_vpn_name() -> Result<Option<String>, String> {
    let mut command = Command::new("powershell");
    command.creation_flags(CREATE_NO_WINDOW);
    let output = command
        .args([
            "-NoProfile",
            "-Command",
            "Get-VpnConnection | Where-Object {$_.ConnectionStatus -eq 'Connected'} | Select-Object -ExpandProperty Name",
        ])
        .bounded_output()
        .map_err(|error| format!("无法完成系统网络检查：{error}"))?;
    if !output.status.success() {
        return Err("无法读取系统 VPN 状态".into());
    }
    let text = String::from_utf8_lossy(&output.stdout);
    Ok(text.lines()
        .map(str::trim)
        .find(|value| !value.is_empty())
        .map(|value| value.to_string()))
}

#[cfg(windows)]
fn detect_windows_proxy_conflict(expected_proxy_server: &str) -> Result<Option<String>, String> {
    let mut enable = Command::new("reg");
    enable.creation_flags(CREATE_NO_WINDOW);
    let enable_output = enable
        .args([
            "query",
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings",
            "/v",
            "ProxyEnable",
        ])
        .bounded_output()
        .map_err(|error| format!("无法读取 Windows 系统代理：{error}"))?;
    let enable_text = String::from_utf8_lossy(&enable_output.stdout).to_lowercase();
    if !enable_output.status.success() || !enable_text.contains("0x1") {
        return Ok(None);
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
        .bounded_output()
        .map_err(|error| format!("无法读取 Windows 系统代理：{error}"))?;
    if !server_output.status.success() {
        return Ok(Some("未知代理".to_string()));
    }
    let server_text = String::from_utf8_lossy(&server_output.stdout);
    if server_text.contains(expected_proxy_server) {
        return Ok(None);
    }
    Ok(server_text
        .lines()
        .find_map(|line| {
            let trimmed = line.trim();
            if trimmed.contains("ProxyServer") {
                trimmed
                    .split_whitespace()
                    .last()
                    .map(|value| value.to_string())
            } else {
                None
            }
        })
        .or_else(|| Some("未知代理".to_string())))
}

#[cfg(target_os = "macos")]
fn set_proxy(http_port: u16, socks_port: u16) -> Result<(), std::io::Error> {
    let bypass_hosts = api_proxy_bypass_hosts();
    let services=network_services()?;
    if services.is_empty(){return Err(io::Error::new(io::ErrorKind::NotFound,"未找到可配置的网络服务"));}
    for service in services {
        let mut bypass_command = Command::new("networksetup");
        bypass_command.arg("-setproxybypassdomains").arg(&service);
        for host in &bypass_hosts {
            bypass_command.arg(host);
        }
        let status = bypass_command.bounded_status()?;
        if !status.success() {
            return Err(io::Error::new(
                io::ErrorKind::Other,
                format!("设置代理绕过域名失败：{service}"),
            ));
        }
        run_networksetup(&[
            "-setwebproxy",
            &service,
            "127.0.0.1",
            &http_port.to_string(),
        ])?;
        run_networksetup(&[
            "-setsecurewebproxy",
            &service,
            "127.0.0.1",
            &http_port.to_string(),
        ])?;
        run_networksetup(&[
            "-setsocksfirewallproxy",
            &service,
            "127.0.0.1",
            &socks_port.to_string(),
        ])?;
        run_networksetup(&["-setwebproxystate", &service, "on"])?;
        run_networksetup(&["-setsecurewebproxystate", &service, "on"])?;
        run_networksetup(&["-setsocksfirewallproxystate", &service, "on"])?;
        verify_macos_proxy_config(&service, http_port, socks_port, &bypass_hosts)?;
    }

    Ok(())
}

#[cfg(target_os = "macos")]
fn clear_proxy() -> Result<(), std::io::Error> {
    proxy_cleanup::clear_owned_services(&network_services()?,
        |service|with_command_budget(Duration::from_secs(2),||macos_proxy_service_owned(service)),
        |service|{
            let mut first_error=None;
            for option in ["-setwebproxystate","-setsecurewebproxystate","-setsocksfirewallproxystate"] {
                if let Err(error)=run_networksetup(&[option,service,"off"]) { if first_error.is_none(){first_error=Some(error);} }
            }
            first_error.map_or(Ok(()),Err)
        })
}

#[cfg(target_os = "macos")]
fn macos_proxy_service_owned(service:&str) -> Result<bool, io::Error> {
    let bypass_hosts=api_proxy_bypass_hosts();
    let web_proxy=networksetup_output(&["-getwebproxy",service])?;
    let secure_proxy=networksetup_output(&["-getsecurewebproxy",service])?;
    let socks_proxy=networksetup_output(&["-getsocksfirewallproxy",service])?;
    let bypass_output=networksetup_output(&["-getproxybypassdomains",service])?;
    let proxy_owned=macos_proxy_points_to_loopback(&web_proxy)||macos_proxy_points_to_loopback(&secure_proxy)||macos_proxy_points_to_loopback(&socks_proxy);
    let bypass_owned=bypass_hosts.iter().all(|host|bypass_output.lines().any(|line|line.trim().eq_ignore_ascii_case(host)));
    Ok(proxy_owned && bypass_owned)
}

#[cfg(target_os = "macos")]
fn macos_proxy_points_to_loopback(output: &str) -> bool {
    let enabled = output
        .lines()
        .any(|line| line.trim().eq_ignore_ascii_case("Enabled: Yes"));
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
            if !entries
                .iter()
                .any(|candidate| candidate.eq_ignore_ascii_case(&host))
            {
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
        .bounded_output()?;
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
        .bounded_output()?;
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
        .bounded_output()?;
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
    let status = command.bounded_status()?;
    if status.success() {
        Ok(())
    } else {
        Err(io::Error::new(
            io::ErrorKind::Other,
            format!("reg 命令执行失败：{:?}", args),
        ))
    }
}

#[cfg(windows)]
fn verify_windows_proxy_config(
    expected_proxy_server: &str,
    expected_proxy_override: &str,
) -> Result<(), io::Error> {
    let mut enable = Command::new("reg");
    enable.creation_flags(CREATE_NO_WINDOW);
    let enable_output = enable
        .args([
            "query",
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings",
            "/v",
            "ProxyEnable",
        ])
        .bounded_output()?;
    let enable_text = String::from_utf8_lossy(&enable_output.stdout).to_lowercase();
    if !enable_output.status.success() || !enable_text.contains("0x1") {
        return Err(io::Error::new(
            io::ErrorKind::Other,
            "Windows 系统代理未成功启用",
        ));
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
        .bounded_output()?;
    let server_text = String::from_utf8_lossy(&server_output.stdout);
    if !server_output.status.success() || !server_text.contains(expected_proxy_server) {
        return Err(io::Error::new(
            io::ErrorKind::Other,
            "Windows 系统代理地址未成功写入",
        ));
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
        .bounded_output()?;
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
    let status = Command::new("networksetup").args(args).bounded_status()?;
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
    let output = Command::new("networksetup").args(args).bounded_output()?;
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
        if !bypass_output
            .lines()
            .any(|line| line.trim().eq_ignore_ascii_case(host))
        {
            return Err(io::Error::new(
                io::ErrorKind::Other,
                format!("代理绕过域名未生效：{service} 缺少 {host}"),
            ));
        }
    }

    Ok(())
}

#[cfg(target_os = "macos")]
fn verify_macos_named_proxy(
    output: &str,
    expected_port: u16,
    label: &str,
) -> Result<(), io::Error> {
    let enabled = output
        .lines()
        .any(|line| line.trim().eq_ignore_ascii_case("Enabled: Yes"));
    let server_ok = output
        .lines()
        .any(|line| line.trim().eq_ignore_ascii_case("Server: 127.0.0.1"));
    let port_ok = output
        .lines()
        .any(|line| line.trim() == format!("Port: {expected_port}"));
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
        if InternetSetOptionW(
            std::ptr::null(),
            INTERNET_OPTION_SETTINGS_CHANGED,
            std::ptr::null_mut(),
            0,
        ) == 0
        {
            return Err(io::Error::last_os_error());
        }
        if InternetSetOptionW(
            std::ptr::null(),
            INTERNET_OPTION_REFRESH,
            std::ptr::null_mut(),
            0,
        ) == 0
        {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn network_services() -> Result<Vec<String>, io::Error> {
    let output = Command::new("networksetup").arg("-listnetworkserviceorder").bounded_output()?;
    if !output.status.success() { return Err(io::Error::new(io::ErrorKind::Other,"无法读取网络服务列表")); }
    let text = String::from_utf8_lossy(&output.stdout);
    let mut services = Vec::new();
    let mut pending_name: Option<String> = None;

    for line in text.lines() {
        let trimmed = line.trim();

        if trimmed.starts_with('(') && trimmed.contains(')') && !trimmed.contains("Hardware Port:")
        {
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

    Ok(services)
}

fn cleanup_stale_runtime(app: &AppHandle) -> Result<(),String> {
    let runtime_dir = app
        .path()
        .app_local_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("chordv-desktop"))
        .join("runtime");

    clear_system_proxy().map_err(|error|error.to_string())?;

    if let Some(record) = load_runtime_pid_record(app) {
        if runtime_pid_belongs_to_chordv(app, &record)? {
            kill_pid(record.pid)?;
        }
        clear_runtime_pid(app);
    }

    let stale_binary = runtime_dir.join("bin").join(runtime_binary_name());
    if stale_binary.exists() {
        #[cfg(unix)]
        let _ = Command::new("pkill")
            .args(["-f", &stale_binary.to_string_lossy()])
            .bounded_status();
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

    cleanup_legacy_runtime_component_copies(app);
    cleanup_legacy_installed_runtime_names(app);
    Ok(())
}

#[cfg(windows)]
fn windows_install_dir_from_current_exe() -> Option<PathBuf> {
    let current_exe = std::env::current_exe().ok()?;
    current_exe.parent().map(Path::to_path_buf)
}

#[cfg(windows)]
fn migrate_windows_main_binary_on_startup() {
    let Some(install_dir) = windows_install_dir_from_current_exe() else {
        return;
    };
    let Ok(current_exe) = std::env::current_exe() else {
        return;
    };
    let Some(current_name) = current_exe.file_name().and_then(|value| value.to_str()) else {
        return;
    };
    let main_exe = install_dir.join("ChordV.exe");

    // If this process is the legacy binary and ChordV.exe is missing, seed the new name first.
    if current_name.eq_ignore_ascii_case("chordv-desktop.exe") && !main_exe.exists() {
        let _ = fs::copy(&current_exe, &main_exe);
    }

    // Prefer the product binary after migration; rewrite common shortcuts that still point at the crate name.
    let target_exe = if main_exe.exists() {
        main_exe.clone()
    } else {
        current_exe.clone()
    };
    rewrite_windows_shortcuts_to_main_binary(&install_dir, &target_exe);

    // The installer maintains legacy names as links/copies of the current binary.
    // Keep them: arbitrary pinned/user-created shortcuts may still reference them.
}

#[cfg(windows)]
fn rewrite_windows_shortcuts_to_main_binary(install_dir: &Path, target_exe: &Path) {
    let install_dir_display = install_dir.to_string_lossy().replace('\'', "''");
    let target_exe_display = target_exe.to_string_lossy().replace('\'', "''");
    let script = format!(
        r#"
$ErrorActionPreference = 'SilentlyContinue'
$InstallDir = '{install_dir}'
$TargetExe = '{target_exe}'
try {{
  $shell = New-Object -ComObject WScript.Shell
  $legacyNames = @('chordv-desktop.exe', 'chordv_desktop.exe')
  $searchRoots = @(
    [Environment]::GetFolderPath('Desktop'),
    [Environment]::GetFolderPath('StartMenu'),
    [Environment]::GetFolderPath('Programs'),
    (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'),
    (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs')
  ) | Where-Object {{ $_ -and (Test-Path -LiteralPath $_) }} | Select-Object -Unique
  foreach ($root in $searchRoots) {{
    Get-ChildItem -LiteralPath $root -Filter '*.lnk' -Recurse -ErrorAction SilentlyContinue | ForEach-Object {{
      try {{
        $shortcut = $shell.CreateShortcut($_.FullName)
        $targetPath = [string]$shortcut.TargetPath
        if (-not $targetPath) {{ return }}
        $targetLeaf = [System.IO.Path]::GetFileName($targetPath)
        $sameDir = [string]::Equals(
          [System.IO.Path]::GetFullPath([System.IO.Path]::GetDirectoryName($targetPath)),
          [System.IO.Path]::GetFullPath($InstallDir),
          [System.StringComparison]::OrdinalIgnoreCase
        )
        if ($sameDir -and ($legacyNames -contains $targetLeaf.ToLowerInvariant())) {{
          $shortcut.TargetPath = $TargetExe
          $shortcut.WorkingDirectory = $InstallDir
          $shortcut.Save()
        }}
      }} catch {{
      }}
    }}
  }}
}} catch {{
}}
"#,
        install_dir = install_dir_display,
        target_exe = target_exe_display
    );
    let mut command = Command::new("powershell");
    command.creation_flags(CREATE_NO_WINDOW);
    let _ = command
        .args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-WindowStyle",
            "Hidden",
            "-Command",
            &script,
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .bounded_status();
}

fn ensure_startup_ready(app:&AppHandle)->Result<(),String>{
    EXIT_CLEANUP.ensure_running()?;
    STARTUP_READY.ensure_ready(||perform_startup_maintenance(app))
}

fn perform_startup_maintenance(app:&AppHandle)->Result<(),String>{
    with_command_budget(Duration::from_secs(20), || {
                        cleanup_runtime_artifacts_on_startup(app)?;
                        #[cfg(not(target_os = "android"))]
                        {
                            ensure_runtime_bin_dir(app)?;
                            let _=cleanup_outdated_installer_packages(app);
                        }
                        #[cfg(target_os = "macos")]
                        {let _=cleanup_mounted_installer_volumes(app);}
                        Ok::<(),String>(())
                    })
}

fn cleanup_runtime_artifacts_on_startup(app: &AppHandle) -> Result<(),String> {
    cleanup_stale_runtime(app)?;
    #[cfg(windows)]
    migrate_windows_main_binary_on_startup();
    Ok(())
}

#[cfg(not(target_os = "android"))]
fn disable_context_menu(window: &tauri::WebviewWindow) -> Result<(), String> {
    window
        .eval(
            r#"
            window.addEventListener('contextmenu', (event) => {
              const element = event.target instanceof Element ? event.target : event.target && event.target.parentElement;
              if (element && element.closest("input, textarea, [contenteditable]")) {
                return;
              }
              const selection = window.getSelection && window.getSelection();
              if (selection && selection.toString().trim().length > 0) {
                return;
              }
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
fn app_window_title(app: &AppHandle) -> String {
    let version = app.package_info().version.to_string();
    let normalized = version.trim();
    if normalized.is_empty() {
        return "ChordV v-".to_string();
    }
    if normalized.starts_with('v') || normalized.starts_with('V') {
        format!("ChordV {normalized}")
    } else {
        format!("ChordV v{normalized}")
    }
}

#[cfg(not(target_os = "android"))]
fn set_main_window_title(window: &tauri::WebviewWindow, app: &AppHandle) -> Result<(), String> {
    window
        .set_title(&app_window_title(app))
        .map_err(|error| error.to_string())
}

#[cfg(not(target_os = "android"))]
fn show_main_window_internal(app: &AppHandle) -> Result<(), String> {
    let window = window_for_shell(app)?;
    let _ = set_main_window_title(&window, app);
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(ActivationPolicy::Regular);
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

    window
        .eval(script)
        .map_err(|error| format!("壳层动作派发失败：{error}"))
}

#[cfg(not(target_os = "android"))]
fn disconnect_runtime_internal(app: &AppHandle) -> Result<(), String> {
    CONNECTION_GENERATION.invalidate();
    let binding=app.state::<Mutex<RuntimeState>>();
    let mut state=binding.lock().map_err(|_|"运行时状态异常".to_string())?;
    let previous=state.status.clone();state.status="disconnecting".into();
    let result=shutdown_runtime(app,&mut state);
    if result.is_err(){state.status=previous;}
    sync_shell_from_runtime(app,&state);notify_native_lease_heartbeat(app);
    result
}

#[cfg(target_os = "android")]
fn disconnect_runtime_internal(app: &AppHandle) -> Result<(), String> {
    CONNECTION_GENERATION.invalidate();
    let runtime_state = app.state::<Mutex<RuntimeState>>();
    let mut state = runtime_state
        .lock()
        .map_err(|_| "运行时状态异常".to_string())?;

    stop_runtime_process(app, &mut state)?;
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

#[cfg(target_os = "macos")]
fn build_shell_menu(
    app: &AppHandle,
    state: &ShellState,
) -> Result<tauri::menu::Menu<tauri::Wry>, String> {
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
        let undo =
            PredefinedMenuItem::undo(app, Some("撤销")).map_err(|error| error.to_string())?;
        let redo =
            PredefinedMenuItem::redo(app, Some("重做")).map_err(|error| error.to_string())?;
        let cut = PredefinedMenuItem::cut(app, Some("剪切")).map_err(|error| error.to_string())?;
        let copy =
            PredefinedMenuItem::copy(app, Some("复制")).map_err(|error| error.to_string())?;
        let paste =
            PredefinedMenuItem::paste(app, Some("粘贴")).map_err(|error| error.to_string())?;
        let select_all =
            PredefinedMenuItem::select_all(app, Some("全选")).map_err(|error| error.to_string())?;

        let app_menu = SubmenuBuilder::new(app, "ChordV")
            .item(&about)
            .separator()
            .item(&show_app)
            .item(&hide_app)
            .separator()
            .item(&quit)
            .build()
            .map_err(|error| error.to_string())?;

        let edit_menu = SubmenuBuilder::new(app, "编辑")
            .item(&undo)
            .item(&redo)
            .separator()
            .item(&cut)
            .item(&copy)
            .item(&paste)
            .separator()
            .item(&select_all)
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
            .item(&edit_menu)
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
fn build_shell_tray_menu(
    app: &AppHandle,
    state: &ShellState,
) -> Result<tauri::menu::Menu<tauri::Wry>, String> {
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
    // Runtime workers may own RuntimeState here. Menu constructors synchronously
    // wait for the main thread, so dispatch the whole render without waiting.
    let render_app = app.clone();
    app.run_on_main_thread(move || {
        if let Err(error) = render_shell_ui(&render_app) {
            append_download_diagnostic_log(&render_app, "shell-ui", format!("菜单刷新失败：{error}"));
        }
    }).map_err(|error| error.to_string())
}

#[cfg(not(target_os = "android"))]
fn render_shell_ui(app: &AppHandle) -> Result<(), String> {
    // Menu APIs must never execute while a shared application mutex is held.
    let shell = {
        let binding = app.state::<Mutex<ShellState>>();
        let state = binding.lock().map_err(|_| "桌面壳层状态异常".to_string())?;
        state.clone()
    };
    #[cfg(target_os = "macos")]
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
    let shell = {
        let binding = app.state::<Mutex<ShellState>>();
        let state = binding.lock().map_err(|_| "桌面壳层状态异常".to_string())?;
        state.clone()
    };
    let menu = build_shell_tray_menu(app, &shell)?;
    let icon = app
        .default_window_icon()
        .ok_or_else(|| "缺少默认应用图标".to_string())?
        .clone();

    let mut builder = TrayIconBuilder::with_id("main-tray");
    builder = builder.icon(icon).tooltip("ChordV").menu(&menu);

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

    builder.build(app).map_err(|error| error.to_string())?;

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[allow(unused_mut)]
    let mut context = tauri::generate_context!();
    #[cfg(windows)]
    if std::env::args().any(|arg| arg == "--installer-maintenance") {
        context.config_mut().app.windows.clear();
        let result = tauri::Builder::default().build(context)
            .map_err(|error| error.to_string())
            .and_then(|app| windows_installer::cleanup_legacy_connection(app.handle()));
        match result {
            Ok(()) => std::process::exit(0),
            Err(error) => { eprintln!("{error}"); std::process::exit(1); }
        }
    }
    #[cfg(windows)]
    if windows_update::installation_in_progress() { return; }
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default()
        .plugin(android_mobile_plugin::init())
        .manage(window_transition::WindowTransitionState::default())
        .manage(Mutex::new(RuntimeState::default()))
        .manage(Mutex::new(ShellState {
            status: "idle".into(),
            signed_in: false,
            node_name: None,
            primary_action_label: "连接/断开".into(),
        }))
        .manage(Mutex::new(InstallerOperationState::default()))
        .manage(Mutex::new(PendingInstallerState::default()))
        .manage(Mutex::new(RuntimeComponentDownloadState::default()))
        .manage(Mutex::new(NativeLeaseHeartbeatSignalState::default()))
        .manage(Mutex::new(NativeClientEventStreamState::default()))
        .manage(AsyncMutex::new(NativeSessionRefreshState::default()))
        .manage(Mutex::new(android_runtime::AndroidRuntimeState::default()));

    #[cfg(windows)]
    {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build())
            .manage(windows_update::PreparedState::default());
    }

    #[cfg(not(target_os = "android"))]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            let _ = show_main_window_internal(app);
        }));
    }

    let app = builder
        .setup(|app| {
            let startup_app=app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let result=tauri::async_runtime::spawn_blocking(move || {
                    perform_startup_maintenance(&startup_app)
                }).await.unwrap_or_else(|error|Err(error.to_string()));
                STARTUP_READY.finish(result);
            });
            start_native_lease_heartbeat_loop(app.handle().clone());
            #[cfg(not(target_os = "android"))]
            if let Some(window) = app.get_webview_window("main") {
                let _ = set_main_window_title(&window, &app.handle());
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
            window_transition::transition_main_window,
            api_request,
            start_client_event_stream,
            stop_client_event_stream,
            record_client_diagnostic,
            refresh_session_native,
            load_session,
            save_session,
            clear_session,
            probe_nodes,
            show_main_window,
            hide_main_window,
            quit_application,
            download_desktop_installer,
            open_desktop_installer,
            open_external_url,
            test_routing_rule,
            install_windows_update,
            quit_for_update,
            consume_desktop_update_install_report,
            desktop_runtime_environment,
            ensure_bundled_runtime_components,
            get_runtime_component_local_info,
            fetch_remote_text,
            check_runtime_component_file,
            download_runtime_component,
            cancel_runtime_component_download,
            update_shell_summary,
            runtime_status,
            runtime_snapshot,
            runtime_logs,
            check_network_conflict,
            connect_runtime,
            disconnect_runtime,
            android_runtime::android_runtime_status,
            android_runtime::start_android_runtime,
            android_runtime::stop_android_runtime
        ])
        .build(context)
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
                        .try_lock()
                        .ok()
                        .map(|runtime| runtime.status.clone())
                };
                if !matches!(
                    status.as_deref(),
                    Some("connected" | "connecting" | "disconnecting")
                ) {
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
        RunEvent::ExitRequested { api, .. } => {
            match EXIT_CLEANUP.request() {
                exit_gate::ExitAction::Exit => {},
                exit_gate::ExitAction::WaitForCleanup => api.prevent_exit(),
                exit_gate::ExitAction::StartCleanup => {
                    api.prevent_exit();
                    CONNECTION_GENERATION.invalidate();
                    let shutdown_app=app_handle.clone();
                    tauri::async_runtime::spawn(async move {
                        let cleanup_app=shutdown_app.clone();
                        let result=tauri::async_runtime::spawn_blocking(move || {
                            STARTUP_READY.wait_finished()?;
                            shutdown_runtime_state(&cleanup_app)
                        }).await.unwrap_or_else(|error|Err(error.to_string()));
                        match result {
                            Ok(())=>{EXIT_CLEANUP.complete();shutdown_app.exit(0);},
                            Err(error)=>{
                                let _=shutdown_app.emit("chordv://exit-cleanup-failed",&error);
                                EXIT_CLEANUP.failed();
                                append_download_diagnostic_log(&shutdown_app,"runtime-exit",error);
                                let ui_app=shutdown_app.clone();
                                let _=shutdown_app.run_on_main_thread(move||{let _=show_main_window_internal(&ui_app);});
                            }
                        }
                    });
                }
            }
        }

        _ => {}
    });
}

#[cfg(test)]
mod update_trust_tests {
    use super::{
        checked_desktop_update_download_size, installer_download_url_allowed,
        installer_file_matches_expectation, max_desktop_update_download_bytes,
        normalize_sha256_hex, parse_xray_version_output, require_desktop_update_download_size,
        require_sha256_hex, resolve_trusted_desktop_update_url,
        runtime_component_download_checksum, runtime_component_local_checksum,
        validate_installer_file, RuntimeComponentKindInput, RuntimeComponentSourceFormat,
    };
    use std::fs;
    use url::Url;

    #[test]
    fn normalize_sha256_hex_accepts_colon_separated_hex() {
        let value = "AA:bb:CC:dd:EE:ff:00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff:01:23:45:67:89:ab:cd:ef:00:11";
        let normalized = normalize_sha256_hex(value).expect("valid hash");
        assert_eq!(normalized.len(), 64);
        assert!(normalized.chars().all(|ch| ch.is_ascii_hexdigit()));
    }

    #[test]
    fn require_sha256_hex_rejects_missing_and_invalid() {
        assert!(require_sha256_hex(None, "pkg").is_err());
        assert!(require_sha256_hex(Some("  "), "pkg").is_err());
        assert!(require_sha256_hex(Some("zzz"), "pkg").is_err());
        let ok = require_sha256_hex(
            Some("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"),
            "pkg",
        )
        .expect("valid");
        assert_eq!(ok.len(), 64);
    }

    #[test]
    fn xray_version_output_extracts_installed_version() {
        assert_eq!(
            parse_xray_version_output("Xray 26.3.27 (Xray, Penetrates Everything.)").as_deref(),
            Some("26.3.27")
        );
        assert_eq!(parse_xray_version_output("invalid output"), None);
    }

    #[test]
    fn zip_entry_checksum_applies_to_archive_not_installed_file() {
        let hash = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        assert_eq!(
            runtime_component_local_checksum(RuntimeComponentSourceFormat::Direct, Some(hash)),
            Some(hash)
        );
        assert_eq!(
            runtime_component_local_checksum(RuntimeComponentSourceFormat::ZipEntry, Some(hash)),
            None
        );
    }

    #[test]
    fn runtime_download_keeps_developer_requested_2026_07_14_policy() {
        assert_eq!(
            runtime_component_download_checksum(RuntimeComponentKindInput::Geoip, None).unwrap(),
            None
        );
        assert_eq!(
            runtime_component_download_checksum(RuntimeComponentKindInput::Geosite, None).unwrap(),
            None
        );
        assert_eq!(
            runtime_component_download_checksum(RuntimeComponentKindInput::Xray, None).unwrap(),
            None
        );
        assert_eq!(
            runtime_component_download_checksum(RuntimeComponentKindInput::Xray, Some("invalid"))
                .unwrap(),
            None
        );
        assert_eq!(
            runtime_component_download_checksum(
                RuntimeComponentKindInput::Xray,
                Some("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")
            )
            .unwrap()
            .as_deref(),
            Some("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")
        );
    }

    #[test]
    fn installer_validation_allows_missing_or_invalid_optional_hash() {
        let path =
            std::env::temp_dir().join(format!("chordv-optional-hash-{}.bin", std::process::id()));
        fs::write(&path, b"optional hash regression").unwrap();
        let size = fs::metadata(&path).unwrap().len();

        assert!(installer_file_matches_expectation(&path, Some(size), None).unwrap());
        assert!(installer_file_matches_expectation(&path, Some(size), Some("invalid")).unwrap());
        validate_installer_file(&path, size, Some(size), None).unwrap();
        validate_installer_file(&path, size, Some(size), Some("invalid")).unwrap();

        let _ = fs::remove_file(path);
    }

    #[test]
    fn installer_download_url_allowed_https_and_local_http_only() {
        let https = Url::parse("https://cdn.example.com/ChordV.zip").unwrap();
        assert!(installer_download_url_allowed(&https));

        let local = Url::parse("http://127.0.0.1:3000/ChordV.zip").unwrap();
        assert!(installer_download_url_allowed(&local));

        let remote_http = Url::parse("http://evil.example.com/ChordV.zip").unwrap();
        assert!(!installer_download_url_allowed(&remote_http));
    }

    #[test]
    fn trusted_update_candidate_switches_only_within_manifest_urls() {
        let api_base = Url::parse("https://api.example.com").unwrap();
        let mirror = resolve_trusted_desktop_update_url(
            &api_base,
            "https://mirror.example.com/ChordV.zip",
            Some("https://origin.example.com/ChordV.zip"),
            "mirror",
        )
        .expect("mirror candidate");
        assert_eq!(mirror.as_str(), "https://mirror.example.com/ChordV.zip");

        let origin = resolve_trusted_desktop_update_url(
            &api_base,
            "https://mirror.example.com/ChordV.zip",
            Some("/downloads/ChordV.zip"),
            "origin",
        )
        .expect("origin candidate");
        assert_eq!(
            origin.as_str(),
            "https://api.example.com/downloads/ChordV.zip"
        );

        assert!(resolve_trusted_desktop_update_url(
            &api_base,
            "https://mirror.example.com/ChordV.zip",
            None,
            "origin",
        )
        .is_err());
        assert!(resolve_trusted_desktop_update_url(
            &api_base,
            "https://mirror.example.com/ChordV.zip",
            Some("https://origin.example.com/ChordV.zip"),
            "untrusted",
        )
        .is_err());
    }

    #[test]
    fn desktop_update_size_guards_reject_missing_and_overflow() {
        let max_download_bytes = max_desktop_update_download_bytes();
        assert_eq!(max_download_bytes, 1_073_741_824);
        assert!(require_desktop_update_download_size(None).is_err());
        assert!(require_desktop_update_download_size(Some(0)).is_err());
        assert!(require_desktop_update_download_size(Some(1024)).is_ok());
        assert!(require_desktop_update_download_size(Some(max_download_bytes + 1)).is_err());
        assert!(checked_desktop_update_download_size(900, 124, 1024).is_ok());
        assert!(checked_desktop_update_download_size(900, 125, 1024).is_err());
        assert!(checked_desktop_update_download_size(u64::MAX, 1, u64::MAX).is_err());
    }
}

#[cfg(test)]
mod runtime_failure_tests {
    use super::*;
    #[test]
    fn rejected_duplicate_does_not_own_the_original_start(){
        let mut state=RuntimeState::default();state.status="starting".into();state.active_session_id=Some("same-session".into());state.active_attempt=Some(1);
        assert!(!owns_failed_connection(&state,2,"same-session"));
        assert!(owns_failed_connection(&state,1,"same-session"));
    }
    #[test]
    fn startup_errors_do_not_leave_a_connecting_session() {
        for phase in ["starting","connecting"] {
            let mut state=RuntimeState::default();state.status=phase.into();
            state.active_session_id=Some("failed-session".into());state.active_node_id=Some("node".into());
            state.active_pid=Some(42);state.local_http_port=Some(1080);
            mark_failed_runtime_start(&mut state,"configuration write failed");
            assert_eq!(state.status,"error");assert!(state.active_session_id.is_none());
            assert!(state.active_pid.is_none());assert!(state.local_http_port.is_none());
            assert_eq!(state.last_error.as_deref(),Some("configuration write failed"));
        }
    }
}
