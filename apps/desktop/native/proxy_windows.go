//go:build windows

package main

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"runtime"
	"strconv"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

const internetSettings = `Software\Microsoft\Windows\CurrentVersion\Internet Settings`

func platformReadProxy(_ context.Context) ([]proxySetting, error) {
	key, err := registry.OpenKey(registry.CURRENT_USER, internetSettings, registry.QUERY_VALUE)
	if err != nil {
		return nil, err
	}
	defer key.Close()
	values := map[string]string{}
	for _, name := range []string{"ProxyServer", "ProxyOverride", "AutoConfigURL"} {
		value, _, err := key.GetStringValue(name)
		if errors.Is(err, registry.ErrNotExist) {
			values[name+".missing"] = "1"
		} else if err != nil {
			return nil, err
		}
		values[name] = value
	}
	for _, name := range []string{"ProxyEnable", "AutoDetect"} {
		value, _, err := key.GetIntegerValue(name)
		if errors.Is(err, registry.ErrNotExist) {
			values[name+".missing"] = "1"
		} else if err != nil {
			return nil, err
		}
		values[name] = strconv.FormatUint(value, 10)
	}
	connections, err := registry.OpenKey(registry.CURRENT_USER, internetSettings+`\Connections`, registry.QUERY_VALUE)
	if err == nil {
		defer connections.Close()
		for _, name := range []string{"DefaultConnectionSettings", "SavedLegacySettings"} {
			value, _, readErr := connections.GetBinaryValue(name)
			if readErr == nil {
				values[name] = base64.StdEncoding.EncodeToString(value)
				if name == "DefaultConnectionSettings" && len(value) > 8 {
					values["connectionFlags"] = strconv.Itoa(int(value[8]))
				}
			} else if !errors.Is(readErr, registry.ErrNotExist) {
				return nil, readErr
			}
		}
	}
	effective, err := queryWindowsProxy()
	if err != nil {
		return nil, err
	}
	for key, value := range effective {
		values[key] = value
	}
	return []proxySetting{{Service: "current-user", Kind: "windows", Values: values}}, nil
}
func platformWriteProxy(ctx context.Context, setting proxySetting) error {
	if setting.Kind != "windows" {
		return errors.New("未知系统代理设置")
	}
	if expected, ok := ctx.Value(proxyExpectationKey{}).(proxySetting); ok {
		current, err := platformReadProxy(ctx)
		if err != nil {
			return err
		}
		if len(current) != 1 || !proxyOwnershipMatches(current[0], expected) {
			return errProxyChanged
		}
	}
	if err := applyWindowsProxy(setting.Values); err != nil {
		return err
	}
	key, err := registry.OpenKey(registry.CURRENT_USER, internetSettings, registry.SET_VALUE)
	if err != nil {
		return err
	}
	defer key.Close()
	for _, name := range []string{"ProxyServer", "ProxyOverride", "AutoConfigURL"} {
		if setting.Values[name+".missing"] == "1" {
			if err = key.DeleteValue(name); err != nil && !errors.Is(err, registry.ErrNotExist) {
				return err
			}
		} else if err = key.SetStringValue(name, setting.Values[name]); err != nil {
			return err
		}
	}
	for _, name := range []string{"ProxyEnable", "AutoDetect"} {
		if setting.Values[name+".missing"] == "1" {
			if err = key.DeleteValue(name); err != nil && !errors.Is(err, registry.ErrNotExist) {
				return err
			}
		} else {
			value, err := strconv.ParseUint(setting.Values[name], 10, 32)
			if err != nil {
				return err
			}
			if err = key.SetDWordValue(name, uint32(value)); err != nil {
				return err
			}
		}
	}
	connections, err := registry.OpenKey(registry.CURRENT_USER, internetSettings+`\Connections`, registry.SET_VALUE)
	if err != nil {
		return err
	}
	defer connections.Close()
	for _, name := range []string{"DefaultConnectionSettings", "SavedLegacySettings"} {
		if setting.Values["restoreConnections"] == "0" {
			continue
		}
		if encoded := setting.Values[name]; encoded != "" {
			value, err := base64.StdEncoding.DecodeString(encoded)
			if err != nil {
				return err
			}
			if name == "DefaultConnectionSettings" && len(value) > 8 {
				flags, err := strconv.Atoi(setting.Values["connectionFlags"])
				if err != nil {
					return err
				}
				value[8] = byte(flags)
			}
			if err = connections.SetBinaryValue(name, value); err != nil {
				return err
			}
		}
	}
	wininet := syscall.NewLazyDLL("wininet.dll")
	setOption := wininet.NewProc("InternetSetOptionW")
	for _, option := range []uintptr{39, 37} {
		result, _, err := setOption.Call(0, option, 0, 0)
		if result == 0 {
			return fmt.Errorf("刷新系统代理失败：%w", err)
		}
	}
	return nil
}

