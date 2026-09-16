//! Keep startup disk/process maintenance off the UI thread without racing new work.
use std::{sync::{Condvar,Mutex},time::Duration};
pub struct StartupGate { result:Mutex<Option<Result<(),String>>>, changed:Condvar }
impl StartupGate {
    pub const fn new()->Self {Self{result:Mutex::new(None),changed:Condvar::new()}}
    pub fn finish(&self,result:Result<(),String>){if let Ok(mut slot)=self.result.lock(){*slot=Some(result);self.changed.notify_all();}}
    pub fn ensure_ready(&self,retry:impl FnOnce()->Result<(),String>)->Result<(),String>{
        {
            let mut slot=self.result.lock().map_err(|_|"启动维护状态异常".to_string())?;
            if matches!(*slot,Some(Err(_))) {
                *slot=None;drop(slot);
                let result=std::panic::catch_unwind(std::panic::AssertUnwindSafe(retry))
                    .unwrap_or_else(|_|Err("启动维护异常，请重试".into()));
                self.finish(result.clone());return result;
            }
        }
        self.wait()
    }
    pub fn wait(&self)->Result<(),String>{self.wait_for(Duration::from_secs(30))?}
    pub fn wait_finished(&self)->Result<(),String>{self.wait_for(Duration::from_secs(30)).map(|_|())}
    fn wait_for(&self,budget:Duration)->Result<Result<(),String>,String>{
        let slot=self.result.lock().map_err(|_|"启动维护状态异常".to_string())?;
        let (slot,_)=self.changed.wait_timeout_while(slot,budget,|value|value.is_none()).map_err(|_|"启动维护状态异常".to_string())?;
        slot.clone().ok_or_else(||"客户端启动维护尚未完成，请稍后重试".into())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn transient_failure_retries_once_before_releasing_work(){
        let gate=std::sync::Arc::new(StartupGate::new());gate.finish(Err("temporary".into()));
        let retry_gate=gate.clone();let (started_tx,started_rx)=std::sync::mpsc::channel();let (done_tx,done_rx)=std::sync::mpsc::channel();
        let first=std::thread::spawn(move||retry_gate.ensure_ready(||{started_tx.send(()).unwrap();done_rx.recv().unwrap();Ok(())}));
        started_rx.recv().unwrap();let other=gate.clone();
        let second=std::thread::spawn(move||other.ensure_ready(||panic!("must not run concurrent maintenance")));
        done_tx.send(()).unwrap();assert!(first.join().unwrap().is_ok());assert!(second.join().unwrap().is_ok());
        assert!(gate.ensure_ready(||panic!("completed startup does not repeat")).is_ok());
    }
    #[test]
    fn failed_or_pending_maintenance_never_releases_new_runtime_work(){
        let gate=StartupGate::new();assert!(gate.wait_for(Duration::ZERO).is_err());
        gate.finish(Err("disk failure".into()));assert_eq!(gate.wait(),Err("disk failure".into()));
        assert!(gate.wait_finished().is_ok(),"failed initialization must still permit shutdown");
    }
    #[test]
    fn completed_maintenance_releases_waiters(){
        let gate=std::sync::Arc::new(StartupGate::new());let worker=gate.clone();
        let pending=std::thread::spawn(move||worker.wait());gate.finish(Ok(()));assert!(pending.join().unwrap().is_ok());
    }
}
