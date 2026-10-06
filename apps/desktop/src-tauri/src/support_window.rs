//! 新工单系统（Achord Connect）独立窗口。
//!
//! - 工单窗口顶层加载后台签发的一次性 launchUrl；只允许留在工单站点（supportOrigin，必须是 https）内导航，
//!   其他 http/https 链接和所有新窗口请求（target=_blank、window.open）一律转到系统浏览器，其余协议直接拦截。
//! - 工单窗口不获得 ChordV 的任何原生命令：应用命令由 permissions/main-window.toml 授权、只给主窗口；
//!   工单窗口只在运行时拿到一条窄权限（support-bridge），而且只对当前工单站点生效。
//! - 可选的原生桥接：初始化脚本在工单站点页面上定义 window.AchordConnectNative.postMessage，
//!   消息在原生层按固定格式校验后才处理（未读数、会话过期、请求关闭）。
//! - launchUrl 的片段里带着一次性票据，任何日志和错误信息都不能包含它。
use serde::Serialize;
use serde_json::Value;
use std::time::{Duration, Instant};
use url::Url;

/// 工单窗口的标签前缀；每次打开都用新标签，避免与正在关闭的旧窗口冲突。
pub const SUPPORT_WINDOW_LABEL_PREFIX: &str = "support-";
/// 只授予工单窗口的桥接权限（permissions/support-bridge.toml）。
pub const SUPPORT_BRIDGE_PERMISSION: &str = "support-bridge";
/// 桥接收到的未读数只发给主窗口。
pub const SUPPORT_UNREAD_EVENT: &str = "chordv://support-unread";
/// 工单窗口不再能提供未读数时通知主窗口（窗口关闭 / 被重开取代，或门户报告会话过期）：
/// 未读数改回以后台推送 / 状态接口为准。
pub const SUPPORT_BRIDGE_ENDED_EVENT: &str = "chordv://support-bridge-ended";
pub const SUPPORT_BRIDGE_SOURCE: &str = "achord-connect-v1";
/// 一次性票据的有效期：窗口打开后这么久门户仍没确认就绪，就允许重新签发票据。
pub const SUPPORT_LAUNCH_GRACE: Duration = Duration::from_secs(60);
pub const MAX_SUPPORT_BRIDGE_MESSAGE_BYTES: usize = 4096;
pub const MAX_SUPPORT_UNREAD_COUNT: u64 = 99_999;
pub const SUPPORT_WINDOW_TITLE: &str = "ChordV 工单";
/// 点击“工单”后立刻弹出的本地占位页（public/support-loading.html），拿到票据后同一个窗口再跳转到工单站点。
pub const SUPPORT_LOADING_PAGE: &str = "support-loading.html";
/// 用户在占位窗口等待期间把它关掉了：打开请求据此静默结束，不会让窗口自己再弹出来。
pub const SUPPORT_WINDOW_CLOSED_ERROR: &str = "support_window_closed";
pub const SUPPORT_WINDOW_SIZE: (f64, f64) = (900.0, 680.0);
pub const SUPPORT_WINDOW_MIN_SIZE: (f64, f64) = (720.0, 560.0);
/// 标题栏等窗口装饰预留的高度（逻辑像素），以及离屏幕边缘的留白。
pub const SUPPORT_WINDOW_DECORATION_HEIGHT: f64 = 40.0;
pub const SUPPORT_WINDOW_SCREEN_MARGIN: f64 = 16.0;

/// 校验后台下发的工单站点来源：必须是不带路径、参数、账号信息的 https 来源。
pub fn parse_support_origin(input: &str) -> Result<Url, String> {
    let parsed = Url::parse(input.trim()).map_err(|_| "工单地址无效".to_string())?;
    if parsed.scheme() != "https" {
        return Err("工单地址必须使用 https".into());
    }
    if parsed.host_str().map_or(true, str::is_empty)
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || !matches!(parsed.path(), "" | "/")
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err("工单地址无效".into());
    }
    Ok(parsed)
}

/// 规范化后的来源字符串，例如 `https://support.achord.cn`（默认端口省略）。
pub fn support_origin_string(origin: &Url) -> String {
    origin.origin().ascii_serialization()
}

