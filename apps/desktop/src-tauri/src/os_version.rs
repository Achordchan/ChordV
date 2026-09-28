//! 系统版本标签（打开工单时附带给客服）：macOS 15.1（24B83，arm64）/ Windows 11 23H2（22631.4317，x64）。
//! 只读取系统版本号，不含主机名、用户名或路径；结果在本次运行内缓存，取不到时返回 None（前端显示“未知”）。

/// 解析 `sw_vers` 的输出（ProductVersion / BuildVersion 两行）。
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn macos_label_from_sw_vers(output: &str, architecture: &str) -> Option<String> {
    let mut version = None;
    let mut build = None;
    for line in output.lines() {
        let Some((key, value)) = line.split_once(':') else { continue };
        let value = value.trim();
        match key.trim() {
            "ProductVersion" if is_version_token(value) => version = Some(value.to_string()),
            "BuildVersion" if is_version_token(value) => build = Some(value.to_string()),
            _ => {}
        }
    }
    let version = version?;
    Some(with_details(format!("macOS {version}"), build.as_deref(), architecture))
}

/// `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion` 里用到的几个值。
#[derive(Debug, Default, PartialEq, Eq)]
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) struct WindowsVersionValues {
    pub product_name: Option<String>,
    /// Client / Server / Server Core；服务器版的内部版本号与桌面版重叠，不能只按版本号判断。
    pub installation_type: Option<String>,
    pub display_version: Option<String>,
    pub current_build: Option<String>,
    pub ubr: Option<u32>,
}

/// 解析 `reg query "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion"` 的输出：
/// 每行形如 `    CurrentBuild    REG_SZ    22631`，UBR 是 REG_DWORD（`0x10dd`）。
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn parse_windows_reg_query(output: &str) -> WindowsVersionValues {
    let mut values = WindowsVersionValues::default();
    for line in output.lines() {
        let mut parts = line.split_whitespace();
        let (Some(name), Some(kind)) = (parts.next(), parts.next()) else { continue };
        if !kind.starts_with("REG_") {
            continue;
        }
        let data = parts.collect::<Vec<_>>().join(" ");
        match name {
            "ProductName" if kind == "REG_SZ" => values.product_name = Some(data),
            "InstallationType" if kind == "REG_SZ" => values.installation_type = Some(data),
            "DisplayVersion" if kind == "REG_SZ" && is_version_token(&data) => values.display_version = Some(data),
            // 旧版 Windows 10 没有 DisplayVersion，只有 ReleaseId（例如 2004）。
            "ReleaseId" if kind == "REG_SZ" && values.display_version.is_none() && is_version_token(&data) => {
                values.display_version = Some(data)
            }
            "CurrentBuild" if kind == "REG_SZ" && data.chars().all(|ch| ch.is_ascii_digit()) && !data.is_empty() => {
                values.current_build = Some(data)
            }
            "UBR" if kind == "REG_DWORD" => {
                values.ubr = data.strip_prefix("0x").and_then(|hex| u32::from_str_radix(hex, 16).ok())
            }
            _ => {}
        }
    }
    values
}

/// 注册表里的 ProductName 在 Windows 11 上仍写着“Windows 10”，桌面版按内部版本号判断：22000 及以上为 Windows 11。
/// 服务器版（ProductName 含 Server 或 InstallationType 为 Server）的内部版本号与桌面版重叠（Server 2022 为 20348，
/// Server 2025 为 26100），先按服务器版识别，名称取 ProductName 里的年份。
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn windows_label(values: &WindowsVersionValues, architecture: &str) -> Option<String> {
    let build_number = values.current_build.as_deref().and_then(|value| value.parse::<u32>().ok());
    let product_is_server = values.product_name.as_deref().is_some_and(|product| product.split_whitespace().any(|word| word == "Server"));
    let installed_as_server = values.installation_type.as_deref().is_some_and(|kind| kind.starts_with("Server"));
    let name = if product_is_server || installed_as_server {
        let year = values.product_name.as_deref().and_then(|product| {
            let mut words = product.split_whitespace().skip_while(|word| *word != "Server");
            words.next();
            words.next().filter(|word| is_version_token(word) && word.chars().next().is_some_and(|ch| ch.is_ascii_digit()))
        });
        match year {
            Some(year) => format!("Windows Server {year}"),
            None => "Windows Server".to_string(),
        }
    } else {
        match build_number {
            Some(build) if build >= 22000 => "Windows 11".to_string(),
            Some(build) if build >= 10240 => "Windows 10".to_string(),
            _ => values
                .product_name
                .as_deref()
                .and_then(|product| {
                    let mut words = product.split_whitespace();
                    match (words.next(), words.next()) {
                        (Some("Windows"), Some(version)) if is_version_token(version) => Some(format!("Windows {version}")),
                        _ => None,
                    }
                })
                .unwrap_or_else(|| "Windows".to_string()),
        }
    };
    if build_number.is_none() && values.product_name.is_none() {
        return None;
    }
    let title = match values.display_version.as_deref() {
        Some(release) => format!("{name} {release}"),
        None => name,
    };
    let build = build_number.map(|build| match values.ubr {
        Some(ubr) => format!("{build}.{ubr}"),
        None => build.to_string(),
    });
    Some(with_details(title, build.as_deref(), architecture))
}

fn with_details(title: String, build: Option<&str>, architecture: &str) -> String {
    let details: Vec<&str> = [build, Some(architecture).filter(|value| !value.is_empty())]
        .into_iter()
        .flatten()
        .collect();
    if details.is_empty() {
        title
    } else {
        format!("{title}（{}）", details.join("，"))
    }
}

