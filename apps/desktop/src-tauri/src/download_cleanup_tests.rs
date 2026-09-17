use super::*;
use std::sync::{Arc, Mutex};

struct Directory(PathBuf);
impl Directory {
    fn new() -> Self {
        use std::sync::atomic::{AtomicU64, Ordering};
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "chordv-cleanup-test-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn write(&self, name: &str) -> PathBuf {
        let path = self.0.join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, b"verified component").unwrap();
        path
    }
}
impl Drop for Directory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn failed_download_removes_archive_and_extracted_partial() {
    let dir = Directory::new();
    let archive = dir.write("runtime/downloads/geoip-id-geoip.dat.download");
    let partial = dir.write("runtime/bin/geoip.part");
    let installed = dir.write("runtime/bin/geoip.dat");
    let simulate_failure = || -> Result<(), &'static str> {
        let _guard = TemporaryFiles::new(vec![archive.clone(), partial.clone()], |_| {
            panic!("unexpected cleanup failure")
        });
        Err("checksum mismatch")
    };
    assert!(simulate_failure().is_err());
    assert!(!archive.exists());
    assert!(!partial.exists());
    assert!(installed.exists());
}

#[test]
fn cleanup_failure_is_reported_and_other_files_are_still_removed() {
    let dir = Directory::new();
    let blocked = dir.0.join("blocked.part");
    fs::create_dir(&blocked).unwrap();
    let partial = dir.write("geoip.part");
    let errors = Arc::new(Mutex::new(Vec::new()));
    let captured = errors.clone();
    drop(TemporaryFiles::new(
        vec![blocked.clone(), partial.clone()],
        move |message| captured.lock().unwrap().push(message.to_owned()),
    ));
    assert_eq!(errors.lock().unwrap().len(), 1);
    assert!(!partial.exists());
    assert!(blocked.exists());
}

#[test]
fn successful_replace_keeps_final_file() {
    let dir = Directory::new();
    let partial = dir.write("geoip.part");
    let final_path = dir.0.join("geoip.dat");
    let guard = TemporaryFiles::new(vec![partial.clone()], |_| {
        panic!("missing partial is harmless")
    });
    fs::rename(&partial, &final_path).unwrap();
    drop(guard);
    assert!(final_path.exists());
}

#[test]
fn startup_recovers_backup_and_cleans_interrupted_downloads() {
    let dir = Directory::new();
    let backup = dir.write("bin/geoip.previous");
    let partial = dir.write("bin/geoip.part");
    let archive = dir.write("downloads/geoip-id-data.download");
    let unrelated = dir.write("downloads/user.download");
    cleanup_components(&dir.0, "xray.exe").unwrap();
    assert!(dir.0.join("bin/geoip.dat").exists());
    assert!(!backup.exists());
    assert!(!partial.exists());
    assert!(!archive.exists());
    assert!(unrelated.exists());
}

#[test]
fn startup_removes_backup_only_when_replacement_exists() {
    let dir = Directory::new();
    let target = dir.write("bin/xray.exe");
    let backup = dir.write("bin/xray.previous");
    fs::write(&target, b"new core").unwrap();
    cleanup_components(&dir.0, "xray.exe").unwrap();
    assert_eq!(fs::read(&target).unwrap(), b"new core");
    assert!(!backup.exists());
}

#[test]
fn startup_keeps_only_latest_pending_installer() {
    let dir = Directory::new();
    let old = dir.write("ChordV_1.1.7_x64-setup.exe");
    let installed = dir.write("ChordV_1.1.8_x64-setup.exe");
    let pending = dir.write("ChordV_1.1.9_x64-setup.exe");
    let latest = dir.write("ChordV_1.1.10_x64-setup.exe");
    let partial = dir.write("ChordV_1.1.11_x64-setup.exe.part");
    let unknown = dir.write("user-document.zip");
    cleanup_installers(&dir.0, "1.1.8", None).unwrap();
    for path in [old, installed, pending, partial] {
        assert!(!path.exists(), "{}", path.display());
    }
    assert!(latest.exists());
    assert!(unknown.exists());
}

#[test]
fn newly_verified_package_is_retained_even_when_other_cache_has_higher_version() {
    let dir = Directory::new();
    let selected = dir.write("ChordV_1.1.9_aarch64.dmg");
    let abandoned = dir.write("ChordV_1.2.0_aarch64.dmg");
    cleanup_installers(&dir.0, "1.1.8", Some(&selected)).unwrap();
    assert!(selected.exists());
    assert!(!abandoned.exists());
    cleanup_installers(&dir.0, "1.1.9", None).unwrap();
    assert!(!selected.exists());
}

#[test]
fn same_version_archives_do_not_accumulate_and_cleanup_is_idempotent() {
    let dir = Directory::new();
    dir.write("ChordV_1.1.9_universal.dmg");
    dir.write("ChordV_1.1.9_aarch64.dmg");
    cleanup_installers(&dir.0, "1.1.8", None).unwrap();
    cleanup_installers(&dir.0, "1.1.8", None).unwrap();
    assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 1);
}

#[test]
fn absent_directories_are_safe() {
    let dir = Directory::new();
    cleanup_components(&dir.0.join("missing"), "xray").unwrap();
    cleanup_installers(&dir.0.join("missing"), "1.1.8", None).unwrap();
}

#[cfg(unix)]
#[test]
fn directory_symlinks_are_not_followed() {
    let dir = Directory::new();
    let outside = Directory::new();
    let protected = outside.write("ChordV_1.1.7.dmg");
    std::os::unix::fs::symlink(&outside.0, dir.0.join("linked")).unwrap();
    assert!(cleanup_installers(&dir.0.join("linked"), "1.1.8", None).is_err());
    assert!(protected.exists());
}

#[test]
fn recovery_continues_when_download_directory_is_blocked() {
    let dir = Directory::new();
    dir.write("downloads");
    dir.write("bin/geoip.previous");
    assert!(cleanup_components(&dir.0, "xray").is_err());
    assert!(dir.0.join("bin/geoip.dat").exists());
}

#[test]
fn official_updater_cleanup_requires_exact_layout_and_stale_files() {
    let dir = Directory::new();
    let installer = dir.write("ChordV-1.1.9-updater-ABC123/ChordV-1.1.9-installer.exe");
    let unknown = dir.write("ChordV-1.1.9-updater-DEF456/user-file.txt");
    let other_app = dir.write("OtherApp-1.1.9-updater-ABC123/OtherApp-installer.exe");
    cleanup_official_updater(&dir.0, std::time::SystemTime::UNIX_EPOCH).unwrap();
    assert!(installer.exists(), "recent installer must be retained");
    cleanup_official_updater(
        &dir.0,
        std::time::SystemTime::now() + std::time::Duration::from_secs(1),
    )
    .unwrap();
    assert!(!installer.parent().unwrap().exists());
    assert!(unknown.exists());
    assert!(other_app.exists());
}
