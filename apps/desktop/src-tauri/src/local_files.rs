//! 本地文件位置：只列出排查需要的运行目录与组件文件，“在文件夹中显示”只接受固定的条目，
//! 并且解析后的真实路径必须位于应用数据目录内。登录凭据（session.json）既不列出也不能打开。
use serde::{Deserialize, Serialize};
use std::path::{Component, Path, PathBuf};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum LocalFileKind {
    AppData,
    Xray,
    Geoip,
    Geosite,
    Runtime,
    Updater,
}

impl LocalFileKind {
    pub const ALL: [LocalFileKind; 6] = [
        LocalFileKind::AppData,
        LocalFileKind::Xray,
        LocalFileKind::Geoip,
        LocalFileKind::Geosite,
        LocalFileKind::Runtime,
        LocalFileKind::Updater,
    ];

    pub fn is_directory(self) -> bool {
        matches!(self, LocalFileKind::AppData | LocalFileKind::Runtime | LocalFileKind::Updater)
    }
}

/// 原生端实际使用的目录；由调用方用 `installed_runtime_bin_dir` 等函数解析后传入。
pub struct LocalFileRoots {
    pub app_data: PathBuf,
    pub runtime: PathBuf,
    pub bin: PathBuf,
    pub updater: PathBuf,
    pub xray_file_name: &'static str,
}