/// 版本号类的值只接受字母、数字和点，最长 20 个字符，避免把异常输出带给客服。
fn is_version_token(value: &str) -> bool {
    !value.is_empty() && value.len() <= 20 && value.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '.')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_sw_vers_output() {
        let output = "ProductName:\t\tmacOS\nProductVersion:\t\t15.1\nBuildVersion:\t\t24B83\n";
        assert_eq!(macos_label_from_sw_vers(output, "arm64").as_deref(), Some("macOS 15.1（24B83，arm64）"));
        assert_eq!(macos_label_from_sw_vers(output, "").as_deref(), Some("macOS 15.1（24B83）"));
        let legacy = "ProductName:\tMac OS X\nProductVersion:\t10.15.7\nBuildVersion:\t19H2026\n";
        assert_eq!(macos_label_from_sw_vers(legacy, "x64").as_deref(), Some("macOS 10.15.7（19H2026，x64）"));
        assert_eq!(macos_label_from_sw_vers("ProductVersion:\t15.1\n", "x64").as_deref(), Some("macOS 15.1（x64）"));
        assert_eq!(macos_label_from_sw_vers("", "arm64"), None);
        assert_eq!(macos_label_from_sw_vers("ProductVersion:\t/Users/me\n", "arm64"), None, "异常输出不带给客服");
    }

    #[test]
    fn parses_windows_registry_values() {
        let output = "\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\r\n    SystemRoot    REG_SZ    C:\\WINDOWS\r\n    CurrentBuild    REG_SZ    22631\r\n    ProductName    REG_SZ    Windows 10 Pro\r\n    DisplayVersion    REG_SZ    23H2\r\n    ReleaseId    REG_SZ    2009\r\n    UBR    REG_DWORD    0x10dd\r\n    RegisteredOwner    REG_SZ    Some Person\r\n";
        let values = parse_windows_reg_query(output);
        assert_eq!(
            values,
            WindowsVersionValues {
                product_name: Some("Windows 10 Pro".into()),
                installation_type: None,
                display_version: Some("23H2".into()),
                current_build: Some("22631".into()),
                ubr: Some(4317),
            }
        );
        let label = windows_label(&values, "x64").unwrap();
        assert_eq!(label, "Windows 11 23H2（22631.4317，x64）", "内部版本号 22000 及以上是 Windows 11");
        assert!(!label.contains("Some Person") && !label.contains("WINDOWS"), "只取版本相关的值");
    }

    #[test]
    fn labels_windows_server_before_build_mapping() {
        let server_2022 = parse_windows_reg_query("    CurrentBuild    REG_SZ    20348\r\n    ProductName    REG_SZ    Windows Server 2022 Datacenter\r\n    InstallationType    REG_SZ    Server\r\n    DisplayVersion    REG_SZ    21H2\r\n    UBR    REG_DWORD    0xa8c\r\n");
        assert_eq!(windows_label(&server_2022, "x64").as_deref(), Some("Windows Server 2022 21H2（20348.2700，x64）"), "20348 不能当成 Windows 10");
        let server_2025 = parse_windows_reg_query("    CurrentBuild    REG_SZ    26100\n    ProductName    REG_SZ    Windows Server 2025 Standard\n    InstallationType    REG_SZ    Server Core\n    DisplayVersion    REG_SZ    24H2\n");
        assert_eq!(windows_label(&server_2025, "x64").as_deref(), Some("Windows Server 2025 24H2（26100，x64）"), "26100 不能当成 Windows 11");
        // ProductName 没写服务器，但安装类型是服务器：同样不按桌面版版本号判断。
        let typed_only = WindowsVersionValues {
            product_name: Some("Windows 10 Pro".into()),
            installation_type: Some("Server".into()),
            current_build: Some("26100".into()),
            ..Default::default()
        };
        assert_eq!(windows_label(&typed_only, "x64").as_deref(), Some("Windows Server（26100，x64）"));
        let client = WindowsVersionValues {
            product_name: Some("Windows 10 Pro".into()),
            installation_type: Some("Client".into()),
            current_build: Some("26100".into()),
            ..Default::default()
        };
        assert_eq!(windows_label(&client, "arm64").as_deref(), Some("Windows 11（26100，arm64）"));
    }

    #[test]
    fn labels_windows_10_and_older_values() {
        let win10 = WindowsVersionValues {
            product_name: Some("Windows 10 Home".into()),
            installation_type: Some("Client".into()),
            display_version: Some("22H2".into()),
            current_build: Some("19045".into()),
            ubr: Some(5011),
        };
        assert_eq!(windows_label(&win10, "x64").as_deref(), Some("Windows 10 22H2（19045.5011，x64）"));
        let release_id_only = parse_windows_reg_query("    CurrentBuild    REG_SZ    19041\n    ReleaseId    REG_SZ    2004\n");
        assert_eq!(windows_label(&release_id_only, "arm64").as_deref(), Some("Windows 10 2004（19041，arm64）"));
        let old = WindowsVersionValues { product_name: Some("Windows 8.1 Pro".into()), current_build: Some("9600".into()), ..Default::default() };
        assert_eq!(windows_label(&old, "x64").as_deref(), Some("Windows 8.1（9600，x64）"));
        assert_eq!(windows_label(&WindowsVersionValues::default(), "x64"), None);
        let bad_ubr = parse_windows_reg_query("    CurrentBuild    REG_SZ    22631\n    UBR    REG_DWORD    garbage\n");
        assert_eq!(windows_label(&bad_ubr, "x64").as_deref(), Some("Windows 11（22631，x64）"));
    }
}
