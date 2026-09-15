//! Bound DNS, connection and native TLS probing without occupying an async worker.
use native_tls::TlsConnector;
use sha2::{Digest,Sha256};
use std::{net::Shutdown,time::Duration};
use url::Url;

pub async fn verify(url:&Url,expected:&str)->Result<(),String> {
    verify_with_timeout(url,expected,Duration::from_secs(5)).await
}
async fn verify_with_timeout(url:&Url,expected:&str,budget:Duration)->Result<(),String> {
    let host=url.host_str().ok_or("API 地址缺少主机名")?.to_owned();
    let port=url.port_or_known_default().unwrap_or(443);
    let deadline=tokio::time::Instant::now()+budget;
    let socket=tokio::time::timeout_at(deadline,tokio::net::TcpStream::connect((host.as_str(),port)))
        .await.map_err(|_|"证书连接检查超时".to_string())?.map_err(|e|e.to_string())?;
    let socket=socket.into_std().map_err(|e|e.to_string())?;
    socket.set_nonblocking(false).map_err(|e|e.to_string())?;
    socket.set_read_timeout(Some(budget)).map_err(|e|e.to_string())?;
    socket.set_write_timeout(Some(budget)).map_err(|e|e.to_string())?;
    let cancel=socket.try_clone().map_err(|e|e.to_string())?;
    let expected=expected.replace(':',"").to_lowercase();
    let task=tauri::async_runtime::spawn_blocking(move||{
        let connector=TlsConnector::builder().danger_accept_invalid_certs(true).build().map_err(|e|e.to_string())?;
        let tls=connector.connect(&host,socket).map_err(|e|format!("TLS 握手失败：{e}"))?;
        let cert=tls.peer_certificate().map_err(|e|e.to_string())?.ok_or("服务端未返回证书")?;
        let der=cert.to_der().map_err(|e|e.to_string())?;
        if hex::encode(Sha256::digest(der))!=expected {return Err("API 证书指纹校验失败".into());}
        Ok(())
    });
    match tokio::time::timeout_at(deadline,task).await {
        Ok(result)=>result.map_err(|e|e.to_string())?,
        Err(_)=>{
            // Dropping a blocking task cannot stop its socket. Shutdown wakes the
            // handshake immediately, including a peer that keeps trickling bytes.
            let _=cancel.shutdown(Shutdown::Both);
            Err("证书握手检查超时".into())
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn silent_tls_peer_cannot_hold_the_request_open() {
        let server=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url=Url::parse(&format!("https://127.0.0.1:{}",server.local_addr().unwrap().port())).unwrap();
        let peer=tokio::spawn(async move {let (socket,_)=server.accept().await.unwrap();tokio::time::sleep(Duration::from_secs(5)).await;drop(socket);});
        let result=tokio::time::timeout(Duration::from_secs(2),verify_with_timeout(&url,"00",Duration::from_millis(150)))
            .await.expect("TLS probing must stop when its deadline expires");
        assert!(result.is_err());peer.abort();
    }
}
