package store

import (
	"math/big"
	"path/filepath"
	"testing"
	"time"

	"github.com/Achordchan/ChordV/apps/agent/internal/protocol"
)

// sampleAt reads the clock as 2026-09-09T12:00:00Z; these sit either side of it.
const (
	pastExpiry   = "2026-09-09T11:00:00.000Z"
	futureExpiry = "2026-09-10T11:00:00.000Z"
	tickInstant  = "2026-09-09T12:00:00.000Z"
)

func expiring(bindingID, email, revision, expiresAt string) protocol.DesiredUser {
	u := user(bindingID, email, revision, "100000000")
	u.ExpiresAt = expiresAt
	return u
}

func mustInstant(t *testing.T, instant string) time.Time {
	t.Helper()
	at, err := time.Parse(time.RFC3339, instant)
	if err != nil {
		t.Fatal(err)
	}
	return at
}

// sampleAtInstant is sampleAt with the clock somewhere else.
func sampleAtInstant(t *testing.T, store *Store, instant string, online bool, counters ...protocol.AbsoluteCounter) SampleResult {
	t.Helper()
	result, err := store.RecordSample(counters, mustInstant(t, instant), online)
	if err != nil {
		t.Fatalf("record sample: %v", err)
	}
	return result
}

func offlineDisabled(t *testing.T, store *Store, bindingID string) bool {
	t.Helper()
	held, err := store.OfflineDisabled(bindingID)
	if err != nil {
		t.Fatal(err)
	}
	return held
}

func locallyDisabled(t *testing.T, store *Store) bool {
	t.Helper()
	held, err := store.HasUsageDisabledUsers()
	if err != nil {
		t.Fatal(err)
	}
	return held
}

func TestAnExpiredUserIsCutOffOnlyWhileTheBackendIsUnreachable(t *testing.T) {
	store := newStore(t, "node-1", "boot-1")
	seed(t, store, expiring("b1", "u1@chordv", "1", pastExpiry))

	// Reachable, the control plane is the authority on expiry. An agent that cut
	// users off from its own clock could only ever disagree with it.
	online := sampleAt(t, store, true, counter("u1@chordv", "0", "0"))
	if len(online.DisableEmails) != 0 || !storedUser(t, store, "b1").Enabled {
		t.Fatalf("an agent that can reach the control plane expired a user on its own: %v", online.DisableEmails)
	}

	offline := sampleAt(t, store, false, counter("u1@chordv", "0", "0"))
	if len(offline.DisableEmails) != 1 || offline.DisableEmails[0] != "u1@chordv" {
		t.Fatalf("DisableEmails = %v, want the expired user", offline.DisableEmails)
	}
	if len(offline.ExpiredEmails) != 1 {
		t.Fatalf("ExpiredEmails = %v, want the expired user", offline.ExpiredEmails)
	}
	if row := storedUser(t, store, "b1"); row.Enabled {
		t.Fatal("the user is still enabled after expiring offline")
	}
	// It is a LOCAL cutoff, so a snapshot that still wants the user may take it
	// back, and the runner must go and ask.
	if !offlineDisabled(t, store, "b1") || !locallyDisabled(t, store) {
		t.Fatal("an offline expiry was not classified as a local cutoff")
	}
}

func TestAnIdleExpiredUserIsCutOffToo(t *testing.T) {
	// Xray reports no counter for an account that never moved a byte. The
	// allowance could never catch this user — it only counts traffic.
	store := newStore(t, "node-1", "boot-1")
	seed(t, store, expiring("b1", "u1@chordv", "1", pastExpiry))

	result := sampleAt(t, store, false)
	if len(result.DisableEmails) != 1 || storedUser(t, store, "b1").Enabled {
		t.Fatalf("an idle expired user was left enabled: %v", result.DisableEmails)
	}
	if result.Batch != nil {
		t.Fatal("an expiry with no traffic behind it produced a batch")
	}
}

