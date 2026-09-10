package agentcfg

import (
	"path/filepath"
	"strings"
	"testing"
)

// baseEnv sets the minimum that makes Load succeed, so each test can change one
// variable and attribute the outcome to it.
func baseEnv(t *testing.T) {
	t.Helper()
	t.Setenv("CHORDV_API_BASE_URL", "https://v.achord.cn")
	t.Setenv("CHORDV_AGENT_ID", "agent-1")
	t.Setenv("CHORDV_NODE_ID", "node-1")
	t.Setenv("CHORDV_AGENT_TOKEN", "token-1")
	t.Setenv("CHORDV_REGISTER_TOKEN", "")
	t.Setenv("XRAY_API_ADDRESS", "")
	t.Setenv("AGENT_OFFLINE_ALLOWANCE_BYTES", "")
	t.Setenv("AGENT_DATABASE_PATH", filepath.Join(t.TempDir(), "node-agent.db"))
	t.Setenv("AGENT_CREDENTIALS_PATH", filepath.Join(t.TempDir(), "credentials.json"))
	t.Setenv("CHORDV_AGENT_RESET_IDENTITY", "")
	t.Setenv("AGENT_SAMPLE_INTERVAL_MS", "")
	t.Setenv("AGENT_HEARTBEAT_INTERVAL_MS", "")
	t.Setenv("AGENT_XRAY_RESTART_TOLERANCE_MS", "")
}

func TestXrayAddressMustBeLocal(t *testing.T) {
	// The Xray gRPC API has no auth and no per-method ACL: reaching it is enough
	// to remove the panel's inbounds. Loopback/unix is the entire boundary.
	for _, address := range []string{"0.0.0.0:10085", "10.0.0.5:10085", "example.com:10085", "[fe80::1]:10085", "127.0.0.2:10085"} {
		if err := AssertLocalXrayAddress(address); err == nil {
			t.Fatalf("AssertLocalXrayAddress(%q) accepted a non-local control address", address)
		}
	}
	for _, address := range []string{"127.0.0.1:10085", "localhost:10085", "[::1]:10085", "unix:/run/xray.sock", "UNIX:/run/xray.sock"} {
		if err := AssertLocalXrayAddress(address); err != nil {
			t.Fatalf("AssertLocalXrayAddress(%q) rejected a local address: %v", address, err)
		}
	}
}

func TestAPIBaseURLMustBeHTTPSOffHost(t *testing.T) {
	// The bearer token rides on every request and the answers decide which users
	// exist on this node; plaintext off-host would put both on the wire.
	for _, value := range []string{"http://v.achord.cn", "http://10.0.0.5:3000", "ftp://v.achord.cn"} {
		if err := AssertSafeAPIBaseURL(value); err == nil {
			t.Fatalf("AssertSafeAPIBaseURL(%q) accepted plaintext to a remote host", value)
		}
	}
	// Both bracket spellings of the IPv6 loopback must pass: Node keeps the
	// brackets in url.hostname and Go strips them, and the two agents are meant
	// to read one environment file identically.
	for _, value := range []string{"https://v.achord.cn", "http://127.0.0.1:3000", "http://localhost:3000", "http://[::1]:3000"} {
		if err := AssertSafeAPIBaseURL(value); err != nil {
			t.Fatalf("AssertSafeAPIBaseURL(%q) rejected a safe URL: %v", value, err)
		}
	}
}

func TestRegisterTokenIsMutuallyExclusiveWithCredentials(t *testing.T) {
	// A register token beside credentials only takes effect if the credentials
	// FILE also happens to be missing — never a combination anyone means, and
	// silently picking one would onboard the host as the wrong node.
	baseEnv(t)
	t.Setenv("CHORDV_REGISTER_TOKEN", "one-time")
	if _, err := Load(); err == nil || !strings.Contains(err.Error(), "互斥") {
		t.Fatalf("Load accepted a register token alongside full credentials: %v", err)
	}

	baseEnv(t)
	t.Setenv("CHORDV_AGENT_TOKEN", "")
	t.Setenv("CHORDV_REGISTER_TOKEN", "one-time")
	if _, err := Load(); err == nil || !strings.Contains(err.Error(), "互斥") {
		t.Fatalf("Load accepted a register token alongside a PARTIAL credential trio: %v", err)
	}
}

func TestLoadRequiresSomeIdentitySource(t *testing.T) {
	baseEnv(t)
	t.Setenv("CHORDV_AGENT_ID", "")
	t.Setenv("CHORDV_NODE_ID", "")
	t.Setenv("CHORDV_AGENT_TOKEN", "")
	if _, err := Load(); err == nil {
		t.Fatal("Load succeeded with no credentials, no register token and no credentials file")
	}

	// A register token alone is the legitimate first boot.
	t.Setenv("CHORDV_REGISTER_TOKEN", "one-time")
	config, err := Load()
	if err != nil {
		t.Fatalf("Load rejected a first boot carrying only a register token: %v", err)
	}
	if config.RegisterToken != "one-time" {
		t.Fatalf("RegisterToken = %q, want it carried through", config.RegisterToken)
	}
}