/// launchUrl 必须与工单站点同源，且只能是 https。
pub fn validate_support_launch_url(launch_url: &str, origin: &Url) -> Result<Url, String> {
    let parsed = Url::parse(launch_url.trim()).map_err(|_| "工单打开地址无效".to_string())?;
    if parsed.scheme() != "https"
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.origin() != origin.origin()
    {
        return Err("工单打开地址与工单站点不一致".into());
    }
    Ok(parsed)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SupportNavigation {
    /// 留在工单窗口内。
    Allow,
    /// 取消本次导航，改用系统浏览器打开。
    OpenExternal(Url),
    /// 直接拦截（file:、javascript:、data:、自定义协议等）。
    Block,
}

/// 工单窗口的导航策略。
pub fn classify_support_navigation(url: &Url, origin: &Url) -> SupportNavigation {
    match url.scheme() {
        "https" if url.origin() == origin.origin() && url.username().is_empty() && url.password().is_none() => {
            SupportNavigation::Allow
        }
        // 空白内嵌页不含任何外部内容（macOS 会对子框架也询问导航策略）。
        "about" if matches!(url.path(), "blank" | "srcdoc") => SupportNavigation::Allow,
        "http" | "https" => SupportNavigation::OpenExternal(url.clone()),
        _ => SupportNavigation::Block,
    }
}

/// 占位页是应用自带的静态页面：允许它在工单窗口里加载（其余本地页面仍然一律拦截）。
/// 打包后是 tauri://localhost 或 http(s)://tauri.localhost，开发时是本机开发服务器。
pub fn is_support_loading_page(url: &Url) -> bool {
    let page = format!("/{SUPPORT_LOADING_PAGE}");
    if url.path() != page || !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    match url.scheme() {
        "tauri" => url.host_str() == Some("localhost"),
        "http" | "https" => matches!(url.host_str(), Some("tauri.localhost") | Some("localhost") | Some("127.0.0.1")),
        _ => false,
    }
}

/// 新窗口请求（target=_blank、window.open）：http/https 交给系统浏览器，其余拦截。
pub fn classify_support_new_window(url: &Url) -> Option<Url> {
    matches!(url.scheme(), "http" | "https").then(|| url.clone())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SupportBridgeMessage {
    Ready,
    UnreadChanged(u64),
    SessionExpired,
    CloseRequested,
}

/// 校验工单页面通过 AchordConnectNative.postMessage 发来的 JSON 字符串。
pub fn parse_support_bridge_message(raw: &str) -> Result<SupportBridgeMessage, String> {
    if raw.len() > MAX_SUPPORT_BRIDGE_MESSAGE_BYTES {
        return Err("工单消息过长".into());
    }
    let value: Value = serde_json::from_str(raw).map_err(|_| "工单消息格式无效".to_string())?;
    let object = value.as_object().ok_or_else(|| "工单消息格式无效".to_string())?;
    if object.get("source").and_then(Value::as_str) != Some(SUPPORT_BRIDGE_SOURCE) {
        return Err("工单消息来源无效".into());
    }
    match object.get("type").and_then(Value::as_str) {
        Some("ready") => Ok(SupportBridgeMessage::Ready),
        Some("session-expired") => Ok(SupportBridgeMessage::SessionExpired),
        Some("close-requested") => Ok(SupportBridgeMessage::CloseRequested),
        Some("unread-changed") => object
            .get("unreadCount")
            .and_then(Value::as_u64)
            .filter(|count| *count <= MAX_SUPPORT_UNREAD_COUNT)
            .map(SupportBridgeMessage::UnreadChanged)
            .ok_or_else(|| "工单未读数无效".to_string()),
        _ => Err("工单消息类型无效".into()),
    }
}

/// 注入工单窗口的初始化脚本：只在工单站点上定义桥接对象，转发给唯一的桥接命令。
pub fn support_bridge_script(origin: &str) -> String {
    let origin_literal = serde_json::to_string(origin).unwrap_or_else(|_| "\"\"".into());
    format!(
        r#"(function () {{
  "use strict";
  var allowedOrigin = {origin_literal};
  if (window.location.origin !== allowedOrigin || window.AchordConnectNative) return;
  var bridge = Object.freeze({{
    postMessage: function (message) {{
      if (typeof message !== "string" || message.length > {max}) return;
      var internals = window.__TAURI_INTERNALS__;
      if (!internals || typeof internals.invoke !== "function") return;
      try {{
        Promise.resolve(internals.invoke("support_bridge_message", {{ message: message }})).catch(function () {{}});
      }} catch (error) {{}}
    }}
  }});
  Object.defineProperty(window, "AchordConnectNative", {{ value: bridge, configurable: false, enumerable: false, writable: false }});
}})();"#,
        max = MAX_SUPPORT_BRIDGE_MESSAGE_BYTES
    )
}

