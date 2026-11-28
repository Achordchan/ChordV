//go:build darwin

package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"regexp"

	"github.com/ebitengine/purego/objc"
)

const (
	macRecoveryKeychainService = "app.chordv.desktop.update-recovery.v1"
	macRecoveryKeychainSuffix  = ".app.chordv.desktop.update-recovery"
	macKeychainDuplicateItem   = -25299
	macKeychainItemNotFound    = -25300
)

var macRecoveryKeychainTeam = regexp.MustCompile(`^[A-Z0-9]{10}$`)

type macRecoveryKeychainBackend struct {
	api         *macRecoveryKeychainAPI
	accessGroup string
}

var _ macRecoverySlotBackend = (*macRecoveryKeychainBackend)(nil)

// Callers must obtain the sealed identity independently. Only the OS can
// grant this process access to the configured group.
func newMacRecoveryKeychainBackend(bundle macBundleInfo) (*macRecoveryKeychainBackend, error) {
	if buildMode != "release" || bundle.Build.Mode != "release" || !macRecoveryKeychainTeam.MatchString(bundle.Team) {
		return nil, errors.New("本地或未确认正式签名的应用不能启用钥匙串更新授权")
	}
	if err := validateMacSigning(bundle, bundle, "release"); err != nil {
		return nil, err
	}
	api, err := loadMacRecoveryKeychainAPI()
	if err != nil {
		return nil, err
	}
	return &macRecoveryKeychainBackend{api: api, accessGroup: bundle.Team + macRecoveryKeychainSuffix}, nil
}

func openMacRecoveryKeychainSlot(bundle macBundleInfo, target, dataDir string) (*macRecoverySlotAuthority, error) {
	backend, err := newMacRecoveryKeychainBackend(bundle)
	if err != nil {
		return nil, err
	}
	return newMacRecoverySlotAuthority(backend, target, dataDir)
}

func (b *macRecoveryKeychainBackend) withQuery(ctx context.Context, key string, run func(map[string]uintptr) error) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if !macRecoverySlotDigest(key) {
		return errors.New("受保护更新授权槽标识无效")
	}
	api := b.api
	query := map[string]uintptr{
		"kSecClass":                     api.symbols["kSecClassGenericPassword"],
		"kSecUseDataProtectionKeychain": api.symbols["kCFBooleanTrue"],
		"kSecAttrSynchronizable":        api.symbols["kCFBooleanFalse"],
	}
	for name, text := range map[string]string{"kSecAttrService": macRecoveryKeychainService, "kSecAttrAccessGroup": b.accessGroup, "kSecAttrAccount": key} {
		ref := api.stringCreate(0, text, 0x08000100) // kCFStringEncodingUTF8
		if ref == 0 {
			return errors.New("受保护更新存储范围编码失败")
		}
		defer api.release(ref)
		query[name] = ref
	}
	auth := newMacRecoveryKeychainAuthentication()
	if auth == 0 {
		return errors.New("受保护更新存储无法禁用交互认证")
	}
	defer auth.Send(objc.RegisterName("release"))
	query["kSecUseAuthenticationContext"] = uintptr(auth)
	if err := ctx.Err(); err != nil {
		return err
	}
	return run(query)
}

func (b *macRecoveryKeychainBackend) read(ctx context.Context, key string) ([]byte, error) {
	api := b.api
	var raw []byte
	err := b.withQuery(ctx, key, func(query map[string]uintptr) error {
		query["kSecReturnAttributes"], query["kSecReturnData"] = api.symbols["kCFBooleanTrue"], api.symbols["kCFBooleanTrue"]
		match, err := api.dictionary(query)
		if err != nil {
			return err
		}
		defer api.release(match)
		if err = ctx.Err(); err != nil {
			return err
		}
		var output uintptr
		status := api.copyMatching(match, &output)
		if output != 0 {
			defer api.release(output)
		}
		if status == macKeychainItemNotFound && output == 0 {
			return ctx.Err()
		}
		if status != 0 {
			return fmt.Errorf("受保护更新授权读取失败（OSStatus %d）", status)
		}
		if output == 0 || api.typeID(output) != api.dictionaryType() {
			return errors.New("钥匙串没有返回完整的受保护更新授权")
		}
		value, err := api.readData(output, "kSecValueData", maxMacRecoverySlotBytes)
		if err != nil {
			return err
		}
		digest, err := api.readData(output, "kSecAttrGeneric", sha256.Size)
		want := sha256.Sum256(value)
		if err != nil || !bytes.Equal(digest, want[:]) {
			return errors.Join(err, errors.New("钥匙串记录的原文和指纹不一致"))
		}
		raw = value
		return ctx.Err()
	})
	if err != nil {
		return nil, err
	}
	return raw, nil
}

func (b *macRecoveryKeychainBackend) compareAndSwap(ctx context.Context, key string, before, after []byte) (bool, error) {
	if (before == nil && after == nil) || (before != nil && (len(before) == 0 || len(before) > maxMacRecoverySlotBytes)) ||
		(after != nil && (len(after) == 0 || len(after) > maxMacRecoverySlotBytes)) {
		return false, errors.New("受保护更新授权的条件替换参数无效")
	}
	api := b.api
	ok := false
	err := b.withQuery(ctx, key, func(query map[string]uintptr) error {
		values := map[string]uintptr{}
		if before != nil {
			fingerprint := sha256.Sum256(before)
			ref := api.dataCreate(0, &fingerprint[0], len(fingerprint))
			if ref == 0 {
				return errors.New("无法构造旧记录的比较条件")
			}
			defer api.release(ref)
			query["kSecAttrGeneric"] = ref
		} else {
			values = query // Creation sends the same scope plus the new payload.
			values["kSecAttrAccessible"] = api.symbols["kSecAttrAccessibleWhenUnlockedThisDeviceOnly"]
		}
		if after != nil {
			fingerprint := sha256.Sum256(after)
			data := api.dataCreate(0, &after[0], len(after))
			digest := api.dataCreate(0, &fingerprint[0], len(fingerprint))
			if data != 0 {
				defer api.release(data)
			}
			if digest != 0 {
				defer api.release(digest)
			}
			if data == 0 || digest == 0 {
				return errors.New("无法构造新记录和指纹")
			}
			values["kSecValueData"], values["kSecAttrGeneric"] = data, digest
		}
		match, err := api.dictionary(query)
		if err != nil {
			return err
		}
		defer api.release(match)
		var attributes uintptr
		if before != nil && after != nil {
			attributes, err = api.dictionary(values)
			if err != nil {
				return err
			}
			defer api.release(attributes)
		}
		if err = ctx.Err(); err != nil {
			return err
		}
		var status int32
		var operation string
		switch {
		case before == nil:
			operation = "创建"
			status = api.add(match, nil)
			if status == macKeychainDuplicateItem {
				return nil
			}
		case after == nil:
			operation = "删除"
			status = api.delete(match)
		default:
			operation = "替换"
			status = api.update(match, attributes)
		}
		if before != nil && status == macKeychainItemNotFound {
			return nil
		}
		if status != 0 {
			return fmt.Errorf("受保护更新授权%s失败（OSStatus %d）", operation, status)
		}
		if err = ctx.Err(); err != nil {
			return err
		}
		ok = true
		return nil
	})
	return ok, err
}
