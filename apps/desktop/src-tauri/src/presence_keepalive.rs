//! 客户端在线上报：推送连接保持期间定期调用 `/client/ping`，证明客户端仍在运行。
//!
//! 电脑睡眠或断网时 TCP 往往不会正常关闭，服务端要等连接超时（最坏十几分钟）才发现推送连接已断，
//! 后台会一直显示“在线”。推送连接地址带上 `presence=ping` 声明后，服务端对这条连接超过 150 秒没有上报
//! 就主动断开并记为离线。上报与推送连接同生共死：连接建立后才开始上报，连接停止（退出登录、切换账号、
//! 重连）时随之停止，不会出现“声明了却不上报”的连接。
//!
//! 上报只是尽力而为：失败不提示用户、不重试，只在诊断日志里记状态变化（第一次失败、此后每 60 次、恢复时各一条）；
//! 计时用普通定时器，不会唤醒睡眠中的电脑。

use std::sync::{Arc, Mutex};
use std::time::Duration;

use reqwest::Client;
use tokio::sync::watch;
use tokio::task::JoinHandle;
use tokio::time::Instant;

/// 推送流地址上的声明：这条连接保持期间客户端会定期上报在线。
pub const PRESENCE_PING_QUERY: &str = "presence=ping";
/// 上报间隔。服务端超过 150 秒没有收到上报才断开，允许错过一次。
pub const PRESENCE_PING_INTERVAL: Duration = Duration::from_secs(60);
/// 窗口重新显示、网络恢复时会请求立即补报；距上次上报（或连接建立）不到这么久就不补，避免频繁请求。
pub const PRESENCE_PING_NUDGE_MIN_GAP: Duration = Duration::from_secs(20);
/// 单次上报的超时。
pub const PRESENCE_PING_REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
/// 持续失败时每隔这么多次再记一条诊断日志（按 60 秒一次约每小时一条）。
const FAILURE_LOG_EVERY: u32 = 60;

pub fn event_stream_url(api_base: &str) -> String {
    format!(
        "{}/api/client/events/stream?{PRESENCE_PING_QUERY}",
        api_base.trim_end_matches('/')
    )
}

pub fn ping_url(api_base: &str) -> String {
    format!("{}/api/client/ping", api_base.trim_end_matches('/'))
}

/// 上报结果的诊断日志：只在状态变化时返回要记的一行，持续失败时不刷屏。
#[derive(Debug, Default)]
pub struct PingFailureLog {
    failures: u32,
}

impl PingFailureLog {
    pub fn record(&mut self, result: &Result<(), String>) -> Option<String> {
        match result {
            Ok(()) => {
                if self.failures == 0 {
                    return None;
                }
                let failures = std::mem::take(&mut self.failures);
                Some(format!("presence ping recovered after {failures} failure(s)"))
            }
            Err(error) => {
                self.failures = self.failures.saturating_add(1);
                if self.failures == 1 || self.failures % FAILURE_LOG_EVERY == 0 {
                    Some(format!("presence ping failed ({} in a row): {error}", self.failures))
                } else {
                    None
                }
            }
        }
    }
}

/// 请求立即补报（窗口重新显示、网络恢复）。所有正在上报的推送连接都会收到，由各自按最小间隔决定是否补报。
pub struct PresenceNudges {
    sender: watch::Sender<u64>,
}

impl PresenceNudges {
    pub fn new() -> Self {
        let (sender, _) = watch::channel(0);
        Self { sender }
    }

    pub fn nudge(&self) {
        self.sender.send_modify(|value| *value = value.wrapping_add(1));
    }

    pub fn subscribe(&self) -> watch::Receiver<u64> {
        self.sender.subscribe()
    }
}

#[derive(Clone)]
pub struct PresenceKeepaliveConfig {
    pub ping_url: String,
    pub access_token: String,
    pub interval: Duration,
    pub nudge_min_gap: Duration,
    pub request_timeout: Duration,
}

