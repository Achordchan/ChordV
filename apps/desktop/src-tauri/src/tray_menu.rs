//! System tray: connection status at a glance plus the handful of actions worth
//! doing without opening the main window. Shared by macOS and Windows.
use std::io::Write;
use std::process::{Command, Stdio};
use std::sync::OnceLock;

use tauri::image::Image;
use tauri::menu::{CheckMenuItemBuilder, Menu, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Wry};

use super::{ShellNode, ShellState};

pub(crate) const MODE_ID_PREFIX: &str = "shell.mode.";
pub(crate) const NODE_ID_PREFIX: &str = "shell.node.";
pub(crate) const COPY_PROXY_ID: &str = "shell.copy-proxy";

fn is_connected(state: &ShellState) -> bool {
    state.signed_in && state.status == "connected"
}

fn is_transitioning(state: &ShellState) -> bool {
    matches!(state.status.as_str(), "connecting" | "starting" | "disconnecting")
}

fn status_text(state: &ShellState) -> String {
    if !state.signed_in {
        return "未登录".into();
    }
    let label = match state.status.as_str() {
        "connected" => "已连接",
        "connecting" | "starting" => "连接中",
        "disconnecting" => "断开中",
        "error" => "连接异常",
        _ => "未连接",
    };
    let shows_node = matches!(state.status.as_str(), "connected" | "connecting" | "starting");
    match state.node_name.as_deref().filter(|_| shows_node) {
        Some(node) => format!("{label} · {node}"),
        None => label.into(),
    }
}

pub(crate) fn tooltip(state: &ShellState) -> String {
    format!("ChordV · {}", status_text(state))
}

fn mode_label(mode: &str) -> &'static str {
    match mode {
        "global" => "全局",
        "direct" => "直连",
        _ => "规则",
    }
}

fn node_label(node: &ShellNode) -> String {
    match (node.status.as_str(), node.latency_ms) {
        ("offline", _) => format!("{} · 不可用", node.name),
        (_, Some(latency)) => format!("{} · {latency}ms", node.name),
        _ => node.name.clone(),
    }
}

fn primary_action(state: &ShellState) -> (String, bool) {
    match state.status.as_str() {
        "connected" | "error" => ("断开连接".into(), true),
        "connecting" | "starting" => ("连接中…".into(), false),
        "disconnecting" => ("断开中…".into(), false),
        _ => match state.node_name.as_deref() {
            Some(node) => (format!("连接到 {node}"), true),
            None => ("连接".into(), true),
        },
    }
}

pub(crate) fn build_menu(app: &AppHandle, state: &ShellState) -> Result<Menu<Wry>, String> {
    let error = |error: tauri::Error| error.to_string();
    let dot = if is_connected(state) { "●" } else { "○" };
    let mut menu = MenuBuilder::new(app).item(
        &MenuItemBuilder::with_id("shell.status", format!("{dot} {}", status_text(state)))
            .enabled(false)
            .build(app)
            .map_err(error)?,
    );
    if let Some(traffic) = state.traffic_line.as_deref().filter(|_| state.signed_in) {
        menu = menu.item(
            &MenuItemBuilder::with_id("shell.traffic", traffic)
                .enabled(false)
                .build(app)
                .map_err(error)?,
        );
    }
    menu = menu.separator();

    if !state.signed_in {
        menu = menu.item(&MenuItemBuilder::with_id("shell.show", "登录 ChordV").build(app).map_err(error)?);
    } else {
        let (label, enabled) = primary_action(state);
        menu = menu.item(
            &MenuItemBuilder::with_id("shell.toggle", label)
                .enabled(enabled)
                .build(app)
                .map_err(error)?,
        );

        // Switching while connected reconnects in the main window, so both lists are
        // frozen only during a connect/disconnect that is already in flight.
        let locked = is_transitioning(state);
        if let Some(current) = state.mode.as_deref().filter(|_| !state.modes.is_empty()) {
            let mut modes = SubmenuBuilder::with_id(app, "shell.modes", format!("代理模式 · {}", mode_label(current)));
            for mode in &state.modes {
                modes = modes.item(
                    &CheckMenuItemBuilder::with_id(format!("{MODE_ID_PREFIX}{mode}"), mode_label(mode))
                        .checked(mode == current)
                        .enabled(!locked)
                        .build(app)
                        .map_err(error)?,
                );
            }
            menu = menu.item(&modes.build().map_err(error)?);
        }
        if !state.nodes.is_empty() {
            let mut nodes = SubmenuBuilder::with_id(app, "shell.nodes", "切换节点");
            for node in &state.nodes {
                nodes = nodes.item(
                    &CheckMenuItemBuilder::with_id(format!("{NODE_ID_PREFIX}{}", node.id), node_label(node))
                        .checked(state.selected_node_id.as_deref() == Some(node.id.as_str()))
                        .enabled(!locked)
                        .build(app)
                        .map_err(error)?,
                );
            }
            menu = menu.item(&nodes.build().map_err(error)?);
        }
        if is_connected(state) {
            menu = menu.item(&MenuItemBuilder::with_id(COPY_PROXY_ID, "复制终端代理命令").build(app).map_err(error)?);
        }
        menu = menu
            .separator()
            .item(&MenuItemBuilder::with_id("shell.show", "打开 ChordV").build(app).map_err(error)?);
    }

    // Quitting stops the local core, so say so while traffic is flowing through it.
    let quit = if is_connected(state) { "退出 ChordV（将断开连接）" } else { "退出 ChordV" };
    if !state.signed_in {
        menu = menu.separator();
    }
    menu.item(&MenuItemBuilder::with_id("shell.quit", quit).build(app).map_err(error)?)
        .build()
        .map_err(error)
}