/// 以主窗口为中心摆放工单窗口，并尽量留在主窗口所在屏幕内（逻辑坐标）。
pub fn centered_window_origin(
    parent: (f64, f64, f64, f64),
    child: (f64, f64),
    bounds: Option<(f64, f64, f64, f64)>,
) -> (f64, f64) {
    let (px, py, pw, ph) = parent;
    let mut x = px + (pw - child.0) / 2.0;
    let mut y = py + (ph - child.1) / 2.0;
    if let Some((bx, by, bw, bh)) = bounds {
        x = x.min(bx + bw - child.0).max(bx);
        y = y.min(by + bh - child.1).max(by);
    }
    (x.round(), y.round())
}

/// 逻辑坐标的矩形：(x, y, 宽, 高)。
pub type LogicalRect = (f64, f64, f64, f64);

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SupportWindowLayout {
    pub size: (f64, f64),
    pub min_size: (f64, f64),
    /// None 表示交给系统居中。
    pub position: Option<(f64, f64)>,
}

/// 规划工单窗口的大小与位置：
/// - 重开（会话过期 / 未就绪）时沿用旧窗口的位置和大小，看起来就是原窗口重新进入；
/// - 否则以主窗口为中心；
/// - 大小和最小尺寸都收进屏幕可用区域（扣除窗口装饰和留白），小屏或高缩放下不会有部分内容在屏幕外。
pub fn plan_support_window_layout(
    parent: Option<LogicalRect>,
    previous: Option<LogicalRect>,
    bounds: Option<LogicalRect>,
) -> SupportWindowLayout {
    let desired = previous.map_or(SUPPORT_WINDOW_SIZE, |(_, _, width, height)| (width, height));
    let (size, min_size) = match bounds {
        Some((_, _, width, height)) => {
            let max_width = (width - 2.0 * SUPPORT_WINDOW_SCREEN_MARGIN).max(320.0);
            let max_height = (height - SUPPORT_WINDOW_DECORATION_HEIGHT - 2.0 * SUPPORT_WINDOW_SCREEN_MARGIN).max(240.0);
            let size = (desired.0.min(max_width), desired.1.min(max_height));
            (size, (SUPPORT_WINDOW_MIN_SIZE.0.min(size.0), SUPPORT_WINDOW_MIN_SIZE.1.min(size.1)))
        }
        None => (desired, SUPPORT_WINDOW_MIN_SIZE),
    };
    let outer = (size.0, size.1 + SUPPORT_WINDOW_DECORATION_HEIGHT);
    let position = match (previous, parent) {
        (Some((x, y, _, _)), _) => Some(centered_window_origin((x, y, outer.0, outer.1), outer, bounds)),
        (None, Some(parent)) => Some(centered_window_origin(parent, outer, bounds)),
        (None, None) => None,
    };
    SupportWindowLayout { size, min_size, position }
}

#[derive(Debug, Clone)]
pub struct SupportWindowRecord {
    pub label: String,
    pub origin: String,
    /// 打开这个窗口时的批次号；它发出的未读数都带着这个批次号，前端据此丢弃上一个账号的消息。
    pub epoch: u64,
    pub opened_at: Instant,
    /// 门户通过桥接确认已就绪（ready）。页面“加载完成”不算：同源的 502 错误页也会加载完成。
    pub ready: bool,
    /// 工单页面通过桥接报告会话已过期：下次点击“工单”要重新签发票据。
    pub expired: bool,
    /// 占位窗口：已经弹出，正在等后台签发票据，还没有跳转到工单站点。
    pub loading: bool,
}

