package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

type appConfig struct {
	DataDir           string
	APIBase           string
	ReleaseRepository string
	ReleasePublicKey  string
}

var buildMode = "local"
var defaultAPIBase = "http://127.0.0.1:3100"
var embeddedReleaseRepository string
var embeddedReleasePublicKey string
var embeddedBuildNumber = "0"

func loadConfig() (appConfig, error) {
	base := defaultAPIBase
	if buildMode != "release" {
		if local := strings.TrimRight(strings.TrimSpace(os.Getenv("CHORDV_API_BASE_URL")), "/"); local != "" {
			base = local
		}
	}
	if err := validateAPIBase(base); err != nil {
		return appConfig{}, err
	}
	dir := os.Getenv("CHORDV_MYGO_DATA_DIR")
	if dir == "" {
		root, err := os.UserConfigDir()
		if err != nil {
			return appConfig{}, err
		}
		name := "ChordV-MyGo-Local"
		if buildMode == "release" {
			name = "ChordV"
		}
		dir = filepath.Join(root, name)
	}
	abs, err := filepath.Abs(dir)
	if err != nil {
		return appConfig{}, err
	}
	repository, publicKey := embeddedReleaseRepository, embeddedReleasePublicKey
	if buildMode != "release" {
		if value := os.Getenv("CHORDV_GITHUB_RELEASE_REPOSITORY"); value != "" {
			repository = value
		}
		if value := os.Getenv("CHORDV_GITHUB_RELEASE_PUBLIC_KEY"); value != "" {
			publicKey = value
		}
	}
	if repository != "" && !validRepository(repository) {
		return appConfig{}, errors.New("GitHub 发布仓库格式无效")
	}
	return appConfig{DataDir: abs, APIBase: base, ReleaseRepository: repository, ReleasePublicKey: strings.ReplaceAll(publicKey, `\n`, "\n")}, nil
}

func validateAPIBase(base string) error {
	u, err := url.Parse(base)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return errors.New("API 地址必须是完整来源，不包含路径、参数或凭据")
	}
	if buildMode != "release" {
		return validateLocalURL(base)
	}
	if u.Scheme != "https" {
		return errors.New("正式构建仅允许显式配置的 HTTPS API")
	}
	if base != defaultAPIBase {
		return errors.New("正式构建仅允许安装包内的 API 来源")
	}
	return nil
}

func validateLocalURL(value string) error {
	u, err := url.Parse(value)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || u.Fragment != "" {
		return errors.New("本地调试 API 地址无效")
	}
	ip := net.ParseIP(u.Hostname())
	if ip == nil || !ip.IsLoopback() {
		return errors.New("本地调试仅允许回环地址，不能访问线上 API")
	}
	return nil
}

func (s *DesktopService) apiHTTPClient(timeout time.Duration) *http.Client {
	return &http.Client{
		Timeout:   timeout,
		Transport: s.apiTransport,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 5 {
				return errors.New("重定向次数过多")
			}
			base, _ := url.Parse(s.cfg.APIBase)
			if req.URL.Scheme != base.Scheme || req.URL.Host != base.Host || req.URL.User != nil {
				return errors.New("API 不能跳转到其他来源")
			}
			return nil
		},
	}
}

var newAPITransport = func() *http.Transport {
	return &http.Transport{Proxy: nil, DialContext: (&net.Dialer{Timeout: 10 * time.Second}).DialContext, ResponseHeaderTimeout: 15 * time.Second, TLSHandshakeTimeout: 10 * time.Second, IdleConnTimeout: 90 * time.Second, MaxIdleConns: 16, MaxIdleConnsPerHost: 8}
}

func atomicJSON(path string, value any) error {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	return atomicFile(path, data, 0600)
}

func atomicFile(path string, data []byte, mode os.FileMode) error {
	return publishAtomicFile(path, data, mode, os.Rename)
}

func publishAtomicFile(path string, data []byte, mode os.FileMode, publish func(string, string) error) error {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".chordv-*")
	if err != nil {
		return err
	}
	name := f.Name()
	defer os.Remove(name)
	if err = f.Chmod(mode); err == nil {
		_, err = f.Write(data)
	}
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	return publish(name, path)
}

func commandOutput(ctx context.Context, program string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, program, args...)
	hideCommandWindow(cmd)
	bytes, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("%s 执行失败：%w", filepath.Base(program), err)
	}
	return strings.TrimSpace(string(bytes)), nil
}

func platformName() string {
	if runtime.GOOS == "darwin" {
		return "macos"
	}
	return runtime.GOOS
}

func architectureName() string {
	if runtime.GOARCH == "amd64" {
		return "x64"
	}
	return runtime.GOARCH
}

func xrayFileName() string {
	if runtime.GOOS == "windows" {
		return "xray.exe"
	}
	return "xray"
}

func nilString(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func applicationName() string {
	if buildMode == "release" {
		return "ChordV"
	}
	return "ChordV MyGo Local"
}

func systemProcessEnvironment() []string {
	environment := []string{}
	for _, entry := range os.Environ() {
		name, _, _ := strings.Cut(entry, "=")
		switch strings.ToUpper(name) {
		case "PATH", "HOME", "USER", "LOGNAME", "USERPROFILE", "SYSTEMROOT", "WINDIR", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "TMPDIR", "LANG":
			environment = append(environment, entry)
		default:
			if strings.HasPrefix(strings.ToUpper(name), "LC_") {
				environment = append(environment, entry)
			}
		}
	}
	if runtime.GOOS == "linux" {
		environment = append(environment, gnomeSessionEnvironment(os.Environ())...)
	}
	return environment
}
