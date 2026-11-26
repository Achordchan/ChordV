package store

import (
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/Achordchan/ChordV/apps/agent/internal/protocol"
)

// rollbackFixture is the one artefact both agents are tested against.
//
// A node can be rolled back from this agent to the Node one on the same data
// directory. The Node agent's suite cannot run this store, and this suite cannot
// run the Node agent's, so each is pinned to the same file instead:
//
//   - this side proves the file IS what an offline expiry leaves on disk, by
//     producing it through the real store and comparing;
//   - apps/node-agent/test/go-agent-rollback.test.ts loads the file into a
//     database the Node agent created and proves the Node agent releases the
//     users in it, through its own store and its own runner.
//
// Change what an expiry writes and this test fails until the file is
// regenerated (CHORDV_UPDATE_FIXTURES=1 go test ./internal/store/), at which
// point the Node agent's test is judging the new shape.
const rollbackFixturePath = "testdata/offline-expiry-cutoff.json"

type rollbackFixture struct {
	Comment string `json:"comment"`
	// AddedColumns are the columns of desired_users_v2 the Node agent's schema
	// does not have, with the definition this agent adds them by.
	AddedColumns map[string]string `json:"addedColumns"`
	// Rows are desired_users_v2 after the cutoff, minus updated_at.
	Rows []map[string]any `json:"rows"`
}

// nodeAgentColumns is desired_users_v2 as apps/node-agent/src/store.ts creates it.
var nodeAgentColumns = map[string]bool{
	"binding_id": true, "email": true, "uuid": true, "flow": true, "enabled": true, "revision": true,
	"quota_remaining": true, "offline_allowance": true, "offline_used": true, "generation": true,
	"counter_initialized": true, "uplink": true, "downlink": true, "updated_at": true,
}