impl SupportWindowRecord {
    pub fn new(label: String, origin: String, epoch: u64, opened_at: Instant) -> Self {
        Self { label, origin, epoch, opened_at, ready: false, expired: false, loading: false }
    }

    /// 点击“工单”时能否直接聚焦这个窗口：会话未过期，且门户已确认就绪，或仍在票据有效期内（加载中不重复签发）。
    /// 票据有效期过了门户仍未就绪（刚打开就断网、502 错误页等），就重新签发票据重开窗口。
    pub fn can_focus(&self, now: Instant) -> bool {
        !self.expired && (self.ready || now.saturating_duration_since(self.opened_at) < SUPPORT_LAUNCH_GRACE)
    }

    /// 顶层文档重新加载（刷新、同源整页跳转）：新文档必须重新确认 ready，并重新计算加载宽限期，
    /// 否则刷新后落在 502 等错误页时会一直只聚焦错误页。
    pub fn restart_loading(&mut self, now: Instant) {
        self.ready = false;
        self.opened_at = now;
    }
}

/// 桥接结束事件：带批次号（区分账号）和窗口标签（区分同一账号里先后打开的窗口），
/// 前端只处理当前正在报告未读数的那个窗口发出的事件。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SupportBridgeEndedEvent {
    pub epoch: u64,
    pub window: String,
}

/// 发给主窗口的未读数事件（批次号 + 窗口标签，含义同上）。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SupportUnreadEvent {
    pub unread_count: u64,
    pub epoch: u64,
    pub window: String,
}

#[derive(Debug, Default)]
pub struct SupportWindowState {
    pub current: Option<SupportWindowRecord>,
    pub next_id: u64,
    /// 退出登录 / 换账号时递增：之前开始、还没完成的打开流程一律作废。
    pub epoch: u64,
}

pub const SUPPORT_WINDOW_STALE_ERROR: &str = "账号已变化，工单窗口未打开";

impl SupportWindowState {
    pub fn next_label(&mut self) -> String {
        self.next_id += 1;
        format!("{SUPPORT_WINDOW_LABEL_PREFIX}{}", self.next_id)
    }

    /// 关闭当前工单窗口并作废所有进行中的打开流程，返回需要销毁的窗口记录（新的批次号见 `epoch`）。
    pub fn invalidate(&mut self) -> Option<SupportWindowRecord> {
        self.epoch = self.epoch.wrapping_add(1);
        self.current.take()
    }

    pub fn ensure_epoch(&self, epoch: u64) -> Result<(), String> {
        if epoch == self.epoch {
            Ok(())
        } else {
            Err(SUPPORT_WINDOW_STALE_ERROR.into())
        }
    }

    /// 建窗之前先登记新窗口（取代旧记录）：网页在建窗过程中就开始加载，门户很快发来的 ready / 未读数
    /// 必须能找到这条记录。批次号已作废（期间退出登录 / 换账号）时拒绝。
    pub fn begin_open(&mut self, epoch: u64, record: SupportWindowRecord) -> Result<(), String> {
        self.ensure_epoch(epoch)?;
        self.current = Some(record);
        Ok(())
    }

    /// 建窗之后确认登记仍然有效：期间被退出登录作废或被更新的打开取代时返回 false，调用方必须销毁刚建好的窗口。
    pub fn is_registered(&self, epoch: u64, label: &str) -> bool {
        epoch == self.epoch && self.current.as_ref().is_some_and(|record| record.label == label)
    }

    /// 票据到手：接管同一批次、同一站点的占位窗口，转为正常加载（重新计算加载宽限期），返回它的标签。
    /// 站点不一致（期间后台改了地址）或没有占位窗口时返回 None，调用方按原有流程新建窗口。
    pub fn adopt_loading_window(&mut self, epoch: u64, origin: &str, now: Instant) -> Option<String> {
        let record = self
            .current
            .as_mut()
            .filter(|record| record.loading && record.epoch == epoch && record.origin == origin)?;
        record.loading = false;
        record.ready = false;
        record.expired = false;
        record.opened_at = now;
        Some(record.label.clone())
    }

