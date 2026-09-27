//! Build number embedded by CI (`CHORDV_BUILD_NUMBER`). The version stays plain
//! (for example 1.1.10); the build only orders successive installers of it.
use semver::Version;
use std::cmp::Ordering;

pub fn embedded_build_number() -> Option<u64> {
    parse_build_number(option_env!("CHORDV_BUILD_NUMBER"))
}

fn parse_build_number(raw: Option<&str>) -> Option<u64> {
    raw.map(str::trim).filter(|value| !value.is_empty()).and_then(|value| value.parse::<u64>().ok()).filter(|value| *value > 0)
}

/// "1.1.10+42" -> "1.1.10"; the server only adds build metadata for clients that report a build.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn strip_build_metadata(version: &str) -> &str {
    version.split('+').next().unwrap_or(version)
}

#[cfg_attr(not(windows), allow(dead_code))]
pub fn build_from_version(version: &str) -> Option<u64> {
    version.split_once('+').and_then(|(_, build)| parse_build_number(Some(build)))
}

/// A higher version always wins; the same version needs a strictly higher build.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn is_newer_release(current: &Version, remote: &Version, local_build: Option<u64>) -> bool {
    match remote.cmp_precedence(current) {
        Ordering::Greater => true,
        Ordering::Less => false,
        Ordering::Equal => matches!(
            (parse_build_number(Some(remote.build.as_str())), local_build),
            (Some(remote_build), Some(local)) if remote_build > local
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn version(value: &str) -> Version {
        Version::parse(value).unwrap()
    }

    #[test]
    fn same_version_needs_a_higher_build() {
        assert!(is_newer_release(&version("1.1.10"), &version("1.1.10+42"), Some(41)));
        assert!(!is_newer_release(&version("1.1.10"), &version("1.1.10+42"), Some(42)));
        assert!(!is_newer_release(&version("1.1.10"), &version("1.1.10+40"), Some(42)));
        assert!(!is_newer_release(&version("1.1.10"), &version("1.1.10+42"), None));
        assert!(!is_newer_release(&version("1.1.10"), &version("1.1.10"), Some(41)));
    }

    #[test]
    fn version_order_is_unchanged() {
        assert!(is_newer_release(&version("1.1.9"), &version("1.1.10"), None));
        assert!(is_newer_release(&version("1.1.10"), &version("1.1.11+3"), Some(99)));
        assert!(!is_newer_release(&version("1.1.10"), &version("1.1.9+99"), Some(1)));
    }

    #[test]
    fn build_metadata_is_stripped_and_read() {
        assert_eq!(strip_build_metadata("1.1.10+42"), "1.1.10");
        assert_eq!(strip_build_metadata("1.1.10"), "1.1.10");
        assert_eq!(build_from_version("1.1.10+42"), Some(42));
        assert_eq!(build_from_version("1.1.10"), None);
        assert_eq!(parse_build_number(Some("0")), None);
        assert_eq!(parse_build_number(Some("")), None);
    }
}
