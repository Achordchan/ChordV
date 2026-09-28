use super::*;
use std::collections::BTreeSet;
use std::str::FromStr;
use std::time::{Duration, Instant};
use tauri::utils::acl::RemoteUrlPattern;

fn origin() -> Url {
    parse_support_origin("https://support.achord.cn").expect("valid origin")
}

fn url(value: &str) -> Url {
    Url::parse(value).expect("valid url")
}

#[test]
fn support_origin_must_be_a_plain_https_origin() {
    assert_eq!(support_origin_string(&origin()), "https://support.achord.cn");
    assert_eq!(
        support_origin_string(&parse_support_origin(" https://support.achord.cn/ ").unwrap()),
        "https://support.achord.cn"
    );
    assert_eq!(
        support_origin_string(&parse_support_origin("https://support.example.com:8443").unwrap()),
        "https://support.example.com:8443"
    );
    for rejected in [
        "http://support.achord.cn",
        "http://localhost:3000",
        "file:///etc/passwd",
        "javascript:alert(1)",
        "data:text/html,hi",
        "chordv://support",
        "https://user:pass@support.achord.cn",
        "https://support.achord.cn/embed",
        "https://support.achord.cn/?next=1",
        "https://support.achord.cn/#ticket=act_1",
        "",
        "support.achord.cn",
    ] {
        assert!(parse_support_origin(rejected).is_err(), "{rejected} must be rejected");
    }
}

#[test]
fn launch_url_must_share_the_support_origin() {
    let launch = validate_support_launch_url(
        "https://support.achord.cn/embed/connect/pub_1#ticket=act_1&mode=native",
        &origin(),
    )
    .expect("same-origin launch url");
    assert_eq!(launch.fragment(), Some("ticket=act_1&mode=native"));
    for rejected in [
        "http://support.achord.cn/embed/connect/pub_1#ticket=act_1",
        "https://evil.example.com/embed/connect/pub_1#ticket=act_1",
        "https://support.achord.cn.evil.example.com/embed#ticket=act_1",
        "https://support.achord.cn:8443/embed#ticket=act_1",
        "https://user@support.achord.cn/embed#ticket=act_1",
        "javascript:alert(1)",
        "not a url",
    ] {
        let error = validate_support_launch_url(rejected, &origin()).expect_err(rejected);
        assert!(!error.contains("act_1"), "errors never echo the ticket");
    }
}

#[test]
fn navigation_stays_inside_the_support_origin() {
    let origin = origin();
    for allowed in [
        "https://support.achord.cn/embed/connect/pub_1#ticket=act_1&mode=native",
        "https://support.achord.cn/requests/42?tab=messages",
        "https://support.achord.cn:443/",
        "about:blank",
        "about:srcdoc",
    ] {
        assert_eq!(classify_support_navigation(&url(allowed), &origin), SupportNavigation::Allow, "{allowed}");
    }
    for external in [
        "https://www.example.com/help",
        "https://achord.cn/",
        "https://evil.support.achord.cn/",
        "http://support.achord.cn/requests/42",
        "https://support.achord.cn:8443/",
        "https://user:pass@support.achord.cn/",
    ] {
        assert_eq!(
            classify_support_navigation(&url(external), &origin),
            SupportNavigation::OpenExternal(url(external)),
            "{external}"
        );
    }
    for blocked in [
        "file:///etc/passwd",
        "javascript:alert(document.cookie)",
        "data:text/html,<script>alert(1)</script>",
        "blob:https://support.achord.cn/7d5c0a5e",
        "chordv://open",
        "tauri://localhost/index.html",
        "mailto:support@achord.cn",
        "about:config",
    ] {
        assert_eq!(classify_support_navigation(&url(blocked), &origin), SupportNavigation::Block, "{blocked}");
    }
}