    /// 取消还没跳转的占位窗口（票据没拿到：失败、未开放、账号变化）。只取消同一批次的占位窗口，已正常打开的不动。
    pub fn cancel_loading_window(&mut self, epoch: u64) -> Option<SupportWindowRecord> {
        if self.current.as_ref().is_some_and(|record| record.loading && record.epoch == epoch) {
            self.current.take()
        } else {
            None
        }
    }

    /// 建窗失败时撤销预先登记的记录（只撤销自己的，不影响之后的打开）。
    pub fn discard(&mut self, label: &str) {
        if self.current.as_ref().is_some_and(|record| record.label == label) {
            self.current = None;
        }
    }
}

/// 聚焦结果带上当前的打开批次，前端打开新窗口时原样带回。
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SupportFocusResult {
    pub focused: bool,
    pub epoch: u64,
}

#[cfg(not(target_os = "android"))]
use std::sync::{Mutex, MutexGuard};
#[cfg(not(target_os = "android"))]
use tauri::{
    ipc::CapabilityBuilder,
    webview::{NewWindowResponse, PageLoadEvent},
    AppHandle, Emitter, Manager, State,
    WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};

#[cfg(not(target_os = "android"))]
fn lock<'a>(state: &'a State<'_, Mutex<SupportWindowState>>) -> Result<MutexGuard<'a, SupportWindowState>, String> {
    state.lock().map_err(|_| "工单窗口状态异常".to_string())
}

#[cfg(not(target_os = "android"))]
fn open_in_system_browser(url: Url) {
    // 导航回调运行在界面线程上，打开系统浏览器放到后台线程，不阻塞工单窗口。
    tauri::async_runtime::spawn_blocking(move || {
        let _ = crate::open_external_url_with_system(url.as_str());
    });
}

#[cfg(not(target_os = "android"))]
fn current_window(app: &AppHandle, state: &SupportWindowState) -> Option<WebviewWindow> {
    state.current.as_ref().and_then(|record| app.get_webview_window(&record.label))
}

#[cfg(not(target_os = "android"))]
fn focus(window: &WebviewWindow) -> Result<(), String> {
    let _ = window.unminimize();
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())
}

#[cfg(not(target_os = "android"))]
fn work_area(monitor: Option<tauri::Monitor>) -> Option<LogicalRect> {
    let monitor = monitor?;
    let scale = monitor.scale_factor();
    let area = monitor.work_area();
    let origin = area.position.to_logical::<f64>(scale);
    let extent = area.size.to_logical::<f64>(scale);
    Some((origin.x, origin.y, extent.width, extent.height))
}

#[cfg(not(target_os = "android"))]
fn window_rect(window: &WebviewWindow, outer: bool) -> Option<LogicalRect> {
    let scale = window.scale_factor().ok()?;
    let position = window.outer_position().ok()?.to_logical::<f64>(scale);
    let size = if outer { window.outer_size().ok()? } else { window.inner_size().ok()? }.to_logical::<f64>(scale);
    Some((position.x, position.y, size.width, size.height))
}

#[cfg(not(target_os = "android"))]
fn plan_layout(app: &AppHandle, previous: Option<&WebviewWindow>) -> SupportWindowLayout {
    if let Some(previous) = previous.filter(|window| !window.is_minimized().unwrap_or(false)) {
        if let Some(rect) = window_rect(previous, false) {
            return plan_support_window_layout(None, Some(rect), work_area(previous.current_monitor().ok().flatten()));
        }
    }
    let main = app
        .get_webview_window("main")
        .filter(|main| main.is_visible().unwrap_or(false) && !main.is_minimized().unwrap_or(false));
    if let Some(main) = main {
        if let Some(rect) = window_rect(&main, true) {
            return plan_support_window_layout(Some(rect), None, work_area(main.current_monitor().ok().flatten()));
        }
    }
    plan_support_window_layout(None, None, work_area(app.primary_monitor().ok().flatten()))
}

