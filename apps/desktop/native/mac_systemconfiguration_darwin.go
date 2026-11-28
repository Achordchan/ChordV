//go:build darwin

package main

import (
	"encoding/base64"
	"errors"
	"fmt"
	"sync"
	"unsafe"

	"github.com/ebitengine/purego"
)

type macSystemAPI struct {
	release         func(uintptr)
	stringCreate    func(uintptr, string, uint32) uintptr
	stringGet       func(uintptr, *byte, int64, uint32) bool
	arrayCount      func(uintptr) int64
	arrayItem       func(uintptr, int64) uintptr
	dataCreate      func(uintptr, *byte, int64) uintptr
	dataLength      func(uintptr) int64
	dataBytes       func(uintptr) *byte
	plistData       func(uintptr, uintptr, int64, uintptr, *uintptr) uintptr
	plistCreate     func(uintptr, uintptr, uintptr, *int64, *uintptr) uintptr
	prefsCreate     func(uintptr, uintptr, uintptr) uintptr
	prefsAuthorized func(uintptr, uintptr, uintptr, uintptr) uintptr
	prefsLock       func(uintptr, bool) bool
	prefsUnlock     func(uintptr) bool
	prefsCommit     func(uintptr) bool
	prefsApply      func(uintptr) bool
	services        func(uintptr) uintptr
	serviceName     func(uintptr) uintptr
	serviceID       func(uintptr) uintptr
	serviceEnabled  func(uintptr) bool
	protocolCopy    func(uintptr, uintptr) uintptr
	protocolConfig  func(uintptr) uintptr
	protocolSet     func(uintptr, uintptr) bool
	authCreate      func(uintptr, uintptr, uint32, *uintptr) int32
	authExternal    func(uintptr, *[32]byte) int32
	authImport      func(*[32]byte, *uintptr) int32
	authFree        func(uintptr, uint32) int32
	scError         func() int32
}

var macAPI macSystemAPI
var macAPIOnce sync.Once
var macAPIErr error
var macAuthorization struct {
	sync.Mutex
	ref      uintptr
	external [32]byte
}

func loadMacSystemAPI() (*macSystemAPI, error) {
	macAPIOnce.Do(func() {
		defer func() {
			if value := recover(); value != nil {
				macAPIErr = fmt.Errorf("系统代理 API 初始化失败：%v", value)
			}
		}()
		cf, err := purego.Dlopen("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation", purego.RTLD_NOW|purego.RTLD_LOCAL)
		if err != nil {
			macAPIErr = err
			return
		}
		sc, err := purego.Dlopen("/System/Library/Frameworks/SystemConfiguration.framework/SystemConfiguration", purego.RTLD_NOW|purego.RTLD_LOCAL)
		if err != nil {
			macAPIErr = err
			return
		}
		security, err := purego.Dlopen("/System/Library/Frameworks/Security.framework/Security", purego.RTLD_NOW|purego.RTLD_LOCAL)
		if err != nil {
			macAPIErr = err
			return
		}
		for _, binding := range []struct {
			function any
			handle   uintptr
			name     string
		}{
			{&macAPI.release, cf, "CFRelease"}, {&macAPI.stringCreate, cf, "CFStringCreateWithCString"}, {&macAPI.stringGet, cf, "CFStringGetCString"}, {&macAPI.arrayCount, cf, "CFArrayGetCount"}, {&macAPI.arrayItem, cf, "CFArrayGetValueAtIndex"}, {&macAPI.dataCreate, cf, "CFDataCreate"}, {&macAPI.dataLength, cf, "CFDataGetLength"}, {&macAPI.dataBytes, cf, "CFDataGetBytePtr"}, {&macAPI.plistData, cf, "CFPropertyListCreateData"}, {&macAPI.plistCreate, cf, "CFPropertyListCreateWithData"},
			{&macAPI.prefsCreate, sc, "SCPreferencesCreate"}, {&macAPI.prefsAuthorized, sc, "SCPreferencesCreateWithAuthorization"}, {&macAPI.prefsLock, sc, "SCPreferencesLock"}, {&macAPI.prefsUnlock, sc, "SCPreferencesUnlock"}, {&macAPI.prefsCommit, sc, "SCPreferencesCommitChanges"}, {&macAPI.prefsApply, sc, "SCPreferencesApplyChanges"}, {&macAPI.services, sc, "SCNetworkServiceCopyAll"}, {&macAPI.serviceName, sc, "SCNetworkServiceGetName"}, {&macAPI.serviceID, sc, "SCNetworkServiceGetServiceID"}, {&macAPI.serviceEnabled, sc, "SCNetworkServiceGetEnabled"}, {&macAPI.protocolCopy, sc, "SCNetworkServiceCopyProtocol"}, {&macAPI.protocolConfig, sc, "SCNetworkProtocolGetConfiguration"}, {&macAPI.protocolSet, sc, "SCNetworkProtocolSetConfiguration"}, {&macAPI.scError, sc, "SCError"},
			{&macAPI.authCreate, security, "AuthorizationCreate"}, {&macAPI.authExternal, security, "AuthorizationMakeExternalForm"}, {&macAPI.authImport, security, "AuthorizationCreateFromExternalForm"}, {&macAPI.authFree, security, "AuthorizationFree"},
		} {
			purego.RegisterLibFunc(binding.function, binding.handle, binding.name)
		}
	})
	return &macAPI, macAPIErr
}
func (api *macSystemAPI) cfString(value string) uintptr {
	return api.stringCreate(0, value, 0x08000100)
}
func (api *macSystemAPI) goString(value uintptr) string {
	if value == 0 {
		return ""
	}
	buffer := make([]byte, 8192)
	if !api.stringGet(value, &buffer[0], int64(len(buffer)), 0x08000100) {
		return ""
	}
	for i, char := range buffer {
		if char == 0 {
			return string(buffer[:i])
		}
	}
	return string(buffer)
}
func (api *macSystemAPI) dictionaryData(dictionary uintptr) ([]byte, error) {
	var cfError uintptr
	data := api.plistData(0, dictionary, 100, 0, &cfError)
	if cfError != 0 {
		api.release(cfError)
	}
	if data == 0 {
		return nil, errors.New("系统代理快照序列化失败")
	}
	defer api.release(data)
	length := api.dataLength(data)
	if length < 0 || length > 1<<20 {
		return nil, errors.New("系统代理快照大小无效")
	}
	return append([]byte(nil), unsafe.Slice(api.dataBytes(data), int(length))...), nil
}
func (api *macSystemAPI) dictionaryFromData(bytes []byte) (uintptr, error) {
	if len(bytes) == 0 {
		return 0, errors.New("系统代理快照为空")
	}
	data := api.dataCreate(0, &bytes[0], int64(len(bytes)))
	if data == 0 {
		return 0, errors.New("系统代理快照无法读取")
	}
	defer api.release(data)
	var format int64
	var cfError uintptr
	dictionary := api.plistCreate(0, data, 0, &format, &cfError)
	if cfError != 0 {
		api.release(cfError)
	}
	if dictionary == 0 {
		return 0, errors.New("系统代理快照格式无效")
	}
	return dictionary, nil
}

