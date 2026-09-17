//! Cleanup is restricted to application-owned cache files. Call directory sweeps
//! only at startup or while the corresponding download operation is exclusive.
use std::{
    cmp::Ordering,
    fs, io,
    path::{Path, PathBuf},
};

pub struct TemporaryFiles {
    paths: Vec<PathBuf>,
    report: Box<dyn Fn(&str) + Send>,
}

impl TemporaryFiles {
    pub fn new(paths: Vec<PathBuf>, report: impl Fn(&str) + Send + 'static) -> Self {
        Self {
            paths,
            report: Box::new(report),
        }
    }
}

impl Drop for TemporaryFiles {
    fn drop(&mut self) {
        for path in &self.paths {
            if let Err(error) = remove_file(path) {
                (self.report)(&format!("清理临时文件 {} 失败：{error}", path.display()));
            }
        }
    }
}

fn remove_file(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        result => result,
    }
}

// Never traverse symlinked directories or recursively remove unknown content.
fn cache_files(directory: &Path) -> io::Result<Vec<PathBuf>> {
    match fs::symlink_metadata(directory) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Ok(metadata) if !metadata.file_type().is_dir() => {
            return Err(io::Error::other("缓存目录不是普通目录"))
        }
        Err(error) => return Err(error),
        _ => {}
    }
    fs::read_dir(directory)?
        .filter_map(|entry| match entry {
            Ok(entry) => match entry.file_type() {
                Ok(kind) if kind.is_file() => Some(Ok(entry.path())),
                Ok(_) => None,
                Err(error) => Some(Err(error)),
            },
            Err(error) => Some(Err(error)),
        })
        .collect()
}

pub fn cleanup_components(runtime: &Path, binary_name: &str) -> io::Result<()> {
    let mut errors = Vec::new();
    match cache_files(&runtime.join("downloads")) {
        Ok(paths) => {
            for path in paths {
                let name = path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("");
                if name.ends_with(".download")
                    && ["xray-", "geoip-", "geosite-"]
                        .iter()
                        .any(|prefix| name.starts_with(prefix))
                {
                    record_cleanup(remove_file(&path), &mut errors);
                }
            }
        }
        Err(error) => errors.push(error.to_string()),
    }
    let bin = runtime.join("bin");
    // A blocked download cleanup must not prevent recovery of a working backup.
    match cache_files(&bin) {
        Ok(_) => {
            for name in [binary_name, "geoip.dat", "geosite.dat"] {
                let target = bin.join(name);
                record_cleanup(recover_component(&target), &mut errors);
                record_cleanup(remove_file(&target.with_extension("part")), &mut errors);
            }
        }
        Err(error) => errors.push(error.to_string()),
    }
    cleanup_result(errors)
}

fn recover_component(target: &Path) -> io::Result<()> {
    let previous = target.with_extension("previous");
    match fs::symlink_metadata(&previous) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
        Ok(metadata) if !metadata.file_type().is_file() => {
            return Err(io::Error::other("组件备份不是普通文件"))
        }
        _ => {}
    }
    match fs::symlink_metadata(target) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => fs::rename(&previous, target),
        Ok(metadata) if metadata.file_type().is_file() => remove_file(&previous),
        Ok(_) => Err(io::Error::other("组件目标不是普通文件，保留备份")),
        Err(error) => Err(error),
    }
}

fn record_cleanup(result: io::Result<()>, errors: &mut Vec<String>) {
    if let Err(error) = result {
        errors.push(error.to_string());
    }
}

fn cleanup_result(errors: Vec<String>) -> io::Result<()> {
    if errors.is_empty() {
        Ok(())
    } else {
        Err(io::Error::other(errors.join("；")))
    }
}

/// The official Windows updater exits without dropping its temporary installer.
/// Only remove its exact file layout, never recurse into the shared temp folder.
pub fn cleanup_official_updater(
    directory: &Path,
    stale_before: std::time::SystemTime,
) -> io::Result<()> {
    let mut errors = Vec::new();
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        let Some(rest) = name.strip_prefix("ChordV-") else {
            continue;
        };
        let Some((version, random)) = rest.split_once("-updater-") else {
            continue;
        };
        if parse_version(version).is_none()
            || random.is_empty()
            || !random.bytes().all(|b| b.is_ascii_alphanumeric())
        {
            continue;
        }
        let cleanup = (|| {
            if entry.metadata()?.modified()? > stale_before {
                return Ok(());
            }
            let files = fs::read_dir(entry.path())?.collect::<io::Result<Vec<_>>>()?;
            // Unknown children, links and recent files mean this is not safe to remove.
            for file in &files {
                let name = file.file_name();
                if !file.file_type()?.is_file()
                    || ![
                        format!("ChordV-{version}-installer.exe"),
                        format!("ChordV-{version}-installer.msi"),
                    ]
                    .iter()
                    .any(|allowed| name == allowed.as_str())
                    || file.metadata()?.modified()? > stale_before
                {
                    return Ok(());
                }
            }
            for file in files {
                remove_file(&file.path())?;
            }
            fs::remove_dir(entry.path())
        })();
        record_cleanup(cleanup, &mut errors);
    }
    cleanup_result(errors)
}

/// Keep one pending installer, or the exact package just verified by a download.
/// Installed versions and abandoned partial downloads have no cache value.
pub fn cleanup_installers(directory: &Path, current: &str, keep: Option<&Path>) -> io::Result<()> {
    let current = parse_version(current).ok_or_else(|| io::Error::other("当前应用版本号无效"))?;
    let mut packages = Vec::new();
    let mut errors = Vec::new();
    for path in cache_files(directory)? {
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("");
        if let Some(original) = name.strip_suffix(".part") {
            if installer_version(original).is_some() {
                record_cleanup(remove_file(&path), &mut errors);
            }
        } else if let Some(version) = installer_version(name) {
            packages.push((path, version));
        }
    }
    let newest = packages
        .iter()
        .filter(|(_, version)| compare_versions(version, &current).is_gt())
        .max_by(|(a_path, a), (b_path, b)| compare_versions(a, b).then_with(|| a_path.cmp(b_path)))
        .map(|(path, _)| path.clone());
    let keep = keep.or(newest.as_deref());
    for (path, _) in packages {
        if Some(path.as_path()) != keep {
            record_cleanup(remove_file(&path), &mut errors);
        }
    }
    cleanup_result(errors)
}

fn installer_version(name: &str) -> Option<Vec<u32>> {
    let rest = name.strip_prefix("ChordV_")?;
    for suffix in [".dmg", ".exe", ".zip"] {
        if let Some(version) = rest.strip_suffix(suffix) {
            return parse_version(version.split('_').next()?);
        }
    }
    None
}

fn parse_version(raw: &str) -> Option<Vec<u32>> {
    let raw = raw.trim().trim_start_matches('v');
    if raw.is_empty() {
        return None;
    }
    raw.split('.')
        .map(|part| part.parse::<u32>().ok())
        .collect()
}

fn compare_versions(left: &[u32], right: &[u32]) -> Ordering {
    for index in 0..left.len().max(right.len()) {
        let order = left
            .get(index)
            .unwrap_or(&0)
            .cmp(right.get(index).unwrap_or(&0));
        if !order.is_eq() {
            return order;
        }
    }
    Ordering::Equal
}

#[cfg(test)]
#[path = "download_cleanup_tests.rs"]
mod tests;
