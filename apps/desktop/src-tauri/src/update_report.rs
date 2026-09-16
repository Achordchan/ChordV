/// Accept both native UTF-8 reports and Windows PowerShell 5.1 UTF-8 BOM reports.
pub fn parse(raw: &str) -> Result<serde_json::Value, String> {
    serde_json::from_str(raw.trim_start_matches('\u{feff}'))
        .map_err(|error| format!("failed to parse update install report: {error}"))
}

#[cfg(test)]
mod tests {
    #[test]
    fn accepts_native_and_windows_reports_without_losing_chinese() {
        for prefix in ["", "\u{feff}"] {
            let raw = format!("{prefix}{{\"ok\":false,\"summary\":\"安装失败\"}}\r\n");
            let result = super::parse(&raw).unwrap();
            assert_eq!(result["ok"], false);
            assert_eq!(result["summary"], "安装失败");
        }
        assert!(super::parse("\u{feff}{broken").is_err());
    }
}