func dumpDesiredUsers(t *testing.T, store *Store) []map[string]any {
	t.Helper()
	rows, err := store.db.Query(`SELECT * FROM desired_users_v2 ORDER BY binding_id`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	columns, err := rows.Columns()
	if err != nil {
		t.Fatal(err)
	}
	var dump []map[string]any
	for rows.Next() {
		values := make([]any, len(columns))
		targets := make([]any, len(columns))
		for i := range values {
			targets[i] = &values[i]
		}
		if err := rows.Scan(targets...); err != nil {
			t.Fatal(err)
		}
		row := make(map[string]any, len(columns))
		for i, name := range columns {
			if name == "updated_at" {
				continue
			}
			switch value := values[i].(type) {
			case []byte:
				row[name] = string(value)
			case int64:
				// JSON has one number type; compare in it.
				row[name] = float64(value)
			default:
				row[name] = value
			}
		}
		dump = append(dump, row)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return dump
}

// addedColumns reads, from the table itself, every column the Node agent's
// schema does not have and the definition it was added by.
func addedColumns(t *testing.T, store *Store) map[string]string {
	t.Helper()
	rows, err := store.db.Query(`SELECT name, type, "notnull", dflt_value FROM pragma_table_info('desired_users_v2')`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	added := map[string]string{}
	for rows.Next() {
		var name, kind string
		var notNull int
		var fallback sql.NullString
		if err := rows.Scan(&name, &kind, &notNull, &fallback); err != nil {
			t.Fatal(err)
		}
		if nodeAgentColumns[name] {
			continue
		}
		definition := kind
		if notNull != 0 {
			definition += " NOT NULL"
		}
		if fallback.Valid {
			definition += " DEFAULT " + fallback.String
		}
		added[name] = definition
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return added
}

// TestAnExpiryCutoffIsTheRowTheNodeAgentIsTestedAgainst produces the cutoff
// through the real store — one user who never moved a byte, one cut off partway
// through its allowance — and holds the result to the shared file.
func TestAnExpiryCutoffIsTheRowTheNodeAgentIsTestedAgainst(t *testing.T) {
	store := newStore(t, "node-1", "boot-1")
	idle := protocol.DesiredUser{
		BindingID: "binding-idle", Email: "idle@chordv", UUID: "11111111-1111-4111-8111-111111111111",
		Revision: "1", Flow: protocol.FlowVision, Enabled: true,
		QuotaRemainingBytes: "1073741824", OfflineAllowanceBytes: "10737418240", ExpiresAt: pastExpiry,
	}
	active := protocol.DesiredUser{
		BindingID: "binding-active", Email: "active@chordv", UUID: "22222222-2222-4222-8222-222222222222",
		Revision: "1", Flow: protocol.FlowVision, Enabled: true,
		QuotaRemainingBytes: "1073741824", OfflineAllowanceBytes: "10737418240", ExpiresAt: pastExpiry,
	}
	seed(t, store, idle, active)
	// The outage starts before the date passes; the active user spends part of
	// its allowance in it.
	sampleAtInstant(t, store, "2026-09-09T10:00:00.000Z", false, counter("active@chordv", "100", "200"))
	sampleAtInstant(t, store, "2026-09-09T10:30:00.000Z", false, counter("active@chordv", "1100", "4200"))
	// And is still going when it does.
	result := sampleAt(t, store, false, counter("active@chordv", "1100", "4200"))
	if len(result.ExpiredEmails) != 2 {
		t.Fatalf("setup: expired = %v", result.ExpiredEmails)
	}

	produced := rollbackFixture{
		Comment: "desired_users_v2 as the Go agent leaves it after cutting two users off for expiring while the " +
			"control plane was unreachable. Generated by TestAnExpiryCutoffIsTheRowTheNodeAgentIsTestedAgainst " +
			"(CHORDV_UPDATE_FIXTURES=1); read by apps/node-agent/test/go-agent-rollback.test.ts. Do not edit by hand.",
		AddedColumns: addedColumns(t, store),
		Rows:         dumpDesiredUsers(t, store),
	}

	if os.Getenv("CHORDV_UPDATE_FIXTURES") == "1" {
		encoded, err := json.MarshalIndent(produced, "", "  ")
		if err != nil {
			t.Fatal(err)
		}
		if err := os.MkdirAll(filepath.Dir(rollbackFixturePath), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(rollbackFixturePath, append(encoded, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	raw, err := os.ReadFile(rollbackFixturePath)
	if err != nil {
		t.Fatal(err)
	}
	var want rollbackFixture
	if err := json.Unmarshal(raw, &want); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(produced.AddedColumns, want.AddedColumns) {
		t.Fatalf("columns beyond the Node agent's schema = %v, the shared file says %v", produced.AddedColumns, want.AddedColumns)
	}
	if !reflect.DeepEqual(produced.Rows, want.Rows) {
		got, _ := json.MarshalIndent(produced.Rows, "", "  ")
		t.Fatalf("an expiry cutoff no longer leaves the rows the Node agent is tested against.\n"+
			"If the change is intended, regenerate %s with CHORDV_UPDATE_FIXTURES=1 and re-run the Node agent's suite.\ngot:\n%s",
			rollbackFixturePath, got)
	}
}

// --- settlement -------------------------------------------------------------

// TestAConfirmedExpiryBecomesAnOrdinaryControlPlaneDisable: once the control
// plane says the user is off, the cutoff is no longer this node's decision —
// to this build or to one rolled back onto the same data.
func TestAConfirmedExpiryBecomesAnOrdinaryControlPlaneDisable(t *testing.T) {
	store := newStore(t, "node-1", "boot-1")
	lapsed := expiring("b1", "u1@chordv", "4", pastExpiry)
	seed(t, store, lapsed)
	sampleAt(t, store, false)
	if !locallyDisabled(t, store) {
		t.Fatal("setup: the expiry should be a local cutoff")
	}

	confirmed := lapsed
	confirmed.Enabled = false
	if err := store.SettleOfflineExpiry([]protocol.DesiredUser{confirmed}, mustInstant(t, tickInstant)); err != nil {
		t.Fatal(err)
	}
	row := storedUser(t, store, "b1")
	if row.Enabled || row.OfflineUsed != "0" || row.Revision != "4" || row.QuotaRemainingBytes != "100000000" {
		t.Fatalf("settled row = %+v", row)
	}
	if locallyDisabled(t, store) || offlineDisabled(t, store, "b1") {
		t.Fatal("a cutoff the control plane confirmed still counts as a local one")
	}
}

func TestOnlyAConfirmedExpiryIsSettled(t *testing.T) {
	now := mustInstant(t, tickInstant)
	cases := []struct {
		name      string
		statement func(protocol.DesiredUser) protocol.DesiredUser
	}{
		// The control plane still wants the user: that is the restore's business.
		{"enabled", func(u protocol.DesiredUser) protocol.DesiredUser { return u }},
		// A statement older than the row says nothing about it.
		{"older", func(u protocol.DesiredUser) protocol.DesiredUser {
			u.Enabled, u.Revision = false, "3"
			return u
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			store := newStore(t, "node-1", "boot-1")
			lapsed := expiring("b1", "u1@chordv", "4", pastExpiry)
			seed(t, store, lapsed)
			sampleAt(t, store, false)
			if err := store.SettleOfflineExpiry([]protocol.DesiredUser{tc.statement(lapsed)}, now); err != nil {
				t.Fatal(err)
			}
			if !offlineDisabled(t, store, "b1") {
				t.Fatal("the cutoff was settled without the control plane confirming it")
			}
		})
	}
}

// TestAnAllowanceCutoffIsNotSettledAsAnExpiry: a user cut off for the allowance
// alone, with time left on the subscription, is none of this function's
// business — it behaves exactly as it did before the agent knew about expiry.
func TestAnAllowanceCutoffIsNotSettledAsAnExpiry(t *testing.T) {
	for _, expiresAt := range []string{"", futureExpiry} {
		store := newStore(t, "node-1", "boot-1")
		current := expiring("b1", "u1@chordv", "4", expiresAt)
		current.OfflineAllowanceBytes = "500"
		seed(t, store, current)
		sampleAt(t, store, false, counter("u1@chordv", "0", "0"))
		sampleAt(t, store, false, counter("u1@chordv", "300", "300"))
		if !offlineDisabled(t, store, "b1") {
			t.Fatalf("setup (expiry %q): the allowance should be spent", expiresAt)
		}
		off := current
		off.Enabled = false
		if err := store.SettleOfflineExpiry([]protocol.DesiredUser{off}, mustInstant(t, tickInstant)); err != nil {
			t.Fatal(err)
		}
		if !offlineDisabled(t, store, "b1") {
			t.Fatalf("expiry %q: an allowance cutoff was settled as an expiry", expiresAt)
		}
	}
}
