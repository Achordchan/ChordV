//go:build darwin

package main

import (
	"errors"
	"fmt"
	"regexp"
	"strings"
	"sync"

	"github.com/ebitengine/purego"
	"golang.org/x/sys/unix"
)

var macUpdateDevicePath = regexp.MustCompile(`^/dev/disk(0|[1-9][0-9]*)(s(0|[1-9][0-9]*))*$`)
var macUpdateBootUUID = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

type macUpdateDeviceAPI struct {
	bsdNameMatching    func(uint32, uint32, string) uintptr
	getMatchingService func(uint32, uintptr) uint32
	getRegistryID      func(uint32, *uint64) int32
	release            func(uint32) int32
}

var macUpdateDevices struct {
	sync.Once
	api macUpdateDeviceAPI
	err error
}

func loadMacUpdateDeviceAPI() (*macUpdateDeviceAPI, error) {
	macUpdateDevices.Do(func() {
		defer func() {
			if value := recover(); value != nil {
				macUpdateDevices.err = fmt.Errorf("镜像设备身份 API 初始化失败：%v", value)
			}
		}()
		library, err := purego.Dlopen("/System/Library/Frameworks/IOKit.framework/IOKit", purego.RTLD_NOW|purego.RTLD_LOCAL)
		if err != nil {
			macUpdateDevices.err = err
			return
		}
		for _, binding := range []struct {
			function any
			name     string
		}{
			{&macUpdateDevices.api.bsdNameMatching, "IOBSDNameMatching"},
			{&macUpdateDevices.api.getMatchingService, "IOServiceGetMatchingService"},
			{&macUpdateDevices.api.getRegistryID, "IORegistryEntryGetRegistryEntryID"},
			{&macUpdateDevices.api.release, "IOObjectRelease"},
		} {
			symbol, err := purego.Dlsym(library, binding.name)
			if err != nil {
				macUpdateDevices.err = err
				return
			}
			purego.RegisterFunc(binding.function, symbol)
		}
	})
	return &macUpdateDevices.api, macUpdateDevices.err
}

func macUpdateDeviceID(path string) (uint64, error) {
	if len(path) > 128 || !macUpdateDevicePath.MatchString(path) {
		return 0, errors.New("镜像设备路径无效")
	}
	api, err := loadMacUpdateDeviceAPI()
	if err != nil {
		return 0, err
	}
	return api.lookup(path)
}

func (api *macUpdateDeviceAPI) lookup(path string) (identity uint64, result error) {
	matching := api.bsdNameMatching(0, 0, strings.TrimPrefix(path, "/dev/"))
	if matching == 0 {
		return 0, errors.New("镜像设备匹配条件创建失败")
	}
	// IOServiceGetMatchingService consumes the matching dictionary even on failure.
	service := api.getMatchingService(0, matching)
	if service == 0 {
		return 0, errors.New("镜像设备注册实体不存在")
	}
	defer func() {
		if code := api.release(service); code != 0 {
			identity = 0
			result = errors.Join(result, fmt.Errorf("镜像设备引用释放失败：0x%x", uint32(code)))
		}
	}()
	if code := api.getRegistryID(service, &identity); code != 0 {
		return 0, fmt.Errorf("镜像设备注册身份读取失败：0x%x", uint32(code))
	}
	if identity == 0 {
		return 0, errors.New("镜像设备注册身份为空")
	}
	return identity, nil
}

func macUpdateBootSession() (string, error) {
	session, err := unix.Sysctl("kern.bootsessionuuid")
	if err != nil {
		return "", fmt.Errorf("读取启动会话身份：%w", err)
	}
	if !macUpdateBootUUID.MatchString(session) || strings.EqualFold(session, "00000000-0000-0000-0000-000000000000") {
		return "", errors.New("启动会话身份格式无效")
	}
	// Registry entry IDs are globally meaningful only within this boot session.
	return strings.ToUpper(session), nil
}
