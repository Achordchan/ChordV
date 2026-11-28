package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"testing"
)

func testService(t *testing.T, base string) *DesktopService {
	t.Helper()
	service := newDesktopService(appConfig{DataDir: t.TempDir(), APIBase: base})
	t.Cleanup(service.cancel)
	return service
}
func testSession(token string) json.RawMessage {
	data, _ := json.Marshal(map[string]any{"accessToken": "access-" + token, "refreshToken": token, "user": map[string]string{"id": "test-user", "email": "local@example.test", "displayName": "本地测试"}})
	return data
}
func testHash(data []byte) string { hash := sha256.Sum256(data); return hex.EncodeToString(hash[:]) }

func testDesiredProxy(before proxySetting, httpPort, socksPort int) proxySetting {
	if before.Kind != "web" {
		owned, err := desiredProxy(before, httpPort, socksPort)
		if err != nil {
			panic(err)
		}
		return owned
	}
	values := map[string]string{}
	for key, value := range before.Values {
		values[key] = value
	}
	values["enabled"] = "Yes"
	values["server"] = "127.0.0.1"
	values["port"] = "10809"
	values["authenticated"] = "0"
	return proxySetting{Service: before.Service, Kind: before.Kind, Values: values}
}