#[cfg(not(target_os = "android"))]
/// 已打开且会话未过期时聚焦现有窗口（focused=true）；否则由前端重新签发票据，
/// 并在打开时带回这里给出的 epoch，期间退出登录则打开会被拒绝。
#[tauri::command]
pub async fn focus_support_window(
    app: AppHandle,
    state: State<'_, Mutex<SupportWindowState>>,
) -> Result<SupportFocusResult, String> {
    let guard = lock(&state)?;
    let epoch = guard.epoch;
    let window = guard
        .current
        .as_ref()
        .filter(|record| record.can_focus(Instant::now()))
        .and_then(|_| current_window(&app, &guard));
    let Some(window) = window else { return Ok(SupportFocusResult { focused: false, epoch }) };
    focus(&window)?;
    Ok(SupportFocusResult { focused: true, epoch })
}

#[cfg(not(target_os = "android"))]
/// 建一个工单窗口并登记（会先销毁旧窗口，沿用它的位置和大小）。
/// url 是占位页（loading=true）或带一次性票据的 launchUrl。
#[cfg(not(target_os = "android"))]
fn create_support_window(
    app: &AppHandle,
    state: &State<'_, Mutex<SupportWindowState>>,
    origin_url: &Url,
    epoch: u64,
    url: WebviewUrl,
    loading: bool,
) -> Result<(), String> {
    let origin = support_origin_string(origin_url);

    let (label, previous) = {
        let mut guard = lock(state)?;
        guard.ensure_epoch(epoch)?;
        let previous = current_window(app, &guard);
        let label = guard.next_label();
        let mut record = SupportWindowRecord::new(label.clone(), origin.clone(), epoch, Instant::now());
        record.loading = loading;
        guard.begin_open(epoch, record)?;
        (label, previous)
    };
    let layout = plan_layout(app, previous.as_ref());
    if let Some(previous) = previous {
        let _ = previous.destroy();
    }
    let discard = |error: String| -> String {
        if let Ok(mut guard) = lock(state) {
            guard.discard(&label);
        }
        error
    };

    // 桥接权限只给这一个窗口、只对工单站点生效；不开放本地页面（占位页是本地页面，同样没有任何原生命令）。
    app.add_capability(
        CapabilityBuilder::new(format!("{SUPPORT_BRIDGE_PERMISSION}-{label}"))
            .local(false)
            .window(label.clone())
            .remote(format!("{origin}/*"))
            .permission(SUPPORT_BRIDGE_PERMISSION),
    )
    .map_err(|error| discard(format!("无法准备工单窗口：{error}")))?;

    let navigation_origin = origin_url.clone();
    let mut builder = WebviewWindowBuilder::new(app, &label, url)
        .title(SUPPORT_WINDOW_TITLE)
        .inner_size(layout.size.0, layout.size.1)
        .min_inner_size(layout.min_size.0, layout.min_size.1)
        .resizable(true)
        .initialization_script(support_bridge_script(&origin))
        .on_navigation(move |url| {
            if is_support_loading_page(url) {
                return true;
            }
            match classify_support_navigation(url, &navigation_origin) {
                SupportNavigation::Allow => true,
                SupportNavigation::OpenExternal(external) => {
                    open_in_system_browser(external);
                    false
                }
                SupportNavigation::Block => false,
            }
        })
        .on_page_load({
            let loading_app = app.clone();
            let loading_label = label.clone();
            move |_window, payload| {
                // 只有顶层文档的加载会触发（单页应用内切换不会）。
                if payload.event() != PageLoadEvent::Started {
                    return;
                }
                if let Ok(mut guard) = loading_app.state::<Mutex<SupportWindowState>>().lock() {
                    if let Some(record) = guard.current.as_mut().filter(|record| record.label == loading_label) {
                        record.restart_loading(Instant::now());
                        // 旧文档不会再报告未读数：通知主窗口改回以后台为准，新文档报告后再接管。
                        let ended = SupportBridgeEndedEvent { epoch: record.epoch, window: loading_label.clone() };
                        let _ = loading_app.emit_to("main", SUPPORT_BRIDGE_ENDED_EVENT, ended);
                    }
                }
            }
        })
        .on_new_window(|url, _features| {
            if let Some(external) = classify_support_new_window(&url) {
                open_in_system_browser(external);
            }
            NewWindowResponse::Deny
        });
    builder = match layout.position {
        Some((x, y)) => builder.position(x, y),
        None => builder.center(),
    };
    let window = builder
        .build()
        .map_err(|error| discard(format!("无法打开工单窗口：{error}")))?;

    // 窗口关闭（用户关闭、门户请求关闭、退出登录、被重开取代）后撤销登记，并通知主窗口改回以后台数据为准。
    let closed_app = app.clone();
    let closed_label = label.clone();
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            if let Ok(mut guard) = closed_app.state::<Mutex<SupportWindowState>>().lock() {
                guard.discard(&closed_label);
            }
            let ended = SupportBridgeEndedEvent { epoch, window: closed_label.clone() };
            let _ = closed_app.emit_to("main", SUPPORT_BRIDGE_ENDED_EVENT, ended);
        }
    });

    // 建窗期间退出登录或换账号：不保留这个窗口。
    if !lock(state)?.is_registered(epoch, &label) {
        let _ = window.destroy();
        return Err(SUPPORT_WINDOW_STALE_ERROR.into());
    }
    // 加载失败的恢复：登记时 ready=false，只有门户通过桥接确认 ready 才算打开成功。若打开后断网、
    // 落在同源错误页等导致门户一直未就绪，SupportWindowRecord::can_focus 会在票据有效期
    // （SUPPORT_LAUNCH_GRACE，60 秒）过后返回 false，下次点击“工单”即重新签发票据并在原位置重开窗口。
    focus(&window)
}