impl LocalFileRoots {
    pub fn path_of(&self, kind: LocalFileKind) -> PathBuf {
        match kind {
            LocalFileKind::AppData => self.app_data.clone(),
            LocalFileKind::Xray => self.bin.join(self.xray_file_name),
            LocalFileKind::Geoip => self.bin.join("geoip.dat"),
            LocalFileKind::Geosite => self.bin.join("geosite.dat"),
            LocalFileKind::Runtime => self.runtime.clone(),
            LocalFileKind::Updater => self.updater.clone(),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalFileEntry {
    pub kind: LocalFileKind,
    pub path: String,
    pub is_directory: bool,
    pub exists: bool,
    pub size_bytes: Option<u64>,
}

/// 只描述固定条目；目录不统计大小，避免在大目录上卡住界面。
pub fn describe(roots: &LocalFileRoots) -> Vec<LocalFileEntry> {
    LocalFileKind::ALL
        .iter()
        .map(|&kind| {
            let path = roots.path_of(kind);
            let is_directory = kind.is_directory();
            let metadata = std::fs::metadata(&path).ok();
            let exists = metadata
                .as_ref()
                .map(|metadata| metadata.is_dir() == is_directory)
                .unwrap_or(false);
            let size_bytes = if exists && !is_directory {
                metadata.map(|metadata| metadata.len())
            } else {
                None
            };
            LocalFileEntry {
                kind,
                path: path.to_string_lossy().into_owned(),
                is_directory,
                exists,
                size_bytes,
            }
        })
        .collect()
}

/// 登录凭据及其临时/备份副本。
pub fn is_credential_file_name(name: &std::ffi::OsStr) -> bool {
    let name = name.to_string_lossy().to_lowercase();
    name == "session.json" || name.starts_with("session.json.")
}

#[derive(Debug, PartialEq, Eq)]
pub struct RevealTarget {
    /// 规范化后的真实路径。
    pub path: PathBuf,
    /// true：在上级目录中选中该文件；false：直接打开该目录。
    pub select: bool,
}

/// 把请求的位置解析为可以交给访达/资源管理器的真实路径。
/// 文件不存在时退到最近的已存在上级目录；解析后的路径必须仍在应用数据目录内。
pub fn resolve_reveal_target(app_data_dir: &Path, requested: &Path) -> Result<RevealTarget, String> {
    const OUTSIDE: &str = "只能打开应用数据目录内的位置。";
    if requested
        .file_name()
        .map(is_credential_file_name)
        .unwrap_or(false)
    {
        return Err("登录凭据文件不提供打开入口。".into());
    }
    if !requested.is_absolute()
        || requested
            .components()
            .any(|component| matches!(component, Component::ParentDir))
    {
        return Err(OUTSIDE.into());
    }
    let root = app_data_dir
        .canonicalize()
        .map_err(|error| format!("无法定位应用数据目录：{error}"))?;
    let mut existing = requested;
    while !existing.exists() {
        existing = existing.parent().ok_or_else(|| OUTSIDE.to_string())?;
    }
    let canonical = existing
        .canonicalize()
        .map_err(|error| format!("无法解析文件位置：{error}"))?;
    if !canonical.starts_with(&root) {
        return Err(OUTSIDE.into());
    }
    if canonical
        .file_name()
        .map(is_credential_file_name)
        .unwrap_or(false)
    {
        return Err("登录凭据文件不提供打开入口。".into());
    }
    let select = !canonical.is_dir();
    Ok(RevealTarget {
        path: canonical,
        select,
    })
}

/// `canonicalize` 在 Windows 上返回 `\\?\C:\...`，资源管理器不认这种写法。
#[cfg(any(windows, test))]
pub fn strip_verbatim_prefix(path: &str) -> String {
    if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = path.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        path.to_string()
    }
}

#[cfg(target_os = "macos")]
pub fn reveal_with_system(target: &RevealTarget) -> Result<(), String> {
    use crate::bounded_command::CommandDeadlineExt;
    let mut command = std::process::Command::new("/usr/bin/open");
    if target.select {
        command.arg("-R");
    } else {
        // 指定访达，避免目录被当成应用包启动。
        command.args(["-a", "Finder"]);
    }
    let status = command
        .arg(&target.path)
        .bounded_status()
        .map_err(|error| format!("打开访达失败：{error}"))?;
    if !status.success() {
        return Err("访达未能打开该位置。".into());
    }
    Ok(())
}

#[cfg(windows)]
pub fn reveal_with_system(target: &RevealTarget) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    let text = target
        .path
        .to_str()
        .ok_or_else(|| "文件路径包含无法识别的字符。".to_string())?;
    let path = strip_verbatim_prefix(text);
    let explorer = std::env::var_os("SystemRoot")
        .map(|root| PathBuf::from(root).join("explorer.exe"))
        .filter(|path| path.is_file())
        .unwrap_or_else(|| PathBuf::from("explorer.exe"));
    let mut command = std::process::Command::new(explorer);
    // 资源管理器自己解析命令行：/select, 后面的路径必须整体加引号，中文与空格才能正确识别。
    // Windows 路径不能包含双引号，因此这里的拼接不会被截断。
    if target.select {
        command.raw_arg(format!("/select,\"{path}\""));
    } else {
        command.raw_arg(format!("\"{path}\""));
    }
    // explorer.exe 即使成功也常返回非 0，不以退出码判断结果。
    let mut child = command
        .spawn()
        .map_err(|error| format!("打开资源管理器失败：{error}"))?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

#[cfg(not(any(target_os = "macos", windows)))]
pub fn reveal_with_system(_target: &RevealTarget) -> Result<(), String> {
    Err("当前平台不支持在文件夹中显示。".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn roots(app_data: &Path) -> LocalFileRoots {
        let runtime = app_data.join("runtime");
        LocalFileRoots {
            app_data: app_data.to_path_buf(),
            bin: runtime.join("bin"),
            runtime,
            updater: app_data.join("updater"),
            xray_file_name: "xray",
        }
    }

    fn app_data_dir() -> (tempfile::TempDir, PathBuf) {
        let folder = tempfile::tempdir().unwrap();
        // 中文与空格，覆盖 Windows 用户名/目录的常见情况。
        let app_data = folder.path().join("应用 数据").join("app.chordv.desktop");
        fs::create_dir_all(app_data.join("runtime").join("bin")).unwrap();
        fs::create_dir_all(app_data.join("updater")).unwrap();
        (folder, app_data)
    }

    #[test]
    fn rejects_paths_outside_app_data_dir() {
        let (folder, app_data) = app_data_dir();
        let outside = folder.path().join("outside.txt");
        fs::write(&outside, b"x").unwrap();
        assert!(resolve_reveal_target(&app_data, &outside).is_err());
        assert!(resolve_reveal_target(&app_data, folder.path()).is_err());
        let escaped = app_data.join("runtime").join("..").join("..").join("outside.txt");
        assert!(resolve_reveal_target(&app_data, &escaped).is_err());
        assert!(resolve_reveal_target(&app_data, Path::new("runtime/bin/xray")).is_err());
        // 不存在的外部路径退到上级目录后仍在外部，同样拒绝。
        assert!(resolve_reveal_target(&app_data, &folder.path().join("missing").join("x")).is_err());
    }

    #[test]
    fn rejects_session_json_even_inside_app_data_dir() {
        let (_folder, app_data) = app_data_dir();
        let session = app_data.join("session.json");
        assert!(resolve_reveal_target(&app_data, &session).is_err(), "missing session.json");
        fs::write(&session, b"{}").unwrap();
        assert!(resolve_reveal_target(&app_data, &session).is_err());
        assert!(resolve_reveal_target(&app_data, &app_data.join("SESSION.JSON")).is_err());
        assert!(resolve_reveal_target(&app_data, &app_data.join("session.json.tmp")).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinks_that_escape_app_data_dir() {
        let (folder, app_data) = app_data_dir();
        let outside = folder.path().join("secret.txt");
        fs::write(&outside, b"x").unwrap();
        let link = app_data.join("runtime").join("bin").join("xray");
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        assert!(resolve_reveal_target(&app_data, &link).is_err());
        let session = app_data.join("session.json");
        fs::write(&session, b"{}").unwrap();
        let alias = app_data.join("runtime").join("alias");
        std::os::unix::fs::symlink(&session, &alias).unwrap();
        assert!(resolve_reveal_target(&app_data, &alias).is_err(), "link to credentials");
    }

    #[test]
    fn accepts_runtime_bin_files_and_directories() {
        let (_folder, app_data) = app_data_dir();
        let xray = app_data.join("runtime").join("bin").join("xray");
        fs::write(&xray, b"bin").unwrap();
        let target = resolve_reveal_target(&app_data, &xray).unwrap();
        assert_eq!(target.path, xray.canonicalize().unwrap());
        assert!(target.select);
        let runtime = resolve_reveal_target(&app_data, &app_data.join("runtime")).unwrap();
        assert!(!runtime.select);
        let root = resolve_reveal_target(&app_data, &app_data).unwrap();
        assert_eq!(root.path, app_data.canonicalize().unwrap());
        assert!(!root.select);
    }

    #[test]
    fn missing_file_reveals_parent_directory() {
        let (_folder, app_data) = app_data_dir();
        let geoip = app_data.join("runtime").join("bin").join("geoip.dat");
        let target = resolve_reveal_target(&app_data, &geoip).unwrap();
        assert_eq!(target.path, app_data.join("runtime").join("bin").canonicalize().unwrap());
        assert!(!target.select);
    }

    #[test]
    fn describe_lists_fixed_entries_without_credentials() {
        let (_folder, app_data) = app_data_dir();
        fs::write(app_data.join("session.json"), b"{}").unwrap();
        fs::write(app_data.join("runtime").join("bin").join("geosite.dat"), b"12345").unwrap();
        let entries = describe(&roots(&app_data));
        let kinds: Vec<_> = entries.iter().map(|entry| entry.kind).collect();
        assert_eq!(kinds, LocalFileKind::ALL.to_vec());
        for entry in &entries {
            assert!(!entry.path.to_lowercase().contains("session.json"));
            assert!(Path::new(&entry.path).starts_with(&app_data));
            assert!(resolve_reveal_target(&app_data, Path::new(&entry.path)).is_ok(), "{:?}", entry.kind);
        }
        let geosite = entries.iter().find(|entry| entry.kind == LocalFileKind::Geosite).unwrap();
        assert!(geosite.exists);
        assert_eq!(geosite.size_bytes, Some(5));
        let xray = entries.iter().find(|entry| entry.kind == LocalFileKind::Xray).unwrap();
        assert!(!xray.exists);
        assert_eq!(xray.size_bytes, None);
        let runtime = entries.iter().find(|entry| entry.kind == LocalFileKind::Runtime).unwrap();
        assert!(runtime.exists && runtime.is_directory && runtime.size_bytes.is_none());
    }

    #[test]
    fn verbatim_prefix_is_removed_for_explorer() {
        assert_eq!(strip_verbatim_prefix(r"\\?\C:\Users\张 三\AppData"), r"C:\Users\张 三\AppData");
        assert_eq!(strip_verbatim_prefix(r"\\?\UNC\server\share\x"), r"\\server\share\x");
        assert_eq!(strip_verbatim_prefix(r"C:\plain"), r"C:\plain");
    }
}
