//go:build darwin

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

type macRecoverySlotTestBackend struct {
	mu          sync.Mutex
	items       map[string][]byte
	afterChange func(before, after []byte) error
}

func (b *macRecoverySlotTestBackend) read(ctx context.Context, key string) ([]byte, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return bytes.Clone(b.items[key]), ctx.Err()
}

func (b *macRecoverySlotTestBackend) compareAndSwap(ctx context.Context, key string, before, after []byte) (bool, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return false, err
	}
	current, exists := b.items[key]
	if exists != (before != nil) || !bytes.Equal(current, before) {
		return false, nil
	}
	if after == nil {
		delete(b.items, key)
	} else {
		b.items[key] = bytes.Clone(after)
	}
	if b.afterChange != nil {
		return true, b.afterChange(before, after)
	}
	return true, nil
}

func newMacRecoverySlotFixture(t *testing.T) (*macRecoverySlotTestBackend, macRecoveryPendingArm) {
	t.Helper()
	f := newMacRecoveryFixtureWithHelper(t, false, true)
	intent := newMacReplayTestAuthority(t, f).intent
	intent.TransactionSHA256, intent.Capability = "", ""
	return &macRecoverySlotTestBackend{items: make(map[string][]byte)}, macRecoveryPendingArm{Intent: intent,
		HelperPID: f.transaction.HelperPID, HelperIdentity: f.transaction.HelperIdentity, HelperExecutable: f.transaction.HelperExecutable}
}

func openTestMacRecoverySlot(t *testing.T, backend macRecoverySlotBackend, intent macRecoveryIntent) *macRecoverySlotAuthority {
	t.Helper()
	store, err := newMacRecoverySlotAuthority(backend, intent.Target, intent.DataDir)
	if err != nil {
		t.Fatal(err)
	}
	return store
}

func TestMacRecoverySlotTransitionsUseExactRevisionAndScope(t *testing.T) {
	ctx := context.Background()
	backend, pending := newMacRecoverySlotFixture(t)
	intent := pending.Intent
	store := openTestMacRecoverySlot(t, backend, intent)
	if err := store.requireEmptyForUpdate(ctx); err != nil || len(backend.items) != 0 {
		t.Fatal("empty preflight must allow preparation without writing", err)
	}
	backend.items[store.key] = []byte("damaged")
	if err := store.requireEmptyForUpdate(ctx); err == nil || string(backend.items[store.key]) != "damaged" {
		t.Fatal("damaged authorization must not be treated as empty or overwritten", err)
	}
	delete(backend.items, store.key)
	if err := store.reserve(ctx, pending); err != nil {
		t.Fatal(err)
	}
	reserved := bytes.Clone(backend.items[store.key])
	if err := store.requireEmptyForUpdate(ctx); err == nil || !bytes.Equal(reserved, backend.items[store.key]) {
		t.Fatal("preflight replaced or accepted an existing reservation", err)
	}
	fresh := func() *macRecoverySlotAuthority { return openTestMacRecoverySlot(t, backend, intent) }
	if _, err := fresh().active(ctx, intent.Target, intent.DataDir); !errors.Is(err, errMacRecoverySlotMissing) {
		t.Fatal("pending slot exposed an active capability", err)
	}
	other := pending
	other.Intent.DataDir = filepath.Join(filepath.Dir(intent.DataDir), "another-data")
	otherStore := openTestMacRecoverySlot(t, backend, other.Intent)
	if err := otherStore.reserve(ctx, other); !errors.Is(err, errMacRecoverySlotConflict) {
		t.Fatal("alternate DataDir created a second slot for the same install", err)
	}
	if _, err := otherStore.active(ctx, other.Intent.Target, other.Intent.DataDir); err == nil {
		t.Fatal("alternate DataDir acquired an existing slot")
	}
	stale := pending
	stale.HelperIdentity += "-replaced"
	digest := macPlanDigest([]byte("durable transaction"))
	if err := fresh().bind(ctx, stale, digest); !errors.Is(err, errMacRecoverySlotConflict) {
		t.Fatal("stale helper identity bound the reservation", err)
	}
	if err := fresh().bind(ctx, pending, digest); err != nil {
		t.Fatal(err)
	}
	rollback := intent
	rollback.TransactionSHA256, rollback.Capability = digest, "rollback_original"
	if active, err := fresh().active(ctx, intent.Target, intent.DataDir); err != nil || active != rollback {
		t.Fatal("new handle could not read exact bound capability", err)
	}
	healthy := rollback
	healthy.Capability = "hold_candidate"
	checkpoint := macRecoveryCleanupCheckpoint{Intent: healthy, JournalSHA256: macPlanDigest([]byte("healthy journal"))}
	if err := fresh().checkpointCleanup(ctx, checkpoint); !errors.Is(err, errMacRecoverySlotConflict) {
		t.Fatal("cleanup checkpoint accepted before health proof", err)
	}
	proof := macVerifiedUpdateHealth{Operation: intent.Operation, Target: intent.Target, DataDir: intent.DataDir, PlanSHA256: intent.PlanSHA256,
		TransactionSHA256: digest, Candidate: intent.Candidate, CandidateFilesystem: intent.Filesystem.Candidate,
		PID: 42, ProcessIdentity: "independent-test-candidate", ChallengeSHA256: macPlanDigest([]byte("secure challenge"))}
	invalid := proof
	invalid.CandidateFilesystem.FileID++
	if err := fresh().markHealthy(ctx, rollback, invalid); !errors.Is(err, errMacRecoverySlotConflict) {
		t.Fatal("wrong candidate filesystem accepted", err)
	}
	ackLost := errors.New("test backend lost reply after commit")
	backend.afterChange = func(_, _ []byte) error { return ackLost }
	if err := fresh().markHealthy(ctx, rollback, proof); !errors.Is(err, ackLost) {
		t.Fatal("uncertain health transition reported success", err)
	}
	backend.afterChange = nil
	if active, err := fresh().active(ctx, intent.Target, intent.DataDir); err != nil || active != healthy {
		t.Fatal("verified health was missing after re-reading the protected slot", err)
	}
	if err := fresh().checkpointCleanup(ctx, checkpoint); err != nil {
		t.Fatal(err)
	}
	if actual, err := fresh().activeCleanup(ctx, intent.Target, intent.DataDir); err != nil || actual != checkpoint {
		t.Fatal("fresh handle did not recover exact checkpoint", err)
	}
	foreign := checkpoint
	foreign.JournalSHA256 = digest
	if err := fresh().retireCleanup(ctx, foreign); !errors.Is(err, errMacRecoverySlotConflict) {
		t.Fatal("foreign journal retired current capability", err)
	}
	if err := fresh().retireCleanup(ctx, checkpoint); err != nil {
		t.Fatal(err)
	}
	pending.Intent.Generation += "-next"
	if err := fresh().reserve(ctx, pending); err != nil {
		t.Fatal(err)
	}
	if err := fresh().retireCleanup(ctx, checkpoint); !errors.Is(err, errMacRecoverySlotConflict) {
		t.Fatal("old retirement consumed a newer reservation", err)
	}
}

