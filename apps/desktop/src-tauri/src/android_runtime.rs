use serde::{Deserialize, Serialize};
use std::{fs, path::{Path, PathBuf}, sync::Mutex};
use tauri::{AppHandle, State};

#[cfg(target_os = "android")]
use tauri::Manager;

#[cfg(target_os = "android")]
use crate::android_mobile_plugin::AndroidRuntimePluginHandle;
use crate::{
    build_xray_config, chrono_like_now, ensure_geo_data, ensure_runtime_dir,
    CommandResult, GeneratedRuntimeConfigDto,
};

pub struct AndroidRuntimeState {
    status: String,
    active_session_id: Option<String>,
    active_node_id: Option<String>,
    config_path: Option<PathBuf>,
    tun_name: Option<String>,
    last_error: Option<String>,
    last_started_at: Option<String>,
    reason_code: Option<String>,
    recovery_hint: Option<String>,
    vpn_active: Option<bool>,
    connectivity_verified: Option<bool>,
}

impl Default for AndroidRuntimeState {
    fn default() -> Self {
        Self {
            status: "idle".into(),
            active_session_id: None,
            active_node_id: None,
            config_path: None,
            tun_name: None,
            last_error: None,
            last_started_at: None,
            reason_code: None,
            recovery_hint: None,
            vpn_active: None,
            connectivity_verified: None,
        }
    }
}

fn android_tun_dns_servers() -> Vec<String> {
    ANDROID_TUN_DNS_SERVERS
        .iter()
        .map(|value| (*value).to_string())
        .collect()
}

