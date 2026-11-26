package store

import (
	"math/big"
	"path/filepath"
	"testing"

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
	row := storedUser(t, store, "b1")
	if row.Enabled || !row.OfflineExpired {
		t.Fatalf("enabled = %v offline_expired = %v after expiring offline", row.Enabled, row.OfflineExpired)
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
	if !row.Enabled || row.OfflineExpired || row.ExpiresAt != futureExpiry {
		t.Fatalf("a renewal did not take the user back: %+v", row)
	}
	if locallyDisabled(t, store) {
		t.Fatal("the node still reports a local cutoff after the renewal")
	}
	if result := sampleAt(t, store, false); len(result.DisableEmails) != 0 {
		t.Fatalf("a renewed user was cut off again: %v", result.DisableEmails)
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
	if !row.Enabled || row.OfflineExpired {
		t.Fatalf("restore left the user cut off: %+v", row)
	}
}

func TestAConfirmedDisableSettlesAnOfflineExpiry(t *testing.T) {
	store := newStore(t, "node-1", "boot-1")
	seed(t, store,
		expiring("b1", "u1@chordv", "5", pastExpiry),
		expiring("b2", "u2@chordv", "5", pastExpiry),
		expiring("b3", "u3@chordv", "5", pastExpiry),
	)
	sampleAt(t, store, false)

	disabled := func(bindingID, email, revision string) protocol.DesiredUser {
		u := expiring(bindingID, email, revision, pastExpiry)
		u.Enabled = false
		return u
	}
	if err := store.SettleOfflineExpiry([]protocol.DesiredUser{
		disabled("b1", "u1@chordv", "5"),
		// Older than the row: not this binding's latest word.
		disabled("b2", "u2@chordv", "4"),
		// Still wanted: restoring it is RestoreBackendConfirmedUsers' job.
		expiring("b3", "u3@chordv", "5", pastExpiry),
		// Unknown to this node.
		disabled("b9", "u9@chordv", "5"),
	}); err != nil {
		t.Fatal(err)
	}
	if row := storedUser(t, store, "b1"); row.Enabled || row.OfflineExpired {
		t.Fatalf("b1 should be an ordinary control-plane disable now: %+v", row)
	}
	if offlineDisabled(t, store, "b1") {
		t.Fatal("b1 is still a local cutoff after the control plane confirmed it")
	}
	if !storedUser(t, store, "b2").OfflineExpired {
		t.Fatal("an older statement settled b2")
	}
	if !storedUser(t, store, "b3").OfflineExpired {
		t.Fatal("an ENABLED statement settled b3 as disabled")
	}

	// Once nothing is held locally the runner stops asking for snapshots.
	if err := store.SettleOfflineExpiry([]protocol.DesiredUser{
		disabled("b2", "u2@chordv", "5"), disabled("b3", "u3@chordv", "6"),
	}); err != nil {
		t.Fatal(err)
	}
	if locallyDisabled(t, store) {
		t.Fatal("the node still reports a local cutoff after every one was confirmed")
	}
}

func TestATerminalCommandSettlesAnOfflineExpiry(t *testing.T) {
	store := newStore(t, "node-1", "boot-1")
	seed(t, store, expiring("b1", "u1@chordv", "1", pastExpiry))
	sampleAt(t, store, false)

	if err := store.ApplyTerminal("b1", "2", "u1@chordv", false); err != nil {
		t.Fatal(err)
	}
	if row := storedUser(t, store, "b1"); row.Enabled || row.OfflineExpired {
		t.Fatalf("DISABLE_USER left the row marked as a local cutoff: %+v", row)
	}
	if locallyDisabled(t, store) {
		t.Fatal("the node still reports a local cutoff after DISABLE_USER")
	}
}

// legacySchema strips the columns an earlier build never created, leaving the
// table as that build wrote it.
func legacySchema(t *testing.T, store *Store) {
	t.Helper()
	for _, column := range []string{"expires_at", "offline_expired"} {
		if _, err := store.db.Exec(`ALTER TABLE desired_users_v2 DROP COLUMN ` + column); err != nil {
			t.Fatalf("drop %s: %v", column, err)
		}
	}
}

func TestAnOlderDatabaseGainsTheExpiryColumns(t *testing.T) {
	path := filepath.Join(t.TempDir(), "node-agent.db")
	first := openAt(t, path, "node-1", "boot-1")
	seed(t, first, user("b1", "u1@chordv", "3", "5000"))
	sampleAt(t, first, true, counter("u1@chordv", "40", "60"))
	legacySchema(t, first)
	first.Close()

	second := openAt(t, path, "node-1", "boot-2")
	row := storedUser(t, second, "b1")
	if row.ExpiresAt != "" || row.OfflineExpired {
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
