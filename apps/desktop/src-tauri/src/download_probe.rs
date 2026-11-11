//! Picks the fastest of several download mirrors before a component download.
//!
//! Each candidate gets a short ranged request for the first part of the file; the
//! measured throughput orders the candidates. A probe never decides correctness:
//! the real download still verifies size and SHA256, so a mirror that answers fast
//! with the wrong bytes only costs one failed attempt.

use reqwest::{header, Client, StatusCode};
use serde::Serialize;
use std::time::{Duration, Instant};
use url::Url;

/// How much of the file each probe reads. Big enough to get past TCP slow start,
/// small enough that probing five mirrors costs less than one slow download.
pub const PROBE_BYTES: u64 = 512 * 1024;
const PROBE_CONNECT_TIMEOUT: Duration = Duration::from_secs(4);
const PROBE_BUDGET: Duration = Duration::from_secs(5);
const MAX_PROBE_CANDIDATES: usize = 8;

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProbeResult {
    pub url: String,
    pub ok: bool,
    pub bytes_received: u64,
    pub bytes_per_second: u64,
    pub elapsed_ms: u64,
    pub error: Option<String>,
}

fn probe_client() -> Result<Client, String> {
    // Mirrors are picked for the user's direct route; the local proxy must not
    // skew the measurement or carry the download.
    Client::builder()
        .no_proxy()
        .connect_timeout(PROBE_CONNECT_TIMEOUT)
        .timeout(PROBE_BUDGET + Duration::from_secs(1))
        .build()
        .map_err(|error| format!("初始化测速客户端失败：{error}"))
}

fn looks_like_web_page(content_type: Option<&header::HeaderValue>) -> bool {
    content_type
        .and_then(|value| value.to_str().ok())
        .map(|value| {
            let value = value.to_ascii_lowercase();
            value.starts_with("text/html") || value.starts_with("application/json")
        })
        .unwrap_or(false)
}

async fn probe_one(client: Client, url: String) -> DownloadProbeResult {
    let started = Instant::now();
    let failed = |error: String, bytes: u64| DownloadProbeResult {
        url: url.clone(),
        ok: false,
        bytes_received: bytes,
        bytes_per_second: 0,
        elapsed_ms: started.elapsed().as_millis() as u64,
        error: Some(error),
    };
    let parsed = match Url::parse(url.trim()) {
        Ok(parsed) if matches!(parsed.scheme(), "http" | "https") => parsed,
        _ => return failed("地址无效".into(), 0),
    };
    let request = client
        .get(parsed)
        .header(header::RANGE, format!("bytes=0-{}", PROBE_BYTES - 1))
        .header(header::ACCEPT_ENCODING, "identity");
    let mut response = match tokio::time::timeout(PROBE_BUDGET, request.send()).await {
        Ok(Ok(response)) => response,
        Ok(Err(error)) => return failed(format!("连接失败：{error}"), 0),
        Err(_) => return failed("连接超时".into(), 0),
    };
    let status = response.status();
    if status != StatusCode::OK && status != StatusCode::PARTIAL_CONTENT {
        return failed(format!("HTTP {}", status.as_u16()), 0);
    }
    if looks_like_web_page(response.headers().get(header::CONTENT_TYPE)) {
        return failed("返回的是网页而不是文件".into(), 0);
    }
    let mut received = 0_u64;
    while received < PROBE_BYTES {
        let remaining = match PROBE_BUDGET.checked_sub(started.elapsed()) {
            Some(remaining) if !remaining.is_zero() => remaining,
            _ => break,
        };
        match tokio::time::timeout(remaining, response.chunk()).await {
            Ok(Ok(Some(chunk))) => received += chunk.len() as u64,
            Ok(Ok(None)) => break,
            Ok(Err(error)) => return failed(format!("读取失败：{error}"), received),
            Err(_) => break,
        }
    }
    let elapsed = started.elapsed();
    if received == 0 {
        return failed("没有收到数据".into(), 0);
    }
    DownloadProbeResult {
        url,
        ok: true,
        bytes_received: received,
        bytes_per_second: bytes_per_second(received, elapsed),
        elapsed_ms: elapsed.as_millis() as u64,
        error: None,
    }
}

pub fn bytes_per_second(bytes: u64, elapsed: Duration) -> u64 {
    let millis = elapsed.as_millis().max(1) as u128;
    ((bytes as u128 * 1000) / millis).min(u64::MAX as u128) as u64
}

/// Fastest first; failed probes keep their original order at the end so the
/// caller can still fall back to them.
pub fn rank_probe_results(mut results: Vec<DownloadProbeResult>) -> Vec<DownloadProbeResult> {
    results.sort_by(|left, right| match (left.ok, right.ok) {
        (true, true) => right.bytes_per_second.cmp(&left.bytes_per_second),
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        (false, false) => std::cmp::Ordering::Equal,
    });
    results
}

pub async fn probe_download_candidates(urls: Vec<String>) -> Result<Vec<DownloadProbeResult>, String> {
    let mut unique = Vec::new();
    for url in urls.into_iter().map(|url| url.trim().to_string()) {
        if !url.is_empty() && !unique.contains(&url) {
            unique.push(url);
        }
        if unique.len() >= MAX_PROBE_CANDIDATES {
            break;
        }
    }
    let client = probe_client()?;
    let handles: Vec<_> = unique
        .into_iter()
        .map(|url| tauri::async_runtime::spawn(probe_one(client.clone(), url)))
        .collect();
    let mut results = Vec::with_capacity(handles.len());
    for handle in handles {
        if let Ok(result) = handle.await {
            results.push(result);
        }
    }
    Ok(rank_probe_results(results))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn result(url: &str, ok: bool, speed: u64) -> DownloadProbeResult {
        DownloadProbeResult {
            url: url.into(),
            ok,
            bytes_received: if ok { 1 } else { 0 },
            bytes_per_second: speed,
            elapsed_ms: 1,
            error: None,
        }
    }

    #[test]
    fn ranks_fastest_working_mirror_first_and_keeps_failures_last() {
        let ranked = rank_probe_results(vec![
            result("broken-a", false, 0),
            result("slow", true, 10),
            result("fast", true, 1000),
            result("broken-b", false, 0),
        ]);
        let order: Vec<_> = ranked.iter().map(|item| item.url.as_str()).collect();
        assert_eq!(order, vec!["fast", "slow", "broken-a", "broken-b"]);
    }

    #[test]
    fn computes_throughput_without_dividing_by_zero() {
        assert_eq!(bytes_per_second(1000, Duration::from_millis(500)), 2000);
        assert_eq!(bytes_per_second(1000, Duration::ZERO), 1_000_000);
    }

    #[test]
    fn treats_html_and_json_as_mirror_error_pages() {
        assert!(looks_like_web_page(Some(&header::HeaderValue::from_static("text/html; charset=utf-8"))));
        assert!(looks_like_web_page(Some(&header::HeaderValue::from_static("application/json"))));
        assert!(!looks_like_web_page(Some(&header::HeaderValue::from_static("application/octet-stream"))));
        assert!(!looks_like_web_page(None));
    }
}
