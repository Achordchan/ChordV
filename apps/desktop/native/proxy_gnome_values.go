package main

import (
	"errors"
	"fmt"
	"path/filepath"
	"strconv"
	"strings"
)

const gnomeProxyKind = "gnome"
const gnomeProxyService = "current-user-gnome"

type gnomeProxyKey struct{ schema, key, field, kind string }

var gnomeProxyKeys = []gnomeProxyKey{
	{"org.gnome.system.proxy", "mode", "mode", "mode"},
	{"org.gnome.system.proxy", "autoconfig-url", "autoconfig-url", "string"},
	{"org.gnome.system.proxy", "ignore-hosts", "ignore-hosts", "array"},
	{"org.gnome.system.proxy", "use-same-proxy", "use-same-proxy", "bool"},
	{"org.gnome.system.proxy.http", "enabled", "http.enabled", "bool"},
	{"org.gnome.system.proxy.http", "host", "http.host", "string"},
	{"org.gnome.system.proxy.http", "port", "http.port", "port"},
	{"org.gnome.system.proxy.http", "use-authentication", "http.use-authentication", "bool"},
	{"org.gnome.system.proxy.https", "host", "https.host", "string"},
	{"org.gnome.system.proxy.https", "port", "https.port", "port"},
	{"org.gnome.system.proxy.ftp", "host", "ftp.host", "string"},
	{"org.gnome.system.proxy.ftp", "port", "ftp.port", "port"},
	{"org.gnome.system.proxy.socks", "host", "socks.host", "string"},
	{"org.gnome.system.proxy.socks", "port", "socks.port", "port"},
}

func gnomeDerived(values map[string]string) {
	values["enabled"] = "No"
	if values["mode"] != "'none'" {
		values["enabled"] = "Yes"
	}
	values["authenticated"] = "0"
	if values["http.use-authentication"] == "true" {
		values["authenticated"] = "1"
	}
}
func validateGNOMEProxy(setting proxySetting) error {
	if setting.Kind != gnomeProxyKind || setting.Service != gnomeProxyService || len(setting.Values) != len(gnomeProxyKeys)+2 {
		return errors.New("GNOME代理快照结构无效")
	}
	if setting.Scope != "" {
		if normalized, err := normalizedSHA256(setting.Scope); err != nil || normalized != setting.Scope {
			return errors.New("GNOME代理配置空间标识无效")
		}
	}
	for _, key := range gnomeProxyKeys {
		value, ok := setting.Values[key.field]
		if !ok || len(value) > 65536 || strings.ContainsRune(value, '\x00') {
			return errors.New("GNOME代理快照字段无效")
		}
		switch key.kind {
		case "mode":
			if value != "'none'" && value != "'manual'" && value != "'auto'" {
				return errors.New("GNOME代理模式无效")
			}
		case "bool":
			if value != "true" && value != "false" {
				return errors.New("GNOME代理布尔值无效")
			}
		case "port":
			port, err := strconv.Atoi(value)
			if err != nil || port < 0 || port > 65535 || strconv.Itoa(port) != value {
				return errors.New("GNOME代理端口无效")
			}
		case "string":
			if len(value) < 2 || (value[0] != '\'' && value[0] != '"') || value[len(value)-1] != value[0] {
				return errors.New("GNOME代理字符串无效")
			}
		case "array":
			raw := strings.TrimPrefix(value, "@as ")
			if !strings.HasPrefix(raw, "[") || !strings.HasSuffix(raw, "]") {
				return errors.New("GNOME代理忽略列表无效")
			}
		}
	}
	expected := map[string]string{"mode": setting.Values["mode"], "http.use-authentication": setting.Values["http.use-authentication"]}
	gnomeDerived(expected)
	if expected["enabled"] != setting.Values["enabled"] || expected["authenticated"] != setting.Values["authenticated"] {
		return errors.New("GNOME代理状态标志不一致")
	}
	return nil
}
func gnomeOwnedProxy(before proxySetting, httpPort, socksPort int) (proxySetting, error) {
	if err := validateGNOMEProxy(before); err != nil {
		return proxySetting{}, err
	}
	if before.Values["authenticated"] == "1" {
		return proxySetting{}, errors.New("GNOME认证代理不能接管")
	}
	if httpPort < 1 || httpPort > 65535 || socksPort < 1 || socksPort > 65535 {
		return proxySetting{}, errors.New("GNOME本地代理端口无效")
	}
	owned := proxySetting{Service: before.Service, Kind: before.Kind, Scope: before.Scope, Values: map[string]string{}}
	for key, value := range before.Values {
		owned.Values[key] = value
	}
	owned.Values["mode"] = "'manual'"
	owned.Values["autoconfig-url"] = "''"
	owned.Values["use-same-proxy"] = "false"
	for _, protocol := range []string{"http", "https", "socks"} {
		owned.Values[protocol+".host"] = "'127.0.0.1'"
		port := httpPort
		if protocol == "socks" {
			port = socksPort
		}
		owned.Values[protocol+".port"] = strconv.Itoa(port)
	}
	owned.Values["ftp.host"] = "''"
	owned.Values["ftp.port"] = "0"
	gnomeDerived(owned.Values)
	return owned, nil
}
func gnomePartiallyOwned(current, before, owned proxySetting) bool {
	if validateGNOMEProxy(current) != nil || validateGNOMEProxy(before) != nil || validateGNOMEProxy(owned) != nil {
		return false
	}
	if current.Scope != before.Scope || current.Scope != owned.Scope {
		return false
	}
	for _, key := range gnomeProxyKeys {
		value := current.Values[key.field]
		if key.field == "mode" && value == "'none'" {
			continue
		} // All multi-key writes first disable the proxy.
		if value != before.Values[key.field] && value != owned.Values[key.field] {
			return false
		}
	}
	return true
}

func gnomeSessionEnvironment(source []string) []string {
	values := map[string]string{}
	for _, entry := range source {
		key, value, ok := strings.Cut(entry, "=")
		if ok {
			values[key] = value
		}
	}
	desktop := false
	for _, part := range strings.Split(values["XDG_CURRENT_DESKTOP"], ":") {
		if strings.EqualFold(part, "GNOME") {
			desktop = true
		}
	}
	bus := values["DBUS_SESSION_BUS_ADDRESS"]
	if !desktop || (!strings.HasPrefix(bus, "unix:path=") && !strings.HasPrefix(bus, "unix:abstract=")) || strings.ContainsAny(bus, ";\n\r\x00") || !filepath.IsAbs(values["XDG_RUNTIME_DIR"]) {
		return nil
	}
	result := []string{}
	for _, key := range []string{"DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR", "XDG_CURRENT_DESKTOP", "XDG_SESSION_DESKTOP", "DESKTOP_SESSION", "XDG_CONFIG_HOME", "DCONF_PROFILE"} {
		if value := values[key]; value != "" {
			if strings.ContainsAny(value, "\x00\n\r") {
				return nil
			}
			result = append(result, fmt.Sprintf("%s=%s", key, value))
		}
	}
	return result
}
