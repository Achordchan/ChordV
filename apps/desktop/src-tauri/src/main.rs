#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::PathBuf,
    process::Command,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::State;

#[derive(Default)]
struct RuntimeState {
    status: String,
    active_session_id: Option<String>,
    config_path: Option<PathBuf>,
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
    outbound: RuntimeOutboundDto,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeStatusResponse {
    status: String,
    active_session_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CommandResult {
    ok: bool,
    config_path: Option<String>,
}

#[tauri::command]
fn runtime_status(state: State<'_, Mutex<RuntimeState>>) -> RuntimeStatusResponse {
    let state = state.lock().expect("runtime state lock");
    RuntimeStatusResponse {
        status: state.status.clone(),
        active_session_id: state.active_session_id.clone(),
    }
}

#[tauri::command]
fn connect_runtime(
    config: GeneratedRuntimeConfigDto,
    state: State<'_, Mutex<RuntimeState>>,
) -> Result<CommandResult, String> {
    let mut state = state.lock().map_err(|_| "runtime state poisoned")?;
    state.status = "connecting".into();

    let config_path = write_runtime_file(&config)?;

    if cfg!(target_os = "macos") {
        set_proxy(config.local_http_port).map_err(|error| error.to_string())?;
    }

    state.status = "connected".into();
    state.active_session_id = Some(config.session_id);
    state.config_path = Some(config_path.clone());

    Ok(CommandResult {
        ok: true,
        config_path: Some(config_path.to_string_lossy().into_owned()),
    })
}

#[tauri::command]
fn disconnect_runtime(state: State<'_, Mutex<RuntimeState>>) -> Result<CommandResult, String> {
    let mut state = state.lock().map_err(|_| "runtime state poisoned")?;
    state.status = "disconnecting".into();

    if cfg!(target_os = "macos") {
      clear_proxy().map_err(|error| error.to_string())?;
    }

    if let Some(path) = state.config_path.take() {
        let _ = fs::remove_file(path);
    }

    state.status = "idle".into();
    state.active_session_id = None;

    Ok(CommandResult {
        ok: true,
        config_path: None,
    })
}

fn write_runtime_file(config: &GeneratedRuntimeConfigDto) -> Result<PathBuf, String> {
    let mut path = std::env::temp_dir();
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis();

    path.push(format!("chordv-runtime-{}-{}.json", config.node.id, timestamp));
    let serialized = serde_json::to_string_pretty(config).map_err(|error| error.to_string())?;
    fs::write(&path, serialized).map_err(|error| error.to_string())?;
    Ok(path)
}

fn set_proxy(port: u16) -> Result<(), std::io::Error> {
    for service in ["Wi-Fi", "USB 10/100/1000 LAN"] {
        let _ = Command::new("networksetup")
            .args(["-setwebproxy", service, "127.0.0.1", &port.to_string()])
            .status();
        let _ = Command::new("networksetup")
            .args(["-setsecurewebproxy", service, "127.0.0.1", &port.to_string()])
            .status();
        let _ = Command::new("networksetup")
            .args(["-setwebproxystate", service, "on"])
            .status();
        let _ = Command::new("networksetup")
            .args(["-setsecurewebproxystate", service, "on"])
            .status();
    }

    Ok(())
}

fn clear_proxy() -> Result<(), std::io::Error> {
    for service in ["Wi-Fi", "USB 10/100/1000 LAN"] {
        let _ = Command::new("networksetup")
            .args(["-setwebproxystate", service, "off"])
            .status();
        let _ = Command::new("networksetup")
            .args(["-setsecurewebproxystate", service, "off"])
            .status();
    }

    Ok(())
}

fn main() {
    tauri::Builder::default()
        .manage(Mutex::new(RuntimeState {
            status: "idle".into(),
            active_session_id: None,
            config_path: None,
        }))
        .invoke_handler(tauri::generate_handler![
            runtime_status,
            connect_runtime,
            disconnect_runtime
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
