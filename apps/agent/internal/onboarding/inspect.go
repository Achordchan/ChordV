// Package onboarding performs the installer's read-only checks before an agent
// identity or service is created. Panel secrets never leave this process.
package onboarding

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/Achordchan/ChordV/apps/agent/internal/xray"
)

var tagPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,32}$`)
var socketPattern = regexp.MustCompile(`^/[A-Za-z0-9_./-]+$`)
var versionPattern = regexp.MustCompile(`^v?3\.(\d+)\.(\d+)$`)

type Config struct {
	API struct {
		Tag      string   `json:"tag"`
		Listen   string   `json:"listen"`
		Services []string `json:"services"`
	} `json:"api"`
	Inbounds []struct {
		Tag      string          `json:"tag"`
		Listen   string          `json:"listen"`
		Port     json.RawMessage `json:"port"`
		Protocol string          `json:"protocol"`
	} `json:"inbounds"`
	Routing struct {
		Rules []struct {
			InboundTag  []string `json:"inboundTag"`
			OutboundTag string   `json:"outboundTag"`
		} `json:"rules"`
	} `json:"routing"`
	Policy struct {
		Levels map[string]struct {
			Up   bool `json:"statsUserUplink"`
			Down bool `json:"statsUserDownlink"`
		} `json:"levels"`
	} `json:"policy"`
	Stats json.RawMessage `json:"stats"`
}

func SupportedVersion(value string) bool {
	parts := versionPattern.FindStringSubmatch(strings.TrimSpace(value))
	if parts == nil {
		return false
	}
	minor, err := strconv.Atoi(parts[1])
	return err == nil && minor >= 7
}

// APIAddress accepts one unambiguous local control listener. No default port is
// guessed, and a missing listen address is never treated as loopback.
func APIAddress(data []byte) (string, error) {
	var config Config
	if json.Unmarshal(data, &config) != nil {
		return "", fmt.Errorf("面板 Xray 配置不是有效 JSON")
	}
	services := map[string]bool{}
	for _, service := range config.API.Services {
		services[service] = true
	}
	if !services["HandlerService"] || !services["StatsService"] {
		return "", fmt.Errorf("请在面板开启 HandlerService 和 StatsService")
	}
	level := config.Policy.Levels["0"]
	if !level.Up || !level.Down || len(config.Stats) == 0 || string(config.Stats) == "null" {
		return "", fmt.Errorf("面板必须开启 level 0 上下行用户统计及 stats")
	}
	var addresses []string
	if config.API.Listen != "" {
		addresses = append(addresses, config.API.Listen)
	}
	for _, inbound := range config.Inbounds {
		routed := false
		for _, rule := range config.Routing.Rules {
			for _, tag := range rule.InboundTag {
				if tag == inbound.Tag && rule.OutboundTag == config.API.Tag && config.API.Tag != "" {
					routed = true
				}
			}
		}
		// Current 3x-ui uses Xray's "tunnel" name; older supported builds use
		// its dokodemo-door alias. Routing to the API tag is required for both.
		if !routed || (inbound.Protocol != "dokodemo-door" && inbound.Protocol != "tunnel") {
			continue
		}
		portText := strings.Trim(string(inbound.Port), `"`)
		port, err := strconv.Atoi(portText)
		if err != nil || port < 1 || port > 65535 {
			return "", fmt.Errorf("面板 API 端口不是单个有效端口")
		}
		addresses = append(addresses, net.JoinHostPort(inbound.Listen, strconv.Itoa(port)))
	}
	if len(addresses) != 1 {
		return "", fmt.Errorf("未找到唯一的面板 API 监听，请检查面板 Xray 配置")
	}
	address := addresses[0]
	if strings.HasPrefix(address, "unix:") {
		path := filepath.Clean(strings.TrimPrefix(strings.TrimPrefix(address, "unix:"), "//"))
		if !socketPattern.MatchString(path) || !serviceSocketPath(path) {
			return "", fmt.Errorf("面板 API socket 必须位于服务可见的 /run 或 /var/run，不能位于临时目录或用户目录")
		}
		return "unix:" + path, nil
	}
	host, portText, err := net.SplitHostPort(address)
	port, portErr := strconv.Atoi(portText)
	ip := net.ParseIP(host)
	if err != nil || portErr != nil || port < 1 || port > 65535 || ip == nil || !ip.IsLoopback() || (host != "127.0.0.1" && host != "::1") {
		return "", fmt.Errorf("面板无鉴权 API 必须绑定本机回环地址")
	}
	return net.JoinHostPort(host, strconv.Itoa(port)), nil
}

