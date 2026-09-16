//! Serialize credential files and reject writes from obsolete login operations.
use sha2::{Digest,Sha256};
use std::collections::BTreeMap;
use serde::{de::DeserializeOwned, Serialize};
use std::{fs, io::Write, path::Path, sync::{atomic::{AtomicU64,Ordering},Mutex}};

#[derive(Clone,Copy)]
pub struct SaveTicket { epoch:u64, order:u64 }
struct Committed { order:u64, retired:BTreeMap<String,u64> }
fn credential_hash(value:&serde_json::Value)->Result<String,String>{
    Ok(hex::encode(Sha256::digest(serde_json::to_vec(value).map_err(|e|e.to_string())?)))
}
pub struct SessionStore { epoch: AtomicU64, next:AtomicU64, io: Mutex<Committed> }
impl SessionStore {
    pub const fn new() -> Self { Self{epoch:AtomicU64::new(0),next:AtomicU64::new(0),io:Mutex::new(Committed{order:0,retired:BTreeMap::new()})} }
    pub fn generation(&self)->u64 {self.epoch.load(Ordering::SeqCst)}
    pub fn reserve_save(&self)->SaveTicket {
        SaveTicket{epoch:self.generation(),order:self.next.fetch_add(1,Ordering::SeqCst)+1}
    }
    pub fn invalidate(&self)->u64 {
        // Odd generations are tombstones: old credentials are unreadable even
        // while the cleanup worker is still waiting for the runtime lock.
        let old=self.epoch.fetch_update(Ordering::SeqCst,Ordering::SeqCst,|value|Some(value.wrapping_add(2)|1)).unwrap();
        old.wrapping_add(2)|1
    }
    pub fn read<T:DeserializeOwned>(&self,path:&Path)->Result<(Option<T>,SaveTicket),String> {
        let _guard=self.io.lock().map_err(|_|"会话存储状态异常".to_string())?;
        let ticket=self.reserve_save();
        let epoch=ticket.epoch;
        if epoch & 1 != 0 {return Ok((None,ticket));}
        match fs::read(path) {
            Ok(bytes)=>Ok((Some(serde_json::from_slice(&bytes).map_err(|e|e.to_string())?),ticket)),
            Err(error) if error.kind()==std::io::ErrorKind::NotFound=>Ok((None,ticket)),
            Err(error)=>Err(error.to_string())
        }
    }
    pub fn save<T:Serialize>(&self,path:&Path,session:&T,ticket:SaveTicket)->Result<(),String> {
        self.save_inner(path,session,ticket,None)
    }
    pub fn rotate<T:Serialize>(&self,path:&Path,session:&T,ticket:SaveTicket,previous:&T)->Result<(),String> {
        self.save_inner(path,session,ticket,Some(serde_json::to_value(previous).map_err(|e|e.to_string())?))
    }
    fn save_inner<T:Serialize>(&self,path:&Path,session:&T,ticket:SaveTicket,previous:Option<serde_json::Value>)->Result<(),String> {
        let mut committed=self.io.lock().map_err(|_|"会话存储状态异常".to_string())?;
        let expected=self.generation();
        let same_login=expected==ticket.epoch || (ticket.epoch&1!=0 && expected==ticket.epoch.wrapping_add(1));
        if !same_login {return Err("登录状态已变化，忽略过期会话".into());}
        let incoming=serde_json::to_value(session).map_err(|e|e.to_string())?;
        let retired=previous.as_ref().map(credential_hash).transpose()?;
        if let Some(previous)=previous {
            let bytes=fs::read(path).map_err(|e|e.to_string())?;
            let current:serde_json::Value=serde_json::from_slice(&bytes).map_err(|e|e.to_string())?;
            if current!=previous {return Err("登录凭据已更新，忽略过期刷新".into());}
        } else {
            let obsolete=committed.retired.get(&credential_hash(&incoming)?).is_some_and(|cutoff|ticket.order<=*cutoff);
            if ticket.order<=committed.order || obsolete {return Err("登录状态已变化，忽略过期会话".into());}
        }
        let parent=path.parent().ok_or("会话路径无效")?;
        fs::create_dir_all(parent).map_err(|e|e.to_string())?;
        let mut temp=tempfile::NamedTempFile::new_in(parent).map_err(|e|e.to_string())?;
        serde_json::to_writer(&mut temp,session).map_err(|e|e.to_string())?;
        temp.flush().map_err(|e|e.to_string())?;
        temp.persist(path).map_err(|e|e.to_string())?;
        // Readers remain behind the IO lock. A concurrent invalidation leaves
        // its tombstone intact; failed persistence never changes committed state.
        self.epoch.compare_exchange(expected,if expected&1==0 {expected}else{expected.wrapping_add(1)},Ordering::SeqCst,Ordering::SeqCst)
            .map_err(|_|"登录状态已变化，忽略过期会话".to_string())?;
        committed.order=committed.order.max(ticket.order);
        if let Some(hash)=retired {committed.retired.insert(hash,self.next.load(Ordering::SeqCst));}
        let order=committed.order;
        committed.retired.retain(|_,cutoff|*cutoff>order);
        Ok(())
    }
    #[cfg(test)]
    pub fn clear(&self,path:&Path,expected:u64)->Result<(),String> {
        self.clear_with(path,expected,||Ok(()))
    }
    pub fn clear_with(&self,path:&Path,expected:u64,cleanup:impl FnOnce()->Result<(),String>)->Result<(),String> {
        // Lock order is session IO -> runtime; no runtime holder waits for session IO.
        let _guard=self.io.lock().map_err(|_|"会话存储状态异常".to_string())?;
        if self.generation()!=expected {return Ok(());} // Never stop or clear a newer login.
        cleanup()?;
        match fs::remove_file(path) {
            Ok(())=>Ok(()),Err(e) if e.kind()==std::io::ErrorKind::NotFound=>Ok(()),Err(e)=>Err(e.to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn queued_new_login_survives_old_login_rotation(){
        let folder=tempfile::tempdir().unwrap();let path=folder.path().join("session.json");let store=SessionStore::new();
        store.save(&path,&"old login",store.reserve_save()).unwrap();let (_,refresh)=store.read::<String>(&path).unwrap();
        let replacement=store.reserve_save();
        store.rotate(&path,&"old login rotated",refresh,&"old login").unwrap();
        store.save(&path,&"new login",replacement).unwrap();
        assert_eq!(store.read::<String>(&path).unwrap().0,Some("new login".into()));
    }
    #[test]
    fn successful_rotation_survives_same_credentials_saved_during_network_request(){
        let folder=tempfile::tempdir().unwrap();let path=folder.path().join("session.json");let store=SessionStore::new();
        store.save(&path,&"old token",store.reserve_save()).unwrap();
        let (_,refresh)=store.read::<String>(&path).unwrap();let redundant=store.reserve_save();
        store.save(&path,&"old token",redundant).unwrap();let late_old=store.reserve_save();
        store.rotate(&path,&"rotated token",refresh,&"old token").unwrap();
        assert!(store.save(&path,&"old token",late_old).is_err());
        assert_eq!(store.read::<String>(&path).unwrap().0,Some("rotated token".into()));
    }
    #[test]
    fn rotation_cannot_replace_a_different_login(){
        let folder=tempfile::tempdir().unwrap();let path=folder.path().join("session.json");let store=SessionStore::new();
        store.save(&path,&"old",store.reserve_save()).unwrap();let (_,ticket)=store.read::<String>(&path).unwrap();
        store.save(&path,&"new login",store.reserve_save()).unwrap();
        assert!(store.rotate(&path,&"rotated",ticket,&"old").is_err());
    }
    #[test]
    fn queued_saves_commit_the_newest_request_in_either_worker_order(){
        for reversed in [false,true] {
            let folder=tempfile::tempdir().unwrap();let path=folder.path().join("session.json");let store=SessionStore::new();
            store.invalidate();let older=store.reserve_save();let newer=store.reserve_save();
            if reversed {store.save(&path,&"new",newer).unwrap();assert!(store.save(&path,&"old",older).is_err());}
            else {store.save(&path,&"old",older).unwrap();store.save(&path,&"new",newer).unwrap();}
            assert_eq!(store.read::<String>(&path).unwrap().0,Some("new".into()));
        }
    }
    #[test]
    fn failed_persistence_keeps_the_tombstone_and_old_bytes_hidden(){
        let folder=tempfile::tempdir().unwrap();let path=folder.path().join("session.json");let backup=folder.path().join("old.json");let store=SessionStore::new();
        store.save(&path,&"old",store.reserve_save()).unwrap();let expected=store.invalidate();
        fs::rename(&path,&backup).unwrap();fs::create_dir(&path).unwrap();
        assert!(store.save(&path,&"new",store.reserve_save()).is_err());assert_eq!(store.generation(),expected);
        fs::remove_dir(&path).unwrap();fs::rename(&backup,&path).unwrap();
        assert!(store.read::<String>(&path).unwrap().0.is_none());
    }
    #[test]
    fn delayed_clear_never_runs_cleanup_for_a_new_login(){
        let folder=tempfile::tempdir().unwrap();let path=folder.path().join("session.json");let store=SessionStore::new();
        let clearing=store.invalidate();store.save(&path,&"new",store.reserve_save()).unwrap();
        let mut runtime_active=true;
        store.clear_with(&path,clearing,||{runtime_active=false;Ok(())}).unwrap();
        assert!(runtime_active);assert_eq!(store.read::<String>(&path).unwrap().0,Some("new".into()));
    }
    #[test]
    fn refresh_cannot_read_old_credentials_during_pending_clear() {
        let folder=tempfile::tempdir().unwrap();let path=folder.path().join("session.json");let store=SessionStore::new();
        store.save(&path,&"old",store.reserve_save()).unwrap();
        let clearing=store.invalidate();
        assert!(path.exists());assert!(store.read::<String>(&path).unwrap().0.is_none());
        store.clear(&path,clearing).unwrap();assert!(!path.exists());
    }
    #[test]
    fn late_refresh_cannot_restore_a_logged_out_session() {
        let folder=tempfile::tempdir().unwrap();let path=folder.path().join("session.json");let store=SessionStore::new();
        store.save(&path,&"old",store.reserve_save()).unwrap();
        let (_,captured)=store.read::<String>(&path).unwrap();
        let cleared=store.invalidate();store.clear(&path,cleared).unwrap();
        assert!(store.save(&path,&"refreshed",captured).is_err());assert!(!path.exists());
    }
    #[test]
    fn queued_save_cannot_overwrite_newer_credentials() {
        let folder=tempfile::tempdir().unwrap();let path=folder.path().join("session.json");let store=SessionStore::new();
        let captured=store.reserve_save();store.save(&path,&"new",captured).unwrap();
        assert!(store.save(&path,&"old",captured).is_err());assert_eq!(store.read::<String>(&path).unwrap().0,Some("new".into()));
    }
    #[test]
    fn delayed_clear_preserves_a_new_login() {
        let folder=tempfile::tempdir().unwrap();let path=folder.path().join("session.json");let store=SessionStore::new();
        let clearing=store.invalidate();store.save(&path,&"new login",store.reserve_save()).unwrap();
        store.clear(&path,clearing).unwrap();assert_eq!(store.read::<String>(&path).unwrap().0,Some("new login".into()));
    }
}
