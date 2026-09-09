package protocol

import (
	"encoding/json"
	"sort"
	"testing"
)

// keysOf marshals a value and returns its top-level JSON field names. The wire
// names are the contract with a control plane that VALIDATES them (class-
// validator with a whitelisting pipe: an unknown property is a 400, a missing
// required one is a 400). Renaming a Go field is therefore a protocol change,
// and this test is what makes that visible in review.
func keysOf(t *testing.T, value any) []string {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]json.RawMessage
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatal(err)
	}
	keys := make([]string, 0, len(decoded))
	for key := range decoded {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func assertKeys(t *testing.T, name string, value any, want []string) {
	t.Helper()
	got := keysOf(t, value)
	sort.Strings(want)
	if len(got) != len(want) {
		t.Fatalf("%s marshals %v, want %v", name, got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("%s marshals %v, want %v", name, got, want)
		}
	}
}

func TestOutboundPayloadsMatchTheServerDTOs(t *testing.T) {
	// AgentHeartbeatDto
	assertKeys(t, "Heartbeat", Heartbeat{}, []string{"bootId", "version", "configRevision", "queueDepth", "xrayStatus"})
	// AgentUsageBatchDto
	assertKeys(t, "UsageBatch", UsageBatch{}, []string{"bootId", "sequence", "sampledAt", "samples"})
	// AgentUsageSampleInputDto
	assertKeys(t, "UsageSample", UsageSample{}, []string{
		"bindingId", "counterGeneration", "uplinkBytes", "downlinkBytes", "uplinkDeltaBytes", "downlinkDeltaBytes"})
	// AgentRegisterDto — xrayVersion is @IsOptional and omitted when unset.
	assertKeys(t, "RegisterRequest", RegisterRequest{}, []string{
		"registerToken", "agentToken", "hostname", "arch", "agentVersion", "bootId"})
	assertKeys(t, "RegisterRequest with xray", RegisterRequest{XrayVersion: "1.8.4"}, []string{
		"registerToken", "agentToken", "hostname", "arch", "agentVersion", "bootId", "xrayVersion"})
}

func TestDesiredUserKeepsAnExplicitEmptyFlow(t *testing.T) {
	// "" is a MEANINGFUL value (no flow), not an absent field. An omitempty tag
	// would drop it, and a consumer defaulting the missing key would give the
	// user a different protocol than the control plane assigned.
	assertKeys(t, "DesiredUser", DesiredUser{}, []string{
		"bindingId", "revision", "email", "uuid", "flow", "enabled",
		"quotaRemainingBytes", "offlineAllowanceBytes"})
	raw, err := json.Marshal(DesiredUser{Flow: FlowNone})
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	json.Unmarshal(raw, &decoded)
	if value, present := decoded["flow"]; !present || value != "" {
		t.Fatalf("flow = %v (present=%v), want an explicit empty string", value, present)
	}
}

func TestCommandResultOmitsEmptyOptionalFields(t *testing.T) {
	// AgentCommandResultDto: result and error are @IsOptional, and the
	// whitelisting pipe rejects a null where it expects an object or a string.
	assertKeys(t, "CommandResult", CommandResult{Status: StatusCompleted}, []string{"commandId", "status"})
	assertKeys(t, "CommandResult failed", CommandResult{Status: StatusFailed, Error: "boom"},
		[]string{"commandId", "status", "error"})
}

func TestCommandTypesMatchTheServerWhitelist(t *testing.T) {
	// QueueAgentCommandDto @IsIn — a type outside this list cannot be queued, so
	// an agent that invents one can never receive it.
	want := []string{"ENSURE_USER", "ENABLE_USER", "DISABLE_USER", "REMOVE_USER",
		"RECONCILE_USERS", "REFRESH_QUOTA", "ENSURE_INBOUND"}
	if len(AllCommandTypes) != len(want) {
		t.Fatalf("AllCommandTypes = %v", AllCommandTypes)
	}
	for i, value := range want {
		if string(AllCommandTypes[i]) != value {
			t.Fatalf("AllCommandTypes[%d] = %q, want %q", i, AllCommandTypes[i], value)
		}
		if !IsCommandType(value) {
			t.Fatalf("IsCommandType(%q) = false", value)
		}
	}
	// A newer control plane talking to an older agent must fail the command
	// rather than guess at it.
	for _, value := range []string{"", "ensure_user", "ROTATE_KEYS"} {
		if IsCommandType(value) {
			t.Fatalf("IsCommandType(%q) = true", value)
		}
	}
}

func TestControlModeGateIsClosedByDefault(t *testing.T) {
	for _, value := range []string{"xui_primary", "shadow_direct", "direct_primary", "rollback_pending"} {
		if !IsControlMode(value) {
			t.Fatalf("IsControlMode(%q) = false", value)
		}
	}
	// Only direct_primary may write to Xray. An unrecognised mode must never be
	// treated as writable by falling through a switch.
	for _, value := range []string{"", "DIRECT_PRIMARY", "primary", "direct"} {
		if IsControlMode(value) {
			t.Fatalf("IsControlMode(%q) = true", value)
		}
	}
}

func TestInboundSnapshotDecodesTheServerShape(t *testing.T) {
	// Decoding, not encoding: this one arrives from the control plane.
	raw := `{"nodeId":"n1","revision":"12","controlMode":"direct_primary","users":[
		{"bindingId":"b1","revision":"12","email":"u1@chordv","uuid":"uuid-1","flow":"xtls-rprx-vision",
		 "enabled":true,"quotaRemainingBytes":"1073741824","offlineAllowanceBytes":"67108864"}]}`
	var snapshot ConfigSnapshot
	if err := json.Unmarshal([]byte(raw), &snapshot); err != nil {
		t.Fatal(err)
	}
	if snapshot.ControlMode != ModeDirectPrimary || len(snapshot.Users) != 1 {
		t.Fatalf("snapshot = %+v", snapshot)
	}
	user := snapshot.Users[0]
	if user.Email != "u1@chordv" || user.Flow != FlowVision || !user.Enabled {
		t.Fatalf("user = %+v", user)
	}
	// Byte counts stay STRINGS end to end: 1 TiB of traffic is already beyond
	// what a float64 round-trips exactly, and JSON numbers decode as float64.
	if user.QuotaRemainingBytes != "1073741824" {
		t.Fatalf("QuotaRemainingBytes = %q", user.QuotaRemainingBytes)
	}
}
