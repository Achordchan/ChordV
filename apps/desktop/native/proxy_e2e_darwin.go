//go:build e2e && darwin

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"time"

	"golang.org/x/sys/unix"
)

const e2eProxyStateName = "qa-proxy-state.json"
const e2eProxyService = "e2e-runtime-proxy"

type e2eProxyDocument struct {
	Schema   int            `json:"schema"`
	TestOnly bool           `json:"testOnly"`
	Settings []proxySetting `json:"settings"`
}

type e2eFileProxy struct {
	dataDir   string
	apiBase   string
	directory os.FileInfo
}

func init() {
	state, explicit := os.LookupEnv("CHORDV_E2E_PROXY_STATE")
	// 仅e2e子命令禁止退回系统恢复；未启用profile的普通GUI启动仍保持原行为。
	if len(os.Args) == 3 && os.Args[1] == "--proxy-watchdog" && (!explicit || state == "") {
		log.Fatal("E2E watchdog缺少显式文件代理profile，启动已停止")
	}
	if explicit {
		if err := installE2EFileProxy(state); err != nil {
			log.Fatal("E2E文件代理配置无效，启动已停止：", err)
		}
	}
}

func installE2EFileProxy(state string) error {
	if os.Getenv("CHORDV_API_BASE_URL") == "" || os.Getenv("CHORDV_MYGO_DATA_DIR") == "" {
		return errors.New("显式文件代理profile必须提供API和数据目录")
	}
	cfg, err := loadConfig()
	if err != nil {
		return err
	}
	if len(os.Args) == 3 && os.Args[1] == "--proxy-watchdog" && os.Args[2] != cfg.DataDir {
		return errors.New("E2E watchdog参数目录与文件profile不一致")
	}
	adapter, err := newE2EFileProxy(state, cfg, buildMode)
	if err != nil {
		return err
	}
	readProxySettings = adapter.read
	writeProxySetting = adapter.write
	prepareProxyAuthorization = func() error { return nil }
	launchProxyWatchdog = adapter.startWatchdog
	return nil
}

func newE2EFileProxy(state string, cfg appConfig, mode string) (*e2eFileProxy, error) {
	if mode != "local" || validateLocalURL(cfg.APIBase) != nil {
		return nil, errors.New("文件代理仅限本地构建和回环API")
	}
	if !filepath.IsAbs(state) || filepath.Clean(state) != state || filepath.Base(state) != e2eProxyStateName || filepath.Dir(state) != cfg.DataDir {
		return nil, errors.New("文件代理必须位于显式独立desktop目录")
	}
	temporary, err := filepath.EvalSymlinks(os.TempDir())
	if err != nil {
		return nil, err
	}
	relative, err := filepath.Rel(temporary, cfg.DataDir)
	if err != nil {
		return nil, err
	}
	parts := strings.Split(relative, string(filepath.Separator))
	if len(parts) != 4 || !strings.HasPrefix(parts[0], "chordv-support-e2e-") || parts[0] == "chordv-support-e2e-" || parts[1] != ".data" || parts[2] != "mygo" || parts[3] != "desktop" {
		return nil, errors.New("文件代理不在独立临时测试根目录内")
	}
	canonical, err := filepath.EvalSymlinks(cfg.DataDir)
	if err != nil || canonical != cfg.DataDir {
		return nil, errors.New("文件代理目录必须是无符号链接的canonical路径")
	}
	info, err := os.Stat(canonical)
	if err != nil || !info.IsDir() {
		return nil, errors.New("文件代理目录不存在")
	}
	adapter := &e2eFileProxy{dataDir: canonical, apiBase: cfg.APIBase, directory: info}
	if _, err := adapter.read(context.Background()); err != nil {
		return nil, err
	}
	return adapter, nil
}

func validE2EProxySetting(setting proxySetting) bool {
	if setting.Service != e2eProxyService || setting.Kind != "windows" || setting.Values == nil {
		return false
	}
	for _, key := range []string{"ProxyEnable", "ProxyServer", "ProxyOverride", "AutoConfigURL", "AutoDetect"} {
		if _, ok := setting.Values[key]; !ok {
			return false
		}
	}
	return true
}