func TestMacRecoverySlotRejectsCompetingWritersAndMalformedState(t *testing.T) {
	ctx := context.Background()
	backend, pending := newMacRecoverySlotFixture(t)
	store := openTestMacRecoverySlot(t, backend, pending.Intent)
	start, results := make(chan struct{}), make(chan error, 2)
	for _, arm := range []macRecoveryPendingArm{pending, pending} {
		go func() { <-start; results <- store.reserve(ctx, arm) }()
	}
	close(start)
	first, second := <-results, <-results
	if !((first == nil && errors.Is(second, errMacRecoverySlotConflict)) || (second == nil && errors.Is(first, errMacRecoverySlotConflict))) {
		t.Fatal("reservation did not have exactly one winner", first, second)
	}
	type binding struct {
		digest string
		err    error
	}
	bindings := make(chan binding, 2)
	start = make(chan struct{})
	for _, message := range []string{"first transaction", "second transaction"} {
		go func() {
			<-start
			digest := macPlanDigest([]byte(message))
			bindings <- binding{digest, store.bind(ctx, pending, digest)}
		}()
	}
	close(start)
	winner, loser := <-bindings, <-bindings
	if winner.err != nil {
		winner, loser = loser, winner
	}
	active, err := store.active(ctx, pending.Intent.Target, pending.Intent.DataDir)
	if winner.err != nil || !errors.Is(loser.err, errMacRecoverySlotConflict) || err != nil || active.TransactionSHA256 != winner.digest {
		t.Fatal("binding did not preserve exactly the winning transaction", winner.err, loser.err, err)
	}
	raw, err := backend.read(ctx, store.key)
	if err != nil || len(raw) == 0 {
		t.Fatal("missing successful reservation", err)
	}
	var record macRecoverySlotRecord
	if err = json.Unmarshal(raw, &record); err != nil {
		t.Fatal(err)
	}
	record.Arm.Intent.Capability = "hold_candidate"
	record.Arm.Intent.TransactionSHA256 = macPlanDigest([]byte("transaction with no health proof"))
	healthWithoutProof, _ := json.Marshal(record)
	for key, corrupt := range map[string][]byte{
		"noncanonical": append(bytes.Clone(raw), '\n'), "oversized": bytes.Repeat([]byte{'x'}, maxMacRecoverySlotBytes+1),
		"empty-item": {}, "stale-schema": bytes.Replace(raw, []byte(`"Schema":1`), []byte(`"Schema":2`), 1), "health-without-proof": healthWithoutProof,
	} {
		t.Run(key, func(t *testing.T) {
			backend.items[store.key] = bytes.Clone(corrupt)
			if _, err := store.active(ctx, pending.Intent.Target, pending.Intent.DataDir); err == nil {
				t.Fatal("malformed state exposed an active capability")
			}
			if err := store.reserve(ctx, pending); !errors.Is(err, errMacRecoverySlotConflict) {
				t.Fatal("malformed record treated as an empty slot", err)
			}
			if current, err := backend.read(ctx, store.key); err != nil || !bytes.Equal(current, corrupt) {
				t.Fatal("malformed record was changed", err)
			}
		})
	}
}

func macRecoverySlotLiveTestBackend(updater, mode string) *macRecoverySlotTestBackend {
	return &macRecoverySlotTestBackend{items: make(map[string][]byte), afterChange: func(before, after []byte) error {
		var observation macRecoverySlotRecord
		name := "test-protected-cleanup-checkpoint.json"
		retiring := after == nil
		if retiring {
			name, after = "test-protected-cleanup-retired.json", before
			if _, err := os.Lstat(filepath.Join(updater, "mac-update-journal.json")); !os.IsNotExist(err) {
				return errors.New("slot retired before journal removal")
			}
		}
		if err := json.Unmarshal(after, &observation); err != nil || observation.CleanupSHA256 == "" {
			return err
		}
		if err := atomicJSON(filepath.Join(updater, name), observation); err != nil {
			return err
		}
		if !retiring && mode == "slot-authority-lost-checkpoint" {
			return errors.New("test slot lost checkpoint acknowledgment after commit")
		}
		return nil
	}}
}
