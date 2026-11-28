//go:build darwin

package main

import (
	"bytes"
	"errors"
	"fmt"
	"sync"
	"unsafe"

	"github.com/ebitengine/purego"
	"github.com/ebitengine/purego/objc"
)

type macRecoveryKeychainAPI struct {
	symbols                      map[string]uintptr
	keyCallbacks, valueCallbacks unsafe.Pointer
	release                      func(uintptr)
	stringCreate                 func(uintptr, string, uint32) uintptr
	dataCreate                   func(uintptr, *byte, int) uintptr
	dataLength                   func(uintptr) int
	dataBytes                    func(uintptr) *byte
	typeID                       func(uintptr) uintptr
	dictionaryType, dataType     func() uintptr
	dictionaryCreate             func(uintptr, *uintptr, *uintptr, int, unsafe.Pointer, unsafe.Pointer) uintptr
	dictionaryGet                func(uintptr, uintptr) uintptr
	copyMatching, add            func(uintptr, *uintptr) int32
	update                       func(uintptr, uintptr) int32
	delete                       func(uintptr) int32
}

var macRecoveryKeychainLibrary struct {
	sync.Once
	api macRecoveryKeychainAPI
	err error
}

// Loading symbols does not open a keychain or query any items.
func loadMacRecoveryKeychainAPI() (*macRecoveryKeychainAPI, error) {
	macRecoveryKeychainLibrary.Do(func() {
		macRecoveryKeychainLibrary.err = macRecoveryKeychainLibrary.api.bind()
	})
	return &macRecoveryKeychainLibrary.api, macRecoveryKeychainLibrary.err
}

func (api *macRecoveryKeychainAPI) bind() (err error) {
	defer func() {
		if failure := recover(); failure != nil {
			err = fmt.Errorf("受保护更新存储 API 初始化失败：%v", failure)
		}
	}()
	open := func(name string) (uintptr, error) {
		return purego.Dlopen("/System/Library/Frameworks/"+name+".framework/"+name, purego.RTLD_NOW|purego.RTLD_LOCAL)
	}
	cf, err := open("CoreFoundation")
	if err != nil {
		return err
	}
	security, err := open("Security")
	if err != nil {
		return err
	}
	if _, err = open("LocalAuthentication"); err != nil {
		return err
	}
	for _, binding := range []struct {
		lib  uintptr
		name string
		fn   any
	}{
		{cf, "CFRelease", &api.release}, {cf, "CFStringCreateWithCString", &api.stringCreate}, {cf, "CFDataCreate", &api.dataCreate},
		{cf, "CFDataGetLength", &api.dataLength}, {cf, "CFDataGetBytePtr", &api.dataBytes}, {cf, "CFGetTypeID", &api.typeID},
		{cf, "CFDataGetTypeID", &api.dataType}, {cf, "CFDictionaryGetTypeID", &api.dictionaryType},
		{cf, "CFDictionaryCreate", &api.dictionaryCreate}, {cf, "CFDictionaryGetValue", &api.dictionaryGet},
		{security, "SecItemCopyMatching", &api.copyMatching}, {security, "SecItemAdd", &api.add},
		{security, "SecItemUpdate", &api.update}, {security, "SecItemDelete", &api.delete},
	} {
		purego.RegisterLibFunc(binding.fn, binding.lib, binding.name)
	}
	// Data symbols contain CF references, not callable functions. Bind dlsym
	// with a pointer result so Go never derives a pointer from an integer.
	var symbol func(uintptr, string) unsafe.Pointer
	purego.RegisterLibFunc(&symbol, purego.RTLD_DEFAULT, "dlsym")
	api.keyCallbacks = symbol(cf, "kCFTypeDictionaryKeyCallBacks")
	api.valueCallbacks = symbol(cf, "kCFTypeDictionaryValueCallBacks")
	if api.keyCallbacks == nil || api.valueCallbacks == nil {
		return errors.New("受保护更新存储缺少字典引用规则")
	}
	api.symbols = map[string]uintptr{}
	for lib, names := range map[uintptr][]string{
		cf: {"kCFBooleanTrue", "kCFBooleanFalse"},
		security: {"kSecClass", "kSecClassGenericPassword", "kSecAttrService", "kSecAttrAccount", "kSecAttrAccessGroup", "kSecAttrSynchronizable",
			"kSecUseDataProtectionKeychain", "kSecUseAuthenticationContext", "kSecAttrAccessible", "kSecAttrAccessibleWhenUnlockedThisDeviceOnly",
			"kSecAttrGeneric", "kSecValueData", "kSecReturnAttributes", "kSecReturnData"},
	} {
		for _, name := range names {
			address := symbol(lib, name)
			if address == nil || *(*uintptr)(address) == 0 {
				return fmt.Errorf("受保护更新存储缺少系统常量 %s", name)
			}
			api.symbols[name] = *(*uintptr)(address)
		}
	}
	return nil
}

func (api *macRecoveryKeychainAPI) dictionary(fields map[string]uintptr) (uintptr, error) {
	keys, values := make([]uintptr, 0, len(fields)), make([]uintptr, 0, len(fields))
	for name, value := range fields {
		key := api.symbols[name]
		if key == 0 || value == 0 {
			return 0, errors.New("受保护更新存储字典字段无效")
		}
		keys, values = append(keys, key), append(values, value)
	}
	if len(keys) == 0 {
		return 0, errors.New("受保护更新存储字典为空")
	}
	ref := api.dictionaryCreate(0, &keys[0], &values[0], len(keys), api.keyCallbacks, api.valueCallbacks)
	if ref == 0 {
		return 0, errors.New("受保护更新存储字典创建失败")
	}
	return ref, nil
}

func (api *macRecoveryKeychainAPI) readData(dict uintptr, name string, limit int) ([]byte, error) {
	ref := api.dictionaryGet(dict, api.symbols[name])
	if ref == 0 || api.typeID(ref) != api.dataType() {
		return nil, errors.New("钥匙串中的更新授权数据类型无效")
	}
	length, data := api.dataLength(ref), api.dataBytes(ref)
	if length <= 0 || length > limit || data == nil {
		return nil, errors.New("钥匙串中的更新授权数据长度无效")
	}
	return bytes.Clone(unsafe.Slice(data, length)), nil
}

func newMacRecoveryKeychainAuthentication() objc.ID {
	class := objc.GetClass("LAContext")
	if class == 0 {
		return 0
	}
	ctx := objc.ID(class).Send(objc.RegisterName("new"))
	if ctx != 0 {
		ctx.Send(objc.RegisterName("setInteractionNotAllowed:"), true)
		if !objc.Send[bool](ctx, objc.RegisterName("interactionNotAllowed")) {
			ctx.Send(objc.RegisterName("release"))
			return 0
		}
	}
	return ctx
}
