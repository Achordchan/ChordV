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
    pub fn complete(&self){self.0.store(2,Ordering::SeqCst);}
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn repeated_quit_waits_for_completed_cleanup(){
        let gate=ExitGate::new();assert_eq!(gate.request(),ExitAction::StartCleanup);
        assert_eq!(gate.request(),ExitAction::WaitForCleanup);assert_eq!(gate.request(),ExitAction::WaitForCleanup);
        gate.complete();assert_eq!(gate.request(),ExitAction::Exit);
    }
}
