//! Read a bounded suffix: opening diagnostics must not rescan gigabytes of traffic.
use std::{fs::File,io::{Read,Seek,SeekFrom},path::Path};
const MAX_TAIL_BYTES:u64=256*1024;
pub fn read_tail(path:&Path,lines:usize)->String {
    if lines==0{return String::new();}
    let result=(||->std::io::Result<String>{
        let mut file=File::open(path)?;
        let offset=file.metadata()?.len().saturating_sub(MAX_TAIL_BYTES);
        file.seek(SeekFrom::Start(offset))?;
        let mut bytes=Vec::new();file.take(MAX_TAIL_BYTES).read_to_end(&mut bytes)?;
        let text=String::from_utf8_lossy(&bytes);
        let complete=if offset>0 {text.split_once('\n').map_or(text.as_ref(),|(_,rest)|rest)} else {text.as_ref()};
        let mut tail=complete.lines().rev().take(lines).collect::<Vec<_>>();tail.reverse();Ok(tail.join("\n"))
    })();result.unwrap_or_default()
}
#[cfg(test)]
mod tests {
    use super::*;use std::io::Write;
    #[test]
    fn large_log_reads_only_the_requested_tail(){
        let mut file=tempfile::NamedTempFile::new().unwrap();
        for i in 0..10000{writeln!(file,"{i}: {}","x".repeat(100)).unwrap();}
        let output=read_tail(file.path(),2);assert_eq!(output.lines().count(),2);assert!(output.starts_with("9998:"));
    }
    #[test]
    fn partial_utf8_or_missing_log_is_safe(){
        let mut file=tempfile::NamedTempFile::new().unwrap();file.write_all(b"old\nnew\xff").unwrap();
        assert!(read_tail(file.path(),1).starts_with("new"));assert!(read_tail(Path::new("missing-log-file"),2).is_empty());
    }
}