func TestDefaultsMatchTheNodeAgent(t *testing.T) {
	baseEnv(t)
	config, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if config.XrayAPIAddress != "127.0.0.1:10085" {
		t.Fatalf("XrayAPIAddress = %q", config.XrayAPIAddress)
	}
	if config.XrayInboundTag != "vless-in" {
		t.Fatalf("XrayInboundTag = %q", config.XrayInboundTag)
	}
	if config.SampleInterval.Milliseconds() != 5_000 {
		t.Fatalf("SampleInterval = %v", config.SampleInterval)
	}
	if config.HeartbeatInterval.Milliseconds() != 15_000 {
		t.Fatalf("HeartbeatInterval = %v", config.HeartbeatInterval)
	}
	if config.RestartTolerance.Milliseconds() != 2_000 {
		t.Fatalf("RestartTolerance = %v", config.RestartTolerance)
	}
	if config.OfflineAllowanceBytes.String() != "67108864" {
		t.Fatalf("OfflineAllowanceBytes = %s", config.OfflineAllowanceBytes)
	}
}

func TestIntervalsAndAllowanceMustBePositive(t *testing.T) {
	for _, name := range []string{"AGENT_SAMPLE_INTERVAL_MS", "AGENT_HEARTBEAT_INTERVAL_MS", "AGENT_XRAY_RESTART_TOLERANCE_MS"} {
		for _, value := range []string{"0", "-1", "abc", "1.5"} {
			baseEnv(t)
			t.Setenv(name, value)
			if _, err := Load(); err == nil {
				t.Fatalf("Load accepted %s=%q", name, value)
			}
		}
	}
	// A non-positive allowance would disable a user the instant it goes offline.
	for _, value := range []string{"0", "-1", "abc"} {
		baseEnv(t)
		t.Setenv("AGENT_OFFLINE_ALLOWANCE_BYTES", value)
		if _, err := Load(); err == nil {
			t.Fatalf("Load accepted AGENT_OFFLINE_ALLOWANCE_BYTES=%q", value)
		}
	}
}

func TestBaseURLTrailingSlashIsStripped(t *testing.T) {
	baseEnv(t)
	t.Setenv("CHORDV_API_BASE_URL", "https://v.achord.cn/")
	config, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	// Paths are concatenated, so a kept slash yields //api/agent/v1/... which
	// the reverse proxy in front of the control plane does not route.
	if config.APIBaseURL != "https://v.achord.cn" {
		t.Fatalf("APIBaseURL = %q", config.APIBaseURL)
	}
}

func TestDerivedPathsHangOffTheCredentialsFile(t *testing.T) {
	baseEnv(t)
	config, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if config.PendingCredentialsPath() != config.CredentialsPath+".pending" {
		t.Fatalf("PendingCredentialsPath = %q", config.PendingCredentialsPath())
	}
	if config.ResetJournalPath() != config.CredentialsPath+".reset-journal" {
		t.Fatalf("ResetJournalPath = %q", config.ResetJournalPath())
	}
	// The database and its WAL sidecars must travel WITH the identity: leaving
	// them behind hands a new identity the old node's unsettled usage batches.
	state := config.StateCandidates()
	want := []string{config.DatabasePath, config.DatabasePath + "-wal", config.DatabasePath + "-shm"}
	if len(state) != len(want) {
		t.Fatalf("StateCandidates = %v", state)
	}
	for i := range want {
		if state[i] != want[i] {
			t.Fatalf("StateCandidates[%d] = %q, want %q", i, state[i], want[i])
		}
	}
	archive := config.ArchiveCandidates()
	if len(archive) != len(state)+2 || archive[0] != config.CredentialsPath || archive[1] != config.PendingCredentialsPath() {
		t.Fatalf("ArchiveCandidates = %v", archive)
	}
}

func TestIntervalMillisMustFitInADuration(t *testing.T) {
	// time.Duration is int64 NANOseconds. A perfectly valid positive integer in
	// milliseconds can overflow the multiplication and come back NEGATIVE, which
	// time.NewTicker then PANICS on — a config typo taking the agent down with a
	// stack trace instead of a message naming the variable.
	overflowing := []string{
		"9223372036855",       // just past the representable range
		"9223372036854775807", // math.MaxInt64
		"999999999999999999",  //
	}
	for _, name := range []string{"AGENT_SAMPLE_INTERVAL_MS", "AGENT_HEARTBEAT_INTERVAL_MS", "AGENT_XRAY_RESTART_TOLERANCE_MS"} {
		for _, value := range overflowing {
			baseEnv(t)
			t.Setenv(name, value)
			config, err := Load()
			if err == nil {
				t.Fatalf("%s=%s produced %v instead of a configuration error", name, value, config)
			}
		}
	}
	// The boundary itself must still be accepted, so the check rejects only what
	// genuinely cannot be represented.
	baseEnv(t)
	t.Setenv("AGENT_SAMPLE_INTERVAL_MS", "9223372036854")
	config, err := Load()
	if err != nil {
		t.Fatalf("the largest representable interval was rejected: %v", err)
	}
	if config.SampleInterval <= 0 {
		t.Fatalf("SampleInterval = %v, want a positive duration", config.SampleInterval)
	}
}

func TestOwnershipSwitchesRequireOptIn(t *testing.T) {
	baseEnv(t)
	for _, value := range []string{"", "false", "1", "TRUE", "yes"} {
		t.Setenv("AGENT_REMOVE_UNKNOWN_USERS", value)
		t.Setenv("AGENT_ADOPT_EXISTING_ACCOUNTS", value)
		config, err := Load()
		if err != nil {
			t.Fatal(err)
		}
		want := value != "" && value != "false"
		if config.RemoveUnknownUsers != want || config.AdoptExistingAccounts != want {
			t.Fatalf("switch %q: %+v", value, config)
		}
	}
}
