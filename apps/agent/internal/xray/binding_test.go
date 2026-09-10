package xray

import (
	"context"
	"crypto/ecdh"
	"encoding/base64"
	"math/big"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Achordchan/ChordV/apps/agent/internal/protocol"
	"github.com/Achordchan/ChordV/apps/agent/internal/store"
	"github.com/xtls/xray-core/app/proxyman"
	handler "github.com/xtls/xray-core/app/proxyman/command"
	"github.com/xtls/xray-core/common/serial"
	vin "github.com/xtls/xray-core/proxy/vless/inbound"
	"github.com/xtls/xray-core/transport/internet"
	"github.com/xtls/xray-core/transport/internet/reality"
	"google.golang.org/protobuf/proto"
)

// Uses a real Xray API and SQLite database; no production binding hooks are replaced.
func bindingFixture(t *testing.T) (*GRPC, map[string]any) {
	t.Helper()
	key, err := ecdh.X25519().NewPrivateKey([]byte(strings.Repeat("k", 32)))
	if err != nil {
		t.Fatal(err)
	}
	stream := &internet.StreamConfig{ProtocolName: "tcp", SecurityType: "xray.transport.internet.reality.Config", SecuritySettings: []*serial.TypedMessage{
		serial.ToTypedMessage(&reality.Config{Dest: "127.0.0.1:1", Type: "tcp", PrivateKey: key.Bytes(), ServerNames: []string{"example.com"}, ShortIds: [][]byte{{0xab, 0xcd, 0, 0, 0, 0, 0, 0}}}),
	}}
	g, _ := configuredProxyServer(t, false, stream, &vin.Config{Decryption: "none"})
	inbounds, err := g.handler.ListInbounds(context.Background(), &handler.ListInboundsRequest{})
	if err != nil {
		t.Fatal(err)
	}
	var receiver proxyman.ReceiverConfig
	if err := proto.Unmarshal(inbounds.Inbounds[0].ReceiverSettings.Value, &receiver); err != nil {
		t.Fatal(err)
	}
	spec := map[string]any{"mode": "validate_panel", "inboundTag": "inbound-parser-default", "listenPort": float64(receiver.PortList.Range[0].From),
		"realityPublicKey": base64.RawURLEncoding.EncodeToString(key.PublicKey().Bytes()), "shortId": "abcd", "serverNames": []any{"example.com"},
		"serverHost": "node.example.com", "flow": "xtls-rprx-vision", "fingerprint": "chrome", "spiderX": "/"}
	connection := *g
	connection.tag = ""
	return &connection, spec
}

func bindingStore(t *testing.T, path, boot string) *store.Store {
	t.Helper()
	s, err := store.Open(path, store.Options{NodeID: "node-binding", BootID: boot, DefaultOfflineAllowance: big.NewInt(64 * 1024 * 1024)})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

func TestBindingRestoresAfterPersistenceBeforeCommandCompletion(t *testing.T) {
	connection, spec := bindingFixture(t)
	path := filepath.Join(t.TempDir(), "agent.db")
	state := bindingStore(t, path, "before-crash")
	binding, err := NewBinding(connection, state)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	cmd := protocol.Command{CommandID: "bind-command", Type: protocol.CommandEnsureInbound, TargetRevision: "1", Payload: spec}
	if _, err := state.BeginCommand(cmd); err != nil {
		t.Fatal(err)
	}
	first, err := binding.ValidatePanel(ctx, spec)
	if err != nil {
		t.Fatal(err)
	}
	tag, err := state.InboundBinding()
	if err != nil || tag == "" {
		t.Fatalf("binding not persisted: %q %v", tag, err)
	}
	// Model loss of the process after persistence, with no CompleteCommand call.
	if err := state.Close(); err != nil {
		t.Fatal(err)
	}
	restoredState := bindingStore(t, path, "after-crash")
	restored, err := NewBinding(connection, restoredState)
	if err != nil || !restored.InboundReady() {
		t.Fatalf("restore failed: %v", err)
	}
	if completed, err := restoredState.BeginCommand(cmd); err != nil || completed != nil {
		t.Fatalf("unfinished command must replay: %+v %v", completed, err)
	}
	replay, err := restored.ValidatePanel(ctx, spec)
	if err != nil {
		t.Fatal(err)
	}
	if first["inbound"].(map[string]any)["inboundTag"] != replay["inbound"].(map[string]any)["inboundTag"] {
		t.Fatal("replay changed target")
	}
	if err := restoredState.CompleteCommand(protocol.CommandResult{CommandID: cmd.CommandID, Status: protocol.StatusCompleted, Result: replay}); err != nil {
		t.Fatal(err)
	}
	if completed, err := restoredState.BeginCommand(cmd); err != nil || completed == nil || completed.Status != protocol.StatusCompleted {
		t.Fatalf("completed replay was not retained: %+v %v", completed, err)
	}
	spec["tagOverrideConfirmed"] = true
	spec["inboundTag"] = "other-target"
	if _, err := restored.ValidatePanel(ctx, spec); err == nil {
		t.Fatal("conflicting tag accepted")
	}
	if got, err := restoredState.InboundBinding(); err != nil || got != tag {
		t.Fatalf("conflict overwrote binding: %q %v", got, err)
	}
	users, err := restored.ListUsers(ctx)
	if err != nil || len(users) != 0 {
		t.Fatalf("validation changed users: %+v %v", users, err)
	}
}

func TestFailedValidationNeverBindsAndUnboundAdapterRejectsAccountAccess(t *testing.T) {
	connection, spec := bindingFixture(t)
	state := bindingStore(t, filepath.Join(t.TempDir(), "agent.db"), "boot")
	binding, err := NewBinding(connection, state)
	if err != nil {
		t.Fatal(err)
	}
	spec["realityPublicKey"] = "wrong"
	if _, err := binding.ValidatePanel(context.Background(), spec); err == nil {
		t.Fatal("invalid public key accepted")
	}
	if tag, err := state.InboundBinding(); err != nil || tag != "" || binding.InboundReady() {
		t.Fatalf("failed validation persisted binding: %q %v", tag, err)
	}
	ctx := context.Background()
	if _, err := binding.ListUsers(ctx); err == nil {
		t.Fatal("unbound user read accepted")
	}
	if _, err := binding.ReadAbsoluteCounters(ctx); err == nil {
		t.Fatal("unbound counter read accepted")
	}
	if err := binding.EnsureUser(ctx, protocol.DesiredUser{}, Expectation{}); err == nil {
		t.Fatal("unbound user install accepted")
	}
	if err := binding.RemoveUser(ctx, "panel-user", Expectation{}); err == nil {
		t.Fatal("unbound user removal accepted")
	}
}