/// 点击“工单”后立刻弹出占位窗口（本地“正在打开工单…”页），不等后台签发票据。
/// origin 来自状态接口；站点无效时报错，前端退回到拿到票据后再开窗的流程。
#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn begin_support_window(
    app: AppHandle,
    state: State<'_, Mutex<SupportWindowState>>,
    support_origin: String,
    epoch: u64,
) -> Result<(), String> {
    let origin_url = parse_support_origin(&support_origin)?;
    let origin = support_origin_string(&origin_url);
    {
        let guard = lock(&state)?;
        guard.ensure_epoch(epoch)?;
        // 已经有同一站点的占位窗口：只聚焦，不重复建窗。
        let existing = guard
            .current
            .as_ref()
            .filter(|record| record.loading && record.epoch == epoch && record.origin == origin)
            .and_then(|_| current_window(&app, &guard));
        if let Some(window) = existing {
            return focus(&window);
        }
    }
    create_support_window(&app, &state, &origin_url, epoch, WebviewUrl::App(SUPPORT_LOADING_PAGE.into()), true)
}

/// 票据没拿到（失败、未开放、账号变化）：关掉还停在占位页的窗口。已经跳转到工单站点的窗口不受影响。
#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn cancel_support_loading_window(
    app: AppHandle,
    state: State<'_, Mutex<SupportWindowState>>,
    epoch: u64,
) -> Result<(), String> {
    let record = lock(&state)?.cancel_loading_window(epoch);
    if let Some(window) = record.and_then(|record| app.get_webview_window(&record.label)) {
        let _ = window.destroy();
    }
    Ok(())
}

/// 打开工单窗口：有同站点的占位窗口就让它跳转到一次性 launchUrl，否则（旧流程）新建窗口并顶层加载 launchUrl。
/// prepared=true 表示前端已经预开了占位窗口；它被用户关掉后不再重新弹出。
#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn open_support_window(
    app: AppHandle,
    state: State<'_, Mutex<SupportWindowState>>,
    launch_url: String,
    support_origin: String,
    epoch: u64,
    prepared: Option<bool>,
) -> Result<(), String> {
    let origin_url = parse_support_origin(&support_origin)?;
    let launch = validate_support_launch_url(&launch_url, &origin_url)?;
    let origin = support_origin_string(&origin_url);

    let adopted = {
        let mut guard = lock(&state)?;
        guard.ensure_epoch(epoch)?;
        let adopted = guard.adopt_loading_window(epoch, &origin, Instant::now());
        if adopted.is_none() && prepared.unwrap_or(false) && guard.current.is_none() {
            return Err(SUPPORT_WINDOW_CLOSED_ERROR.into());
        }
        adopted
    };
    if let Some(label) = adopted {
        let Some(window) = app.get_webview_window(&label) else {
            if let Ok(mut guard) = state.lock() {
                guard.discard(&label);
            }
            return Err(SUPPORT_WINDOW_CLOSED_ERROR.into());
        };
        // 错误信息里可能带出带票据的地址，统一换成固定提示。
        if window.navigate(launch).is_err() {
            let _ = window.destroy();
            return Err("无法打开工单窗口".into());
        }
        return focus(&window);
    }
    create_support_window(&app, &state, &origin_url, epoch, WebviewUrl::External(launch), false)
}

