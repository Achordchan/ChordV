//go:build darwin

package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"strings"
	"testing"

	"github.com/ebitengine/purego/objc"
)

func macRecoveryKeychainTestAPI(t *testing.T) macRecoveryKeychainAPI {
	t.Helper()
	api, err := loadMacRecoveryKeychainAPI()
	if err != nil {
		t.Fatal(err)
	}
	offline := *api
	unexpected := func() int32 { t.Fatal("unexpected Security mutation/read call"); return -1 }
	offline.copyMatching = func(uintptr, *uintptr) int32 { return unexpected() }
	offline.add = func(uintptr, *uintptr) int32 { return unexpected() }
	offline.update = func(uintptr, uintptr) int32 { return unexpected() }
	offline.delete = func(uintptr) int32 { return unexpected() }
	return offline
}

func macRecoveryKeychainTestScope(t *testing.T, api *macRecoveryKeychainAPI, dict uintptr, key, group string) {
	t.Helper()
	get := func(name string) uintptr { return api.dictionaryGet(dict, api.symbols[name]) }
	for name, symbol := range map[string]string{"kSecClass": "kSecClassGenericPassword", "kSecUseDataProtectionKeychain": "kCFBooleanTrue", "kSecAttrSynchronizable": "kCFBooleanFalse"} {
		if get(name) != api.symbols[symbol] {
			t.Fatalf("query weakened its scope: %s", name)
		}
	}
	for name, want := range map[string]string{"kSecAttrService": macRecoveryKeychainService, "kSecAttrAccount": key, "kSecAttrAccessGroup": group} {
		ref := get(name)
		if ref == 0 || objc.Send[string](objc.ID(ref), objc.RegisterName("UTF8String")) != want {
			t.Fatalf("query lost exact scope: %s", name)
		}
	}
	context := objc.ID(get("kSecUseAuthenticationContext"))
	if context == 0 || !objc.Send[bool](context, objc.RegisterName("interactionNotAllowed")) {
		t.Fatal("query could prompt for authentication")
	}
}

func TestMacRecoveryKeychainLocalBuildDoesNotOpenStorage(t *testing.T) {
	if _, err := newMacRecoveryKeychainBackend(macBundleInfo{Identifier: "app.chordv.desktop", Team: "AB12CD34EF", Build: macBuildInfo{Mode: "release"}}); err == nil {
		t.Fatal("local binary enabled the system store through caller-supplied bundle fields")
	}
}

