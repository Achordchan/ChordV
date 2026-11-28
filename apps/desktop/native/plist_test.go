package main

import (
	"encoding/base64"
	"reflect"
	"testing"
)

func TestPlistSnapshotPreservesMissingKeysEmptyValuesAndAllTypes(t *testing.T) {
	original := map[string]any{"HTTPEnable": int64(0), "HTTPProxy": "", "SOCKSProxy": "old.proxy.test", "SOCKSPort": int64(1080), "ExceptionsList": []any{"*.local", "169.254/16"}, "ExcludeSimpleHostnames": true, "Data": []byte{0, 1, 255}, "Nested": map[string]any{"number": float64(1.5), "date": plistDate("2026-11-16T00:00:00Z")}}
	bytes, err := marshalPlist(original)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := parsePlist(bytes)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(parsed, original) {
		t.Fatal("snapshot types or values changed", parsed)
	}
	before := proxySetting{Service: "service", Kind: "macos", Values: map[string]string{"name": "Wi-Fi", "configuration": base64.StdEncoding.EncodeToString(bytes), "missing": "0", "enabled": "No"}}
	owned, err := desiredProxy(before, 10809, 10808)
	if err != nil {
		t.Fatal(err)
	}
	data, _ := base64.StdEncoding.DecodeString(owned.Values["configuration"])
	current, err := parsePlist(data)
	if err != nil {
		t.Fatal(err)
	}
	if current["HTTPProxy"] != "127.0.0.1" || current["HTTPPort"] != int64(10809) || !reflect.DeepEqual(current["ExceptionsList"], original["ExceptionsList"]) {
		t.Fatal("proxy config lost unrelated fields")
	}
	restored, _ := base64.StdEncoding.DecodeString(before.Values["configuration"])
	snapshot, _ := parsePlist(restored)
	if _, exists := snapshot["HTTPPort"]; exists {
		t.Fatal("originally absent port invented in snapshot")
	}
	if snapshot["HTTPProxy"] != "" {
		t.Fatal("original blank proxy not preserved")
	}
}