/// The app icon while connected, a faded grey copy otherwise.
pub(crate) fn tray_icon(app: &AppHandle, connected: bool) -> Option<Image<'static>> {
    let base = app.default_window_icon()?.clone().to_owned();
    if connected {
        return Some(base);
    }
    static DIMMED: OnceLock<Image<'static>> = OnceLock::new();
    Some(
        DIMMED
            .get_or_init(|| {
                let rgba = base
                    .rgba()
                    .chunks_exact(4)
                    .flat_map(|pixel| {
                        let luma = (0.3 * pixel[0] as f32 + 0.59 * pixel[1] as f32 + 0.11 * pixel[2] as f32) as u8;
                        [luma, luma, luma, (pixel[3] as f32 * 0.55) as u8]
                    })
                    .collect();
                Image::new_owned(rgba, base.width(), base.height())
            })
            .clone(),
    )
}

pub(crate) fn is_connected_state(state: &ShellState) -> bool {
    is_connected(state)
}

fn proxy_command(http_port: u16, socks_port: Option<u16>) -> String {
    let http = format!("http://127.0.0.1:{http_port}");
    let socks = socks_port.map(|port| format!("socks5://127.0.0.1:{port}"));
    if cfg!(windows) {
        let mut command = format!("$env:HTTP_PROXY=\"{http}\"; $env:HTTPS_PROXY=\"{http}\"");
        if let Some(socks) = socks {
            command.push_str(&format!("; $env:ALL_PROXY=\"{socks}\""));
        }
        command
    } else {
        let mut command = format!("export http_proxy={http} https_proxy={http}");
        if let Some(socks) = socks {
            command.push_str(&format!(" all_proxy={socks}"));
        }
        command
    }
}

/// The tray copies natively: the hidden WebView has no focus, so the web
/// clipboard API is not reliable there. The command is ASCII, which both
/// `pbcopy` and `clip.exe` accept without encoding concerns.
pub(crate) fn copy_proxy_command(http_port: Option<u16>, socks_port: Option<u16>) -> Result<(), String> {
    let http_port = http_port.ok_or_else(|| "当前没有可用的本地代理端口".to_string())?;
    let text = proxy_command(http_port, socks_port);
    #[cfg(target_os = "macos")]
    let mut command = Command::new("pbcopy");
    #[cfg(windows)]
    let mut command = {
        use std::os::windows::process::CommandExt;
        let mut command = Command::new("clip");
        command.creation_flags(super::CREATE_NO_WINDOW);
        command
    };
    #[cfg(not(any(target_os = "macos", windows)))]
    let mut command = Command::new("xclip");
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("无法访问剪贴板：{error}"))?;
    child
        .stdin
        .take()
        .ok_or_else(|| "无法访问剪贴板".to_string())?
        .write_all(text.as_bytes())
        .map_err(|error| format!("写入剪贴板失败：{error}"))?;
    let status = child.wait().map_err(|error| format!("写入剪贴板失败：{error}"))?;
    if status.success() { Ok(()) } else { Err("写入剪贴板失败".into()) }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state(status: &str) -> ShellState {
        ShellState {
            status: status.into(),
            signed_in: true,
            node_name: Some("香港 01".into()),
            primary_action_label: String::new(),
            mode: Some("rule".into()),
            modes: vec!["rule".into(), "global".into()],
            nodes: Vec::new(),
            selected_node_id: None,
            traffic_line: None,
        }
    }

    #[test]
    fn status_mentions_node_only_while_connected() {
        assert_eq!(status_text(&state("connected")), "已连接 · 香港 01");
        assert_eq!(status_text(&state("idle")), "未连接");
        assert_eq!(status_text(&ShellState { signed_in: false, ..state("idle") }), "未登录");
    }

    #[test]
    fn primary_action_names_the_target_node() {
        assert_eq!(primary_action(&state("idle")), ("连接到 香港 01".into(), true));
        assert_eq!(primary_action(&state("connected")), ("断开连接".into(), true));
        assert_eq!(primary_action(&state("connecting")).1, false);
    }

    #[test]
    fn node_label_prefers_availability_over_latency() {
        let node = |status: &str, latency_ms| ShellNode { id: "n".into(), name: "日本 01".into(), latency_ms, status: status.into() };
        assert_eq!(node_label(&node("offline", Some(80))), "日本 01 · 不可用");
        assert_eq!(node_label(&node("healthy", Some(80))), "日本 01 · 80ms");
        assert_eq!(node_label(&node("unknown", None)), "日本 01");
    }

    #[test]
    fn proxy_command_targets_loopback_ports() {
        let command = proxy_command(17890, Some(17891));
        assert!(command.contains("http://127.0.0.1:17890"));
        assert!(command.contains("socks5://127.0.0.1:17891"));
    }
}
