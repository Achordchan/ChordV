use std::sync::atomic::{AtomicU64, Ordering};

/// Cancels work that has been requested but has not acquired the runtime lock yet.
/// Session identity checks alone cannot see a disconnect before initialization.
pub struct ConnectionGeneration(AtomicU64);

impl ConnectionGeneration {
    pub const fn new() -> Self { Self(AtomicU64::new(0)) }
    pub fn capture(&self) -> u64 { self.0.load(Ordering::SeqCst) }
    pub fn invalidate(&self) { self.0.fetch_add(1, Ordering::SeqCst); }
    pub fn ensure_current(&self, captured: u64) -> Result<(), String> {
        if self.capture() == captured { Ok(()) } else { Err("连接已取消".into()) }
    }
}

#[cfg(test)]
mod tests {
    use super::ConnectionGeneration;
    use std::sync::{mpsc, Arc};

    #[test]
    fn disconnect_before_queued_worker_starts_prevents_initialization() {
        let generation = Arc::new(ConnectionGeneration::new());
        let captured = generation.capture();
        let queued = Arc::clone(&generation);
        let (resume, wait) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            wait.recv().unwrap();
            queued.ensure_current(captured)?;
            Ok::<_, String>("initialized")
        });
        generation.invalidate();
        resume.send(()).unwrap();
        assert_eq!(worker.join().unwrap(), Err("连接已取消".into()));
        assert!(generation.ensure_current(generation.capture()).is_ok());
    }

    #[test]
    fn disconnect_during_preparation_invalidates_the_next_startup_stage() {
        let generation = ConnectionGeneration::new();
        let captured = generation.capture();
        assert!(generation.ensure_current(captured).is_ok());
        generation.invalidate();
        assert!(generation.ensure_current(captured).is_err());
    }
}