func TestOnlyUsersPastTheirExpiryAreCutOff(t *testing.T) {
	store := newStore(t, "node-1", "boot-1")
	seed(t, store,
		expiring("b1", "u1@chordv", "1", futureExpiry),
		expiring("b2", "u2@chordv", "1", ""),
		// The control plane treats expireAt <= now as expired, so the instant
		// itself counts.
		expiring("b3", "u3@chordv", "1", tickInstant),
	)

	result := sampleAt(t, store, false)
	if len(result.DisableEmails) != 1 || result.DisableEmails[0] != "u3@chordv" {
		t.Fatalf("DisableEmails = %v, want only the user at its expiry instant", result.DisableEmails)
	}
	if !storedUser(t, store, "b1").Enabled || !storedUser(t, store, "b2").Enabled {
		t.Fatal("a user with a future expiry, or none, was cut off")
	}
}

func TestTheLastReadingIsBilledBeforeAnExpiryCutoff(t *testing.T) {
	store := newStore(t, "node-1", "boot-1")
	seed(t, store, expiring("b1", "u1@chordv", "1", pastExpiry))
	sampleAt(t, store, true, counter("u1@chordv", "100", "100"))

	result := sampleAt(t, store, false, counter("u1@chordv", "400", "600"))
	if result.Batch == nil || len(result.Batch.Samples) != 1 {
		t.Fatalf("the tick that expired the user dropped its traffic: %+v", result.Batch)
	}
	if sample := result.Batch.Samples[0]; sample.UplinkDeltaBytes != "300" || sample.DownlinkDeltaBytes != "500" {
		t.Fatalf("billed %s/%s, want 300/500", sample.UplinkDeltaBytes, sample.DownlinkDeltaBytes)
	}
	if len(result.DisableEmails) != 1 {
		t.Fatalf("DisableEmails = %v, want the user exactly once", result.DisableEmails)
	}
}

func TestAnExpiryIsStoredInOneSpelling(t *testing.T) {
	store := newStore(t, "node-1", "boot-1")
	// Same instant, as Date.toISOString() would not write it.
	seed(t, store, expiring("b1", "u1@chordv", "1", "2026-09-09T19:00:00+08:00"))
	if got := storedUser(t, store, "b1").ExpiresAt; got != pastExpiry {
		t.Fatalf("expires_at = %q, want %q", got, pastExpiry)
	}

	if err := store.UpsertDesiredUser(expiring("b2", "u2@chordv", "1", "next tuesday")); err == nil {
		t.Fatal("an unreadable expiry was stored")
	}
	if row, err := userByBindingID(store.db, "b2"); err != nil || row != nil {
		t.Fatalf("a user with an unreadable expiry was written: %+v %v", row, err)
	}
}

func TestAnEqualRevisionStatementRefreshesPolicy(t *testing.T) {
	// Every row written before the agent stored an expiry has none, and the
	// binding's revision does not move just because the agent was upgraded. The
	// next snapshot is the only thing that can tell it.
	store := newStore(t, "node-1", "boot-1")
	seed(t, store, user("b1", "u1@chordv", "5", "100000000"))
	sampleAt(t, store, true, counter("u1@chordv", "40", "60"))

	next := expiring("b1", "u1@chordv", "5", futureExpiry)
	next.OfflineAllowanceBytes = "10737418240"
	// Not policy: an equal revision must still not move these.
	next.QuotaRemainingBytes = "1"
	seed(t, store, next)

	row := storedUser(t, store, "b1")
	if row.ExpiresAt != futureExpiry || row.OfflineAllowanceBytes != "10737418240" {
		t.Fatalf("policy not refreshed: expires_at = %q allowance = %s", row.ExpiresAt, row.OfflineAllowanceBytes)
	}
	if row.QuotaRemainingBytes != "100000000" || row.Uplink != "40" || row.Downlink != "60" {
		t.Fatalf("an equal revision rewrote more than policy: %+v", row)
	}

	// A statement with no expiry is not vouching for the one on record.
	cleared := user("b1", "u1@chordv", "5", "100000000")
	cleared.OfflineAllowanceBytes = ""
	seed(t, store, cleared)
	row = storedUser(t, store, "b1")
	if row.ExpiresAt != "" {
		t.Fatalf("expires_at = %q after a statement that named none", row.ExpiresAt)
	}
	if row.OfflineAllowanceBytes != "10737418240" {
		t.Fatalf("an empty allowance replaced the stored one with %s", row.OfflineAllowanceBytes)
	}

	older := expiring("b1", "u1@chordv", "4", pastExpiry)
	seed(t, store, older)
	if got := storedUser(t, store, "b1").ExpiresAt; got != "" {
		t.Fatalf("an OLDER revision changed the expiry to %q", got)
	}
}

