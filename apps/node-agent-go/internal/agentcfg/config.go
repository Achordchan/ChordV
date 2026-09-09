// Package agentcfg loads and validates the agent's environment.
//
// Every variable name matches the Node agent's, so a host can be moved between
// implementations by swapping the binary and nothing else. Two of the checks
// here are load-bearing rather than cosmetic and are marked as such.
package agentcfg

import (
	"errors"
	"fmt"
	"math"
	"math/big"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// Config is the fully resolved runtime configuration.
type Config struct {
	// Operator-supplied identity. Either all three are set, or none are and the
	// identity comes from the credentials file / a registration token.
	AgentID string
	NodeID  string
	Token   string

	APIBaseURL      string
	XrayAPIAddress  string
	XrayInboundTag  string
	DatabasePath    string
	CredentialsPath string

	SampleInterval    time.Duration
	HeartbeatInterval time.Duration
	RestartTolerance  time.Duration

	OfflineAllowanceBytes *big.Int

	// RegisterToken is set only on a FIRST boot that has no credentials yet.
	RegisterToken string
	// ResetIdentity is the operator's explicit consent to archive a saved
	// identity that the current registration token did not issue. Off by
	// default: a repurposed host must never silently keep a stale identity.
	ResetIdentity bool
	// PublicHost overrides the address clients dial, ahead of API-observed
	// detection.
	PublicHost string
}

// DefaultOfflineAllowance matches the Node agent's 64 MiB.
const DefaultOfflineAllowance = 64 * 1024 * 1024

// AssertLocalXrayAddress refuses a non-local Xray control address.
//
// LOAD-BEARING: the Xray gRPC API has no authentication and no per-method ACL.
// Anything that can reach it can add users, remove the panel's inbounds, or
// rewrite routing. Binding it to a loopback address or a unix socket is the
// only thing standing between that surface and the internet, so a
// misconfiguration must stop the agent rather than widen the exposure.
func AssertLocalXrayAddress(address string) error {
	normalized := strings.ToLower(address)
	for _, prefix := range []string{"unix:", "127.0.0.1:", "localhost:", "[::1]:"} {
		if strings.HasPrefix(normalized, prefix) {
			return nil
		}
	}
	return errors.New("XRAY_API_ADDRESS 只能使用 Unix Socket 或本机 loopback 地址")
}

// AssertSafeAPIBaseURL refuses plaintext HTTP to anywhere but this machine.
//
// LOAD-BEARING: the agent's bearer token travels on every request, and the
// control plane's answers decide which users exist on this node. Plaintext off
// -host would put both on the wire.
func AssertSafeAPIBaseURL(value string) error {
	parsed, err := url.Parse(value)
	if err != nil {
		return fmt.Errorf("CHORDV_API_BASE_URL 不是合法 URL: %w", err)
	}
	// Go strips the brackets from an IPv6 literal, Node keeps them; accept both
	// spellings so the two agents read one environment file identically.
	host := strings.Trim(parsed.Hostname(), "[]")
	local := host == "127.0.0.1" || host == "localhost" || host == "::1"
	if parsed.Scheme == "https" || (parsed.Scheme == "http" && local) {
		return nil
	}
	return errors.New("CHORDV_API_BASE_URL 在非本机环境必须使用 HTTPS")
}

// Load reads the environment, applying the Node agent's defaults and refusals.
func Load() (*Config, error) {
	xrayAPIAddress := trimmedEnv("XRAY_API_ADDRESS")
	if xrayAPIAddress == "" {
		xrayAPIAddress = "127.0.0.1:10085"
	}
	if err := AssertLocalXrayAddress(xrayAPIAddress); err != nil {
		return nil, err
	}

	offlineRaw := trimmedEnv("AGENT_OFFLINE_ALLOWANCE_BYTES")
	if offlineRaw == "" {
		offlineRaw = strconv.Itoa(DefaultOfflineAllowance)
	}
	offlineAllowance, ok := new(big.Int).SetString(offlineRaw, 10)
	if !ok {
		return nil, errors.New("AGENT_OFFLINE_ALLOWANCE_BYTES 必须是十进制整数")
	}
	if offlineAllowance.Sign() <= 0 {
		return nil, errors.New("AGENT_OFFLINE_ALLOWANCE_BYTES 必须大于 0")
	}

	apiBaseURL := trimmedEnv("CHORDV_API_BASE_URL")
	if apiBaseURL == "" {
		return nil, errors.New("缺少环境变量 CHORDV_API_BASE_URL")
	}
	apiBaseURL = strings.TrimRight(apiBaseURL, "/")
	if err := AssertSafeAPIBaseURL(apiBaseURL); err != nil {
		return nil, err
	}

	// Credentials may legitimately be absent on a FIRST boot that carries a
	// one-time register token instead; the exchange persists them for later
	// boots. A missing trio is therefore not fatal by itself — the saved
	// credentials file may hold them. Fail only when no source exists at all.
	agentID := trimmedEnv("CHORDV_AGENT_ID")
	nodeID := trimmedEnv("CHORDV_NODE_ID")
	token := trimmedEnv("CHORDV_AGENT_TOKEN")
	registerToken := trimmedEnv("CHORDV_REGISTER_TOKEN")

	complete := agentID != "" && nodeID != "" && token != ""
	partial := agentID != "" || nodeID != "" || token != ""
	// Both a partial trio plus a register token and a COMPLETE trio plus one are
	// refused: the register token would only take effect if the credentials file
	// also happened to be missing, which is never a combination anyone means.
	if registerToken != "" && partial {
		return nil, errors.New("CHORDV_REGISTER_TOKEN 与既有凭据互斥：请仅提供注册令牌（首次接入）或完整凭据")
	}

	credentialsPath, err := absPath(envOr("AGENT_CREDENTIALS_PATH", "./data/credentials.json"))
	if err != nil {
		return nil, err
	}
	if !complete && registerToken == "" && !fileExists(credentialsPath) {
		return nil, errors.New(
			"缺少环境变量：需要 CHORDV_AGENT_ID/CHORDV_NODE_ID/CHORDV_AGENT_TOKEN，" +
				"或首次启动提供 CHORDV_REGISTER_TOKEN，或存在已注册的本地凭据文件")
	}

	databasePath, err := absPath(envOr("AGENT_DATABASE_PATH", "./data/node-agent.db"))
	if err != nil {
		return nil, err
	}
	sampleInterval, err := positiveDuration("AGENT_SAMPLE_INTERVAL_MS", 5_000)
	if err != nil {
		return nil, err
	}
	heartbeatInterval, err := positiveDuration("AGENT_HEARTBEAT_INTERVAL_MS", 15_000)
	if err != nil {
		return nil, err
	}
	// Uptime has second granularity and sampling jitters, so a restart estimate
	// needs a small window. A false positive only costs one idempotent reconcile.
	restartTolerance, err := positiveDuration("AGENT_XRAY_RESTART_TOLERANCE_MS", 2_000)
	if err != nil {
		return nil, err
	}

	inboundTag := trimmedEnv("XRAY_INBOUND_TAG")
	if inboundTag == "" {
		inboundTag = "vless-in"
	}

	config := &Config{
		AgentID:               agentID,
		NodeID:                nodeID,
		Token:                 token,
		APIBaseURL:            apiBaseURL,
		XrayAPIAddress:        xrayAPIAddress,
		XrayInboundTag:        inboundTag,
		DatabasePath:          databasePath,
		CredentialsPath:       credentialsPath,
		SampleInterval:        sampleInterval,
		HeartbeatInterval:     heartbeatInterval,
		RestartTolerance:      restartTolerance,
		OfflineAllowanceBytes: offlineAllowance,
		ResetIdentity:         truthyFlag("CHORDV_AGENT_RESET_IDENTITY"),
		PublicHost:            trimmedEnv("CHORDV_NODE_PUBLIC_HOST"),
	}
	// Mirrors the Node agent: the register token is only carried when it is the
	// actual identity source, never alongside an operator-supplied token.
	if registerToken != "" && token == "" {
		config.RegisterToken = registerToken
	}
	return config, nil
}

// PendingCredentialsPath is where the client-generated registration secret is
// parked BEFORE the request that spends it.
func (c *Config) PendingCredentialsPath() string { return c.CredentialsPath + ".pending" }

// ResetJournalPath records an in-progress identity archive so a crash midway
// leaves a resumable state rather than "no saved identity".
func (c *Config) ResetJournalPath() string { return c.CredentialsPath + ".reset-journal" }

// StateCandidates are the runtime-state files that must travel WITH the
// identity: the database holds the old node's desired users, command history
// and unsettled usage batches.
func (c *Config) StateCandidates() []string {
	return []string{c.DatabasePath, c.DatabasePath + "-wal", c.DatabasePath + "-shm"}
}

// ArchiveCandidates is the identity plus its state, archived under one stamp.
func (c *Config) ArchiveCandidates() []string {
	return append([]string{c.CredentialsPath, c.PendingCredentialsPath()}, c.StateCandidates()...)
}

func trimmedEnv(name string) string { return strings.TrimSpace(os.Getenv(name)) }

func envOr(name, fallback string) string {
	if value := trimmedEnv(name); value != "" {
		return value
	}
	return fallback
}

func truthyFlag(name string) bool {
	switch strings.ToLower(trimmedEnv(name)) {
	case "1", "true", "yes":
		return true
	}
	return false
}

func positiveDuration(name string, fallbackMillis int64) (time.Duration, error) {
	raw := os.Getenv(name)
	if raw == "" {
		return time.Duration(fallbackMillis) * time.Millisecond, nil
	}
	value, err := strconv.ParseInt(strings.TrimSpace(raw), 10, 64)
	if err != nil || value <= 0 {
		return 0, fmt.Errorf("%s 必须是正整数", name)
	}
	// time.Duration is int64 NANOseconds, so a value that is a perfectly valid
	// positive integer in milliseconds can still overflow the multiplication and
	// come back NEGATIVE. That would then be handed to time.NewTicker, which
	// panics on a non-positive duration — a config typo taking the agent down
	// with a stack trace instead of a message naming the variable.
	if value > maxDurationMillis {
		return 0, fmt.Errorf("%s 超出可表示范围（最大 %d）", name, maxDurationMillis)
	}
	return time.Duration(value) * time.Millisecond, nil
}

// maxDurationMillis is the largest millisecond count time.Duration can hold.
const maxDurationMillis = int64(math.MaxInt64) / int64(time.Millisecond)

func absPath(value string) (string, error) { return filepath.Abs(value) }

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}
