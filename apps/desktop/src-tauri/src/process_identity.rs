use std::{io,process::Output};
#[cfg(any(windows,test))]
pub fn windows_query(output:io::Result<Output>)->Result<Option<String>,String>{
    let output=output.map_err(|error|format!("进程归属检查失败：{error}"))?;
    if !output.status.success(){return Err("无法读取 Windows 进程归属，请重试".into());}
    let text=String::from_utf8_lossy(&output.stdout);
    let value:serde_json::Value=serde_json::from_str(text.trim()).map_err(|_|"Windows 进程归属响应无效".to_string())?;
    match value.get("exists").and_then(|v|v.as_bool()) {
        Some(false)=>Ok(None),
        Some(true)=>{
            let command=value.get("command").and_then(|v|v.as_str()).unwrap_or("").trim();
            if command.is_empty(){Err("进程存在但无法确认归属，请重试".into())}else{Ok(Some(command.into()))}
        },
        None=>Err("Windows 进程归属响应缺少状态".into()),
    }
}
#[cfg(unix)]
pub fn unix_query(output:io::Result<Output>)->Result<Option<String>,String>{
    let output=output.map_err(|error|format!("进程归属检查失败：{error}"))?;
    let text=String::from_utf8_lossy(&output.stdout).trim().to_string();
    if output.status.success() && !text.is_empty(){return Ok(Some(text));}
    if output.status.code()==Some(1)&&text.is_empty()&&output.stderr.is_empty(){return Ok(None);}
    Err("无法确认本机进程归属，请重试".into())
}
#[cfg(test)]
mod tests {
    use super::*;
    fn result(text:&str)->io::Result<Output>{
        #[cfg(unix)] use std::os::unix::process::ExitStatusExt;
        #[cfg(windows)] use std::os::windows::process::ExitStatusExt;
        Ok(Output{status:std::process::ExitStatus::from_raw(0),stdout:text.as_bytes().to_vec(),stderr:vec![]})
    }
    #[test]
    fn unknown_and_timed_out_queries_are_not_absence(){
        assert!(windows_query(Err(io::Error::new(io::ErrorKind::TimedOut,"deadline"))).is_err());
        assert!(windows_query(result(r#"{"exists":true,"command":""}"#)).is_err());
        assert!(windows_query(result("")).is_err());
        assert_eq!(windows_query(result(r#"{"exists":false}"#)).unwrap(),None);
        assert_eq!(windows_query(result(r#"{"exists":true,"command":"xray run"}"#)).unwrap(),Some("xray run".into()));
    }
}
