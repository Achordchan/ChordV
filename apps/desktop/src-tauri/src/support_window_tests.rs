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
    assert!(parse_support_bridge_message(r#"{"source":"chordv-host","type":"page-loaded"}"#).is_err());
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
fn support_window_fits_the_work_area() {
    let screen = Some((0.0, 25.0, 1440.0, 875.0));
    // 普通屏幕：900×680，以主窗口为中心，最小 720×560。
    let normal = plan_support_window_layout(Some((270.0, 180.0, 820.0, 588.0)), None, screen);
    assert_eq!(normal.size, SUPPORT_WINDOW_SIZE);
    assert_eq!(normal.min_size, SUPPORT_WINDOW_MIN_SIZE);
    assert_eq!(normal.position, Some((230.0, 114.0)));

    // 可用高度不足 680（高缩放的笔记本）：大小和最小尺寸都收进屏幕，整个窗口留在屏幕内。
    let small = Some((0.0, 25.0, 1280.0, 615.0));
    let fitted = plan_support_window_layout(Some((230.0, 40.0, 820.0, 588.0)), None, small);
    assert_eq!(fitted.size, (900.0, 543.0));
    assert_eq!(fitted.min_size, (720.0, 543.0));
    let (x, y) = fitted.position.unwrap();
    assert!(y >= 25.0 && y + fitted.size.1 + SUPPORT_WINDOW_DECORATION_HEIGHT <= 25.0 + 615.0);
    assert!(x >= 0.0 && x + fitted.size.0 <= 1280.0);

    // 很窄的屏幕：宽度也收进来。
    let narrow = plan_support_window_layout(None, None, Some((0.0, 0.0, 700.0, 900.0)));
    assert_eq!(narrow.size, (668.0, 680.0));
    assert_eq!(narrow.min_size, (668.0, 560.0));
    assert_eq!(narrow.position, None, "without a visible main window the system centers it");

    // 重开时沿用旧窗口的位置和大小。
    let reopened = plan_support_window_layout(Some((270.0, 180.0, 820.0, 588.0)), Some((100.0, 60.0, 1000.0, 700.0)), screen);
    assert_eq!(reopened.size, (1000.0, 700.0));
    assert_eq!(reopened.position, Some((100.0, 60.0)));
}

#[test]
fn bridge_authority_ends_on_close_and_session_expiry() {
    let source = normalized(include_str!("support_window.rs"));
    // 会话过期：通知主窗口改回以后台为准。
    let expired = source.find("SupportBridgeMessage::SessionExpired => {").expect("session-expired branch");
    let branch_end = source[expired..].find("SupportBridgeMessage::CloseRequested").expect("next branch");
    assert!(source[expired..expired + branch_end].contains("emit_to(\"main\", SUPPORT_BRIDGE_ENDED_EVENT"));
    // 窗口销毁：同样通知。
    assert!(source.contains("tauri::WindowEvent::Destroyed"));
    // 顶层文档重新加载时重新要求就绪。
    assert!(source.contains("payload.event() != PageLoadEvent::Started"));
    assert!(source.contains("record.restart_loading(Instant::now())"));
    let reload = source.find("record.restart_loading(Instant::now())").unwrap();
    assert!(source[reload..reload + 400].contains("SUPPORT_BRIDGE_ENDED_EVENT"), "a reload ends the old document's authority");
}

#[test]
fn window_closed_event_carries_the_epoch() {
    let json = serde_json::to_value(SupportBridgeEndedEvent { epoch: 5, window: "support-2".into() }).unwrap();
    assert_eq!(json, serde_json::json!({ "epoch": 5, "window": "support-2" }));
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
    // 正常流程：拿到批次号 → 签发票据 → 建窗前先登记（建窗中门户发来的消息能找到记录）→ 建窗后确认。
    let epoch = state.epoch;
    assert!(state.begin_open(epoch, record("support-1")).is_ok());
    assert_eq!(state.current.as_ref().map(|r| r.label.as_str()), Some("support-1"));
    assert!(state.is_registered(epoch, "support-1"));

    // 建窗期间退出登录：登记被作废，建好的窗口必须销毁。
    let building = state.epoch;
    assert!(state.begin_open(building, record("support-2")).is_ok());
    assert_eq!(state.invalidate().map(|r| r.label), Some("support-2".to_string()));
    assert!(!state.is_registered(building, "support-2"), "a window built for the old account is discarded");

    // 票据还在路上时退出登录：旧批次号不能开始打开。
    let pending = building;
    assert_eq!(state.begin_open(pending, record("support-3")), Err(SUPPORT_WINDOW_STALE_ERROR.to_string()));
    assert!(state.current.is_none());

    // 建窗失败：只撤销自己的登记。
    let fresh = state.epoch;
    assert_ne!(fresh, pending);
    assert!(state.begin_open(fresh, record("support-4")).is_ok());
    state.discard("support-3");
    assert!(state.is_registered(fresh, "support-4"));
    state.discard("support-4");
    assert!(state.current.is_none());

    // 较新的打开取代了较早的：较早的那次建窗后不再有效。
    assert!(state.begin_open(fresh, record("support-5")).is_ok());
    assert!(state.begin_open(fresh, record("support-6")).is_ok());
    assert!(!state.is_registered(fresh, "support-5"));
    assert!(state.is_registered(fresh, "support-6"));
}

#[test]
fn a_launch_that_never_becomes_ready_can_be_relaunched_after_the_ticket_expires() {
    let opened = Instant::now();
    let mut record = SupportWindowRecord::new("support-1".into(), "https://support.achord.cn".into(), 0, opened);
    // 票据有效期内仍在加载：聚焦，不重复签发。
    assert!(record.can_focus(opened + Duration::from_secs(5)));
    // 有效期过了门户仍未确认就绪（刚打开就断网、同源 502 错误页等）：重新签发票据重开窗口。
    assert!(!record.can_focus(opened + SUPPORT_LAUNCH_GRACE));
    // 门户确认就绪后一直可以聚焦。
    record.ready = true;
    assert!(record.can_focus(opened + Duration::from_secs(3600)));
    // 就绪后整页刷新：新文档要重新确认就绪；刷新后落在错误页时，宽限期过后可重新签发。
    let reloaded = opened + Duration::from_secs(600);
    record.restart_loading(reloaded);
    assert!(record.can_focus(reloaded + Duration::from_secs(5)));
    assert!(!record.can_focus(reloaded + SUPPORT_LAUNCH_GRACE));
    record.ready = true;
    // 会话过期后必须重开。
    record.expired = true;
    assert!(!record.can_focus(opened + Duration::from_secs(1)));
}

#[test]
fn only_the_bundled_loading_page_may_load_in_the_support_window() {
    for allowed in [
        "tauri://localhost/support-loading.html",
        "http://tauri.localhost/support-loading.html",
        "https://tauri.localhost/support-loading.html",
        "http://localhost:5173/support-loading.html",
    ] {
        assert!(is_support_loading_page(&url(allowed)), "{allowed}");
    }
    for rejected in [
        "tauri://localhost/index.html",
        "tauri://localhost/support-loading.html/../index.html",
        "tauri://other/support-loading.html",
        "https://support.achord.cn/support-loading.html",
        "https://evil.example.com/support-loading.html",
        "http://tauri.localhost/support-loading.html.evil",
        "https://user:pass@tauri.localhost/support-loading.html",
        "file:///support-loading.html",
    ] {
        assert!(!is_support_loading_page(&url(rejected)), "{rejected}");
    }
    // 应用本身的页面仍被导航策略拦截，占位页是单独放行的唯一例外。
    assert_eq!(classify_support_navigation(&url("tauri://localhost/support-loading.html"), &origin()), SupportNavigation::Block);
}

#[test]
fn a_loading_window_is_adopted_by_the_same_epoch_origin_and_label_only() {
    let origin_text = "https://support.achord.cn";
    let opened = Instant::now();
    let mut state = SupportWindowState::default();
    let epoch = state.epoch;
    let mut record = SupportWindowRecord::new("support-1".into(), origin_text.into(), epoch, opened);
    record.loading = true;
    assert!(state.begin_open(epoch, record).is_ok());

    // 站点、批次或标签对不上：不接管。
    assert_eq!(state.adopt_loading_window(epoch, "https://other.example.com", Some("support-1"), opened), None);
    assert_eq!(state.adopt_loading_window(epoch + 1, origin_text, Some("support-1"), opened), None);
    assert_eq!(state.adopt_loading_window(epoch, origin_text, Some("support-9"), opened), None, "another attempt's window");
    assert!(state.current.as_ref().unwrap().loading);

    // 接管：转为正常加载，宽限期从跳转时重新计算，之前的就绪/过期状态清空。
    let later = opened + Duration::from_secs(20);
    {
        let record = state.current.as_mut().unwrap();
        record.ready = true;
        record.expired = true;
    }
    assert_eq!(state.adopt_loading_window(epoch, origin_text, Some("support-1"), later), Some("support-1".to_string()));
    let adopted = state.current.as_ref().unwrap();
    assert!(!adopted.loading && !adopted.ready && !adopted.expired);
    assert!(adopted.can_focus(later + Duration::from_secs(5)));
    assert!(!adopted.can_focus(later + SUPPORT_LAUNCH_GRACE));
    // 已经接管过的窗口不能被第二次接管。
    assert_eq!(state.adopt_loading_window(epoch, origin_text, Some("support-1"), later), None);
}

#[test]
fn cancelling_only_removes_that_attempts_loading_window() {
    let mut state = SupportWindowState::default();
    let epoch = state.epoch;
    let mut loading = SupportWindowRecord::new("support-1".into(), "https://support.achord.cn".into(), epoch, Instant::now());
    loading.loading = true;
    assert!(state.begin_open(epoch, loading).is_ok());
    assert!(state.has_loading_window(epoch, "support-1"));

    assert!(state.cancel_loading_window(epoch + 1, "support-1").is_none(), "another account's batch cannot cancel it");
    assert!(state.cancel_loading_window(epoch, "support-2").is_none(), "another attempt's cleanup cannot cancel it");
    assert_eq!(state.cancel_loading_window(epoch, "support-1").map(|record| record.label), Some("support-1".to_string()));
    assert!(state.current.is_none());

    // 快速重试：上一次的收尾迟到，只认旧标签，不会销毁重试新建的占位窗口。
    let mut retry = SupportWindowRecord::new("support-3".into(), "https://support.achord.cn".into(), epoch, Instant::now());
    retry.loading = true;
    assert!(state.begin_open(epoch, retry).is_ok());
    assert!(state.cancel_loading_window(epoch, "support-1").is_none());
    assert!(state.has_loading_window(epoch, "support-3"));

    // 已经正常打开的窗口（非占位）不会被取消。
    let normal = SupportWindowRecord::new("support-4".into(), "https://support.achord.cn".into(), epoch, Instant::now());
    assert!(state.begin_open(epoch, normal).is_ok());
    assert!(state.cancel_loading_window(epoch, "support-4").is_none());
    assert!(state.current.is_some());
}

#[test]
fn a_leftover_loading_placeholder_is_never_focused_as_an_open_window() {
    let opened = Instant::now();
    let mut record = SupportWindowRecord::new("support-1".into(), "https://support.achord.cn".into(), 0, opened);
    record.loading = true;
    assert!(!record.can_focus(opened + Duration::from_secs(1)), "a new click restarts the attempt instead of focusing an abandoned placeholder");
}

#[test]
fn closed_placeholder_error_matches_the_frontend_constant() {
    let runtime = include_str!("../../src/lib/runtime.ts");
    assert!(
        runtime.contains(&format!("const SUPPORT_WINDOW_CLOSED_ERROR = \"{SUPPORT_WINDOW_CLOSED_ERROR}\";")),
        "runtime.ts must use the same marker the native layer returns when the placeholder was closed"
    );
}

#[test]
fn unread_events_carry_their_window_epoch() {
    let json = serde_json::to_value(SupportUnreadEvent { unread_count: 4, epoch: 2, window: "support-3".into() }).unwrap();
    assert_eq!(json, serde_json::json!({ "unreadCount": 4, "epoch": 2, "window": "support-3" }));
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
