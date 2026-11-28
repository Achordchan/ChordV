//go:build darwin

package main

import (
	"context"
	"encoding/base64"
	"os"
	"testing"
	"unsafe"
)

func TestMacNativeSnapshotIsReadOnlyAndPreservesPropertyTypes(t *testing.T) {
	before, err := os.Stat("/Library/Preferences/SystemConfiguration/preferences.plist")
	if err != nil {
		t.Skip("system preferences unavailable")
	}
	settings, err := platformReadProxy(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	for _, setting := range settings {
		bytes, err := base64.StdEncoding.DecodeString(setting.Values["configuration"])
		if err != nil {
			t.Fatal(err)
		}
		if _, err = parsePlist(bytes); err != nil {
			t.Fatal(err)
		}
		if _, err = desiredProxy(setting, 10809, 10808); err != nil {
			t.Fatal(err)
		}
	}
	after, err := os.Stat("/Library/Preferences/SystemConfiguration/preferences.plist")
	if err != nil {
		t.Fatal(err)
	}
	if before.ModTime() != after.ModTime() {
		t.Fatal("read-only proxy inspection changed system preferences")
	}
	if unsafe.Sizeof(macAuthorizationRights{}) != 16 || unsafe.Sizeof(macAuthorizationItem{}) != 32 {
		t.Fatal("Authorization ABI layout mismatch")
	}
}

func TestMacNativePropertyListRoundTripDoesNotOpenAuthorization(t *testing.T) {
	api, err := loadMacSystemAPI()
	if err != nil {
		t.Fatal(err)
	}
	bytes, err := marshalPlist(map[string]any{"HTTPEnable": int64(0), "HTTPProxy": "", "ExceptionsList": []any{"*.local", "169.254/16"}})
	if err != nil {
		t.Fatal(err)
	}
	dictionary, err := api.dictionaryFromData(bytes)
	if err != nil {
		t.Fatal(err)
	}
	defer api.release(dictionary)
	encoded, err := api.dictionaryData(dictionary)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := parsePlist(encoded)
	if err != nil {
		t.Fatal(err)
	}
	if parsed["HTTPEnable"] != int64(0) || parsed["HTTPProxy"] != "" {
		t.Fatal("CFPropertyList types changed", parsed)
	}
	macAuthorization.Lock()
	authorized := macAuthorization.ref != 0
	macAuthorization.Unlock()
	if authorized {
		t.Fatal("read-only snapshot unexpectedly requested authorization")
	}
}

func TestMacAuthorizationExternalFormWithoutRequestingAnyRights(t *testing.T) {
	api, err := loadMacSystemAPI()
	if err != nil {
		t.Fatal(err)
	}
	var authorization uintptr
	if status := api.authCreate(0, 0, 0, &authorization); status != 0 || authorization == 0 {
		t.Fatal("AuthorizationCreate default ABI failed", status)
	}
	defer api.authFree(authorization, 0)
	var external [32]byte
	if status := api.authExternal(authorization, &external); status != 0 {
		t.Fatal("external form ABI failed", status)
	}
	var imported uintptr
	if status := api.authImport(&external, &imported); status != 0 || imported == 0 {
		t.Fatal("external form import ABI failed", status)
	}
	defer api.authFree(imported, 0)
}