// Inspect identifies the running native x-ui service and its actual Xray child
// configuration through /proc. Custom/container layouts fail explicitly rather
// than accidentally inspecting an unused default file.
func Inspect(ctx context.Context, panelPID int, specPath string) (string, error) {
	if panelPID <= 1 {
		return "", fmt.Errorf("未检测到运行中的原生 x-ui.service")
	}
	panelExe := fmt.Sprintf("/proc/%d/exe", panelPID)
	exe, err := os.Readlink(panelExe)
	if err != nil || exe != "/usr/local/x-ui/x-ui" {
		return "", fmt.Errorf("仅支持 /usr/local/x-ui/x-ui 的原生 3x-ui 服务")
	}
	versionCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	output, err := exec.CommandContext(versionCtx, panelExe, "-v").Output()
	panelVersion := strings.TrimSpace(string(output))
	if err != nil || !SupportedVersion(panelVersion) {
		return "", fmt.Errorf("运行中的 3x-ui 必须为 3.7.0 或以上的 3.x 稳定版")
	}
	configPath, err := runningConfig(panelPID)
	if err != nil {
		return "", err
	}
	data, err := readBounded(configPath, 16*1024*1024)
	if err != nil {
		return "", fmt.Errorf("无法只读获取面板运行配置")
	}
	address, err := APIAddress(data)
	if err != nil {
		return "", err
	}
	if err := validateServiceSocket(address); err != nil {
		return "", err
	}
	specData, err := readBounded(specPath, 16*1024)
	if err != nil {
		return "", fmt.Errorf("无法读取待接入参数")
	}
	var spec map[string]any
	if json.Unmarshal(specData, &spec) != nil {
		return "", fmt.Errorf("待接入参数格式错误")
	}
	if spec["mode"] == "awaiting_panel" {
		if err := VerifyEnvironment(ctx, address); err != nil {
			return "", err
		}
		return fmt.Sprintf("XRAY_API_ADDRESS=%s\nAGENT_WAIT_FOR_INBOUND=true\nCHORDV_PANEL_VERSION=%s\n", address, panelVersion), nil
	}
	tag, _ := spec["inboundTag"].(string)
	if !tagPattern.MatchString(tag) {
		return "", fmt.Errorf("待接入 tag 格式错误")
	}
	adapter, err := xray.New(address, tag)
	if err != nil {
		return "", err
	}
	defer adapter.Close()
	tag, err = adapter.DiscoverPanelTag(ctx, spec)
	if err != nil {
		return "", fmt.Errorf("实际入站校验失败：%w", err)
	}
	if err := adapter.Health(ctx); err != nil {
		return "", fmt.Errorf("面板统计 API 不可用")
	}
	// All output fields have strict character sets; stdout is an EnvironmentFile,
	// never a dump of the panel config or its Reality private key.
	return fmt.Sprintf("XRAY_API_ADDRESS=%s\nXRAY_INBOUND_TAG=%s\nCHORDV_PANEL_VERSION=%s\n", address, tag, panelVersion), nil
}

func readBounded(path string, limit int64) ([]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	stat, err := file.Stat()
	if err != nil || !stat.Mode().IsRegular() || stat.Size() > limit {
		return nil, fmt.Errorf("文件大小或类型无效")
	}
	data := make([]byte, stat.Size())
	_, err = file.ReadAt(data, 0)
	return data, err
}

