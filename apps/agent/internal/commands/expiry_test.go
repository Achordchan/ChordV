package commands

import (
	"testing"

	"github.com/Achordchan/ChordV/apps/agent/internal/protocol"
)

// --- subscription expiry ----------------------------------------------------
//
// The processor's whole part in expiry is carrying the date from a command into
// the store unchanged in meaning. What the date then DOES is the store's and
// the runner's business, and is tested there.

// TestAnInstallRecordsTheExpiryItCarried: ENSURE_USER has carried expiresAt for
// as long as the control plane has had per-user commands, and until now the
// agent dropped it — so a node cut off from the control plane had no way to
// know a subscription had run out.
func TestAnInstallRecordsTheExpiryItCarried(t *testing.T) {
	processor, _, state := newProcessor(t, false)
	payload := userPayload("b1", "u1@chordv")
	payload["expiresAt"] = "2026-12-31T16:00:00.000Z"

	if result := run(t, processor, command("c1", protocol.CommandEnsureUser, "2", payload), true); result.Status != protocol.StatusCompleted {
		t.Fatalf("result = %+v", result)
	}
	stored, err := state.UserByBindingID("b1")
	if err != nil || stored == nil {
		t.Fatalf("stored = %+v, %v", stored, err)
	}
	if stored.ExpiresAt != "2026-12-31T16:00:00.000Z" {
		t.Fatalf("expiresAt = %q", stored.ExpiresAt)
	}
}

// TestANewerInstallWithoutAnExpiryForgetsTheOldOne is the renewal case against
// a control plane that does not say when the renewed subscription ends.
//
// Carrying the stored date forward, the way the quota is carried, would leave a
// date from BEFORE the renewal on the row — and the next time the control plane
// was unreachable the node would cut off a customer who had just paid.
func TestANewerInstallWithoutAnExpiryForgetsTheOldOne(t *testing.T) {
	processor, _, state := newProcessor(t, false)
	first := userPayload("b1", "u1@chordv")
	first["expiresAt"] = "2026-12-31T16:00:00.000Z"
	run(t, processor, command("c1", protocol.CommandEnsureUser, "2", first), true)

	if result := run(t, processor, command("c2", protocol.CommandEnsureUser, "3", userPayload("b1", "u1@chordv")), true); result.Status != protocol.StatusCompleted {
		t.Fatalf("result = %+v", result)
	}
	stored, _ := state.UserByBindingID("b1")
	if stored == nil || stored.ExpiresAt != "" {
		t.Fatalf("a superseded expiry was kept: %+v", stored)
	}
}

// TestARenewalReplacesTheExpiry: the ordinary renewal, where the control plane
// does say.
func TestARenewalReplacesTheExpiry(t *testing.T) {
	processor, _, state := newProcessor(t, false)
	first := userPayload("b1", "u1@chordv")
	first["expiresAt"] = "2026-12-31T16:00:00.000Z"
	run(t, processor, command("c1", protocol.CommandEnsureUser, "2", first), true)

	renewed := userPayload("b1", "u1@chordv")
	renewed["expiresAt"] = "2027-12-31T16:00:00.000Z"
	run(t, processor, command("c2", protocol.CommandEnsureUser, "3", renewed), true)

	stored, _ := state.UserByBindingID("b1")
	if stored == nil || stored.ExpiresAt != "2027-12-31T16:00:00.000Z" {
		t.Fatalf("stored = %+v", stored)
	}
}