func TestPolicyIsNotRewrittenUnderALocalCutoff(t *testing.T) {
	// OfflineDisabled classifies a row by these columns. Raising the allowance
	// under a user who spent it would turn a cutoff a snapshot can release into
	// one nothing can.
	store := newStore(t, "node-1", "boot-1")
	small := user("b1", "u1@chordv", "1", "100000000")
	small.OfflineAllowanceBytes = "1000"
	seed(t, store, small)
	sampleAt(t, store, false, counter("u1@chordv", "0", "0"))
	sampleAt(t, store, false, counter("u1@chordv", "800", "800"))
	if !offlineDisabled(t, store, "b1") {
		t.Fatal("precondition: the user should be past its offline allowance")
	}

	raised := expiring("b1", "u1@chordv", "1", futureExpiry)
	raised.OfflineAllowanceBytes = "10737418240"
	seed(t, store, raised)
	if row := storedUser(t, store, "b1"); row.OfflineAllowanceBytes != "1000" || row.ExpiresAt != "" {
		t.Fatalf("policy rewritten under a local cutoff: %+v", row)
	}
	if !offlineDisabled(t, store, "b1") {
		t.Fatal("an equal-revision statement reclassified a local cutoff")
	}
}

func TestANewerEnableSupersedesAnOfflineExpiry(t *testing.T) {
	store := newStore(t, "node-1", "boot-1")
	seed(t, store, expiring("b1", "u1@chordv", "1", pastExpiry))
	sampleAt(t, store, false)

	// The renewal: a newer revision carrying the new date.
	seed(t, store, expiring("b1", "u1@chordv", "2", futureExpiry))
	row := storedUser(t, store, "b1")
	if !row.Enabled || row.ExpiresAt != futureExpiry {
		t.Fatalf("a renewal did not take the user back: %+v", row)
	}
	if locallyDisabled(t, store) {
		t.Fatal("the node still reports a local cutoff after the renewal")
	}
	// The renewed user has not moved a byte, so Xray has no counter for them and
	// no reachable tick has run to reset the offline count. The control plane
	// then goes away again. The cutoff's record — an allowance marked spent —
	// must not be read as a running count now: one more byte on top of it would
	// cut off a customer who has just paid, for the whole of the outage.
	if row.OfflineUsed != "0" {
		t.Fatalf("offline_used = %s after the renewal, want the cutoff's record cleared", row.OfflineUsed)
	}
	if result := sampleAt(t, store, false, counter("u1@chordv", "0", "0")); len(result.DisableEmails) != 0 {
		t.Fatalf("a renewed user was cut off again: %v", result.DisableEmails)
	}
	if result := sampleAt(t, store, false, counter("u1@chordv", "10", "0")); len(result.DisableEmails) != 0 {
		t.Fatalf("a renewed user was cut off by their first bytes: %v", result.DisableEmails)
	}
}

func TestABackendThatStillWantsTheUserTakesItBack(t *testing.T) {
	// The node's clock was wrong, or the control plane's answer is simply
	// different: once it can be heard, it wins.
	store := newStore(t, "node-1", "boot-1")
	seed(t, store, expiring("b1", "u1@chordv", "1", pastExpiry))
	sampleAt(t, store, false)

	if err := store.RestoreBackendConfirmedUsers([]protocol.DesiredUser{
		expiring("b1", "u1@chordv", "1", pastExpiry),
	}); err != nil {
		t.Fatal(err)
	}
	row := storedUser(t, store, "b1")
	if !row.Enabled || row.OfflineUsed != "0" {
		t.Fatalf("restore left the user cut off: %+v", row)
	}
	if locallyDisabled(t, store) {
		t.Fatal("the node still reports a local cutoff after the restore")
	}
}

