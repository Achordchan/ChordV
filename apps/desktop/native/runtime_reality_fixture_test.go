package main

import (
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"crypto/tls"
	"encoding/base64"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"testing"
)

const realityTestUser = "11111111-1111-4111-8111-111111111111"

func startRealityTestPeer(t *testing.T, binary string, echoPort int) (runtimeOutbound, *exec.Cmd) {
	t.Helper()
	camouflage := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(204) }))
	camouflage.EnableHTTP2 = true
	camouflage.TLS = &tls.Config{MinVersion: tls.VersionTLS13}
	camouflage.Config.ErrorLog = log.New(io.Discard, "", 0)
	camouflage.StartTLS()
	t.Cleanup(camouflage.Close)
	key, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	port, _ := localTestPorts(t)
	dir := t.TempDir()
	config := map[string]any{
		"log": map[string]any{"loglevel": "warning"},
		"dns": map[string]any{"hosts": map[string]any{"chordv-proxy-target.test": "127.0.0.1"}},
		"inbounds": []any{map[string]any{
			"listen": "127.0.0.1", "port": port, "protocol": "vless",
			"settings": map[string]any{"clients": []any{map[string]any{"id": realityTestUser}}, "decryption": "none"},
			"streamSettings": map[string]any{"network": "tcp", "security": "reality", "realitySettings": map[string]any{
				"dest": camouflage.Listener.Addr().String(), "serverNames": []string{"example.com"},
				"privateKey": base64.RawURLEncoding.EncodeToString(key.Bytes()), "shortIds": []string{"0102030405060708"},
			}},
		}},
		"outbounds": []any{map[string]any{"protocol": "freedom", "streamSettings": map[string]any{"sockopt": map[string]any{"domainStrategy": "ForceIP"}}, "settings": map[string]any{
			"targetStrategy": "ForceIP",
			// New Xray blocks private targets from VLESS by default. The
			// isolated peer may reach only this test's exact loopback echo.
			"finalRules": []any{
				map[string]any{"action": "allow", "network": "tcp", "ip": []string{"127.0.0.1/32"}, "port": strconv.Itoa(echoPort)},
				map[string]any{"action": "block", "delay": 0},
			},
		}}},
	}
	file := filepath.Join(dir, "server.json")
	if err = atomicJSON(file, config); err != nil {
		t.Fatal(err)
	}
	output, err := os.Create(filepath.Join(dir, "server.log"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = output.Close() })
	command := exec.Command(binary, "run", "-config", file)
	command.Env = systemProcessEnvironment()
	command.Stdout, command.Stderr = output, output
	if err = command.Start(); err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() { _ = command.Wait(); close(done) }()
	t.Cleanup(func() { _ = command.Process.Kill(); <-done })
	t.Cleanup(func() {
		if t.Failed() {
			raw, _ := os.ReadFile(filepath.Join(dir, "server.log"))
			t.Logf("real Reality server log: %s", raw)
		}
	})
	if err = waitRuntimeReady(context.Background(), done, port); err != nil {
		t.Fatal("genuine loopback Reality server failed", err)
	}
	return runtimeOutbound{Protocol: "vless", Server: net.IPv4(127, 0, 0, 1).String(), Port: port, UUID: realityTestUser, ServerName: "example.com", RealityPublicKey: base64.RawURLEncoding.EncodeToString(key.PublicKey().Bytes()), ShortID: "0102030405060708", Fingerprint: "chrome", SpiderX: "/"}, command
}