// TestAnUnreadableExpiryIsRefusedBeforeAnythingIsTouched. A date the agent
// cannot read is not "no expiry": accepting it would silently turn a dated
// subscription into an undated one. And it has to be refused before the
// install, so a malformed renewal cannot take down the account it was renewing.
func TestAnUnreadableExpiryIsRefusedBeforeAnythingIsTouched(t *testing.T) {
	processor, fake, state := newProcessor(t, false)
	good := userPayload("b1", "u1@chordv")
	good["expiresAt"] = "2026-12-31T16:00:00.000Z"
	run(t, processor, command("c1", protocol.CommandEnsureUser, "2", good), true)
	before := len(fake.calls)

	bad := userPayload("b1", "u1@chordv")
	bad["expiresAt"] = "next tuesday"
	result := run(t, processor, command("c2", protocol.CommandEnsureUser, "3", bad), true)
	if result.Status != protocol.StatusFailed {
		t.Fatalf("an unreadable expiry was accepted: %+v", result)
	}
	for _, call := range fake.calls[before:] {
		if call == "ensure:u1@chordv" || call == "remove:u1@chordv" {
			t.Fatalf("Xray was touched for a refused command: %v", fake.calls[before:])
		}
	}
	stored, _ := state.UserByBindingID("b1")
	if stored == nil || !stored.Enabled || stored.Revision != "2" || stored.ExpiresAt != "2026-12-31T16:00:00.000Z" {
		t.Fatalf("the refused command changed the record: %+v", stored)
	}
}

// TestAnExpiryThatIsNotAStringIsNotAnExpiry. The wire type is a string; a
// number or a null there is a control plane this agent does not understand,
// and "not stated" is the reading that cannot cut anyone off.
func TestAnExpiryThatIsNotAStringIsNotAnExpiry(t *testing.T) {
	processor, _, state := newProcessor(t, false)
	for index, value := range []any{nil, float64(1798732800000), true} {
		binding := "b" + string(rune('1'+index))
		payload := userPayload(binding, binding+"@chordv")
		payload["expiresAt"] = value
		if result := run(t, processor, command("c-"+binding, protocol.CommandEnsureUser, "2", payload), true); result.Status != protocol.StatusCompleted {
			t.Fatalf("%v: result = %+v", value, result)
		}
		stored, _ := state.UserByBindingID(binding)
		if stored == nil || stored.ExpiresAt != "" {
			t.Fatalf("%v was read as an expiry: %+v", value, stored)
		}
	}
}

// TestAFullReconcileCarriesEachUsersExpiry: the other way users reach a node.
func TestAFullReconcileCarriesEachUsersExpiry(t *testing.T) {
	processor, _, state := newProcessor(t, false)
	dated := map[string]any(userPayload("b1", "u1@chordv"))
	dated["expiresAt"] = "2026-12-31T16:00:00Z"
	undated := map[string]any(userPayload("b2", "u2@chordv"))

	if result := run(t, processor, command("c1", protocol.CommandReconcileUsers, "2", map[string]any{
		"controlMode": string(protocol.ModeDirectPrimary),
		"users":       []any{dated, undated},
	}), true); result.Status != protocol.StatusCompleted {
		t.Fatalf("result = %+v", result)
	}
	if stored, _ := state.UserByBindingID("b1"); stored == nil || stored.ExpiresAt != "2026-12-31T16:00:00.000Z" {
		t.Fatalf("b1 = %+v", stored)
	}
	if stored, _ := state.UserByBindingID("b2"); stored == nil || stored.ExpiresAt != "" {
		t.Fatalf("b2 = %+v", stored)
	}
}

// TestAReconcileWithAnUnreadableExpiryChangesNothing: one bad row must not
// leave the set half applied.
func TestAReconcileWithAnUnreadableExpiryChangesNothing(t *testing.T) {
	processor, fake, state := newProcessor(t, false)
	bad := map[string]any(userPayload("b1", "u1@chordv"))
	bad["expiresAt"] = "2026-13-45"
	result := run(t, processor, command("c1", protocol.CommandReconcileUsers, "2", map[string]any{
		"controlMode": string(protocol.ModeDirectPrimary),
		"users":       []any{map[string]any(userPayload("b0", "u0@chordv")), bad},
	}), true)
	if result.Status != protocol.StatusFailed {
		t.Fatalf("result = %+v", result)
	}
	if contains(fake.calls, "ensure:u0@chordv") {
		t.Fatalf("part of a refused set was installed: %v", fake.calls)
	}
	if stored, _ := state.UserByBindingID("b0"); stored != nil {
		t.Fatalf("part of a refused set was recorded: %+v", stored)
	}
}
