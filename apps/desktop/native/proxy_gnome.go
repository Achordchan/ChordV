package main

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"time"
)

type gnomeProxyCommand func(context.Context, ...string) (string, error)
type gnomeProxyBackend struct {
	run   gnomeProxyCommand
	scope string
}

func (b gnomeProxyBackend) read(ctx context.Context) (proxySetting, error) {
	setting := proxySetting{Service: gnomeProxyService, Kind: gnomeProxyKind, Scope: b.scope, Values: map[string]string{}}
	for _, key := range gnomeProxyKeys {
		value, err := b.run(ctx, "get", key.schema, key.key)
		if err != nil {
			return proxySetting{}, fmt.Errorf("无法读取GNOME代理字段%s：%w", key.field, err)
		}
		setting.Values[key.field] = strings.TrimSpace(value)
	}
	mode, err := b.run(ctx, "get", "org.gnome.system.proxy", "mode")
	if err != nil {
		return proxySetting{}, err
	}
	if strings.TrimSpace(mode) != setting.Values["mode"] {
		return proxySetting{}, errProxyChanged
	}
	gnomeDerived(setting.Values)
	if err = validateGNOMEProxy(setting); err != nil {
		return proxySetting{}, err
	}
	return setting, nil
}

func (b gnomeProxyBackend) write(ctx context.Context, target, expected proxySetting) error {
	if err := validateGNOMEProxy(target); err != nil {
		return err
	}
	if err := validateGNOMEProxy(expected); err != nil {
		return err
	}
	if target.Scope != expected.Scope {
		return errors.New("GNOME代理恢复目标不属于当前配置空间，保留设置和恢复记录")
	}
	if target.Values["authenticated"] != "0" || expected.Values["authenticated"] != "0" {
		return errors.New("GNOME认证代理不能修改")
	}
	mutated, err := b.replace(ctx, target, expected)
	if err == nil || !mutated {
		return err
	}
	// Cancellation must not strand the settings midway through a multi-key change.
	rollbackCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	actual, readErr := b.read(rollbackCtx)
	if readErr != nil {
		return errors.Join(err, fmt.Errorf("GNOME部分代理设置尚未恢复：%w", readErr))
	}
	if !gnomePartiallyOwned(actual, expected, target) {
		return errors.Join(err, errProxyChanged)
	}
	_, restoreErr := b.replace(rollbackCtx, expected, actual)
	return errors.Join(err, restoreErr)
}

func (b gnomeProxyBackend) replace(ctx context.Context, target, expected proxySetting) (mutated bool, result error) {
	current, err := b.read(ctx)
	if err != nil {
		return false, err
	}
	if !reflect.DeepEqual(current, expected) {
		return false, errProxyChanged
	}
	if reflect.DeepEqual(current, target) {
		return false, nil
	}
	// Check policy locks before disabling any currently active proxy.
	for _, key := range gnomeProxyKeys {
		if key.field != "mode" && target.Values[key.field] == expected.Values[key.field] {
			continue
		}
		writable, err := b.run(ctx, "writable", key.schema, key.key)
		if err != nil {
			return false, err
		}
		if strings.TrimSpace(writable) != "true" {
			return false, fmt.Errorf("GNOME代理字段%s被系统策略锁定", key.field)
		}
	}
	shadow := proxySetting{Service: expected.Service, Kind: expected.Kind, Scope: expected.Scope, Values: map[string]string{}}
	for key, value := range expected.Values {
		shadow.Values[key] = value
	}
	write := func(key gnomeProxyKey, value string) error {
		if shadow.Values[key.field] == value {
			return nil
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		actual, err := b.read(ctx)
		if err != nil {
			return err
		}
		if !reflect.DeepEqual(actual, shadow) {
			return errProxyChanged
		}
		mutated = true
		if _, err = b.run(ctx, "set", key.schema, key.key, value); err != nil {
			return fmt.Errorf("GNOME代理字段%s保存失败：%w", key.field, err)
		}
		shadow.Values[key.field] = value
		gnomeDerived(shadow.Values)
		actual, err = b.read(ctx)
		if err != nil {
			return err
		}
		if !reflect.DeepEqual(actual, shadow) {
			return errProxyChanged
		}
		return nil
	}
	mode := gnomeProxyKeys[0]
	if err = write(mode, "'none'"); err != nil {
		return mutated, err
	}
	for _, key := range gnomeProxyKeys[1:] {
		if err = write(key, target.Values[key.field]); err != nil {
			return mutated, err
		}
	}
	if err = write(mode, target.Values["mode"]); err != nil {
		return mutated, err
	}
	return mutated, nil
}

func restoreGNOMEProxyChange(ctx context.Context, change proxyChange, current []proxySetting) error {
	for _, setting := range current {
		if setting.Service != change.Owned.Service || setting.Kind != gnomeProxyKind {
			continue
		}
		if setting.Scope != change.Owned.Scope || setting.Scope != change.Before.Scope {
			return errors.New("GNOME代理恢复配置空间已改变，保留当前设置和恢复记录")
		}
		if !proxyOwnershipMatches(setting, change.Owned) && !proxyOwnershipMatches(setting, change.Before) && !gnomePartiallyOwned(setting, change.Before, change.Owned) {
			return errProxyChanged
		}
		return writeProxySetting(expectedProxyContext(ctx, setting), change.Before)
	}
	return errors.New("GNOME代理恢复缺少原用户会话快照")
}
