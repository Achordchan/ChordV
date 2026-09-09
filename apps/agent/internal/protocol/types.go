// Package protocol is the wire contract with the ChordV control plane.
//
// It is a straight transcription of apps/node-agent/src/types.ts and the
// server's apps/api/src/modules/agent/agent.dto.ts. The Go agent must be
// indistinguishable from the Node agent on the wire — a canary that also
// changes the protocol cannot tell a porting bug from a protocol bug — so
// nothing here may be "improved" without the same change landing on both
// sides. Every quantity that must not lose precision is a decimal string,
// matching the server's /^(0|[1-9]\d*)$/ validators.
package protocol

// CommandType enumerates what the control plane may ask an agent to do.
// The server validates against this exact list (QueueAgentCommandDto).
type CommandType string

const (
	CommandEnsureUser     CommandType = "ENSURE_USER"
	CommandEnableUser     CommandType = "ENABLE_USER"
	CommandDisableUser    CommandType = "DISABLE_USER"
	CommandRemoveUser     CommandType = "REMOVE_USER"
	CommandReconcileUsers CommandType = "RECONCILE_USERS"
	CommandRefreshQuota   CommandType = "REFRESH_QUOTA"
	CommandEnsureInbound  CommandType = "ENSURE_INBOUND"
)

// AllCommandTypes is ordered as in types.ts.
var AllCommandTypes = []CommandType{
	CommandEnsureUser, CommandEnableUser, CommandDisableUser, CommandRemoveUser,
	CommandReconcileUsers, CommandRefreshQuota, CommandEnsureInbound,
}

// IsCommandType reports whether the control plane could legitimately have sent
// this type. An unknown type is a newer control plane talking to an older
// agent, which must fail the command rather than guess.
func IsCommandType(value string) bool {
	for _, candidate := range AllCommandTypes {
		if CommandType(value) == candidate {
			return true
		}
	}
	return false
}

// ControlMode decides whether this agent may write to Xray at all.
// Only direct_primary may; the others are observation or handover states.
type ControlMode string

const (
	ModeXuiPrimary      ControlMode = "xui_primary"
	ModeShadowDirect    ControlMode = "shadow_direct"
	ModeDirectPrimary   ControlMode = "direct_primary"
	ModeRollbackPending ControlMode = "rollback_pending"
)

// IsControlMode mirrors isNodeControlMode: an unrecognised mode must never be
// treated as direct_primary by omission.
func IsControlMode(value string) bool {
	switch ControlMode(value) {
	case ModeXuiPrimary, ModeShadowDirect, ModeDirectPrimary, ModeRollbackPending:
		return true
	}
	return false
}

// Flow is the VLESS flow. Only these two values exist in this protocol.
const (
	FlowVision = "xtls-rprx-vision"
	FlowNone   = ""
)

// DesiredUser is one account the control plane wants provisioned.
type DesiredUser struct {
	BindingID string `json:"bindingId"`
	Revision  string `json:"revision"`
	Email     string `json:"email"`
	UUID      string `json:"uuid"`
	// Flow is deliberately NOT omitempty: "" is a meaningful value (no flow),
	// not an absent field, and dropping it would change the user's protocol.
	Flow                  string `json:"flow"`
	Enabled               bool   `json:"enabled"`
	QuotaRemainingBytes   string `json:"quotaRemainingBytes"`
	OfflineAllowanceBytes string `json:"offlineAllowanceBytes"`
}

// AbsoluteCounter is one user's cumulative traffic as Xray reports it.
type AbsoluteCounter struct {
	Email         string `json:"email"`
	UplinkBytes   string `json:"uplinkBytes"`
	DownlinkBytes string `json:"downlinkBytes"`
}

// UsageSample is one user's contribution to a batch. Both the absolute reading
// and the delta travel: the absolute value lets the control plane detect a
// counter reset it was not told about, and the delta is what gets billed.
type UsageSample struct {
	BindingID          string `json:"bindingId"`
	CounterGeneration  string `json:"counterGeneration"`
	UplinkBytes        string `json:"uplinkBytes"`
	DownlinkBytes      string `json:"downlinkBytes"`
	UplinkDeltaBytes   string `json:"uplinkDeltaBytes"`
	DownlinkDeltaBytes string `json:"downlinkDeltaBytes"`
}

