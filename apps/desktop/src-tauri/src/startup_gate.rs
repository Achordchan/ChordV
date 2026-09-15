//! Keep startup disk/process maintenance off the UI thread without racing new work.
use std::{sync::{Condvar,Mutex},time::Duration};
pub struct StartupGate { result:Mutex<Option<Result<(),String>>>, changed:Condvar }
impl StartupGate {
    pub const fn new()->Self {Self{result:Mutex::new(None),changed:Condvar::new()}}
    pub fn finish(&self,result:Result<(),String>){if let Ok(mut slot)=self.result.lock(){*slot=Some(result);self.changed.notify_all();}}
    pub fn wait(&self)->Result<(),String>{self.wait_for(Duration::from_secs(30))}
    fn wait_for(&self,budget:Duration)->Result<(),String>{
        let slot=self.result.lock().map_err(|_|"启动维护状态异常".to_string())?;
        let (slot,_)=self.changed.wait_timeout_while(slot,budget,|value|value.is_none()).map_err(|_|"启动维护状态异常".to_string())?;
        slot.clone().unwrap_or_else(||Err("客户端启动维护尚未完成，请稍后重试".into()))
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn failed_or_pending_maintenance_never_releases_new_runtime_work(){
        let gate=StartupGate::new();assert!(gate.wait_for(Duration::ZERO).is_err());
        gate.finish(Err("disk failure".into()));assert_eq!(gate.wait(),Err("disk failure".into()));
    }
    #[test]
    fn completed_maintenance_releases_waiters(){
        let gate=std::sync::Arc::new(StartupGate::new());let worker=gate.clone();
        let pending=std::thread::spawn(move||worker.wait());gate.finish(Ok(()));assert!(pending.join().unwrap().is_ok());
    }
}