// TestAnExpiryCutoffIsOneEveryBuildCanUndo pins the on-disk shape of the
// cutoff, because other programs read it.
//
// A node can be rolled back onto this data directory — to an earlier build of
// this agent, or to the Node one. Neither knows anything this build adds. What
// both DO know is the cutoff they make themselves when the offline allowance
// runs out, and they recognise it with exactly the predicates below (the Node
// agent's are quoted from apps/node-agent/src/store.ts). If the row an expiry
// leaves does not satisfy them, the user stays disabled on a rolled-back node,
// with quota left, until some newer revision happens to arrive.
func TestAnExpiryCutoffIsOneEveryBuildCanUndo(t *testing.T) {
	store := newStore(t, "node-1", "boot-1")
	untouched := expiring("b1", "idle@chordv", "1", pastExpiry)
	untouched.OfflineAllowanceBytes = "5000"
	partway := expiring("b2", "active@chordv", "1", pastExpiry)
	partway.OfflineAllowanceBytes = "5000"
	// An allowance of zero is storable, and "0 >= 0" alone is not a cutoff to
	// anybody.
	zero := expiring("b3", "zero@chordv", "1", pastExpiry)
	zero.OfflineAllowanceBytes = "0"
	seed(t, store, untouched, partway, zero)
	// b2 has used part of its allowance offline before the date passes.
	sampleAtInstant(t, store, "2026-09-09T10:00:00.000Z", false, counter("active@chordv", "0", "0"))
	sampleAtInstant(t, store, "2026-09-09T10:30:00.000Z", false, counter("active@chordv", "1200", "0"))
	if row := storedUser(t, store, "b2"); !row.Enabled || row.OfflineUsed != "1200" {
		t.Fatalf("setup: %+v", row)
	}

	sampleAt(t, store, false)

	for _, bindingID := range []string{"b1", "b2", "b3"} {
		// Node agent, hasUsageDisabledUsers — and the Go agent's, before this
		// build:  enabled = 0 AND (quota = 0 OR (used > 0 AND used >= allowance)).
		// Node agent, hasOfflineDisabledUsers:
		//   enabled = 0 AND offline_used != '0' AND used >= allowance.
		var enabled int
		var quota, used, allowance string
		if err := store.db.QueryRow(
			`SELECT enabled, quota_remaining, offline_used, offline_allowance FROM desired_users_v2 WHERE binding_id = ?`,
			bindingID).Scan(&enabled, &quota, &used, &allowance); err != nil {
			t.Fatal(err)
		}
		usedValue, _ := new(big.Int).SetString(used, 10)
		allowanceValue, _ := new(big.Int).SetString(allowance, 10)
		if enabled != 0 || used == "0" || usedValue.Sign() <= 0 || usedValue.Cmp(allowanceValue) < 0 {
			t.Fatalf("%s: enabled=%d used=%s allowance=%s is not an allowance cutoff to an earlier build",
				bindingID, enabled, used, allowance)
		}
		// Quota is not what records the cutoff: the same-revision restore is
		// only offered to a user who still has some.
		if quota == "0" {
			t.Fatalf("%s: the cutoff spent the user's quota", bindingID)
		}
		if !offlineDisabled(t, store, bindingID) {
			t.Fatalf("%s is not a local cutoff to this build either", bindingID)
		}
	}
	// What b2 had really used is not rounded DOWN to the allowance, and nothing
	// is invented beyond it.
	if row := storedUser(t, store, "b1"); row.OfflineUsed != "5000" {
		t.Fatalf("b1 offline_used = %s, want the allowance", row.OfflineUsed)
	}
	if row := storedUser(t, store, "b2"); row.OfflineUsed != "5000" || row.QuotaRemainingBytes != "99998800" {
		t.Fatalf("b2 = %+v", row)
	}
	if row := storedUser(t, store, "b3"); row.OfflineUsed != "1" {
		t.Fatalf("b3 offline_used = %s, want a non-zero mark", row.OfflineUsed)
	}
}

