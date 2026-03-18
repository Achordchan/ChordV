#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs::{self, File},
    net::{SocketAddr, TcpStream, ToSocketAddrs},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager, RunEvent, State};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

struct RuntimeState {
    status: String,
    active_session_id: Option<String>,
    config_path: Option<PathBuf>,
    log_path: Option<PathBuf>,
    xray_binary_path: Option<PathBuf>,
    active_pid: Option<u32>,
    last_error: Option<String>,
    child: Option<Child>,
}

impl Default for RuntimeState {
    fn default() -> Self {
        Self {
            status: "idle".into(),
            active_session_id: None,
            config_path: None,
            log_path: None,
            xray_binary_path: None,
            active_pid: None,
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
    server_host: String,
    server_port: u16,
    server_name: String,
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
fn probe_nodes(nodes: Vec<NodeSummaryDto>) -> Vec<NodeProbeResultDto> {
    nodes.into_iter().map(probe_single_node).collect()
}

#[tauri::command]
fn app_ready(app: AppHandle) -> Result<CommandResult, String> {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_focus();
        let _ = disable_context_menu(&window);
    }

    Ok(CommandResult {
        ok: true,
        config_path: None,
        log_path: None,
        active_pid: None,
    })
}

#[tauri::command]
fn runtime_status(state: State<'_, Mutex<RuntimeState>>) -> RuntimeStatusResponse {
    let mut state = state.lock().expect("runtime state lock");
    refresh_child_state(&mut state);
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
    let mut state = state.lock().map_err(|_| "运行时状态异常".to_string())?;
    stop_runtime_process(&mut state);

    if cfg!(target_os = "macos") {
        let _ = clear_proxy();
    }

    state.status = "connecting".into();
    state.active_session_id = Some(config.session_id.clone());
    state.last_error = None;

    let runtime_dir = ensure_runtime_dir(&app)?;
    let xray_binary_path = ensure_xray_binary(&app, &runtime_dir)?;
    ensure_geo_data(&app, &runtime_dir)?;
    let config_path = runtime_dir.join(format!("{}.json", config.session_id));
    let log_path = runtime_dir.join(format!("{}.log", config.session_id));

    write_xray_config(&config, &config_path, &log_path)?;

    let stdout = File::create(&log_path).map_err(|error| error.to_string())?;
    let stderr = stdout.try_clone().map_err(|error| error.to_string())?;

    let mut child = Command::new(&xray_binary_path)
        .arg("run")
        .arg("-config")
        .arg(&config_path)
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr))
        .spawn()
        .map_err(|error| format!("启动 xray 失败：{error}"))?;

    thread::sleep(Duration::from_millis(900));

    if let Some(exit_status) = child.try_wait().map_err(|error| error.to_string())? {
        let log = tail_log(&log_path, 40);
        state.status = "error".into();
        state.active_session_id = None;
        state.config_path = Some(config_path.clone());
        state.log_path = Some(log_path.clone());
        state.xray_binary_path = Some(xray_binary_path.clone());
        state.active_pid = None;
        state.last_error = Some(format!("xray 已退出：{exit_status}"));

        return Err(if log.is_empty() {
            format!("xray 启动失败：{exit_status}")
        } else {
            format!("xray 启动失败：{exit_status}\n{log}")
        });
    }

    if cfg!(target_os = "macos") {
        if let Err(error) = set_proxy(config.local_http_port, config.local_socks_port) {
            let _ = child.kill();
            let _ = child.wait();
            state.status = "error".into();
            state.active_session_id = None;
            state.last_error = Some(format!("设置系统代理失败：{error}"));
            return Err(format!("设置系统代理失败：{error}"));
        }
    }

    state.status = "connected".into();
    state.config_path = Some(config_path.clone());
    state.log_path = Some(log_path.clone());
    state.xray_binary_path = Some(xray_binary_path.clone());
    state.active_pid = Some(child.id());
    state.child = Some(child);

    Ok(CommandResult {
        ok: true,
        config_path: Some(config_path.to_string_lossy().into_owned()),
        log_path: Some(log_path.to_string_lossy().into_owned()),
        active_pid: state.active_pid,
    })
}