func TestMacRecoveryKeychainUsesSingleConditionalMutation(t *testing.T) {
	api := macRecoveryKeychainTestAPI(t)
	b := &macRecoveryKeychainBackend{api: &api, accessGroup: "AB12CD34EF" + macRecoveryKeychainSuffix}
	get := func(dict uintptr, key string) uintptr { return api.dictionaryGet(dict, api.symbols[key]) }
	before, after := []byte("previous exact bytes"), []byte("replacement exact bytes")
	key := macPlanDigest([]byte("private installation identity"))
	newDigest, oldDigest := sha256.Sum256(after), sha256.Sum256(before)
	checkData := func(dict uintptr, name string, want []byte) {
		t.Helper()
		found, err := api.readData(dict, name, maxMacRecoverySlotBytes)
		if err != nil || !bytes.Equal(found, want) {
			t.Fatalf("wrong %s: %x (%v)", name, found, err)
		}
	}
	checkQuery := func(dict uintptr) {
		t.Helper()
		macRecoveryKeychainTestScope(t, &api, dict, key, b.accessGroup)
		if get(dict, "kSecReturnData") != 0 || get(dict, "kSecReturnAttributes") != 0 {
			t.Fatal("write query unexpectedly requested return flags")
		}
	}
	var called int
	var status int32
	api.add = func(dict uintptr, result *uintptr) int32 {
		called++
		checkQuery(dict)
		if result != nil || get(dict, "kSecAttrAccessible") != api.symbols["kSecAttrAccessibleWhenUnlockedThisDeviceOnly"] {
			t.Fatal("creation changed its fixed protection class")
		}
		checkData(dict, "kSecValueData", after)
		checkData(dict, "kSecAttrGeneric", newDigest[:])
		return status
	}
	api.update = func(query, attributes uintptr) int32 {
		called++
		checkQuery(query)
		checkData(query, "kSecAttrGeneric", oldDigest[:])
		if get(query, "kSecValueData") != 0 || get(attributes, "kSecAttrAccessGroup") != 0 || get(attributes, "kSecAttrAccessible") != 0 {
			t.Fatal("replacement rewrote scope/protection or searched by secret data")
		}
		checkData(attributes, "kSecValueData", after)
		checkData(attributes, "kSecAttrGeneric", newDigest[:])
		return status
	}
	api.delete = func(query uintptr) int32 {
		called++
		checkQuery(query)
		checkData(query, "kSecAttrGeneric", oldDigest[:])
		return status
	}
	for _, tc := range []struct {
		name          string
		before, after []byte
		status        int32
		ok, fails     bool
	}{
		{"create", nil, after, 0, true, false}, {"duplicate", nil, after, macKeychainDuplicateItem, false, false},
		{"replace", before, after, 0, true, false}, {"stale-replacement", before, after, macKeychainItemNotFound, false, false},
		{"delete", before, nil, 0, true, false}, {"stale-deletion", before, nil, macKeychainItemNotFound, false, false},
		{"no-access-group-entitlement", before, after, -34018, false, true}, {"device-locked", before, nil, -25308, false, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			status, called = tc.status, 0
			ok, err := b.compareAndSwap(context.Background(), key, tc.before, tc.after)
			if ok != tc.ok || (err != nil) != tc.fails || called != 1 {
				t.Fatal("mutation was unconditional, retried, or misclassified", ok, err, called)
			}
		})
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	called = 0
	if ok, err := b.compareAndSwap(ctx, key, before, after); ok || !errors.Is(err, context.Canceled) || called != 0 {
		t.Fatal("canceled request reached Security", ok, err, called)
	}
	ctx, cancel = context.WithCancel(context.Background())
	defer cancel()
	api.update = func(uintptr, uintptr) int32 { cancel(); return 0 }
	if ok, err := b.compareAndSwap(ctx, key, before, after); ok || !errors.Is(err, context.Canceled) {
		t.Fatal("reply loss after possible mutation was reported as confirmed", ok, err)
	}
}

func TestMacRecoveryKeychainReadChecksPayloadAndDigest(t *testing.T) {
	api := macRecoveryKeychainTestAPI(t)
	b := &macRecoveryKeychainBackend{api: &api, accessGroup: "AB12CD34EF" + macRecoveryKeychainSuffix}
	key := macPlanDigest([]byte("private installation identity"))
	data := []byte("slot record")
	fingerprint := sha256.Sum256(data)
	for _, mode := range []string{"valid", "missing", "denied", "wrong-digest", "wrong-type", "too-large"} {
		t.Run(mode, func(t *testing.T) {
			api.copyMatching = func(query uintptr, output *uintptr) int32 {
				macRecoveryKeychainTestScope(t, &api, query, key, b.accessGroup)
				for _, flag := range []string{"kSecReturnAttributes", "kSecReturnData"} {
					if api.dictionaryGet(query, api.symbols[flag]) != api.symbols["kCFBooleanTrue"] {
						t.Fatal("read did not ask for both payload and fingerprint")
					}
				}
				switch mode {
				case "missing":
					return macKeychainItemNotFound
				case "denied":
					return -34018
				case "wrong-type":
					*output = api.stringCreate(0, "unexpected", 0x08000100)
					return 0
				}
				body, digest := data, fingerprint
				if mode == "wrong-digest" {
					digest[0] ^= 1
				}
				if mode == "too-large" {
					body = []byte(strings.Repeat("x", maxMacRecoverySlotBytes+1))
				}
				valueRef, digestRef := api.dataCreate(0, &body[0], len(body)), api.dataCreate(0, &digest[0], len(digest))
				defer api.release(valueRef)
				defer api.release(digestRef)
				result, err := api.dictionary(map[string]uintptr{"kSecValueData": valueRef, "kSecAttrGeneric": digestRef})
				if err != nil {
					t.Fatal(err)
				}
				*output = result
				return 0
			}
			value, err := b.read(context.Background(), key)
			switch mode {
			case "valid":
				if err != nil || !bytes.Equal(value, data) {
					t.Fatal("read lost checked bytes", err)
				}
			case "missing":
				if err != nil || value != nil {
					t.Fatal("a missing item was not treated as absent", err)
				}
			default:
				if err == nil || value != nil {
					t.Fatal("the failed or corrupt read was accepted", err)
				}
			}
		})
	}
}
