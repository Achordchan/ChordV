//! Finite waits for OS helpers, without pipe backpressure or inherited-pipe EOF waits.
use std::{cell::Cell, fs::File, io::{self, Read, Seek, SeekFrom}, process::{Child, Command, ExitStatus, Output, Stdio}, thread, time::{Duration, Instant}};

const COMMAND_TIMEOUT: Duration = Duration::from_secs(5);
const OUTPUT_LIMIT: u64 = 2 * 1024 * 1024;
thread_local! { static BUDGET: Cell<Option<Instant>> = const { Cell::new(None) }; }

pub fn with_command_budget<T>(duration: Duration, action: impl FnOnce() -> T) -> T {
    struct Restore(Option<Instant>);
    impl Drop for Restore { fn drop(&mut self) { BUDGET.with(|budget| budget.set(self.0)); } }
    let requested = Instant::now() + duration;
    let previous = BUDGET.with(|budget| {
        let previous = budget.get();
        budget.set(Some(previous.map_or(requested, |old| old.min(requested))));
        previous
    });
    let _restore = Restore(previous);
    action()
}

pub trait CommandDeadlineExt {
    fn bounded_output(&mut self) -> io::Result<Output>;
    fn bounded_status(&mut self) -> io::Result<ExitStatus> { self.bounded_output().map(|output| output.status) }
}

pub struct ChildGuard(Option<Child>);
impl ChildGuard {
    pub fn new(child: Child) -> Self { Self(Some(child)) }
    pub fn into_inner(mut self) -> Child { self.0.take().unwrap() }
}
impl std::ops::Deref for ChildGuard { type Target=Child; fn deref(&self)->&Child {self.0.as_ref().unwrap()} }
impl std::ops::DerefMut for ChildGuard { fn deref_mut(&mut self)->&mut Child {self.0.as_mut().unwrap()} }
impl Drop for ChildGuard {
    fn drop(&mut self) {
        if let Some(child) = self.0.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn captured(mut file: File) -> io::Result<Vec<u8>> {
    file.seek(SeekFrom::Start(0))?;
    let mut bytes = Vec::new();
    file.take(OUTPUT_LIMIT + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > OUTPUT_LIMIT { return Err(io::Error::new(io::ErrorKind::InvalidData,"系统命令输出超出限制")); }
    Ok(bytes)
}

impl CommandDeadlineExt for Command {
    fn bounded_output(&mut self) -> io::Result<Output> {
        let deadline = BUDGET.with(|budget| budget.get().map_or(Instant::now()+COMMAND_TIMEOUT, |limit| limit.min(Instant::now()+COMMAND_TIMEOUT)));
        if Instant::now() >= deadline { return Err(io::Error::new(io::ErrorKind::TimedOut,"系统操作已超时")); }
        let name = self.get_program().to_string_lossy().into_owned();
        let stdout = tempfile::tempfile()?;
        let stderr = tempfile::tempfile()?;
        self.stdin(Stdio::null()).stdout(stdout.try_clone()?).stderr(stderr.try_clone()?);
        let mut child = ChildGuard::new(self.spawn()?);
        let status = loop {
            if let Some(status) = child.0.as_mut().unwrap().try_wait()? { break status; }
            if Instant::now() >= deadline { return Err(io::Error::new(io::ErrorKind::TimedOut,format!("系统命令 {name} 执行超时"))); }
            if stdout.metadata()?.len()>OUTPUT_LIMIT || stderr.metadata()?.len()>OUTPUT_LIMIT {
                return Err(io::Error::new(io::ErrorKind::InvalidData,"系统命令输出超出限制"));
            }
            thread::sleep(Duration::from_millis(10));
        };
        child.0.take(); // try_wait reaped the completed child; do not signal a reused PID.
        Ok(Output { status, stdout:captured(stdout)?, stderr:captured(stderr)? })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(mode: &str) -> Command {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command.args(["--exact","bounded_command::tests::child_fixture","--nocapture"])
            .env("CHORDV_COMMAND_FIXTURE",mode);
        command
    }
    #[test]
    fn child_fixture() {
        match std::env::var("CHORDV_COMMAND_FIXTURE").as_deref() {
            Ok("sleep") => thread::sleep(Duration::from_secs(20)),
            Ok("output") => { for _ in 0..200 { println!("{}","x".repeat(1024)); } },
            Ok("failure") => std::process::exit(7),
            _ => {}
        }
    }
    #[test]
    fn handles_output_larger_than_a_pipe_buffer() {
        let output=fixture("output").bounded_output().unwrap();
        assert!(output.status.success());assert!(output.stdout.len()>128*1024);
    }
    #[test]
    fn failed_start_guard_terminates_uncommitted_children() {
        let mut command=fixture("sleep");command.stdout(Stdio::piped());
        let mut child=ChildGuard::new(command.spawn().unwrap());let mut output=child.stdout.take().unwrap();
        drop(child);
        let mut bytes=String::new();output.read_to_string(&mut bytes).unwrap();
        assert!(!bytes.contains("test result: ok"),"an uncommitted runtime must not outlive its guard");
    }
    #[test]
    fn preserves_exit_status() { assert_eq!(fixture("failure").bounded_output().unwrap().status.code(),Some(7)); }
    #[test]
    fn stops_a_hung_command_and_restores_the_budget() {
        let error=with_command_budget(Duration::from_millis(100),||fixture("sleep").bounded_output()).unwrap_err();
        assert_eq!(error.kind(),io::ErrorKind::TimedOut);
        assert!(fixture("output").bounded_status().unwrap().success());
    }
    #[test]
    fn expired_operation_does_not_launch_more_commands() {
        let error=with_command_budget(Duration::ZERO,||fixture("sleep").bounded_output()).unwrap_err();
        assert_eq!(error.kind(),io::ErrorKind::TimedOut);
    }
}