#[tauri::command]
fn disconnect_runtime(state: State<'_, Mutex<RuntimeState>>) -> Result<CommandResult, String> {
    let mut state = state.lock().map_err(|_| "运行时状态异常".to_string())?;
    state.status = "disconnecting".into();

    if cfg!(target_os = "macos") {
        clear_proxy().map_err(|error| error.to_string())?;
    }

    stop_runtime_process(&mut state);

    state.status = "idle".into();
    state.active_session_id = None;
    state.config_path = None;
    state.active_pid = None;
    state.last_error = None;

    Ok(CommandResult {
        ok: true,
        config_path: None,
        log_path: state
            .log_path
            .as_ref()
            .map(|path| path.to_string_lossy().into_owned()),
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

fn ensure_xray_binary(app: &AppHandle, runtime_dir: &Path) -> Result<PathBuf, String> {
    if let Ok(path) = std::env::var("CHORDV_XRAY_BIN") {
        let binary = PathBuf::from(path);
        if binary.exists() {
            return Ok(binary);
        }
    }

    let bin_dir = runtime_dir.join("bin");
    fs::create_dir_all(&bin_dir).map_err(|error| error.to_string())?;
    let installed_path = bin_dir.join("xray");

    if installed_path.exists() {
        ensure_executable(&installed_path)?;
        return Ok(installed_path);
    }

    let candidates = xray_binary_candidates(app);
    for candidate in candidates {
        if candidate.exists() {
            fs::copy(&candidate, &installed_path).map_err(|error| error.to_string())?;
            ensure_executable(&installed_path)?;
            return Ok(installed_path);
        }
    }

    Err("未找到 xray 内核，请先执行 pnpm setup:mac".into())
}

fn xray_binary_candidates(app: &AppHandle) -> Vec<PathBuf> {
    let binary_name = target_binary_name();
    let mut candidates = vec![PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("bin")
        .join(binary_name)];

    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join("bin").join(binary_name));
        candidates.push(resource_dir.join(binary_name));
    }

    candidates
}

fn xray_resource_dirs(app: &AppHandle) -> Vec<PathBuf> {
    let mut dirs = vec![PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("bin")];

    if let Ok(resource_dir) = app.path().resource_dir() {
        dirs.push(resource_dir.join("bin"));
        dirs.push(resource_dir);
    }

    dirs
}

fn target_binary_name() -> &'static str {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        "xray-aarch64-apple-darwin"
    }

    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        "xray-x86_64-apple-darwin"
    }

    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        "xray-x86_64-pc-windows-msvc.exe"
    }

    #[cfg(not(any(
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "macos", target_arch = "x86_64"),
        all(target_os = "windows", target_arch = "x86_64")
    )))]
    {
        "xray"
    }
}

fn ensure_executable(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        let mut permissions = fs::metadata(path)
            .map_err(|error| error.to_string())?
            .permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(path, permissions).map_err(|error| error.to_string())?;
    }

    Ok(())
}

fn set_private_permissions(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        let mut permissions = fs::metadata(path)
            .map_err(|error| error.to_string())?
            .permissions();
        permissions.set_mode(0o600);
        fs::set_permissions(path, permissions).map_err(|error| error.to_string())?;
    }

    Ok(())
}

fn ensure_geo_data(app: &AppHandle, runtime_dir: &Path) -> Result<(), String> {
    let bin_dir = runtime_dir.join("bin");
    fs::create_dir_all(&bin_dir).map_err(|error| error.to_string())?;

    for file_name in ["geoip.dat", "geosite.dat"] {
        let target = bin_dir.join(file_name);
        if target.exists() {
            continue;
        }

        let source = xray_resource_dirs(app)
            .into_iter()
            .map(|dir| dir.join(file_name))
            .find(|path| path.exists())
            .ok_or_else(|| format!("未找到 {file_name}，请先执行 pnpm setup:mac"))?;

        fs::copy(source, target).map_err(|error| error.to_string())?;
    }

    Ok(())
}

fn write_xray_config(
    config: &GeneratedRuntimeConfigDto,
    config_path: &Path,
    log_path: &Path,
) -> Result<(), String> {
    let content = build_xray_config(config, log_path);
    let serialized = serde_json::to_string_pretty(&content).map_err(|error| error.to_string())?;
    fs::write(config_path, serialized).map_err(|error| error.to_string())
}