fn build_android_xray_config(
    config: &GeneratedRuntimeConfigDto,
    log_path: &Path,
) -> serde_json::Value {
    build_xray_config(config, log_path, true)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AndroidRuntimeStatusResponse {
    status: String,
    active_session_id: Option<String>,
    active_node_id: Option<String>,
    config_path: Option<String>,
    tun_name: Option<String>,
    last_error: Option<String>,
    last_started_at: Option<String>,
    reason_code: Option<String>,
    recovery_hint: Option<String>,
    vpn_active: Option<bool>,
    connectivity_verified: Option<bool>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AndroidRuntimeBootstrap {
    session_id: String,
    node_id: String,
    mode: String,
    runtime_profile: String,
    local_http_port: u16,
    local_socks_port: u16,
    xray_binary_path: String,
    geoip_path: String,
    geosite_path: String,
    tun_name: String,
    tun_mtu: u16,
    tun_ipv4_address: String,
    tun_ipv4_prefix: u8,
    tun_ipv6_address: String,
    tun_ipv6_prefix: u8,
    tun_dns_servers: Vec<String>,
    tun_test_url: String,
    outbound_server: String,
    outbound_port: u16,
    outbound_uuid: String,
    outbound_flow: String,
    reality_public_key: String,
    short_id: String,
    server_name: String,
    fingerprint: String,
    spider_x: String,
    routing_profile: String,
    generated_at: String,
}

#[derive(Debug, Default)]
struct AndroidNativeStartResult {
    status: Option<String>,
    active_session_id: Option<String>,
    active_node_id: Option<String>,
    config_path: Option<String>,
    tun_name: Option<String>,
    last_error: Option<String>,
    last_error_code: Option<String>,
    last_started_at: Option<String>,
    vpn_interface_ready: Option<bool>,
    xray_process_alive: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AndroidPluginStartPayload {
    session_id: String,
    node_id: String,
    local_http_port: u16,
    local_socks_port: u16,
    tun_name: String,
    tun_mtu: u16,
    tun_ipv4_address: String,
    tun_ipv4_prefix: u8,
    tun_ipv6_address: String,
    tun_ipv6_prefix: u8,
    tun_dns_servers: Vec<String>,
    tun_test_url: String,
    xray_binary_path: String,
    geoip_path: String,
    geosite_path: String,
    config_path: String,
    log_path: String,
}

#[cfg(target_os = "android")]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AndroidPluginStatusPayload {
    status: Option<String>,
    active_session_id: Option<String>,
    active_node_id: Option<String>,
    config_path: Option<String>,
    tun_name: Option<String>,
    vpn_interface_ready: Option<bool>,
    xray_process_alive: Option<bool>,
    last_error: Option<String>,
    last_error_code: Option<String>,
    last_started_at: Option<String>,
}

const ANDROID_TUN_NAME: &str = "chordv-vpn";
const ANDROID_TUN_MTU: u16 = 1500;
const ANDROID_TUN_IPV4_ADDRESS: &str = "172.19.0.2";
const ANDROID_TUN_IPV4_PREFIX: u8 = 30;
const ANDROID_TUN_IPV6_ADDRESS: &str = "fd66:6f72:6463::2";
const ANDROID_TUN_IPV6_PREFIX: u8 = 126;
const ANDROID_TUN_TEST_URL: &str = "https://www.gstatic.com/generate_204";
const ANDROID_TUN_DNS_SERVERS: [&str; 4] = [
    "1.1.1.1",
    "223.5.5.5",
    "2606:4700:4700::1111",
    "2400:3200::1",
];

#[tauri::command]
pub fn android_runtime_status(
    _app: AppHandle,
    state: State<'_, Mutex<AndroidRuntimeState>>,
) -> AndroidRuntimeStatusResponse {
    #[cfg(target_os = "android")]
    {
        if let Some(plugin) = _app.try_state::<AndroidRuntimePluginHandle>() {
            if let Ok(snapshot) = plugin
                .0
                .run_mobile_plugin::<AndroidPluginStatusPayload>("status", ())
            {
                if let Ok(mut state) = state.lock() {
                    state.status = snapshot.status.clone().unwrap_or_else(|| "idle".into());
                    state.active_session_id = snapshot.active_session_id.clone();
                    state.active_node_id = snapshot.active_node_id.clone();
                    state.config_path = snapshot.config_path.as_ref().map(PathBuf::from);
                    state.tun_name = snapshot.tun_name.clone();
                    state.last_error = snapshot.last_error.clone();
                    state.last_started_at = snapshot.last_started_at.clone();
                    state.reason_code = snapshot.last_error_code.clone();
                    state.recovery_hint = state
                        .reason_code
                        .as_deref()
                        .and_then(recovery_hint_for_reason);
                    state.vpn_active = snapshot.vpn_interface_ready;
                    state.connectivity_verified = snapshot.xray_process_alive;
                }
            }
        }
    }

    let state = state.lock().expect("android runtime state lock");
    AndroidRuntimeStatusResponse {
        status: state.status.clone(),
        active_session_id: state.active_session_id.clone(),
        active_node_id: state.active_node_id.clone(),
        config_path: state
            .config_path
            .as_ref()
            .map(|path| path.to_string_lossy().into_owned()),
        tun_name: state.tun_name.clone(),
        last_error: state.last_error.clone(),
        last_started_at: state.last_started_at.clone(),
        reason_code: state.reason_code.clone(),
        recovery_hint: state.recovery_hint.clone(),
        vpn_active: state.vpn_active,
        connectivity_verified: state.connectivity_verified,
    }
}

#[tauri::command]
pub fn start_android_runtime(
    app: AppHandle,
    config: GeneratedRuntimeConfigDto,
    state: State<'_, Mutex<AndroidRuntimeState>>,
) -> Result<CommandResult, String> {
    let mut state = state
        .lock()
        .map_err(|_| "Android 运行时状态异常".to_string())?;

    let runtime_dir = ensure_runtime_dir(&app)?;
    ensure_geo_data(&app, &runtime_dir)?;
    let geoip_path = runtime_dir.join("bin").join("geoip.dat");
    let geosite_path = runtime_dir.join("bin").join("geosite.dat");
    let config_path = runtime_dir.join(format!("{}-android.json", config.session_id));
    let log_path = runtime_dir.join(format!("{}-android.log", config.session_id));
    let bootstrap = AndroidRuntimeBootstrap {
        session_id: config.session_id.clone(),
        node_id: config.node.id.clone(),
        mode: config.mode.clone(),
        runtime_profile: "android-vpn".into(),
        local_http_port: config.local_http_port,
        local_socks_port: config.local_socks_port,
        xray_binary_path: String::new(),
        geoip_path: geoip_path.to_string_lossy().into_owned(),
        geosite_path: geosite_path.to_string_lossy().into_owned(),
        tun_name: ANDROID_TUN_NAME.into(),
        tun_mtu: ANDROID_TUN_MTU,
        tun_ipv4_address: ANDROID_TUN_IPV4_ADDRESS.into(),
        tun_ipv4_prefix: ANDROID_TUN_IPV4_PREFIX,
        tun_ipv6_address: ANDROID_TUN_IPV6_ADDRESS.into(),
        tun_ipv6_prefix: ANDROID_TUN_IPV6_PREFIX,
        tun_dns_servers: android_tun_dns_servers(),
        tun_test_url: ANDROID_TUN_TEST_URL.into(),
        outbound_server: config.outbound.server.clone(),
        outbound_port: config.outbound.port,
        outbound_uuid: config.outbound.uuid.clone(),
        outbound_flow: config.outbound.flow.clone(),
        reality_public_key: config.outbound.reality_public_key.clone(),
        short_id: config.outbound.short_id.clone(),
        server_name: config.outbound.server_name.clone(),
        fingerprint: config.outbound.fingerprint.clone(),
        spider_x: config.outbound.spider_x.clone(),
        routing_profile: config.routing_profile.clone(),
        generated_at: config.generated_at.clone(),
    };
    let serialized = serde_json::to_string_pretty(&bootstrap).map_err(|error| error.to_string())?;
    fs::write(runtime_dir.join(format!("{}-android.bootstrap.json", config.session_id)), serialized)
        .map_err(|error| error.to_string())?;

    let xray_config = build_android_xray_config(&config, &log_path);
    let xray_serialized =
        serde_json::to_string_pretty(&xray_config).map_err(|error| error.to_string())?;
    fs::write(&config_path, xray_serialized).map_err(|error| error.to_string())?;

    state.status = "starting".into();
    state.active_session_id = Some(config.session_id.clone());
    state.active_node_id = Some(config.node.id.clone());
    state.config_path = Some(config_path.clone());
    state.tun_name = None;
    state.last_error = None;
    state.last_started_at = Some(chrono_like_now());
    state.reason_code = None;
    state.recovery_hint = None;
    state.vpn_active = Some(false);
    state.connectivity_verified = Some(false);

    match start_android_native_bridge(
        &app,
        AndroidPluginStartPayload {
            session_id: config.session_id.clone(),
            node_id: config.node.id.clone(),
            local_http_port: config.local_http_port,
            local_socks_port: config.local_socks_port,
            tun_name: ANDROID_TUN_NAME.into(),
            tun_mtu: ANDROID_TUN_MTU,
            tun_ipv4_address: ANDROID_TUN_IPV4_ADDRESS.into(),
            tun_ipv4_prefix: ANDROID_TUN_IPV4_PREFIX,
            tun_ipv6_address: ANDROID_TUN_IPV6_ADDRESS.into(),
            tun_ipv6_prefix: ANDROID_TUN_IPV6_PREFIX,
            tun_dns_servers: android_tun_dns_servers(),
            tun_test_url: ANDROID_TUN_TEST_URL.into(),
            xray_binary_path: String::new(),
            geoip_path: geoip_path.to_string_lossy().into_owned(),
            geosite_path: geosite_path.to_string_lossy().into_owned(),
            config_path: config_path.to_string_lossy().into_owned(),
            log_path: log_path.to_string_lossy().into_owned(),
        },
    ) {
        Ok(result) => {
            state.status = result.status.unwrap_or_else(|| "connected".into());
            state.active_session_id = result
                .active_session_id
                .or_else(|| Some(config.session_id.clone()));
            state.active_node_id = result.active_node_id.or_else(|| Some(config.node.id.clone()));
            state.config_path = result
                .config_path
                .map(PathBuf::from)
                .or_else(|| Some(config_path.clone()));
            state.tun_name = result.tun_name.or_else(|| Some(ANDROID_TUN_NAME.into()));
            state.last_started_at = result
                .last_started_at
                .or_else(|| Some(chrono_like_now()));
            state.last_error = result.last_error.clone();
            state.reason_code = result.last_error_code.clone();
            state.recovery_hint = result
                .last_error_code
                .as_deref()
                .and_then(recovery_hint_for_reason);
            state.vpn_active = result.vpn_interface_ready.or(Some(true));
            state.connectivity_verified = result.xray_process_alive.or(Some(true));
            Ok(CommandResult {
                ok: true,
                config_path: Some(config_path.to_string_lossy().into_owned()),
                log_path: None,
                active_pid: None,
            })
        }
        Err(error) => {
            let _ = fs::remove_file(&config_path);
            let _ = clear_android_runtime_cache(&app);
            state.status = "error".into();
            state.last_error = Some(error.clone());
            state.reason_code = Some("android_runtime_start_failed".into());
            state.recovery_hint = recovery_hint_for_reason("android_runtime_start_failed");
            state.vpn_active = Some(false);
            state.connectivity_verified = Some(false);
            Err(error)
        }
    }
}

#[tauri::command]
pub fn stop_android_runtime(
    app: AppHandle,
    state: State<'_, Mutex<AndroidRuntimeState>>,
) -> Result<CommandResult, String> {
    let mut state = state
        .lock()
        .map_err(|_| "Android 运行时状态异常".to_string())?;

    state.status = "disconnecting".into();
    let mut native_error: Option<String> = None;
    if let Err(error) = stop_android_native_bridge(&app) {
        native_error = Some(error);
    }

    if let Some(path) = state.config_path.take() {
        let _ = fs::remove_file(path);
    }

    state.status = if native_error.is_some() {
        "error".into()
    } else {
        "idle".into()
    };
    state.active_session_id = None;
    state.active_node_id = None;
    state.tun_name = None;
    state.last_started_at = None;
    state.last_error = native_error.clone();
    state.reason_code = native_error
        .as_ref()
        .map(|_| "android_runtime_stop_failed".to_string());
    state.recovery_hint = native_error
        .as_ref()
        .and_then(|_| recovery_hint_for_reason("android_runtime_stop_failed"));
    state.vpn_active = Some(false);
    state.connectivity_verified = Some(false);

    let _ = clear_android_runtime_cache(&app);

    Ok(CommandResult {
        ok: native_error.is_none(),
        config_path: None,
        log_path: native_error,
        active_pid: None,
    })
}

fn recovery_hint_for_reason(reason: &str) -> Option<String> {
    match reason {
        "vpn_permission_denied" => Some("请允许 Android VPN 权限后重新连接。".into()),
        "vpn_permission_lost" => Some("系统回收了 VPN 权限，请重新连接。".into()),
        "service_start_failed" | "android_runtime_start_failed" => Some("请稍后重试，若仍失败请查看日志。".into()),
        "service_stop_failed" | "android_runtime_stop_failed" => Some("请重新打开应用后再次断开连接。".into()),
        "runtime_stopped" | "runtime_mismatch" => Some("运行时已停止，请重新连接。".into()),
        _ => None,
    }
}

fn clear_android_runtime_cache(app: &AppHandle) -> Result<(), String> {
    let runtime_dir = ensure_runtime_dir(app)?;
    if let Ok(entries) = fs::read_dir(&runtime_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path
                .file_name()
                .and_then(|value| value.to_str())
                .map(|name| {
                    name.ends_with("-android.json")
                        || name.ends_with("-android.bootstrap.json")
                        || name.ends_with("-android.log")
                })
                .unwrap_or(false)
            {
                let _ = fs::remove_file(path);
            }
        }
    }
    Ok(())
}

fn start_android_native_bridge(
    app: &AppHandle,
    payload: AndroidPluginStartPayload,
) -> Result<AndroidNativeStartResult, String> {
    let _ = (app, &payload);

    #[cfg(target_os = "android")]
    {
        let plugin = app
            .try_state::<AndroidRuntimePluginHandle>()
            .ok_or_else(|| "Android 运行时插件未注册".to_string())?;
        let response = plugin
            .0
            .run_mobile_plugin::<AndroidPluginStatusPayload>("start", payload)
            .map_err(|error| format!("调用 Android VPN/TUN 运行时失败：{error}"))?;

        let status = response.status.clone().unwrap_or_else(|| "error".into());
        let vpn_interface_ready = response.vpn_interface_ready.unwrap_or(false);
        let xray_process_alive = response.xray_process_alive.unwrap_or(false);
        if status == "error" {
            return Err(response
                .last_error
                .clone()
                .unwrap_or_else(|| "Android VPN/TUN 启动失败".into()));
        }
        if status != "connected" {
            return Err(format!("Android VPN/TUN 尚未进入已连接状态：{status}"));
        }
        if !vpn_interface_ready {
            return Err(response
                .last_error
                .clone()
                .unwrap_or_else(|| "Android VPN 接口未就绪".into()));
        }
        if !xray_process_alive {
            return Err(response
                .last_error
                .clone()
                .unwrap_or_else(|| "Android 运行时未进入可用状态".into()));
        }

        Ok(AndroidNativeStartResult {
            status: response.status,
            active_session_id: response.active_session_id,
            active_node_id: response.active_node_id,
            config_path: response.config_path,
            tun_name: response.tun_name,
            last_error: response.last_error,
            last_error_code: response.last_error_code,
            last_started_at: response.last_started_at,
            vpn_interface_ready: Some(vpn_interface_ready),
            xray_process_alive: Some(xray_process_alive),
        })
    }

    #[cfg(not(target_os = "android"))]
    {
        Err("当前平台不是 Android，无法启动 Android 运行时".into())
    }
}

fn stop_android_native_bridge(app: &AppHandle) -> Result<(), String> {
    let _ = app;

    #[cfg(target_os = "android")]
    {
        let plugin = app
            .try_state::<AndroidRuntimePluginHandle>()
            .ok_or_else(|| "Android 运行时插件未注册".to_string())?;
        plugin
            .0
            .run_mobile_plugin::<AndroidPluginStatusPayload>("stop", ())
            .map_err(|error| format!("停止 Android VPN/TUN 运行时失败：{error}"))?;
        Ok(())
    }

    #[cfg(not(target_os = "android"))]
    {
        Err("当前平台不是 Android，无法停止 Android 运行时".into())
    }
}