impl PresenceKeepaliveConfig {
    pub fn new(api_base: &str, access_token: &str) -> Self {
        Self {
            ping_url: ping_url(api_base),
            access_token: access_token.to_string(),
            interval: PRESENCE_PING_INTERVAL,
            nudge_min_gap: PRESENCE_PING_NUDGE_MIN_GAP,
            request_timeout: PRESENCE_PING_REQUEST_TIMEOUT,
        }
    }
}

/// 一条推送连接的在线上报任务。丢弃即停止（包括正在进行的请求）。
pub struct PresenceKeepalive {
    task: JoinHandle<()>,
}

impl Drop for PresenceKeepalive {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// 推送连接建立后调用：此后每 `interval` 上报一次，收到补报请求且距上次足够久时立即上报。
/// 必须在 tokio 运行时内调用。`log` 只用于写诊断日志。
pub fn spawn_presence_keepalive(
    config: PresenceKeepaliveConfig,
    nudges: Option<watch::Receiver<u64>>,
    failure_log: Arc<Mutex<PingFailureLog>>,
    log: Arc<dyn Fn(String) + Send + Sync>,
) -> PresenceKeepalive {
    let task = tokio::spawn(async move {
        let client = match Client::builder()
            .timeout(config.request_timeout)
            .no_proxy()
            .build()
        {
            Ok(client) => client,
            Err(error) => {
                log(format!("presence ping disabled: {error}"));
                return;
            }
        };
        let mut nudges = nudges;
        // 定期上报按固定节奏进行，补报不推迟下一次定期上报：服务端写库有节流，被节流的补报不能让
        // 数据库里的上报时间出现比“每 60 秒一次”更大的空档（上报与推送连接落在不同实例上时靠它判断）。
        let mut last = Instant::now();
        let mut due = last + config.interval;
        loop {
            tokio::select! {
                _ = tokio::time::sleep_until(due) => {
                    due = Instant::now() + config.interval;
                }
                changed = next_nudge(&mut nudges) => {
                    if !changed {
                        // 补报通道已关闭，之后只按间隔上报。
                        nudges = None;
                        continue;
                    }
                    if Instant::now() < last + config.nudge_min_gap {
                        continue;
                    }
                }
            }
            last = Instant::now();
            let result = send_presence_ping(&client, &config.ping_url, &config.access_token).await;
            let line = failure_log
                .lock()
                .ok()
                .and_then(|mut failures| failures.record(&result));
            if let Some(line) = line {
                log(line);
            }
        }
    });
    PresenceKeepalive { task }
}

async fn next_nudge(nudges: &mut Option<watch::Receiver<u64>>) -> bool {
    match nudges {
        Some(receiver) => receiver.changed().await.is_ok(),
        None => std::future::pending().await,
    }
}

async fn send_presence_ping(client: &Client, url: &str, access_token: &str) -> Result<(), String> {
    let response = client
        .get(url)
        .header("Authorization", format!("Bearer {access_token}"))
        .header("Cache-Control", "no-cache")
        .send()
        .await
        .map_err(|error| error.to_string())?;
    let status = response.status();
    if status.is_success() {
        Ok(())
    } else {
        Err(format!("status {}", status.as_u16()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    /// 本机假服务：记录收到的请求行与 Authorization，按给定状态码应答。
    async fn fake_server(status: u16) -> (String, Arc<Mutex<Vec<String>>>, Arc<AtomicUsize>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let count = Arc::new(AtomicUsize::new(0));
        let (seen, hits) = (requests.clone(), count.clone());
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else { return };
                let seen = seen.clone();
                let hits = hits.clone();
                tokio::spawn(async move {
                    let mut buffer = vec![0u8; 4096];
                    let size = socket.read(&mut buffer).await.unwrap_or(0);
                    let text = String::from_utf8_lossy(&buffer[..size]).to_string();
                    let request_line = text.lines().next().unwrap_or_default().to_string();
                    let auth = text
                        .lines()
                        .find(|line| line.to_ascii_lowercase().starts_with("authorization:"))
                        .unwrap_or_default()
                        .to_string();
                    seen.lock().unwrap().push(format!("{request_line} | {auth}"));
                    hits.fetch_add(1, Ordering::SeqCst);
                    let body = "{\"ok\":true}";
                    let response = format!(
                        "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = socket.write_all(response.as_bytes()).await;
                });
            }
        });
        (base, requests, count)
    }

    fn test_config(base: &str) -> PresenceKeepaliveConfig {
        PresenceKeepaliveConfig {
            ping_url: ping_url(base),
            access_token: "token-1".into(),
            interval: Duration::from_millis(60),
            nudge_min_gap: Duration::from_millis(40),
            request_timeout: Duration::from_secs(2),
        }
    }

    fn capture_logs() -> (Arc<Mutex<Vec<String>>>, Arc<dyn Fn(String) + Send + Sync>) {
        let logs = Arc::new(Mutex::new(Vec::new()));
        let sink = logs.clone();
        (logs, Arc::new(move |line: String| sink.lock().unwrap().push(line)))
    }

    #[test]
    fn event_stream_declares_presence_ping() {
        assert_eq!(
            event_stream_url("https://v.achord.cn/"),
            "https://v.achord.cn/api/client/events/stream?presence=ping"
        );
        assert_eq!(ping_url("https://v.achord.cn"), "https://v.achord.cn/api/client/ping");
        assert!(PRESENCE_PING_INTERVAL.as_secs() * 2 < 150, "服务端 150 秒超时内至少能容忍错过一次上报");
    }

    #[test]
    fn failure_log_only_records_state_changes() {
        let mut log = PingFailureLog::default();
        assert_eq!(log.record(&Ok(())), None, "一直成功不记日志");
        assert!(log.record(&Err("status 502".into())).unwrap().contains("status 502"), "第一次失败记一条");
        for _ in 2..FAILURE_LOG_EVERY {
            assert_eq!(log.record(&Err("status 502".into())), None, "持续失败不刷屏");
        }
        assert!(log.record(&Err("timeout".into())).is_some(), "持续失败每 60 次再记一条");
        let recovered = log.record(&Ok(())).unwrap();
        assert!(recovered.contains(&FAILURE_LOG_EVERY.to_string()), "恢复时记一条并带上失败次数");
        assert_eq!(log.record(&Ok(())), None);
    }

    /// 等到假服务收到至少 n 次请求（CI 机器较慢时留足时间），返回是否等到。
    async fn wait_for_hits(count: &AtomicUsize, n: usize) -> bool {
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if count.load(Ordering::SeqCst) >= n {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        false
    }

    #[tokio::test]
    async fn pings_periodically_while_alive_and_stops_when_dropped() {
        let (base, requests, count) = fake_server(200).await;
        let (logs, log) = capture_logs();
        let mut config = test_config(&base);
        config.interval = Duration::from_millis(150);
        let keepalive = spawn_presence_keepalive(
            config,
            None,
            Arc::new(Mutex::new(PingFailureLog::default())),
            log,
        );
        tokio::time::sleep(Duration::from_millis(40)).await;
        assert_eq!(count.load(Ordering::SeqCst), 0, "连接刚建立不立即上报（建立本身就是证明）");
        assert!(wait_for_hits(&count, 2).await, "按间隔持续上报");
        let first = requests.lock().unwrap()[0].clone();
        assert!(first.starts_with("GET /api/client/ping "), "{first}");
        assert!(first.contains("Bearer token-1"), "带上推送连接的登录凭据：{first}");

        drop(keepalive);
        tokio::time::sleep(Duration::from_millis(50)).await;
        let after_drop = count.load(Ordering::SeqCst);
        tokio::time::sleep(Duration::from_millis(400)).await;
        assert_eq!(count.load(Ordering::SeqCst), after_drop, "推送连接停止（退出登录）后不再上报");
        assert!(logs.lock().unwrap().is_empty(), "成功上报不写日志");
    }

    #[tokio::test]
    async fn failures_are_silent_and_do_not_retry() {
        let (base, _requests, count) = fake_server(500).await;
        let (logs, log) = capture_logs();
        let mut config = test_config(&base);
        config.interval = Duration::from_millis(100);
        let started = Instant::now();
        let keepalive = spawn_presence_keepalive(config, None, Arc::new(Mutex::new(PingFailureLog::default())), log);
        assert!(wait_for_hits(&count, 3).await, "失败后仍按间隔继续上报");
        let elapsed = started.elapsed();
        drop(keepalive);
        let sent = count.load(Ordering::SeqCst) as u128;
        assert!(sent <= elapsed.as_millis() / 100 + 1, "失败后不立即重试：{sent} 次 / {elapsed:?}");
        let logs = logs.lock().unwrap().clone();
        assert_eq!(logs.len(), 1, "连续失败只记一条诊断日志：{logs:?}");
        assert!(logs[0].contains("status 500"));

        // 服务器不可达（端口已关闭）同样只记日志、任务继续运行而不是结束。
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let closed = format!("http://{}", listener.local_addr().unwrap());
        drop(listener);
        let (logs, log) = capture_logs();
        let mut config = test_config(&closed);
        config.interval = Duration::from_millis(20);
        let keepalive = spawn_presence_keepalive(config, None, Arc::new(Mutex::new(PingFailureLog::default())), log);
        let deadline = Instant::now() + Duration::from_secs(5);
        while logs.lock().unwrap().is_empty() && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(!keepalive.task.is_finished(), "上报失败不会结束任务");
        drop(keepalive);
        assert_eq!(logs.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn nudges_ping_immediately_but_not_too_often() {
        let (base, _requests, count) = fake_server(200).await;
        let (_logs, log) = capture_logs();
        let nudges = PresenceNudges::new();
        let mut config = test_config(&base);
        config.interval = Duration::from_secs(60);
        config.nudge_min_gap = Duration::from_millis(500);
        let keepalive = spawn_presence_keepalive(
            config,
            Some(nudges.subscribe()),
            Arc::new(Mutex::new(PingFailureLog::default())),
            log,
        );
        nudges.nudge();
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(count.load(Ordering::SeqCst), 0, "刚建立连接时的补报请求被最小间隔挡住");
        tokio::time::sleep(Duration::from_millis(500)).await;
        nudges.nudge();
        assert!(wait_for_hits(&count, 1).await, "距上次足够久时立即补报，不等 60 秒");
        nudges.nudge();
        nudges.nudge();
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(count.load(Ordering::SeqCst), 1, "短时间内多次补报请求只报一次");
        drop(keepalive);
    }

    #[tokio::test]
    async fn nudges_do_not_postpone_periodic_pings() {
        let (base, _requests, count) = fake_server(200).await;
        let (_logs, log) = capture_logs();
        let nudges = PresenceNudges::new();
        let mut config = test_config(&base);
        config.interval = Duration::from_millis(600);
        config.nudge_min_gap = Duration::from_millis(100);
        let started = Instant::now();
        let keepalive = spawn_presence_keepalive(
            config,
            Some(nudges.subscribe()),
            Arc::new(Mutex::new(PingFailureLog::default())),
            log,
        );
        tokio::time::sleep(Duration::from_millis(400)).await;
        nudges.nudge();
        assert!(wait_for_hits(&count, 1).await);
        assert!(wait_for_hits(&count, 2).await);
        let elapsed = started.elapsed();
        drop(keepalive);
        // 定期上报仍在第 600 毫秒左右；若被补报推迟会到第 1000 毫秒。
        assert!(elapsed < Duration::from_millis(850), "补报后定期上报按原节奏进行：{elapsed:?}");
    }
}
