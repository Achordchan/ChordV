package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

func TestNodeProbeMeasuresRealLocalListenerAndClosedPort(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	results, err := probeNodes(context.Background(), []nodeSummary{{ID: "local", ServerHost: "127.0.0.1", ServerPort: port}, {ID: "missing"}})
	listener.Close()
	if err != nil {
		t.Fatal(err)
	}
	if results[0]["status"] != "healthy" || results[1]["status"] != "unknown" {
		t.Fatal("node status mismatch", results)
	}
	results, err = probeNodes(context.Background(), []nodeSummary{{ID: "closed", ServerHost: "127.0.0.1", ServerPort: port}})
	if err != nil || results[0]["status"] != "offline" {
		t.Fatal("closed port reported healthy", results, err)
	}
}
func TestRuntimeReadinessRequiresBothPortsAndLiveProcess(t *testing.T) {
	one, _ := net.Listen("tcp", "127.0.0.1:0")
	defer one.Close()
	two, _ := net.Listen("tcp", "127.0.0.1:0")
	defer two.Close()
	done := make(chan struct{})
	if err := waitRuntimeReady(context.Background(), done, one.Addr().(*net.TCPAddr).Port, two.Addr().(*net.TCPAddr).Port); err != nil {
		t.Fatal(err)
	}
	close(done)
	if err := waitRuntimeReady(context.Background(), done, one.Addr().(*net.TCPAddr).Port); err == nil {
		t.Fatal("exited process reported ready")
	}
}
func TestRuntimeConfigPreservesOrderedRulesAndRealityFields(t *testing.T) {
	config := runtimeConfig{SessionID: "session", LeaseHeartbeatIntervalSeconds: 30, LeaseGraceSeconds: 300, Mode: "rule", LocalHTTPPort: 10809, LocalSocksPort: 10808, Outbound: runtimeOutbound{Server: "local.test", Port: 443, UUID: "local-uuid", RealityPublicKey: "key", MLDSA65Verify: "mldsa"}, Features: runtimeFeatures{BlockAds: true, ChinaDirect: true, AIServicesProxy: true}, CustomRoutingRules: []routingRule{{ID: "custom", Value: "example.test", MatchType: "domain", Action: "direct", Enabled: true}}}
	if err := validateRuntimeConfig(config); err != nil {
		t.Fatal(err)
	}
	built := buildXrayConfig(config, "runtime.log")
	rules := built["routing"].(map[string]any)["rules"].([]any)
	first := rules[0].(map[string]any)
	if first["outboundTag"] != "direct" || !reflect.DeepEqual(first["domain"], []string{"domain:example.test"}) {
		t.Fatal("custom priority changed")
	}
	outbound := built["outbounds"].([]any)[0].(map[string]any)
	reality := outbound["streamSettings"].(map[string]any)["realitySettings"].(map[string]any)
	if reality["mldsa65Verify"] != "mldsa" {
		t.Fatal("reality fields lost")
	}
	config.Mode = "direct"
	if len(routingRules(config)) != 1 {
		t.Fatal("direct mode retained rule list")
	}
}
func protoBytes(number uint64, value []byte) []byte {
	header := binary.AppendUvarint(nil, number<<3|2)
	header = binary.AppendUvarint(header, uint64(len(value)))
	return append(header, value...)
}
func TestGeositeDiagnosticReadsActualProtobufAndCustomRulesWin(t *testing.T) {
	s := testService(t, "http://127.0.0.1:3100")
	domain := binary.AppendUvarint(nil, 1<<3)
	domain = binary.AppendUvarint(domain, 2)
	domain = append(domain, protoBytes(2, []byte("example.cn"))...)
	entry := append(protoBytes(1, []byte("CN")), protoBytes(2, domain)...)
	data := protoBytes(1, entry)
	os.MkdirAll(s.binDir(), 0700)
	os.WriteFile(filepath.Join(s.binDir(), "geosite.dat"), data, 0600)
	matched, err := queryGeosite(filepath.Join(s.binDir(), "geosite.dat"), "www.example.cn")
	if err != nil || !matched["CN"] {
		t.Fatal(matched, err)
	}
	input := map[string]any{"value": "www.example.cn", "mode": "rule", "features": map[string]bool{"chinaDirect": true}, "customRoutingRules": []routingRule{{Value: "example.cn", MatchType: "domain", Action: "proxy", Enabled: true}}}
	raw, _ := json.Marshal(input)
	result, err := s.testRoutingRule(context.Background(), raw)
	if err != nil || result.(map[string]any)["action"] != "proxy" {
		t.Fatal("GEO overrode explicit rule", result, err)
	}
}
func TestCanceledReadinessReturnsWithoutWaitingWholeDeadline(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	started := time.Now()
	if err := waitRuntimeReady(ctx, make(chan struct{}), 12345); err == nil || time.Since(started) > time.Second {
		t.Fatal("readiness ignored cancellation")
	}
}
