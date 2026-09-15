use super::{chrono_like_now, NodeProbeResultDto, NodeSummaryDto};
use std::time::{Duration, Instant};
use tokio::{net::{lookup_host, TcpStream}, task::JoinSet, time::timeout};

/// Direct TCP sockets measure this device's route, without HTTP proxy environment settings.
/// DNS and all connection attempts share one deadline. No backend probe is used as a fallback.
async fn tcp_latency(host: &str, port: u16) -> Result<u32, String> {
    let started = Instant::now();
    timeout(Duration::from_secs(4), async {
        let addresses = lookup_host((host, port)).await.map_err(|error| error.to_string())?;
        let mut attempts = JoinSet::new();
        for address in addresses.take(8) {
            attempts.spawn(async move { TcpStream::connect(address).await });
        }
        let mut error = "节点地址无法解析".to_string();
        while let Some(attempt) = attempts.join_next().await {
            match attempt {
                Ok(Ok(_)) => return Ok(started.elapsed().as_millis().clamp(1, 60000) as u32),
                Ok(Err(reason)) => error = reason.to_string(),
                Err(reason) => error = reason.to_string(),
            }
        }
        Err(error)
    }).await.map_err(|_| "本机连接节点超时（4 秒）".to_string())?
}

async fn probe_node(node: NodeSummaryDto) -> NodeProbeResultDto {
    let result = match (node.server_host.as_deref(), node.server_port) {
        (Some(host), Some(port)) if !host.trim().is_empty() && port > 0 => tcp_latency(host, port).await,
        _ => Err("节点未提供本机检测地址，请更新后台并刷新节点列表".to_string()),
    };
    NodeProbeResultDto {
        node_id: node.id,
        status: if result.is_ok() { "healthy" } else { "offline" }.into(),
        latency_ms: result.as_ref().ok().copied(),
        checked_at: chrono_like_now(),
        error: result.err(),
    }
}

pub(super) async fn probe_nodes(nodes: Vec<NodeSummaryDto>) -> Result<Vec<NodeProbeResultDto>, String> {
    if nodes.len() > 32 { return Err("每次最多检测 32 个节点".into()); }
    let mut results = Vec::with_capacity(nodes.len());
    let mut nodes = nodes.into_iter();
    let mut pending = JoinSet::new();
    for node in nodes.by_ref().take(6) { pending.spawn(probe_node(node)); }
    while let Some(result) = pending.join_next().await {
        results.push(result.map_err(|error| error.to_string())?);
        if let Some(node) = nodes.next() { pending.spawn(probe_node(node)); }
    }
    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn measures_real_local_tcp_listener() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let latency = tcp_latency("127.0.0.1", listener.local_addr().unwrap().port()).await.unwrap();
        assert!((1..=60000).contains(&latency));
    }
    #[tokio::test]
    async fn closed_local_port_is_not_reported_as_healthy() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        assert!(tcp_latency("127.0.0.1", port).await.is_err());
    }
}