func TestATerminalCommandAfterAnOfflineExpiryKeepsTheUserOff(t *testing.T) {
	store := newStore(t, "node-1", "boot-1")
	seed(t, store, expiring("b1", "u1@chordv", "1", pastExpiry))
	sampleAt(t, store, false)

	if err := store.ApplyTerminal("b1", "2", "u1@chordv", false); err != nil {
		t.Fatal(err)
	}
	row := storedUser(t, store, "b1")
	if row.Enabled || row.Revision != "2" {
		t.Fatalf("DISABLE_USER did not land on the cut-off row: %+v", row)
	}
	// A same-revision statement that enables it is refused like any other: the
	// control plane's disable is newer than the cutoff it replaced.
	seed(t, store, expiring("b1", "u1@chordv", "2", futureExpiry))
	if storedUser(t, store, "b1").Enabled {
		t.Fatal("an equal-revision enable undid a DISABLE_USER")
	}
}

// legacySchema strips the column an earlier build never created, leaving the
// table as that build wrote it.
func legacySchema(t *testing.T, store *Store) {
	t.Helper()
	if _, err := store.db.Exec(`ALTER TABLE desired_users_v2 DROP COLUMN expires_at`); err != nil {
		t.Fatalf("drop expires_at: %v", err)
	}
}

func TestAnOlderDatabaseGainsTheExpiryColumn(t *testing.T) {
	path := filepath.Join(t.TempDir(), "node-agent.db")
	first := openAt(t, path, "node-1", "boot-1")
	seed(t, first, user("b1", "u1@chordv", "3", "5000"))
	sampleAt(t, first, true, counter("u1@chordv", "40", "60"))
	legacySchema(t, first)
	first.Close()

	second := openAt(t, path, "node-1", "boot-2")
	row := storedUser(t, second, "b1")
	if row.ExpiresAt != "" {
		t.Fatalf("a migrated row claims an expiry it was never given: %+v", row)
	}
	// Everything the earlier build recorded is still there.
	if !row.Enabled || row.QuotaRemainingBytes != "5000" || row.Uplink != "40" || row.Downlink != "60" {
		t.Fatalf("migration disturbed the row: %+v", row)
	}
	// And it does not expire on anybody's word but the control plane's.
	if result := sampleAt(t, second, false); len(result.DisableEmails) != 0 {
		t.Fatalf("a row with no expiry was cut off: %v", result.DisableEmails)
	}
	seed(t, second, expiring("b1", "u1@chordv", "3", pastExpiry))
	if result := sampleAt(t, second, false); len(result.DisableEmails) != 1 {
		t.Fatalf("the migrated row did not pick up its expiry: %v", result.DisableEmails)
	}
}

func TestTheHealthProbeReadsADatabaseItHasNotMigrated(t *testing.T) {
	// The probe opens the service's database read-only. Between an upgrade
	// landing on disk and the service restarting, that database still has the
	// earlier build's table.
	path := filepath.Join(t.TempDir(), "node-agent.db")
	service := openAt(t, path, "node-1", "boot-1")
	seed(t, service, user("b1", "u1@chordv", "1", "5000"))
	legacySchema(t, service)

	probe, err := Open(path, Options{
		BootID: "probe", NodeID: "node-1", DefaultOfflineAllowance: big.NewInt(1), ReadOnly: true,
	})
	if err != nil {
		t.Fatalf("open probe: %v", err)
	}
	defer probe.Close()
	health, err := probe.HealthSnapshot()
	if err != nil {
		t.Fatalf("health snapshot on an unmigrated database: %v", err)
	}
	if health["desiredUsers"] != 1 {
		t.Fatalf("desiredUsers = %v, want 1", health["desiredUsers"])
	}
}
