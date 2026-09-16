use std::sync::atomic::{AtomicU8,Ordering};
#[derive(Debug,PartialEq)]
pub enum ExitAction { StartCleanup, WaitForCleanup, Exit }
pub struct ExitGate(AtomicU8);
impl ExitGate {
    pub const fn new()->Self{Self(AtomicU8::new(0))}
    pub fn request(&self)->ExitAction {
        match self.0.compare_exchange(0,1,Ordering::SeqCst,Ordering::SeqCst) {
            Ok(_)=>ExitAction::StartCleanup,
            Err(2)=>ExitAction::Exit,
            Err(_)=>ExitAction::WaitForCleanup,
        }
    }
    pub fn ensure_running(&self)->Result<(),String>{
        if self.0.load(Ordering::SeqCst)==0 {Ok(())} else {Err("客户端正在退出，不能启动连接".into())}
    }
    pub fn failed(&self){let _=self.0.compare_exchange(1,0,Ordering::SeqCst,Ordering::SeqCst);}
    pub fn complete(&self){self.0.store(2,Ordering::SeqCst);}
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn queued_connection_is_rejected_after_exit_cleanup(){
        let gate=std::sync::Arc::new(ExitGate::new());
        let runtime=std::sync::Arc::new(std::sync::Mutex::new(false));
        assert!(gate.ensure_running().is_ok());
        let held=runtime.lock().unwrap();let worker_gate=gate.clone();let worker_runtime=runtime.clone();
        let worker=std::thread::spawn(move||{let mut active=worker_runtime.lock().unwrap();worker_gate.ensure_running()?;*active=true;Ok::<_,String>(())});
        assert_eq!(gate.request(),ExitAction::StartCleanup);gate.complete();drop(held);
        assert!(worker.join().unwrap().is_err());assert!(!*runtime.lock().unwrap());
    }
    #[test]
    fn failure_keeps_exit_blocked_and_allows_retry(){
        let gate=ExitGate::new();assert_eq!(gate.request(),ExitAction::StartCleanup);
        gate.failed();assert_eq!(gate.request(),ExitAction::StartCleanup);
        assert_eq!(gate.request(),ExitAction::WaitForCleanup);
        gate.complete();assert_eq!(gate.request(),ExitAction::Exit);
    }
    #[test]
    fn repeated_quit_waits_for_completed_cleanup(){
        let gate=ExitGate::new();assert_eq!(gate.request(),ExitAction::StartCleanup);
        assert_eq!(gate.request(),ExitAction::WaitForCleanup);assert_eq!(gate.request(),ExitAction::WaitForCleanup);
        gate.complete();assert_eq!(gate.request(),ExitAction::Exit);
    }
}