// UsageBatch is one metering upload. (bootId, sequence) is the server's
// uniqueness key and the basis of its contiguity check, so sequence starts at 1
// within a boot and must never skip.
type UsageBatch struct {
	BootID    string        `json:"bootId"`
	Sequence  string        `json:"sequence"`
	SampledAt string        `json:"sampledAt"`
	Samples   []UsageSample `json:"samples"`
}

// UsageBatchAck is the server's answer. AckThrough is the watermark below which
// batches may be dropped locally.
type UsageBatchAck struct {
	Accepted   bool   `json:"accepted"`
	Duplicate  bool   `json:"duplicate"`
	AckThrough string `json:"ackThrough"`
}

// Command is one unit of work delivered over SSE.
type Command struct {
	CommandID      string         `json:"commandId"`
	Type           CommandType    `json:"type"`
	TargetRevision string         `json:"targetRevision"`
	Payload        map[string]any `json:"payload"`
	CreatedAt      string         `json:"createdAt"`
}

// CommandResult is reported back per command. The server accepts only these two
// statuses; anything the agent could not finish is "failed" with a reason.
type CommandResult struct {
	CommandID string         `json:"commandId"`
	Status    string         `json:"status"`
	Result    map[string]any `json:"result,omitempty"`
	Error     string         `json:"error,omitempty"`
}

const (
	StatusCompleted = "completed"
	StatusFailed    = "failed"
)

// ConfigSnapshot is the full desired state for this node.
type ConfigSnapshot struct {
	NodeID      string        `json:"nodeId"`
	Revision    string        `json:"revision"`
	ControlMode ControlMode   `json:"controlMode"`
	Users       []DesiredUser `json:"users"`
}

// XrayStatus is the health value carried on every heartbeat.
type XrayStatus string

const (
	XrayUnknown  XrayStatus = "unknown"
	XrayHealthy  XrayStatus = "healthy"
	XrayDegraded XrayStatus = "degraded"
	XrayOffline  XrayStatus = "offline"
)

// Heartbeat is the periodic liveness and progress report.
type Heartbeat struct {
	BootID         string     `json:"bootId"`
	Version        string     `json:"version"`
	ConfigRevision string     `json:"configRevision"`
	QueueDepth     int        `json:"queueDepth"`
	XrayStatus     XrayStatus `json:"xrayStatus"`
}

// HeartbeatAck carries the server's ack watermark and its current revision, so
// a shadow-mode agent learns about config changes without an SSE event.
type HeartbeatAck struct {
	Accepted       bool   `json:"accepted"`
	AckThrough     string `json:"ackThrough"`
	ConfigRevision string `json:"configRevision"`
}

// WhoAmI is the source address the control plane observes for this agent. It is
// used as the node's public host: a cloud host's own NIC usually holds a
// private address, and this answer arrives over the already-authenticated
// channel rather than from a third-party echo service.
type WhoAmI struct {
	ObservedIP string `json:"observedIp"`
}

// RegisterRequest is the one-time-token exchange. agentToken is generated by
// the AGENT and sent here; the server stores only its hash, which is what makes
// a replayed registration idempotent instead of node-bricking.
type RegisterRequest struct {
	RegisterToken string `json:"registerToken"`
	AgentToken    string `json:"agentToken"`
	Hostname      string `json:"hostname"`
	Arch          string `json:"arch"`
	AgentVersion  string `json:"agentVersion"`
	XrayVersion   string `json:"xrayVersion,omitempty"`
	BootID        string `json:"bootId"`
}

// Architectures the control plane accepts (AgentRegisterDto @IsIn).
const (
	ArchAMD64 = "linux-x64"
	ArchARM64 = "linux-arm64"
)

// RegisterResponse is the minted identity.
type RegisterResponse struct {
	Accepted bool   `json:"accepted"`
	AgentID  string `json:"agentId"`
	NodeID   string `json:"nodeId"`
}