// Verify repeats the live check under the service account. A root probe alone
// cannot prove that the service can access a Unix socket's permissions.
func Verify(ctx context.Context, address, tag, specPath string) error {
	if err := validateServiceSocket(address); err != nil {
		return err
	}
	data, err := readBounded(specPath, 16*1024)
	if err != nil {
		return fmt.Errorf("服务用户无法读取公共入站参数")
	}
	var spec map[string]any
	if json.Unmarshal(data, &spec) != nil {
		return fmt.Errorf("入站参数格式错误")
	}
	if spec["mode"] == "awaiting_panel" {
		return VerifyEnvironment(ctx, address)
	}
	if !tagPattern.MatchString(tag) {
		return fmt.Errorf("入站参数格式错误")
	}
	spec["inboundTag"] = tag
	adapter, err := xray.New(address, tag)
	if err != nil {
		return err
	}
	defer adapter.Close()
	if _, err := adapter.ValidatePanel(ctx, spec); err != nil {
		return err
	}
	return adapter.Health(ctx)
}

// PrivateTmp hides temporary directories, and ProtectHome also hides /run/user.
// Validate both the configured name and the resolved socket to reject symlink
// aliases into those namespaces before replacing any existing service.
func serviceSocketPath(path string) bool {
	return (strings.HasPrefix(path, "/run/") || strings.HasPrefix(path, "/var/run/")) &&
		path != "/run/user" && !strings.HasPrefix(path, "/run/user/") &&
		path != "/var/run/user" && !strings.HasPrefix(path, "/var/run/user/")
}

func validateServiceSocket(address string) error {
	if !strings.HasPrefix(address, "unix:") {
		return nil
	}
	path := filepath.Clean(strings.TrimPrefix(strings.TrimPrefix(address, "unix:"), "//"))
	if !serviceSocketPath(path) {
		return fmt.Errorf("面板 API socket 被服务隔离设置隐藏，请使用 /run 下的系统级 socket")
	}
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		return fmt.Errorf("面板 API socket 不存在或服务用户不可访问")
	}
	if !serviceSocketPath(resolved) {
		return fmt.Errorf("面板 API socket 链接指向服务不可见的临时或用户目录")
	}
	return nil
}

func runningConfig(panelPID int) (string, error) {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return "", fmt.Errorf("无法读取面板进程状态")
	}
	var found []string
	for _, entry := range entries {
		if _, err := strconv.Atoi(entry.Name()); err != nil {
			continue
		}
		base := filepath.Join("/proc", entry.Name())
		status, err := os.ReadFile(filepath.Join(base, "status"))
		if err != nil {
			continue
		}
		child := false
		for _, line := range strings.Split(string(status), "\n") {
			if strings.HasPrefix(line, "PPid:") && strings.TrimSpace(strings.TrimPrefix(line, "PPid:")) == strconv.Itoa(panelPID) {
				child = true
			}
		}
		if !child {
			continue
		}
		exe, _ := os.Readlink(filepath.Join(base, "exe"))
		if !strings.HasPrefix(exe, "/usr/local/x-ui/bin/xray-") || strings.HasSuffix(exe, " (deleted)") {
			continue
		}
		cmd, err := os.ReadFile(filepath.Join(base, "cmdline"))
		if err != nil {
			continue
		}
		args := strings.Split(string(cmd), "\x00")
		for i := 1; i+1 < len(args); i++ {
			if args[i] != "-c" && args[i] != "-config" {
				continue
			}
			path := args[i+1]
			if !filepath.IsAbs(path) {
				cwd, err := os.Readlink(filepath.Join(base, "cwd"))
				if err != nil {
					continue
				}
				path = filepath.Join(cwd, path)
			}
			found = append(found, path)
		}
	}
	if len(found) != 1 {
		return "", fmt.Errorf("无法确定面板唯一的运行中 Xray 配置，未修改任何面板设置")
	}
	return found[0], nil
}

// VerifyEnvironment checks both services under the installing service account.
func VerifyEnvironment(ctx context.Context, address string) error {
	if err := validateServiceSocket(address); err != nil {
		return err
	}
	adapter, err := xray.NewControl(address)
	if err != nil {
		return err
	}
	defer adapter.Close()
	return adapter.ValidateEnvironment(ctx)
}
