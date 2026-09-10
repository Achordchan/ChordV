package onboarding

import (
	"encoding/json"
	"testing"
)

func sampleConfig() map[string]any {
	return map[string]any{
		"api":      map[string]any{"tag": "api", "services": []string{"HandlerService", "StatsService"}},
		"inbounds": []any{map[string]any{"tag": "api", "listen": "127.0.0.1", "port": 62789, "protocol": "dokodemo-door"}},
		"routing":  map[string]any{"rules": []any{map[string]any{"inboundTag": []string{"api"}, "outboundTag": "api"}}},
		"policy":   map[string]any{"levels": map[string]any{"0": map[string]any{"statsUserUplink": true, "statsUserDownlink": true}}},
		"stats":    map[string]any{},
	}
}

func TestVersionGate(t *testing.T) {
	for _, value := range []string{"3.7.0", "v3.7.2", "3.10.0"} {
		if !SupportedVersion(value) {
			t.Fatalf("supported version rejected: %s", value)
		}
	}
	for _, value := range []string{"2.8.10", "3.4.2", "3.6.99", "3.7.0-beta", "4.0.0", "", "3.7.0\nsecret"} {
		if SupportedVersion(value) {
			t.Fatalf("unverified version accepted: %s", value)
		}
	}
}

func TestDiscoverAPIPortAndPolicy(t *testing.T) {
	data, _ := json.Marshal(sampleConfig())
	address, err := APIAddress(data)
	if err != nil || address != "127.0.0.1:62789" {
		t.Fatalf("%q %v", address, err)
	}
	cases := map[string]func(map[string]any){
		"public listener":   func(c map[string]any) { c["inbounds"].([]any)[0].(map[string]any)["listen"] = "0.0.0.0" },
		"implicit wildcard": func(c map[string]any) { delete(c["inbounds"].([]any)[0].(map[string]any), "listen") },
		"missing route":     func(c map[string]any) { delete(c, "routing") },
		"missing stats":     func(c map[string]any) { delete(c, "stats") },
		"missing policy":    func(c map[string]any) { delete(c, "policy") },
		"one direction disabled": func(c map[string]any) {
			c["policy"].(map[string]any)["levels"].(map[string]any)["0"].(map[string]any)["statsUserDownlink"] = false
		},
		"missing handler": func(c map[string]any) { c["api"].(map[string]any)["services"] = []string{"StatsService"} },
		"port range":      func(c map[string]any) { c["inbounds"].([]any)[0].(map[string]any)["port"] = "10000-20000" },
		"ambiguous api":   func(c map[string]any) { c["api"].(map[string]any)["listen"] = "127.0.0.1:10085" },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			c := sampleConfig()
			mutate(c)
			data, _ := json.Marshal(c)
			if address, err := APIAddress(data); err == nil {
				t.Fatalf("unsafe config accepted: %s", address)
			}
		})
	}
}

func TestDirectAPIAndUnixSocket(t *testing.T) {
	for _, address := range []string{"[::1]:65001", "unix:/run/xray/api.sock"} {
		c := sampleConfig()
		delete(c, "inbounds")
		c["api"].(map[string]any)["listen"] = address
		data, _ := json.Marshal(c)
		got, err := APIAddress(data)
		if err != nil || got != address {
			t.Fatalf("%s: %s %v", address, got, err)
		}
	}
}

func TestCurrentPanelTunnelListener(t *testing.T) {
	c := sampleConfig()
	c["inbounds"].([]any)[0].(map[string]any)["protocol"] = "tunnel"
	data, _ := json.Marshal(c)
	address, err := APIAddress(data)
	if err != nil || address != "127.0.0.1:62789" {
		t.Fatalf("actual 3x-ui 3.7.0 listener rejected: %s %v", address, err)
	}
}

func TestSocketCannotInjectEnvironment(t *testing.T) {
	c := sampleConfig()
	delete(c, "inbounds")
	c["api"].(map[string]any)["listen"] = "unix:/run/$(id).sock"
	data, _ := json.Marshal(c)
	if _, err := APIAddress(data); err == nil {
		t.Fatal("shell syntax accepted in EnvironmentFile value")
	}
}