type macAuthorizationItem struct {
	Name   *byte
	Length uintptr
	Value  uintptr
	Flags  uint32
}
type macAuthorizationRights struct {
	Count uint32
	Items *macAuthorizationItem
}

func platformPrepareProxyAuthorization() error {
	api, err := loadMacSystemAPI()
	if err != nil {
		return err
	}
	macAuthorization.Lock()
	defer macAuthorization.Unlock()
	if macAuthorization.ref != 0 {
		api.authFree(macAuthorization.ref, 0)
		macAuthorization.ref = 0
	}
	name := append([]byte("system.preferences.network"), 0)
	item := macAuthorizationItem{Name: &name[0]}
	rights := macAuthorizationRights{Count: 1, Items: &item}
	var authorization uintptr
	status := api.authCreate(uintptr(unsafe.Pointer(&rights)), 0, 1|2|16, &authorization)
	if status != 0 || authorization == 0 {
		return errors.New("系统代理授权未完成，连接未启动")
	}
	var external [32]byte
	if api.authExternal(authorization, &external) != 0 {
		api.authFree(authorization, 0)
		return errors.New("系统代理恢复授权无法创建")
	}
	macAuthorization.ref = authorization
	macAuthorization.external = external
	return nil
}
func platformWatchdogAuthorization() string {
	macAuthorization.Lock()
	defer macAuthorization.Unlock()
	if macAuthorization.ref == 0 {
		return ""
	}
	return base64.StdEncoding.EncodeToString(macAuthorization.external[:])
}
func platformImportWatchdogAuthorization(value string) error {
	if value == "" {
		return nil
	}
	bytes, err := base64.StdEncoding.DecodeString(value)
	if err != nil || len(bytes) != 32 {
		return errors.New("代理恢复授权格式无效")
	}
	api, err := loadMacSystemAPI()
	if err != nil {
		return err
	}
	var external [32]byte
	copy(external[:], bytes)
	var authorization uintptr
	if api.authImport(&external, &authorization) != 0 {
		return errors.New("代理恢复授权无法接收")
	}
	macAuthorization.Lock()
	macAuthorization.ref = authorization
	macAuthorization.external = external
	macAuthorization.Unlock()
	return nil
}
