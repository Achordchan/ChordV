package main

import (
	"errors"
	"math/big"
	"os"
	"path/filepath"
	"testing"

	"github.com/Achordchan/ChordV/apps/agent/internal/agentcfg"
	"github.com/Achordchan/ChordV/apps/agent/internal/credentials"
	"github.com/Achordchan/ChordV/apps/agent/internal/store"
)

func testConfig(t *testing.T) *agentcfg.Config {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "data")
	return &agentcfg.Config{AgentID: "agent-1", NodeID: "node-1", Token: "test-only", DatabasePath: filepath.Join(dir, "state.db"),
		CredentialsPath: filepath.Join(dir, "credentials.json"), OfflineAllowanceBytes: big.NewInt(1024)}
}

func TestInvalidXrayAddressPrecedesIdentityAndStateWrites(t *testing.T) {
	config := testConfig(t)
	config.XrayAPIAddress = "0.0.0.0:10085"
	if err := serve(config); err == nil {
		t.Fatal("invalid Xray address accepted")
	}
	if _, err := os.Stat(filepath.Dir(config.DatabasePath)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("created state on refusal: %v", err)
	}
}

func TestHealthDoesNotCreateAnUnstartedStore(t *testing.T) {
	config := testConfig(t)
	if healthCheck(config) {
		t.Fatal("unstarted service reported healthy")
	}
	if _, err := os.Stat(filepath.Dir(config.DatabasePath)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("probe wrote files: %v", err)
	}
}

func TestForeignStateRequiresExplicitArchive(t *testing.T) {
	config := testConfig(t)
	old, err := store.Open(config.DatabasePath, store.Options{NodeID: "old-node", BootID: "old-boot", DefaultOfflineAllowance: big.NewInt(1024)})
	if err != nil {
		t.Fatal(err)
	}
	if err := old.Close(); err != nil {
		t.Fatal(err)
	}
	resolver := credentials.NewResolver(config)
	identity := &credentials.Credentials{NodeID: config.NodeID}
	if state, err := openStore(config, resolver, identity, "new-boot"); err == nil {
		state.Close()
		t.Fatal("foreign state adopted without consent")
	}
	config.ResetIdentity = true
	state, err := openStore(config, resolver, identity, "new-boot")
	if err != nil {
		t.Fatal(err)
	}
	defer state.Close()
	files, err := filepath.Glob(config.DatabasePath + ".replaced.*")
	if err != nil || len(files) != 1 {
		t.Fatalf("archive: %v %v", files, err)
	}
	snapshot, err := state.ConfigSnapshot()
	if err != nil || snapshot.NodeID != config.NodeID {
		t.Fatalf("new identity: %+v %v", snapshot, err)
	}
}
