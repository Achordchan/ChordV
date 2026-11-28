//go:build darwin

package main

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"strconv"
)

func platformReadProxy(ctx context.Context) ([]proxySetting, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	api, err := loadMacSystemAPI()
	if err != nil {
		return nil, err
	}
	name := api.cfString("ChordV proxy snapshot")
	defer api.release(name)
	prefs := api.prefsCreate(0, name, 0)
	if prefs == 0 {
		return nil, errors.New("无法读取系统代理偏好设置")
	}
	defer api.release(prefs)
	services := api.services(prefs)
	if services == 0 {
		return nil, errors.New("无法枚举系统网络服务")
	}
	defer api.release(services)
	protocolName := api.cfString("Proxies")
	defer api.release(protocolName)
	settings := []proxySetting{}
	for i := int64(0); i < api.arrayCount(services); i++ {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		service := api.arrayItem(services, i)
		if !api.serviceEnabled(service) {
			continue
		}
		protocol := api.protocolCopy(service, protocolName)
		if protocol == 0 {
			continue
		}
		configuration := api.protocolConfig(protocol)
		dictionary := map[string]any{}
		missing := "1"
		if configuration != 0 {
			missing = "0"
			bytes, err := api.dictionaryData(configuration)
			if err != nil {
				api.release(protocol)
				return nil, err
			}
			dictionary, err = parsePlist(bytes)
			if err != nil {
				api.release(protocol)
				return nil, err
			}
		}
		api.release(protocol)
		bytes, err := marshalPlist(dictionary)
		if err != nil {
			return nil, err
		}
		enabled := "No"
		for _, key := range []string{"HTTPEnable", "HTTPSEnable", "SOCKSEnable", "ProxyAutoConfigEnable", "ProxyAutoDiscoveryEnable"} {
			if macProxyFlag(dictionary[key]) {
				enabled = "Yes"
			}
		}
		id := api.goString(api.serviceID(service))
		if id == "" {
			return nil, errors.New("系统网络服务缺少标识")
		}
		settings = append(settings, proxySetting{Service: id, Kind: "macos", Values: map[string]string{"name": api.goString(api.serviceName(service)), "configuration": base64.StdEncoding.EncodeToString(bytes), "missing": missing, "enabled": enabled}})
	}
	if len(settings) == 0 {
		return nil, errors.New("没有可配置代理的系统网络服务")
	}
	return settings, nil
}

func platformWriteProxy(ctx context.Context, setting proxySetting) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if setting.Kind != "macos" {
		return errors.New("系统代理恢复记录类型无效")
	}
	api, err := loadMacSystemAPI()
	if err != nil {
		return err
	}
	macAuthorization.Lock()
	authorization := macAuthorization.ref
	macAuthorization.Unlock()
	if authorization == 0 {
		if err := platformPrepareProxyAuthorization(); err != nil {
			return err
		}
		macAuthorization.Lock()
		authorization = macAuthorization.ref
		macAuthorization.Unlock()
	}
	name := api.cfString("ChordV proxy transaction")
	defer api.release(name)
	prefs := api.prefsAuthorized(0, name, 0, authorization)
	if prefs == 0 {
		return errors.New("系统代理事务无法创建")
	}
	defer api.release(prefs)
	if !api.prefsLock(prefs, false) {
		return errors.New("系统网络偏好设置正在修改，请稍后重试恢复")
	}
	defer api.prefsUnlock(prefs)
	services := api.services(prefs)
	if services == 0 {
		return errors.New("无法定位原始网络服务")
	}
	defer api.release(services)
	protocolName := api.cfString("Proxies")
	defer api.release(protocolName)
	for i := int64(0); i < api.arrayCount(services); i++ {
		service := api.arrayItem(services, i)
		if api.goString(api.serviceID(service)) != setting.Service {
			continue
		}
		protocol := api.protocolCopy(service, protocolName)
		if protocol == 0 {
			return errors.New("网络服务不支持代理配置")
		}
		defer api.release(protocol)
		if expected, ok := ctx.Value(proxyExpectationKey{}).(proxySetting); ok {
			matches, err := macConfigurationMatches(api, api.protocolConfig(protocol), expected)
			if err != nil {
				return err
			}
			if !matches {
				return errProxyChanged
			}
		}
		var dictionary uintptr
		if setting.Values["missing"] != "1" {
			data, err := base64.StdEncoding.DecodeString(setting.Values["configuration"])
			if err != nil {
				return errors.New("系统代理快照损坏")
			}
			dictionary, err = api.dictionaryFromData(data)
			if err != nil {
				return err
			}
			defer api.release(dictionary)
		}
		if !api.protocolSet(protocol, dictionary) {
			return fmt.Errorf("系统代理配置未保存（%d）", api.scError())
		}
		if !api.prefsCommit(prefs) {
			return fmt.Errorf("系统代理偏好设置提交失败（%d）", api.scError())
		}
		if !api.prefsApply(prefs) {
			return fmt.Errorf("系统代理偏好设置应用失败（%d）", api.scError())
		}
		return nil
	}
	return errors.New("原始网络服务已经移除，无法恢复代理")
}

func macConfigurationMatches(api *macSystemAPI, configuration uintptr, expected proxySetting) (bool, error) {
	if configuration == 0 {
		return expected.Values["missing"] == "1", nil
	}
	if expected.Values["missing"] == "1" {
		return false, nil
	}
	data, err := api.dictionaryData(configuration)
	if err != nil {
		return false, err
	}
	dictionary, err := parsePlist(data)
	if err != nil {
		return false, err
	}
	normalized, err := marshalPlist(dictionary)
	if err != nil {
		return false, err
	}
	return base64.StdEncoding.EncodeToString(normalized) == expected.Values["configuration"], nil
}

func processIdentity(ctx context.Context, pid int) (string, error) {
	return commandOutput(ctx, "/bin/ps", "-p", strconv.Itoa(pid), "-o", "lstart=")
}
func processExecutable(ctx context.Context, pid int) (string, error) {
	return commandOutput(ctx, "/bin/ps", "-p", strconv.Itoa(pid), "-o", "comm=")
}
