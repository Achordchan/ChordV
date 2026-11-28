package main

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func leaseTestConfig() runtimeConfig {
	return runtimeConfig{SessionID: "lease-test", Mode: "direct", LocalHTTPPort: 41001, LocalSocksPort: 41002,
		LeaseHeartbeatIntervalSeconds: 30, LeaseGraceSeconds: 300,
		Outbound: runtimeOutbound{Server: "127.0.0.1", Port: 443, UUID: "lease-test-uuid"}}
}

func TestLeaseConfigBoundsThroughInvoke(t *testing.T) {
	for _, field := range []string{"leaseHeartbeatIntervalSeconds", "leaseGraceSeconds"} {
		values := []string{"null", "0", "-1", "4", "2147484", "9223372037", "1.5", `"30"`}
		if field == "leaseGraceSeconds" {
			values = append(values, "29")
		}
		values = append(values, "omit")
		for _, value := range values {
			t.Run(field+"/"+value, func(t *testing.T) {
				s := testService(t, "http://127.0.0.1:1")
				body, _ := json.Marshal(leaseTestConfig())
				var config map[string]json.RawMessage
				_ = json.Unmarshal(body, &config)
				if value == "omit" {
					delete(config, field)
				} else {
					config[field] = json.RawMessage(value)
				}
				payload, _ := json.Marshal(map[string]any{"config": config})
				_, err := s.Invoke(context.Background(), "connect_runtime", payload)
				if err == nil || (!strings.Contains(err.Error(), "租约") && !strings.Contains(err.Error(), "原生请求格式")) {
					t.Fatalf("invalid lease value reached component/runtime setup: %v", err)
				}
			})
		}
	}
	for _, bounds := range [][2]int{{5, 30}, {30, 300}, {2147483, 2147483}} {
		t.Run(fmt.Sprint(bounds), func(t *testing.T) {
			config := leaseTestConfig()
			config.LeaseHeartbeatIntervalSeconds, config.LeaseGraceSeconds = bounds[0], bounds[1]
			if err := validateRuntimeConfig(config); err != nil {
				t.Fatal(err)
			}
		})
	}
}
