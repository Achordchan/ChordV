//go:build e2e

package main

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/Achordchan/ChordV/apps/agent/internal/protocol"
	"github.com/Achordchan/ChordV/apps/agent/internal/xray"
)

// This verifies the fixture itself. The full JS E2E never installs users or
// acknowledges commands directly: only its independently running agent does.
func TestLocalRealityTransportAndRevocation(t *testing.T) {
	node, err := startNode()
	if err != nil {
		t.Fatal(err)
	}
	defer node.close()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	account := protocol.DesiredUser{Email: "fixture@local.test", UUID: "d52ca32b-784a-4f4b-ab51-b8341884f213"}
	if err := node.api.EnsureUser(ctx, account, xray.Expectation{Absent: true}); err != nil {
		t.Fatal(err)
	}
	runtime, err := json.Marshal(map[string]any{"outbound": map[string]any{
		"server": "127.0.0.1", "port": node.public["port"], "uuid": account.UUID, "flow": "",
		"realityPublicKey": node.public["publicKey"], "shortId": node.public["shortId"], "serverName": node.public["serverName"], "fingerprint": "chrome", "spiderX": "/",
	}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := node.transfer(ctx, runtime, 262144); err != nil {
		t.Fatal(err)
	}
	counters, err := node.api.ReadAbsoluteCounters(ctx)
	if err != nil || len(counters) != 1 || counters[0].UplinkBytes != "262144" || counters[0].DownlinkBytes != "262144" {
		t.Fatalf("counters=%+v err=%v", counters, err)
	}
	if err := node.api.RemoveUser(ctx, account.Email, xray.Expectation{UUID: account.UUID}); err != nil {
		t.Fatal(err)
	}
	if _, err := node.transfer(ctx, runtime, 1024); err == nil {
		t.Fatal("revoked Reality user transferred bytes")
	}
}
