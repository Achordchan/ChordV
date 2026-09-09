package credentials

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Achordchan/ChordV/apps/agent/internal/agentcfg"
	"github.com/Achordchan/ChordV/apps/agent/internal/durable"
	"github.com/Achordchan/ChordV/apps/agent/internal/protocol"
)

func newConfig(t *testing.T) *agentcfg.Config {
	t.Helper()
	directory := t.TempDir()
	return &agentcfg.Config{
		APIBaseURL:      "https://v.achord.cn",
		CredentialsPath: filepath.Join(directory, "credentials.json"),
		DatabasePath:    filepath.Join(directory, "node-agent.db"),
	}
}

func readJSON(t *testing.T, file string) map[string]any {
	t.Helper()
	raw, err := os.ReadFile(file)
	if err != nil {
		t.Fatalf("read %s: %v", file, err)
	}
	var parsed map[string]any
	if err := json.Unmarshal(raw, &parsed); err != nil {
		t.Fatalf("parse %s: %v", file, err)
	}
	return parsed
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// TestPendingSecretIsDurableBeforeRegistrationIsAttempted is the invariant that
// keeps a lost response from bricking a node: the server stores only the HASH of
// the agent-generated token, so a retry with the SAME secret is idempotent and
// returns the same identity. That only works if the secret reached the disk
// before the request that spent it.
func TestPendingSecretIsDurableBeforeRegistrationIsAttempted(t *testing.T) {
	config := newConfig(t)
	config.RegisterToken = "one-time"
	var onDisk map[string]any
	resolver := &Resolver{
		Config: config,
		Register: func(ctx context.Context, baseURL string, payload protocol.RegisterRequest) (protocol.RegisterResponse, error) {
			onDisk = readJSON(t, config.PendingCredentialsPath())
			if onDisk["agentToken"] != payload.AgentToken {
				t.Fatalf("persisted %v but sent %q", onDisk["agentToken"], payload.AgentToken)
			}
			return protocol.RegisterResponse{Accepted: true, AgentID: "a1", NodeID: "n1"}, nil
		},
	}
	got, err := resolver.Resolve(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if onDisk == nil {
		t.Fatal("registration ran without the pending secret having been persisted first")
	}
	if onDisk["registerTokenFingerprint"] != Fingerprint("one-time") {
		t.Fatalf("pending file was not bound to the register token: %v", onDisk)
	}
	// The one-time token itself must never be written down; only its hash.
	raw, _ := os.ReadFile(config.PendingCredentialsPath())
	if strings.Contains(string(raw), "one-time") {
		t.Fatalf("the one-time register token was persisted verbatim: %s", raw)
	}
	if got.AgentID != "a1" || got.NodeID != "n1" || got.Token != onDisk["agentToken"] {
		t.Fatalf("credentials = %+v", got)
	}
}

func TestRegistrationRetryReusesTheSameSecret(t *testing.T) {
	config := newConfig(t)
	config.RegisterToken = "one-time"
	var attempts []string
	register := func(ctx context.Context, baseURL string, payload protocol.RegisterRequest) (protocol.RegisterResponse, error) {
		attempts = append(attempts, payload.AgentToken)
		if len(attempts) == 1 {
			// The response is lost — exactly the case the invariant exists for.
			return protocol.RegisterResponse{}, errors.New("network died after the server committed")
		}
		return protocol.RegisterResponse{Accepted: true, AgentID: "a1", NodeID: "n1"}, nil
	}
	resolver := &Resolver{Config: config, Register: register}
	if _, err := resolver.Resolve(context.Background()); err == nil {
		t.Fatal("the first attempt should have surfaced the transport failure")
	}
	if _, err := resolver.Resolve(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(attempts) != 2 || attempts[0] != attempts[1] {
		// A fresh secret on the retry would hash differently, so the server
		// would treat it as a DIFFERENT agent and refuse the spent token.
		t.Fatalf("retry used a different secret: %v", attempts)
	}
}

func TestASecretIsNeverCarriedAcrossRegisterTokens(t *testing.T) {
	config := newConfig(t)
	config.RegisterToken = "first"
	first := ""
	resolver := &Resolver{
		Config: config,
		Register: func(ctx context.Context, baseURL string, payload protocol.RegisterRequest) (protocol.RegisterResponse, error) {
			first = payload.AgentToken
			return protocol.RegisterResponse{}, errors.New("failed")
		},
	}
	resolver.Resolve(context.Background())

	// Same host, different one-time token: replaying the previous secret would
	// be exactly the cross-node credential reuse the control plane rejects.
	config.RegisterToken = "second"
	second := ""
	resolver.Register = func(ctx context.Context, baseURL string, payload protocol.RegisterRequest) (protocol.RegisterResponse, error) {
		second = payload.AgentToken
		return protocol.RegisterResponse{Accepted: true, AgentID: "a2", NodeID: "n2"}, nil
	}
	if _, err := resolver.Resolve(context.Background()); err != nil {
		t.Fatal(err)
	}
	if first == "" || second == "" || first == second {
		t.Fatalf("secret was reused across register tokens: %q vs %q", first, second)
	}
}

func TestSavedIdentityIsReturnedWithoutRegistering(t *testing.T) {
	config := newConfig(t)
	config.RegisterToken = "one-time"
	calls := 0
	resolver := &Resolver{
		Config: config,
		Register: func(ctx context.Context, baseURL string, payload protocol.RegisterRequest) (protocol.RegisterResponse, error) {
			calls++
			return protocol.RegisterResponse{Accepted: true, AgentID: "a1", NodeID: "n1"}, nil
		},
	}
	if _, err := resolver.Resolve(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := resolver.Resolve(context.Background()); err != nil {
		t.Fatal(err)
	}
	if calls != 1 {
		t.Fatalf("registered %d times; a restart must reuse the saved identity", calls)
	}
}

func TestRejectedRegistrationDoesNotPersistAnIdentity(t *testing.T) {
	config := newConfig(t)
	config.RegisterToken = "one-time"
	resolver := &Resolver{
		Config: config,
		Register: func(ctx context.Context, baseURL string, payload protocol.RegisterRequest) (protocol.RegisterResponse, error) {
			// accepted:false, or a blank identity, must not be written down:
			// the next boot would then start with an identity the server has
			// never heard of and could never recover from.
			return protocol.RegisterResponse{Accepted: true, AgentID: "", NodeID: "n1"}, nil
		},
	}
	if _, err := resolver.Resolve(context.Background()); err == nil {
		t.Fatal("an invalid registration response was accepted")
	}
	if exists(config.CredentialsPath) {
		t.Fatal("credentials were written from an invalid registration response")
	}
}

func TestForeignIdentityRefusesToStartWithoutExplicitConsent(t *testing.T) {
	config := newConfig(t)
	if err := durable.WriteSecret(config.CredentialsPath, map[string]string{
		"agentId": "old-agent", "nodeId": "old-node", "token": "old-token",
		"registerTokenFingerprint": Fingerprint("previous"),
	}); err != nil {
		t.Fatal(err)
	}
	config.RegisterToken = "brand-new"
	resolver := &Resolver{
		Config: config,
		Register: func(ctx context.Context, baseURL string, payload protocol.RegisterRequest) (protocol.RegisterResponse, error) {
			t.Fatal("registration must not run while a foreign identity is present")
			return protocol.RegisterResponse{}, nil
		},
	}
	_, err := resolver.Resolve(context.Background())
	if err == nil {
		t.Fatal("a saved identity from another register token was silently reused")
	}
	// The message has to name the node an operator is about to displace, and
	// the flag that consents to it.
	for _, needle := range []string{"old-agent", "old-node", "CHORDV_AGENT_RESET_IDENTITY"} {
		if !strings.Contains(err.Error(), needle) {
			t.Fatalf("refusal does not mention %q: %v", needle, err)
		}
	}
	if saved := readJSON(t, config.CredentialsPath); saved["agentId"] != "old-agent" {
		t.Fatalf("the refused start modified the saved identity: %v", saved)
	}
}

func TestResetArchivesIdentityAndStateUnderOneStamp(t *testing.T) {
	config := newConfig(t)
	config.ResetIdentity = true
	config.RegisterToken = "brand-new"
	if err := durable.WriteSecret(config.CredentialsPath, map[string]string{
		"agentId": "old-agent", "nodeId": "old-node", "token": "old-token",
		"registerTokenFingerprint": Fingerprint("previous"),
	}); err != nil {
		t.Fatal(err)
	}
	// The state database MUST travel with the identity: it holds the old node's
	// desired users, command history and unsettled usage batches, and a new
	// identity inheriting it would replay the old node's work.
	if err := os.WriteFile(config.DatabasePath, []byte("old node state"), 0o600); err != nil {
		t.Fatal(err)
	}
	stamp := time.UnixMilli(1_700_000_000_000)
	resolver := &Resolver{
		Config: config,
		Now:    func() time.Time { return stamp },
		Register: func(ctx context.Context, baseURL string, payload protocol.RegisterRequest) (protocol.RegisterResponse, error) {
			return protocol.RegisterResponse{Accepted: true, AgentID: "a2", NodeID: "n2"}, nil
		},
	}
	got, err := resolver.Resolve(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if got.NodeID != "n2" {
		t.Fatalf("credentials = %+v", got)
	}
	suffix := ".replaced.1700000000000"
	// One stamp across both files is what lets an operator reassemble a single
	// reset from the directory listing.
	for _, archived := range []string{config.CredentialsPath + suffix, config.DatabasePath + suffix} {
		if !exists(archived) {
			t.Fatalf("expected %s to be archived under the shared stamp", archived)
		}
	}
	if exists(config.DatabasePath) {
		t.Fatal("the previous node's state database was left in place for the new identity")
	}
	if saved := readJSON(t, config.CredentialsPath); saved["nodeId"] != "n2" {
		t.Fatalf("new identity not persisted: %v", saved)
	}
	if exists(config.ResetJournalPath()) {
		t.Fatal("the reset journal survived a completed reset")
	}
}

func TestInterruptedResetIsCompletedBeforeAnythingElse(t *testing.T) {
	config := newConfig(t)
	// A crash between renaming the credentials and renaming the database leaves
	// this shape. Without the journal the next boot sees "no saved identity" and
	// registers a NEW identity on top of the old node's state.
	if err := os.WriteFile(config.DatabasePath, []byte("old node state"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := durable.WriteSecret(config.ResetJournalPath(), map[string]any{
		"stamp": 1_700_000_000_000,
		"files": config.ArchiveCandidates(),
	}); err != nil {
		t.Fatal(err)
	}
	config.RegisterToken = "brand-new"
	resolver := &Resolver{
		Config: config,
		Register: func(ctx context.Context, baseURL string, payload protocol.RegisterRequest) (protocol.RegisterResponse, error) {
			if exists(config.DatabasePath) {
				t.Fatal("registered before the interrupted archive was completed")
			}
			return protocol.RegisterResponse{Accepted: true, AgentID: "a2", NodeID: "n2"}, nil
		},
	}
	if _, err := resolver.Resolve(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !exists(config.DatabasePath + ".replaced.1700000000000") {
		t.Fatal("the resumed reset did not archive the leftover state database")
	}
	if exists(config.ResetJournalPath()) {
		t.Fatal("the journal survived the resumed reset")
	}
}

func TestJournalNamingUnknownPathsIsRefused(t *testing.T) {
	config := newConfig(t)
	outsider := filepath.Join(t.TempDir(), "someone-elses-file")
	if err := os.WriteFile(outsider, []byte("not ours"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := durable.WriteSecret(config.ResetJournalPath(), map[string]any{
		"stamp": 1_700_000_000_000,
		"files": []string{outsider},
	}); err != nil {
		t.Fatal(err)
	}
	resolver := &Resolver{Config: config}
	if _, err := resolver.Resolve(context.Background()); err == nil {
		t.Fatal("a journal naming a path outside this configuration was executed")
	}
	// A tampered or mismatched journal must not be able to move arbitrary files.
	if !exists(outsider) {
		t.Fatal("the refused journal still renamed a file it named")
	}
}

func TestCorruptFilesFailLoudlyInsteadOfLookingUnregistered(t *testing.T) {
	// A truncated credentials file that read as "not registered yet" would
	// trigger a SECOND registration and split the node's identity.
	config := newConfig(t)
	if err := os.WriteFile(config.CredentialsPath, []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	resolver := &Resolver{Config: config}
	if _, err := resolver.Resolve(context.Background()); err == nil {
		t.Fatal("a corrupt credentials file was treated as absent")
	}

	config = newConfig(t)
	config.RegisterToken = "one-time"
	if err := durable.WriteSecret(config.PendingCredentialsPath(), map[string]string{
		"agentToken":               "not-a-valid-agent-token",
		"registerTokenFingerprint": Fingerprint("one-time"),
	}); err != nil {
		t.Fatal(err)
	}
	resolver = &Resolver{Config: config, Register: func(context.Context, string, protocol.RegisterRequest) (protocol.RegisterResponse, error) {
		t.Fatal("a malformed pending secret must not be sent to the control plane")
		return protocol.RegisterResponse{}, nil
	}}
	if _, err := resolver.Resolve(context.Background()); err == nil {
		t.Fatal("a malformed pending secret was accepted")
	}

	config = newConfig(t)
	if err := durable.WriteSecret(config.CredentialsPath, map[string]string{"agentId": "a1", "nodeId": "n1"}); err != nil {
		t.Fatal(err)
	}
	resolver = &Resolver{Config: config}
	if _, err := resolver.Resolve(context.Background()); err == nil {
		t.Fatal("a credentials file missing its token was accepted")
	}
}

func TestOperatorSuppliedCredentialsBypassTheSavedIdentity(t *testing.T) {
	config := newConfig(t)
	if err := durable.WriteSecret(config.CredentialsPath, map[string]string{
		"agentId": "saved", "nodeId": "saved-node", "token": "saved-token",
	}); err != nil {
		t.Fatal(err)
	}
	config.AgentID, config.NodeID, config.Token = "env-agent", "env-node", "env-token"
	resolver := &Resolver{Config: config}
	got, err := resolver.Resolve(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	// A complete env tuple is an explicit override, including rotation; it must
	// neither read nor overwrite an unrelated saved identity.
	if got.AgentID != "env-agent" {
		t.Fatalf("credentials = %+v", got)
	}
	if saved := readJSON(t, config.CredentialsPath); saved["agentId"] != "saved" {
		t.Fatalf("the env override rewrote the saved identity: %v", saved)
	}

	config.Token = ""
	if _, err := resolver.Resolve(context.Background()); err == nil {
		t.Fatal("a partial env credential trio was accepted")
	}
}

func TestReadExistingNeverWrites(t *testing.T) {
	// The health probe is normally run by an operator as ROOT. Anything this
	// path creates under the data directory would be root-owned and would break
	// the unprivileged service's next start.
	config := newConfig(t)
	config.RegisterToken = "one-time"
	directory := filepath.Dir(config.CredentialsPath)
	resolver := &Resolver{Config: config, Register: func(context.Context, string, protocol.RegisterRequest) (protocol.RegisterResponse, error) {
		t.Fatal("the health path must never register")
		return protocol.RegisterResponse{}, nil
	}}
	got, err := resolver.ReadExisting()
	if err != nil || got != nil {
		t.Fatalf("ReadExisting on an unregistered host = %v, %v; want nil, nil", got, err)
	}
	entries, err := os.ReadDir(directory)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("the read-only path created %d file(s) in the data directory", len(entries))
	}
}

func TestReadExistingReportsAMismatchedRegisterToken(t *testing.T) {
	config := newConfig(t)
	if err := durable.WriteSecret(config.CredentialsPath, map[string]string{
		"agentId": "a1", "nodeId": "n1", "token": "t1",
		"registerTokenFingerprint": Fingerprint("previous"),
	}); err != nil {
		t.Fatal(err)
	}
	config.RegisterToken = "brand-new"
	resolver := &Resolver{Config: config}
	if _, err := resolver.ReadExisting(); err == nil {
		t.Fatal("the probe reported a host healthy whose identity blocks startup")
	}

	// An interrupted reset is reported, never completed: completing it is a write.
	config = newConfig(t)
	if err := durable.WriteSecret(config.ResetJournalPath(), map[string]any{"stamp": 1, "files": config.ArchiveCandidates()}); err != nil {
		t.Fatal(err)
	}
	resolver = &Resolver{Config: config}
	if _, err := (&Resolver{Config: config}).ReadExisting(); err == nil {
		t.Fatal("the probe ignored an interrupted reset")
	}
	if !exists(config.ResetJournalPath()) {
		t.Fatal("the read-only probe completed the reset")
	}
	_ = resolver
}

func TestArchIsOneOfTheTwoValuesTheServerAccepts(t *testing.T) {
	// AgentRegisterDto validates @IsIn(["linux-x64","linux-arm64"]); anything
	// else fails registration outright with a validation error.
	if arch := Arch(); arch != protocol.ArchAMD64 && arch != protocol.ArchARM64 {
		t.Fatalf("Arch() = %q", arch)
	}
}

func TestFingerprintIsAHashNotTheToken(t *testing.T) {
	token := "one-time-secret"
	fingerprint := Fingerprint(token)
	if strings.Contains(fingerprint, token) || len(fingerprint) != 64 {
		t.Fatalf("Fingerprint(%q) = %q", token, fingerprint)
	}
	if Fingerprint(token) != fingerprint {
		t.Fatal("Fingerprint is not deterministic")
	}
	if Fingerprint(token+"x") == fingerprint {
		t.Fatal("Fingerprint collided on a one-character change")
	}
}
