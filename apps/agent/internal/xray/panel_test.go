package xray

import (
	"context"
	"crypto/ecdh"
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"

	"github.com/xtls/xray-core/app/proxyman"
	handler "github.com/xtls/xray-core/app/proxyman/command"
	"github.com/xtls/xray-core/common/serial"
	vin "github.com/xtls/xray-core/proxy/vless/inbound"
	"github.com/xtls/xray-core/transport/internet"
	"github.com/xtls/xray-core/transport/internet/reality"
	"google.golang.org/protobuf/proto"
)

func TestPanelValidationReadsActualRealityWithoutMutation(t *testing.T) {
	testPanelValidation(t, "none", false)
}

func TestPanelValidationRejectsEncryptedVLESS(t *testing.T) {
	testPanelValidation(t, base64.RawURLEncoding.EncodeToString([]byte(strings.Repeat("e", 32))), true)
}

func testPanelValidation(t *testing.T, decryption string, reject bool) {
	key, err := ecdh.X25519().NewPrivateKey([]byte(strings.Repeat("k", 32)))
	if err != nil {
		t.Fatal(err)
	}
	stream := &internet.StreamConfig{ProtocolName: "tcp", SecurityType: "xray.transport.internet.reality.Config", SecuritySettings: []*serial.TypedMessage{
		serial.ToTypedMessage(&reality.Config{Dest: "127.0.0.1:1", Type: "tcp", PrivateKey: key.Bytes(), ServerNames: []string{"example.com"}, ShortIds: [][]byte{{0xab, 0xcd, 0, 0, 0, 0, 0, 0}}}),
	}}
	g, _ := configuredProxyServer(t, false, stream, &vin.Config{Decryption: decryption})
	ctx := context.Background()
	inbounds, err := g.handler.ListInbounds(ctx, &handler.ListInboundsRequest{})
	if err != nil {
		t.Fatal(err)
	}
	var receiver proxyman.ReceiverConfig
	if err := proto.Unmarshal(inbounds.Inbounds[0].ReceiverSettings.Value, &receiver); err != nil {
		t.Fatal(err)
	}
	spec := map[string]any{"mode": "validate_panel", "inboundTag": g.tag, "listenPort": float64(receiver.PortList.Range[0].From),
		"realityPublicKey": base64.RawURLEncoding.EncodeToString(key.PublicKey().Bytes()), "shortId": "abcd", "serverNames": []any{"example.com"},
		"serverHost": "node.example.com", "flow": "xtls-rprx-vision", "fingerprint": "chrome", "spiderX": "/"}
	result, err := g.ValidatePanel(ctx, spec)
	if reject {
		if err == nil || !strings.Contains(err.Error(), "decryption") {
			t.Fatalf("encrypted inbound accepted: %+v %v", result, err)
		}
		return
	}
	if err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(result)
	if strings.Contains(string(encoded), base64.StdEncoding.EncodeToString(key.Bytes())) || strings.Contains(string(encoded), "private") {
		t.Fatal("private material leaked")
	}
	for field, bad := range map[string]any{"inboundTag": "other", "listenPort": float64(1), "realityPublicKey": "wrong", "shortId": "ffff", "serverNames": []any{"other.example.com"}, "rotateKeys": true} {
		t.Run(field, func(t *testing.T) {
			copy := map[string]any{}
			for k, v := range spec {
				copy[k] = v
			}
			copy[field] = bad
			if _, err := g.ValidatePanel(ctx, copy); err == nil {
				t.Fatalf("accepted mismatch %s", field)
			}
		})
	}
	after, err := g.handler.ListInbounds(ctx, &handler.ListInboundsRequest{})
	if err != nil {
		t.Fatal(err)
	}
	if !proto.Equal(inbounds, after) {
		t.Fatal("validation changed inbound")
	}
	users, err := g.ListUsers(ctx)
	if err != nil || len(users) != 0 {
		t.Fatal("validation created probe account")
	}
}