type wininetOption struct {
	Option uint32
	Value  uintptr
}
type wininetOptionList struct {
	Size       uint32
	Connection *uint16
	Count      uint32
	Error      uint32
	Options    *wininetOption
}

func queryWindowsProxy() (map[string]string, error) {
	options := []wininetOption{{Option: 1}, {Option: 2}, {Option: 3}, {Option: 4}}
	list := wininetOptionList{Count: uint32(len(options)), Options: &options[0]}
	list.Size = uint32(unsafe.Sizeof(list))
	size := list.Size
	result, _, err := syscall.NewLazyDLL("wininet.dll").NewProc("InternetQueryOptionW").Call(0, 75, uintptr(unsafe.Pointer(&list)), uintptr(unsafe.Pointer(&size)))
	if result == 0 {
		return nil, fmt.Errorf("读取实际系统代理失败：%w", err)
	}
	values := map[string]string{"effectiveFlags": strconv.FormatUint(uint64(options[0].Value), 10)}
	globalFree := syscall.NewLazyDLL("kernel32.dll").NewProc("GlobalFree")
	for i, key := range []string{"effectiveProxyServer", "effectiveProxyOverride", "effectiveAutoConfigURL"} {
		value := options[i+1].Value
		if value == 0 {
			values[key] = ""
			continue
		}
		pointer := *(**uint16)(unsafe.Pointer(&options[i+1].Value))
		values[key] = windows.UTF16PtrToString(pointer)
		globalFree.Call(value)
	}
	return values, nil
}

func applyWindowsProxy(values map[string]string) error {
	flags, err := strconv.ParseUint(values["effectiveFlags"], 10, 32)
	if err != nil {
		return errors.New("实际系统代理标志无效")
	}
	options := []wininetOption{{Option: 1, Value: uintptr(flags)}}
	pointers := []*uint16{}
	for i, key := range []string{"effectiveProxyServer", "effectiveProxyOverride", "effectiveAutoConfigURL"} {
		pointer, err := windows.UTF16PtrFromString(values[key])
		if err != nil {
			return err
		}
		pointers = append(pointers, pointer)
		options = append(options, wininetOption{Option: uint32(i + 2), Value: uintptr(unsafe.Pointer(pointer))})
	}
	list := wininetOptionList{Count: uint32(len(options)), Options: &options[0]}
	list.Size = uint32(unsafe.Sizeof(list))
	result, _, err := syscall.NewLazyDLL("wininet.dll").NewProc("InternetSetOptionW").Call(0, 75, uintptr(unsafe.Pointer(&list)), uintptr(list.Size))
	runtime.KeepAlive(pointers)
	if result == 0 {
		return fmt.Errorf("应用实际系统代理失败：%w", err)
	}
	return nil
}
func processIdentity(_ context.Context, pid int) (string, error) {
	handle, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return "", err
	}
	defer windows.CloseHandle(handle)
	var created, exit, kernel, user windows.Filetime
	if err = windows.GetProcessTimes(handle, &created, &exit, &kernel, &user); err != nil {
		return "", err
	}
	return strconv.FormatInt(created.Nanoseconds(), 10), nil
}
func processExecutable(_ context.Context, pid int) (string, error) {
	handle, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return "", err
	}
	defer windows.CloseHandle(handle)
	buffer := make([]uint16, 32768)
	length := uint32(len(buffer))
	if err = windows.QueryFullProcessImageName(handle, 0, &buffer[0], &length); err != nil {
		return "", err
	}
	return windows.UTF16ToString(buffer[:length]), nil
}