#[cfg(not(target_os = "android"))]
/// 退出登录时关闭工单窗口，避免下一个账号看到上一个账号的工单。
#[tauri::command]
pub async fn close_support_window(
    app: AppHandle,
    state: State<'_, Mutex<SupportWindowState>>,
) -> Result<(), String> {
    let window = {
        let mut guard = lock(&state)?;
        let window = current_window(&app, &guard);
        guard.invalidate();
        window
    };
    if let Some(window) = window {
        let _ = window.destroy();
    }
    Ok(())
}

#[cfg(not(target_os = "android"))]
/// 工单窗口唯一可用的原生命令（运行时权限只授予当前工单窗口和工单站点）。
#[tauri::command]
pub fn support_bridge_message(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, Mutex<SupportWindowState>>,
    message: String,
) -> Result<(), String> {
    let parsed = parse_support_bridge_message(&message)?;
    let mut guard = lock(&state)?;
    let Some(record) = guard.current.as_mut().filter(|record| record.label == window.label()) else {
        return Err("工单窗口已关闭".into());
    };
    let from_support_site = window
        .url()
        .map(|url| url.scheme() == "https" && url.origin().ascii_serialization() == record.origin)
        .unwrap_or(false);
    if !from_support_site {
        return Err("工单消息来源无效".into());
    }
    match parsed {
        SupportBridgeMessage::Ready => record.ready = true,
        SupportBridgeMessage::UnreadChanged(unread_count) => {
            let event = SupportUnreadEvent { unread_count, epoch: record.epoch, window: record.label.clone() };
            let _ = app.emit_to("main", SUPPORT_UNREAD_EVENT, event);
        }
        SupportBridgeMessage::SessionExpired => {
            // 过期的门户不会再报告未读数：通知主窗口改回以后台为准。
            record.expired = true;
            let ended = SupportBridgeEndedEvent { epoch: record.epoch, window: record.label.clone() };
            let _ = app.emit_to("main", SUPPORT_BRIDGE_ENDED_EVENT, ended);
        }
        SupportBridgeMessage::CloseRequested => {
            guard.current = None;
            drop(guard);
            let _ = window.close();
        }
    }
    Ok(())
}

#[cfg(target_os = "android")]
/// 安卓端由前端直接用系统浏览器打开工单，这些命令只保证注册表一致。
#[tauri::command]
pub async fn focus_support_window() -> Result<SupportFocusResult, String> {
    Ok(SupportFocusResult { focused: false, epoch: 0 })
}

#[cfg(target_os = "android")]
#[tauri::command]
pub async fn open_support_window(launch_url: String, support_origin: String, epoch: u64, prepared: Option<bool>) -> Result<(), String> {
    let _ = (launch_url, support_origin, epoch, prepared);
    Err("安卓端请在浏览器中打开工单".into())
}

#[cfg(target_os = "android")]
#[tauri::command]
pub async fn begin_support_window(support_origin: String, epoch: u64) -> Result<(), String> {
    let _ = (support_origin, epoch);
    Err("安卓端请在浏览器中打开工单".into())
}

#[cfg(target_os = "android")]
#[tauri::command]
pub async fn cancel_support_loading_window(epoch: u64) -> Result<(), String> {
    let _ = epoch;
    Ok(())
}

#[cfg(target_os = "android")]
#[tauri::command]
pub async fn close_support_window() -> Result<(), String> {
    Ok(())
}

#[cfg(target_os = "android")]
#[tauri::command]
pub fn support_bridge_message(message: String) -> Result<(), String> {
    let _ = message;
    Err("安卓端不支持工单窗口".into())
}

#[cfg(test)]
#[path = "support_window_tests.rs"]
mod tests;