fn build_xray_config(config: &GeneratedRuntimeConfigDto, log_path: &Path) -> Value {
    json!({
      "log": {
        "loglevel": "warning",
        "error": log_path.to_string_lossy().to_string()
      },
      "dns": {
        "servers": [
          {
            "address": "223.5.5.5",
            "domains": ["geosite:cn"],
            "expectIPs": ["geoip:cn"]
          },
          {
            "address": "1.1.1.1",
            "domains": ["geosite:geolocation-!cn"]
          },
          "localhost"
        ]
      },
      "inbounds": [
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
      ],
      "outbounds": [
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
      ],
      "routing": {
        "domainMatcher": "hybrid",
        "domainStrategy": "AsIs",
        "rules": routing_rules(config.mode.as_str(), &config.features)
      }
    })
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
                if cfg!(target_os = "macos") {
                    let _ = clear_proxy();
                }
                state.status = "error".into();
                state.active_pid = None;
                state.child = None;
                state.last_error = Some(format!("xray 已退出：{status}"));
            }
            Ok(None) => {
                if state.status == "connecting" {
                    state.status = "connected".into();
                }
            }
            Err(error) => {
                if cfg!(target_os = "macos") {
                    let _ = clear_proxy();
                }
                state.status = "error".into();
                state.active_pid = None;
                state.child = None;
                state.last_error = Some(format!("读取 xray 状态失败：{error}"));
            }
        }
    }

    if (state.status == "connected" || state.status == "connecting")
        && (!is_port_open(17890) && !is_port_open(17891))
    {
        if cfg!(target_os = "macos") {
            let _ = clear_proxy();
        }
        state.status = "error".into();
        state.active_pid = None;
        state.child = None;
        state.last_error = Some("内核未运行".into());
    }
}

fn stop_runtime_process(state: &mut RuntimeState) {
    if let Some(mut child) = state.child.take() {
        let _ = child.kill();
        let _ = child.wait();
    }

    if let Some(path) = state.config_path.take() {
        let _ = fs::remove_file(path);
    }

    state.active_pid = None;
}

fn session_path(app: &AppHandle) -> Result<PathBuf, String> {
    let mut path = app
        .path()
        .app_local_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("chordv-desktop"));
    path.push("session.json");
    Ok(path)
}

fn probe_single_node(node: NodeSummaryDto) -> NodeProbeResultDto {
    let checked_at = chrono_like_now();
    let start = Instant::now();
    let outcome = resolve_socket_addr(&node.server_host, node.server_port)
        .and_then(|address| TcpStream::connect_timeout(&address, Duration::from_secs(4)).map_err(|error| error.to_string()));

    match outcome {
        Ok(_) => NodeProbeResultDto {
            node_id: node.id,
            status: "healthy".into(),
            latency_ms: Some(start.elapsed().as_millis().min(u128::from(u32::MAX)) as u32),
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

fn chrono_like_now() -> String {
    let now = std::time::SystemTime::now();
    let datetime: chrono::DateTime<chrono::Utc> = now.into();
    datetime.to_rfc3339()
}

fn shutdown_runtime(state: &mut RuntimeState) {
    if cfg!(target_os = "macos") {
        let _ = clear_proxy();
    }

    stop_runtime_process(state);
    state.status = "idle".into();
    state.active_session_id = None;
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

    let stale_binary = runtime_dir.join("bin").join("xray");
    if stale_binary.exists() {
        let _ = Command::new("pkill")
            .args(["-f", &stale_binary.to_string_lossy()])
            .status();
    }

    let _ = fs::remove_dir_all(runtime_dir.join("bin").join("cache"));

    if let Ok(entries) = fs::read_dir(&runtime_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) == Some("json") {
                let _ = fs::remove_file(path);
            }
        }
    }

    if cfg!(target_os = "macos") {
        let _ = clear_proxy();
    }
}

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

fn main() {
    let app = tauri::Builder::default()
        .manage(Mutex::new(RuntimeState::default()))
        .setup(|app| {
            cleanup_stale_runtime(&app.handle());
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
                let _ = disable_context_menu(&window);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_ready,
            load_session,
            save_session,
            clear_session,
            probe_nodes,
            runtime_status,
            runtime_logs,
            connect_runtime,
            disconnect_runtime
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| match event {
        RunEvent::ExitRequested { .. } | RunEvent::Exit => {
            let state: State<'_, Mutex<RuntimeState>> = app_handle.state();
            if let Ok(mut state) = state.lock() {
                shutdown_runtime(&mut state);
            } else if cfg!(target_os = "macos") {
                let _ = clear_proxy();
            }
            cleanup_stale_runtime(app_handle);
        }
        _ => {}
    });
}