#[test]
fn new_window_requests_only_open_http_links_in_the_system_browser() {
    assert_eq!(
        classify_support_new_window(&url("https://support.achord.cn/attachments/1")),
        Some(url("https://support.achord.cn/attachments/1"))
    );
    assert_eq!(
        classify_support_new_window(&url("http://example.com/")),
        Some(url("http://example.com/"))
    );
    for blocked in ["file:///tmp/a", "javascript:void(0)", "data:text/plain,a", "chordv://x", "about:blank"] {
        assert_eq!(classify_support_new_window(&url(blocked)), None, "{blocked}");
    }
}

#[test]
fn bridge_accepts_only_known_messages() {
    assert_eq!(
        parse_support_bridge_message(r#"{"source":"achord-connect-v1","type":"ready"}"#),
        Ok(SupportBridgeMessage::Ready)
    );
    assert_eq!(
        parse_support_bridge_message(r#"{"source":"achord-connect-v1","type":"unread-changed","unreadCount":3}"#),
        Ok(SupportBridgeMessage::UnreadChanged(3))
    );
    assert_eq!(
        parse_support_bridge_message(r#"{"source":"achord-connect-v1","type":"unread-changed","unreadCount":0,"extra":"ignored"}"#),
        Ok(SupportBridgeMessage::UnreadChanged(0))
    );
    assert_eq!(
        parse_support_bridge_message(r#"{"source":"achord-connect-v1","type":"session-expired"}"#),
        Ok(SupportBridgeMessage::SessionExpired)
    );
    assert_eq!(
        parse_support_bridge_message(r#"{"source":"achord-connect-v1","type":"close-requested"}"#),
        Ok(SupportBridgeMessage::CloseRequested)
    );
    // ChordV 自己的脚本只能报告页面已加载。
    assert_eq!(
        parse_support_bridge_message(r#"{"source":"chordv-host","type":"page-loaded"}"#),
        Ok(SupportBridgeMessage::PageLoaded)
    );
    assert!(parse_support_bridge_message(r#"{"source":"chordv-host","type":"close-requested"}"#).is_err());
    assert!(parse_support_bridge_message(r#"{"source":"achord-connect-v1","type":"page-loaded"}"#).is_err());
    let too_long = format!(
        r#"{{"source":"achord-connect-v1","type":"ready","padding":"{}"}}"#,
        "x".repeat(MAX_SUPPORT_BRIDGE_MESSAGE_BYTES)
    );
    for rejected in [
        "",
        "null",
        "[]",
        "\"ready\"",
        r#"{"type":"ready"}"#,
        r#"{"source":"other","type":"ready"}"#,
        r#"{"source":"achord-connect-v1"}"#,
        r#"{"source":"achord-connect-v1","type":"navigate","url":"file:///etc/passwd"}"#,
        r#"{"source":"achord-connect-v1","type":"unread-changed"}"#,
        r#"{"source":"achord-connect-v1","type":"unread-changed","unreadCount":-1}"#,
        r#"{"source":"achord-connect-v1","type":"unread-changed","unreadCount":1.5}"#,
        r#"{"source":"achord-connect-v1","type":"unread-changed","unreadCount":"3"}"#,
        r#"{"source":"achord-connect-v1","type":"unread-changed","unreadCount":100000}"#,
        too_long.as_str(),
    ] {
        assert!(parse_support_bridge_message(rejected).is_err(), "{rejected}");
    }
}

#[test]
fn bridge_script_is_bound_to_the_support_origin() {
    let script = support_bridge_script("https://support.achord.cn");
    assert!(script.contains(r#"var allowedOrigin = "https://support.achord.cn";"#));
    assert!(script.contains("window.location.origin !== allowedOrigin"));
    assert!(script.contains(r#"internals.invoke("support_bridge_message", { message: message })"#));
    assert!(script.contains("configurable: false"));
    assert!(script.contains(r#"JSON.stringify({ source: "chordv-host", type: "page-loaded" })"#));
    assert!(script.contains(r#"document.addEventListener("DOMContentLoaded", reportLoaded, { once: true })"#));
    // 来源作为 JSON 字符串嵌入，不能拼出脚本。
    let hostile = support_bridge_script("https://a\";alert(1);//");
    assert!(hostile.contains(r#"var allowedOrigin = "https://a\";alert(1);//";"#));
}

#[test]
fn bridge_capability_pattern_only_matches_the_support_origin() {
    let pattern = RemoteUrlPattern::from_str(&format!("{}/*", support_origin_string(&origin()))).unwrap();
    assert!(pattern.test(&url("https://support.achord.cn/embed/connect/pub_1#ticket=act_1&mode=native")));
    assert!(pattern.test(&url("https://support.achord.cn/")));
    assert!(pattern.test(&url("https://support.achord.cn/requests/1?tab=a")));
    assert!(!pattern.test(&url("https://evil.example.com/support.achord.cn/")));
    assert!(!pattern.test(&url("https://support.achord.cn.evil.example.com/")));
    assert!(!pattern.test(&url("http://support.achord.cn/")));
}

#[test]
fn support_window_is_centered_over_the_main_window_and_kept_on_screen() {
    // 主窗口 820×560 位于 (100, 100)：工单窗口 900×680 以它为中心。
    assert_eq!(centered_window_origin((100.0, 100.0, 820.0, 560.0), (900.0, 680.0), None), (60.0, 40.0));
    // 靠近屏幕左上角时不越界。
    assert_eq!(
        centered_window_origin((0.0, 25.0, 820.0, 560.0), (900.0, 680.0), Some((0.0, 25.0, 1440.0, 875.0))),
        (0.0, 25.0)
    );
    // 靠近右下角时整体收回屏幕内。
    assert_eq!(
        centered_window_origin((900.0, 500.0, 820.0, 560.0), (900.0, 680.0), Some((0.0, 0.0, 1440.0, 900.0))),
        (540.0, 220.0)
    );
}

#[test]
fn every_window_gets_a_fresh_support_label() {
    let mut state = SupportWindowState::default();
    assert_eq!(state.next_label(), "support-1");
    assert_eq!(state.next_label(), "support-2");
}

#[test]
fn logout_invalidates_pending_launches() {
    let mut state = SupportWindowState::default();
    let record = |label: &str| SupportWindowRecord::new(label.into(), "https://support.achord.cn".into(), 0, Instant::now());
    // 正常流程：拿到批次号 → 签发票据 → 用同一批次号打开。
    let epoch = state.epoch;
    assert!(state.ensure_epoch(epoch).is_ok());
    assert!(state.finish_open(epoch, record("support-1")));
    assert_eq!(state.current.as_ref().map(|r| r.label.as_str()), Some("support-1"));

    // 票据还在路上时退出登录：旧批次号既不能开始打开，也不能在建窗后登记。
    let pending = state.epoch;
    assert_eq!(state.invalidate().map(|r| r.label), Some("support-1".to_string()));
    assert!(state.current.is_none());
    assert_eq!(state.ensure_epoch(pending), Err(SUPPORT_WINDOW_STALE_ERROR.to_string()));
    assert!(!state.finish_open(pending, record("support-2")), "a window built for the old account is discarded");
    assert!(state.current.is_none());

    // 新账号拿到的新批次号照常可用。
    let fresh = state.epoch;
    assert_ne!(fresh, pending);
    assert!(state.finish_open(fresh, record("support-3")));
}

#[test]
fn a_launch_that_never_loads_can_be_relaunched_after_the_ticket_expires() {
    let opened = Instant::now();
    let mut record = SupportWindowRecord::new("support-1".into(), "https://support.achord.cn".into(), 0, opened);
    // 票据有效期内仍在加载：聚焦，不重复签发。
    assert!(record.can_focus(opened + Duration::from_secs(5)));
    // 有效期过了还没在工单站点上加载成功（例如刚打开就断网）：重新签发票据重开窗口。
    assert!(!record.can_focus(opened + SUPPORT_LAUNCH_GRACE));
    // 加载成功后一直可以聚焦。
    record.loaded = true;
    assert!(record.can_focus(opened + Duration::from_secs(3600)));
    // 会话过期后必须重开。
    record.expired = true;
    assert!(!record.can_focus(opened + Duration::from_secs(1)));
}

#[test]
fn unread_events_carry_their_window_epoch() {
    let json = serde_json::to_value(SupportUnreadEvent { unread_count: 4, epoch: 2 }).unwrap();
    assert_eq!(json, serde_json::json!({ "unreadCount": 4, "epoch": 2 }));
}

#[test]
fn focus_result_is_serialized_for_the_frontend() {
    let json = serde_json::to_value(SupportFocusResult { focused: false, epoch: 3 }).unwrap();
    assert_eq!(json, serde_json::json!({ "focused": false, "epoch": 3 }));
}

fn normalized(source: &str) -> String {
    source.replace("\r\n", "\n")
}

fn quoted_strings(block: &str) -> BTreeSet<String> {
    block
        .split('"')
        .enumerate()
        .filter(|(index, _)| index % 2 == 1)
        .map(|(_, value)| value.to_string())
        .collect()
}

fn allowed_commands(toml: &str) -> BTreeSet<String> {
    let toml = normalized(toml);
    let start = toml.find("commands.allow = [").expect("commands.allow") + "commands.allow = [".len();
    let end = start + toml[start..].find(']').expect("closing bracket");
    quoted_strings(&toml[start..end])
}

fn registered_commands() -> BTreeSet<String> {
    let lib = normalized(include_str!("lib.rs"));
    let start = lib.find("generate_handler![").expect("generate_handler") + "generate_handler![".len();
    let end = start + lib[start..].find("])").expect("handler end");
    lib[start..end]
        .split(',')
        .map(|entry| entry.trim().rsplit("::").next().unwrap_or_default().to_string())
        .filter(|name| !name.is_empty())
        .collect()
}

#[test]
fn android_opens_external_links_natively() {
    let lib = normalized(include_str!("lib.rs"));
    assert!(lib.contains("#[cfg(target_os = \"android\")]\nfn open_external_url_with_system(url: &str) -> Result<(), String> {\n    android_open_url::open(url)\n}"));
    let opener = normalized(include_str!("android_open_url.rs"));
    assert!(opener.contains("\"android.intent.action.VIEW\""));
    assert!(opener.contains("FLAG_ACTIVITY_NEW_TASK"));
    assert!(opener.contains("exception_clear"));
}

#[test]
fn main_window_is_the_only_window_granted_app_commands() {
    let main = allowed_commands(include_str!("../permissions/main-window.toml"));
    let bridge = allowed_commands(include_str!("../permissions/support-bridge.toml"));
    let registered = registered_commands();

    assert_eq!(bridge, BTreeSet::from(["support_bridge_message".to_string()]));
    assert!(!main.contains("support_bridge_message"), "the bridge is never a main-window command");
    let expected: BTreeSet<String> = registered.difference(&bridge).cloned().collect();
    assert_eq!(main, expected, "every registered command must be granted to the main window explicitly");

    let capability: Value = serde_json::from_str(&normalized(include_str!("../capabilities/default.json"))).unwrap();
    let windows: Vec<&str> = capability["windows"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
    assert_eq!(windows, vec!["main"], "the default capability stays scoped to the main window");
    assert!(windows.iter().all(|window| !window.contains('*')));
    let permissions: Vec<&str> = capability["permissions"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
    assert!(permissions.contains(&"main-window-commands"));
    assert!(!permissions.contains(&SUPPORT_BRIDGE_PERMISSION));
    let remote = capability["remote"]["urls"].as_array().unwrap();
    assert!(remote.iter().filter_map(Value::as_str).all(|url| url.starts_with("http://localhost:5173")));
}

#[test]
fn only_the_main_window_hides_instead_of_closing() {
    let lib = normalized(include_str!("lib.rs"));
    assert!(lib.contains("RunEvent::WindowEvent { label, event, .. } if label == \"main\" =>"));
}

/// 用真实的权限清单（generate_context!）验证：工单窗口拿不到任何 ChordV 命令，
/// 只在运行时授予后才能调用桥接命令，而且只对工单站点生效。
mod acl {
    use super::super::{support_origin_string, SUPPORT_BRIDGE_PERMISSION};
    use super::origin;
    use tauri::ipc::{CallbackFn, CapabilityBuilder, InvokeBody};
    use tauri::test::{get_ipc_response, mock_builder, MockRuntime, INVOKE_KEY};
    use tauri::webview::InvokeRequest;
    use tauri::{Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

    // 命令名与正式命令一致即可：权限按命令名检查，这里不执行真实逻辑。
    #[tauri::command]
    fn api_request() -> &'static str {
        "api"
    }

    #[tauri::command]
    fn close_support_window() -> &'static str {
        "close"
    }

    #[tauri::command]
    fn support_bridge_message() -> &'static str {
        "bridge"
    }

    fn invoke(window: &WebviewWindow<MockRuntime>, cmd: &str, url: &str) -> Result<String, String> {
        get_ipc_response(
            window,
            InvokeRequest {
                cmd: cmd.into(),
                callback: CallbackFn(0),
                error: CallbackFn(1),
                url: url.parse().unwrap(),
                body: InvokeBody::default(),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.to_string(),
            },
        )
        .map(|body| body.deserialize::<String>().unwrap())
        .map_err(|error| error.to_string())
    }

    #[test]
    fn support_window_only_reaches_the_bridge_on_the_support_origin() {
        let app = mock_builder()
            .invoke_handler(tauri::generate_handler![self::api_request, self::close_support_window, self::support_bridge_message])
            .build(tauri::generate_context!(test = true))
            .expect("mock app");
        let main = WebviewWindowBuilder::new(&app, "main", WebviewUrl::default()).build().unwrap();
        let support = WebviewWindowBuilder::new(
            &app,
            "support-1",
            WebviewUrl::External("https://support.achord.cn/embed/connect/pub_1".parse().unwrap()),
        )
        .build()
        .unwrap();
        let local = main.url().unwrap().to_string();
        let portal = "https://support.achord.cn/requests/1";

        // 主窗口照常调用 ChordV 命令，但不能调用桥接命令。
        assert_eq!(invoke(&main, "api_request", &local), Ok("api".into()));
        assert_eq!(invoke(&main, "close_support_window", &local), Ok("close".into()));
        assert!(invoke(&main, "support_bridge_message", &local).is_err());

        // 工单窗口在授予前什么都调用不了。
        for cmd in ["api_request", "close_support_window", "support_bridge_message", "plugin:event|listen"] {
            assert!(invoke(&support, cmd, portal).is_err(), "{cmd} must be denied before the grant");
        }

        app.add_capability(
            CapabilityBuilder::new(format!("{SUPPORT_BRIDGE_PERMISSION}-support-1"))
                .local(false)
                .window("support-1")
                .remote(format!("{}/*", support_origin_string(&origin())))
                .permission(SUPPORT_BRIDGE_PERMISSION),
        )
        .unwrap();

        assert_eq!(invoke(&support, "support_bridge_message", portal), Ok("bridge".into()));
        assert!(invoke(&support, "support_bridge_message", "https://evil.example.com/").is_err());
        assert!(invoke(&support, "support_bridge_message", "http://support.achord.cn/").is_err());
        assert!(invoke(&support, "api_request", portal).is_err(), "the grant is limited to the bridge");
        assert!(invoke(&support, "close_support_window", portal).is_err());
        // 授权只绑定到该窗口：主窗口加载同一站点也拿不到桥接。
        assert!(invoke(&main, "support_bridge_message", portal).is_err());
    }
}
