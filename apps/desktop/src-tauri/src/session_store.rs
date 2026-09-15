//! Serialize credential files and reject writes from obsolete login operations.
use serde::{de::DeserializeOwned, Serialize};
use std::{fs, io::Write, path::Path, sync::{atomic::{AtomicU64,Ordering},Mutex}};

pub struct SessionStore { epoch: AtomicU64, io: Mutex<()> }
impl SessionStore {
    pub const fn new() -> Self { Self{epoch:AtomicU64::new(0),io:Mutex::new(())} }
    pub fn generation(&self)->u64 {self.epoch.load(Ordering::SeqCst)}
    pub fn invalidate(&self)->u64 {self.epoch.fetch_add(1,Ordering::SeqCst)+1}
    pub fn read<T:DeserializeOwned>(&self,path:&Path)->Result<(Option<T>,u64),String> {
        let _guard=self.io.lock().map_err(|_|"会话存储状态异常".to_string())?;
        let epoch=self.generation();
        match fs::read(path) {
            Ok(bytes)=>Ok((Some(serde_json::from_slice(&bytes).map_err(|e|e.to_string())?),epoch)),
            Err(error) if error.kind()==std::io::ErrorKind::NotFound=>Ok((None,epoch)),
            Err(error)=>Err(error.to_string())
        }
    }
    pub fn save<T:Serialize>(&self,path:&Path,session:&T,expected:u64)->Result<(),String> {
        let _guard=self.io.lock().map_err(|_|"会话存储状态异常".to_string())?;
        if self.generation()!=expected {return Err("登录状态已变化，忽略过期会话".into());}
        let parent=path.parent().ok_or("会话路径无效")?;
        fs::create_dir_all(parent).map_err(|e|e.to_string())?;
        let mut temp=tempfile::NamedTempFile::new_in(parent).map_err(|e|e.to_string())?;
        serde_json::to_writer(&mut temp,session).map_err(|e|e.to_string())?;
        temp.flush().map_err(|e|e.to_string())?;
        self.epoch.compare_exchange(expected,expected+1,Ordering::SeqCst,Ordering::SeqCst)
            .map_err(|_|"登录状态已变化，忽略过期会话".to_string())?;
        temp.persist(path).map_err(|e|e.to_string())?;
        Ok(())
    }
    pub fn clear(&self,path:&Path,expected:u64)->Result<(),String> {
        let _guard=self.io.lock().map_err(|_|"会话存储状态异常".to_string())?;
        if self.generation()!=expected {return Ok(());} // Never clear a newer login.
        match fs::remove_file(path) {
            Ok(())=>Ok(()),Err(e) if e.kind()==std::io::ErrorKind::NotFound=>Ok(()),Err(e)=>Err(e.to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn late_refresh_cannot_restore_a_logged_out_session() {
        let folder=tempfile::tempdir().unwrap();let path=folder.path().join("session.json");let store=SessionStore::new();
        store.save(&path,&"old",store.generation()).unwrap();
        let (_,captured)=store.read::<String>(&path).unwrap();
        let cleared=store.invalidate();store.clear(&path,cleared).unwrap();
        assert!(store.save(&path,&"refreshed",captured).is_err());assert!(!path.exists());
    }
    #[test]
    fn queued_save_cannot_overwrite_newer_credentials() {
        let folder=tempfile::tempdir().unwrap();let path=folder.path().join("session.json");let store=SessionStore::new();
        let captured=store.generation();store.save(&path,&"new",captured).unwrap();
        assert!(store.save(&path,&"old",captured).is_err());assert_eq!(store.read::<String>(&path).unwrap().0,Some("new".into()));
    }
    #[test]
    fn delayed_clear_preserves_a_new_login() {
        let folder=tempfile::tempdir().unwrap();let path=folder.path().join("session.json");let store=SessionStore::new();
        let clearing=store.invalidate();store.save(&path,&"new login",store.generation()).unwrap();
        store.clear(&path,clearing).unwrap();assert_eq!(store.read::<String>(&path).unwrap().0,Some("new login".into()));
    }
}