func (a *e2eFileProxy) withState(ctx context.Context, action func(*os.File, *e2eProxyDocument) error) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	canonical, err := filepath.EvalSymlinks(a.dataDir)
	if err != nil || canonical != a.dataDir {
		return errors.New("文件代理目录已被替换")
	}
	root, err := os.OpenRoot(a.dataDir)
	if err != nil {
		return err
	}
	defer root.Close()
	directory, err := root.Stat(".")
	if err != nil || !os.SameFile(directory, a.directory) {
		return errors.New("文件代理目录身份已变化")
	}
	entry, err := root.Lstat(e2eProxyStateName)
	if err != nil || !entry.Mode().IsRegular() || entry.Mode() != 0600 {
		return errors.New("文件代理状态必须是0600非符号链接普通文件")
	}
	file, err := root.OpenFile(e2eProxyStateName, os.O_RDWR|unix.O_NOFOLLOW|unix.O_NONBLOCK, 0)
	if err != nil {
		return err
	}
	defer file.Close()
	if err := lockE2EProxyFile(ctx, int(file.Fd())); err != nil {
		return err
	}
	defer unix.Flock(int(file.Fd()), unix.LOCK_UN)
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Mode() != 0600 {
		return errors.New("文件代理状态必须是0600普通文件")
	}
	var stat unix.Stat_t
	if err := unix.Fstat(int(file.Fd()), &stat); err != nil {
		return err
	}
	if stat.Uid != uint32(os.Geteuid()) || stat.Nlink != 1 {
		return errors.New("文件代理状态必须由当前用户独占且不能有硬链接")
	}
	entry, err = root.Lstat(e2eProxyStateName)
	if err != nil || !os.SameFile(info, entry) {
		return errProxyChanged
	}
	data, err := io.ReadAll(io.LimitReader(file, 65537))
	if err != nil || len(data) > 65536 {
		return errors.New("文件代理状态无法读取或过大")
	}
	var document e2eProxyDocument
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&document) != nil || decoder.Decode(new(any)) != io.EOF || document.Schema != 1 || !document.TestOnly || len(document.Settings) != 1 || !validE2EProxySetting(document.Settings[0]) {
		return errors.New("文件代理状态不符合测试JSON契约")
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	return action(file, &document)
}

func lockE2EProxyFile(ctx context.Context, descriptor int) error {
	timeout := time.NewTimer(2 * time.Second)
	defer timeout.Stop()
	retry := time.NewTicker(10 * time.Millisecond)
	defer retry.Stop()
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		err := unix.Flock(descriptor, unix.LOCK_EX|unix.LOCK_NB)
		if err == nil {
			return nil
		}
		if !errors.Is(err, unix.EWOULDBLOCK) && !errors.Is(err, unix.EAGAIN) && !errors.Is(err, unix.EINTR) {
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-timeout.C:
			return errors.New("文件代理状态锁等待超时")
		case <-retry.C:
		}
	}
}

func (a *e2eFileProxy) read(ctx context.Context) ([]proxySetting, error) {
	var settings []proxySetting
	err := a.withState(ctx, func(_ *os.File, document *e2eProxyDocument) error { settings = document.Settings; return nil })
	return settings, err
}

func (a *e2eFileProxy) write(ctx context.Context, setting proxySetting) error {
	expected, present := ctx.Value(proxyExpectationKey{}).(proxySetting)
	if !present || !validE2EProxySetting(setting) {
		return errors.New("文件代理写入缺少预期快照或合成服务标识")
	}
	return a.withState(ctx, func(file *os.File, document *e2eProxyDocument) error {
		if !reflect.DeepEqual(document.Settings[0], expected) {
			return errProxyChanged
		}
		document.Settings[0] = setting
		data, err := json.MarshalIndent(document, "", "  ")
		if err != nil {
			return err
		}
		data = append(data, '\n')
		// 保持同一文件inode，确保跨进程flock覆盖整个读/CAS/写事务。
		if written, err := file.WriteAt(data, 0); err != nil {
			return err
		} else if written != len(data) {
			return io.ErrShortWrite
		}
		if err := file.Truncate(int64(len(data))); err != nil {
			return err
		}
		return file.Sync()
	})
}

func (a *e2eFileProxy) startWatchdog(dir string) (*proxyWatchdog, error) {
	if dir != a.dataDir {
		return nil, fmt.Errorf("测试watchdog目录必须与文件代理一致")
	}
	if _, err := a.read(context.Background()); err != nil {
		return nil, err
	}
	environment := append(systemProcessEnvironment(), "CHORDV_E2E_PROXY_STATE="+filepath.Join(a.dataDir, e2eProxyStateName), "CHORDV_MYGO_DATA_DIR="+a.dataDir, "CHORDV_API_BASE_URL="+a.apiBase)
	return startProxyWatchdogWithEnvironment(dir, environment)
}
