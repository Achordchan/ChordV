//go:build darwin

package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"errors"
	"os"
	"sync"
	"testing"
)

// This key and issuer exist only in the test controller's memory. They are not
// production trust roots, keychain substitutes, or reboot persistence evidence.
type macReplayTestAuthority struct {
	mu        sync.Mutex
	public    ed25519.PublicKey
	private   ed25519.PrivateKey
	intent    macRecoveryIntent
	calls     int
	onRequest func(int)
}

type macReplayTestProof struct {
	Nonce     []byte
	Intent    macRecoveryIntent
	Signature []byte
}

func newMacReplayTestAuthority(t *testing.T, f *macRecoveryFixture) *macReplayTestAuthority {
	t.Helper()
	fs, err := captureMacUpdateFilesystem(&f.plan, f.transaction.Candidate)
	if err != nil {
		t.Fatal(err)
	}
	f.transaction.Filesystem = fs
	f.persist(t)
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return &macReplayTestAuthority{public: public, private: private, intent: macRecoveryIntent{
		Generation: "isolated-controller-generation-1", Operation: f.plan.ID, UID: uint32(os.Getuid()), Target: f.plan.Current.Path,
		DataDir: f.cfg.DataDir, Work: f.plan.Work, PlanSHA256: f.journal.PlanSHA256, TransactionSHA256: f.journal.TransactionSHA256,
		Filesystem: *fs, Current: f.transaction.Current, Candidate: f.transaction.Candidate, Capability: "rollback_original",
	}}
}

func (a *macReplayTestAuthority) proof(nonce []byte) macReplayTestProof {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.calls++
	if a.onRequest != nil {
		a.onRequest(a.calls)
	}
	proof := macReplayTestProof{Nonce: append([]byte(nil), nonce...), Intent: a.intent}
	raw, _ := json.Marshal(proof)
	proof.Signature = ed25519.Sign(a.private, raw)
	return proof
}

func (a *macReplayTestAuthority) update(change func(*macRecoveryIntent)) {
	a.mu.Lock()
	defer a.mu.Unlock()
	change(&a.intent)
}

func verifyMacReplayTestProof(public ed25519.PublicKey, nonce []byte, proof macReplayTestProof, target, dataDir string) (macRecoveryIntent, error) {
	signature := proof.Signature
	proof.Signature = nil
	raw, _ := json.Marshal(proof)
	if !ed25519.Verify(public, raw, signature) || !macHealthEqual(string(nonce), string(proof.Nonce)) || proof.Intent.Target != target || proof.Intent.DataDir != dataDir {
		return macRecoveryIntent{}, errors.New("test controller proof rejected")
	}
	return proof.Intent, nil
}

func (a *macReplayTestAuthority) active(ctx context.Context, target, dataDir string) (macRecoveryIntent, error) {
	if err := ctx.Err(); err != nil {
		return macRecoveryIntent{}, err
	}
	nonce := make([]byte, 32)
	if _, err := rand.Read(nonce); err != nil {
		return macRecoveryIntent{}, err
	}
	return verifyMacReplayTestProof(a.public, nonce, a.proof(nonce), target, dataDir)
}
