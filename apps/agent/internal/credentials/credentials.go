// Package credentials resolves the agent's persistent identity.
//
// Three invariants live here, each protecting against a failure that would
// otherwise need manual recovery on the VPS:
//
//  1. the client-generated registration secret is made durable BEFORE the
//     request that spends it, so a lost response can be replayed;
//  2. a saved identity that the CURRENT register token did not issue stops the
//     agent instead of being silently reused;
//  3. archiving an identity also archives its runtime state, under one stamp,
//     journalled so a crash midway is resumable.
package credentials

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"

	"github.com/Achordchan/ChordV/apps/agent/internal/agentcfg"
	"github.com/Achordchan/ChordV/apps/agent/internal/apiclient"
	"github.com/Achordchan/ChordV/apps/agent/internal/durable"
	"github.com/Achordchan/ChordV/apps/agent/internal/protocol"
	"github.com/Achordchan/ChordV/apps/agent/internal/uuid"
	"github.com/Achordchan/ChordV/apps/agent/internal/version"
)

// Credentials is the resolved identity every authenticated request carries.
type Credentials struct {
	AgentID string `json:"agentId"`
	NodeID  string `json:"nodeId"`
	Token   string `json:"token"`
}

// agentTokenPattern mirrors the server's AgentRegisterDto validator. Checking
// it locally turns "the control plane rejected registration" into a message
// that names the corrupt file.
var agentTokenPattern = regexp.MustCompile(`^chordv_agent_[A-Za-z0-9_-]{43,128}$`)

// RegisterFunc is the registration call, injectable for tests.
type RegisterFunc func(ctx context.Context, baseURL string, payload protocol.RegisterRequest) (protocol.RegisterResponse, error)

// Resolver owns the identity lifecycle for one configuration.
type Resolver struct {
	Config   *agentcfg.Config
	Register RegisterFunc
	// Logf receives operator-facing notices (archival, registration progress).
	Logf func(format string, args ...any)
	// Now is injectable so a test can assert one archive stamp across files.
	Now func() time.Time
}

// NewResolver wires the production dependencies.
func NewResolver(config *agentcfg.Config) *Resolver {
	return &Resolver{
		Config: config,
		Register: func(ctx context.Context, baseURL string, payload protocol.RegisterRequest) (protocol.RegisterResponse, error) {
			return apiclient.Register(ctx, nil, baseURL, payload)
		},
	}
}

func (r *Resolver) logf(format string, args ...any) {
	if r.Logf != nil {
		r.Logf(format, args...)
	}
}

func (r *Resolver) now() time.Time {
	if r.Now != nil {
		return r.Now()
	}
	return time.Now()
}

// Fingerprint binds persisted state to the registration token that produced it.
// Only the HASH is stored: the saved file must never become a second copy of
// the one-time token.
func Fingerprint(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// readSecret loads a JSON object, treating absence as "no file" and anything
// unparseable as an operator-visible error rather than an empty object — a
// truncated credentials file must not read as "not registered yet" and trigger
// a second registration.
func readSecret(file string) (map[string]any, error) {
	raw, err := os.ReadFile(file)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	var parsed map[string]any
	if err := json.Unmarshal(raw, &parsed); err != nil || parsed == nil {
		return nil, fmt.Errorf("Agent 凭据文件损坏，请恢复原凭据后重试（%s）", file)
	}
	return parsed, nil
}

func stringField(source map[string]any, key string) string {
	value, _ := source[key].(string)
	return strings.TrimSpace(value)
}

// resetJournal is the durable record of an archive in progress.
type resetJournal struct {
	Stamp int64    `json:"stamp"`
	Files []string `json:"files"`
}

// HasInterruptedReset reports a reset that did not finish. The read-only health
// path may only REPORT it; completing it is a write.
func (r *Resolver) HasInterruptedReset() bool {
	_, err := os.Stat(r.Config.ResetJournalPath())
	return err == nil
}

// archiveWithStamp renames each existing file aside under one shared stamp.
func (r *Resolver) archiveWithStamp(stamp int64, files []string) ([]string, error) {
	var archived []string
	for _, file := range files {
		source, err := filepath.Abs(file)
		if err != nil {
			return archived, err
		}
		if _, err := os.Lstat(source); err != nil {
			if errors.Is(err, os.ErrNotExist) {
				continue
			}
			return archived, err
		}
		target := fmt.Sprintf("%s.replaced.%d", source, stamp)
		if err := os.Rename(source, target); err != nil {
			return archived, err
		}
		archived = append(archived, target)
	}
	// Sync EVERY directory the reset covers, not only the ones renamed in this
	// pass. A resumed reset finds already-renamed sources missing, and if their
	// directory entry was never made durable, deleting the journal would leave a
	// rename that a power loss can still undo — with no journal left to recover
	// it. Credentials and database may live in different directories.
	seen := map[string]bool{}
	for _, file := range files {
		source, err := filepath.Abs(file)
		if err != nil {
			return archived, err
		}
		directory := filepath.Dir(source)
		if seen[directory] {
			continue
		}
		seen[directory] = true
		if _, err := os.Stat(directory); err != nil {
			continue
		}
		if err := durable.SyncDir(directory); err != nil {
			return archived, err
		}
	}
	return archived, nil
}

// archiveFiles journals the intent, archives, then clears the journal.
func (r *Resolver) archiveFiles(files []string) ([]string, error) {
	stamp := r.now().UnixMilli()
	// Journal BEFORE the first rename. A crash between renaming the credentials
	// and renaming the database would otherwise look like "no saved identity" on
	// the next boot — which skips the reset entirely and registers a NEW identity
	// on top of the old node's state.
	if err := durable.WriteSecret(r.Config.ResetJournalPath(), resetJournal{Stamp: stamp, Files: files}); err != nil {
		return nil, err
	}
	archived, err := r.archiveWithStamp(stamp, files)
	if err != nil {
		return archived, err
	}
	return archived, r.clearJournal()
}

func (r *Resolver) clearJournal() error {
	journal := r.Config.ResetJournalPath()
	if err := os.Remove(journal); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return durable.SyncDir(filepath.Dir(journal))
}

// ArchiveForeignState archives ONLY the runtime state, keeping the current
// credentials. This is the recovery for a state database that belongs to
// another node while the identity itself is current — a restored backup, a
// hand-copied data directory, a host re-onboarded by deleting only the
// credentials file. The identity reset cannot help there (the saved identity
// already matches the register token), so without this the node would be
// registered yet unable to start.
func (r *Resolver) ArchiveForeignState() ([]string, error) {
	return r.archiveFiles(r.Config.StateCandidates())
}

// finishInterruptedReset completes a partial archive before any identity or
// state is used.
func (r *Resolver) finishInterruptedReset() error {
	raw, err := os.ReadFile(r.Config.ResetJournalPath())
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	var journal resetJournal
	known := map[string]bool{}
	for _, candidate := range r.Config.ArchiveCandidates() {
		known[candidate] = true
	}
	if err := json.Unmarshal(raw, &journal); err != nil || journal.Stamp <= 0 || len(journal.Files) == 0 {
		return errors.New("Agent 重置日志损坏，请人工确认归档状态后删除该文件")
	}
	for _, file := range journal.Files {
		// Resume exactly the files that reset was archiving, and only files this
		// configuration owns: a state-only reset must not go on to archive the
		// credentials it deliberately kept, and a tampered journal must not be
		// able to rename arbitrary paths.
		if !known[file] {
			return errors.New("Agent 重置日志损坏，请人工确认归档状态后删除该文件")
		}
	}
	archived, err := r.archiveWithStamp(journal.Stamp, journal.Files)
	if err != nil {
		return err
	}
	if err := r.clearJournal(); err != nil {
		return err
	}
	if len(archived) == 0 {
		r.logf("[node-agent] 已补完上次中断的身份重置（无剩余文件）")
	} else {
		r.logf("[node-agent] 已补完上次中断的身份重置（%s）", strings.Join(archived, "、"))
	}
	return nil
}

// ReadExisting is the READ-ONLY lookup used by the health probe.
//
// Health checks are normally run by an operator as root, so this path must
// never register, generate or persist anything: a root-owned credentials file
// (or sqlite WAL) inside the service's data directory would be unreadable by
// the unprivileged service and break its next start, and a second generated
// secret would race the service's own registration. Returns nil when the host
// is simply not registered yet, and an error when the saved identity cannot be
// used as-is.
func (r *Resolver) ReadExisting() (*Credentials, error) {
	if r.HasInterruptedReset() {
		return nil, errors.New("上次身份重置未完成，服务启动时会先补完归档，健康检查不做任何写入")
	}
	if explicit, ok, err := r.explicitCredentials(); err != nil || ok {
		return explicit, err
	}
	saved, err := readSecret(r.Config.CredentialsPath)
	if err != nil || saved == nil {
		return nil, err
	}
	credentials, err := savedCredentials(saved)
	if err != nil {
		return nil, err
	}
	if r.Config.RegisterToken != "" &&
		stringField(saved, "registerTokenFingerprint") != Fingerprint(r.Config.RegisterToken) {
		return nil, errors.New("本机保存的 Agent 身份与当前注册令牌不匹配，服务无法启动，请先完成迁移或重置")
	}
	return credentials, nil
}

// explicitCredentials reports an operator-managed trio from the environment.
// A COMPLETE tuple is an explicit override, including rotation: no saved
// identity is read or overwritten while this source is set.
func (r *Resolver) explicitCredentials() (*Credentials, bool, error) {
	agentID, nodeID, token := r.Config.AgentID, r.Config.NodeID, r.Config.Token
	if agentID == "" && nodeID == "" && token == "" {
		return nil, false, nil
	}
	if agentID == "" || nodeID == "" || token == "" || r.Config.RegisterToken != "" {
		return nil, true, errors.New("环境凭据必须完整，且不能与注册令牌同时配置")
	}
	return &Credentials{AgentID: agentID, NodeID: nodeID, Token: token}, true, nil
}

func savedCredentials(saved map[string]any) (*Credentials, error) {
	credentials := &Credentials{
		AgentID: stringField(saved, "agentId"),
		NodeID:  stringField(saved, "nodeId"),
		Token:   stringField(saved, "token"),
	}
	if credentials.AgentID == "" || credentials.NodeID == "" || credentials.Token == "" {
		return nil, errors.New("Agent 凭据文件字段不完整")
	}
	return credentials, nil
}

// Resolve produces the identity the agent will run as, registering if needed.
func (r *Resolver) Resolve(ctx context.Context) (*Credentials, error) {
	// Before ANY identity is used or registered, including an operator-provided
	// one: a half-finished reset must not leave the old node's state in place.
	if err := r.finishInterruptedReset(); err != nil {
		return nil, err
	}
	if explicit, ok, err := r.explicitCredentials(); err != nil || ok {
		return explicit, err
	}

	fingerprint := ""
	if r.Config.RegisterToken != "" {
		fingerprint = Fingerprint(r.Config.RegisterToken)
	}

	saved, err := readSecret(r.Config.CredentialsPath)
	if err != nil {
		return nil, err
	}
	if saved != nil {
		credentials, err := savedCredentials(saved)
		if err != nil {
			return nil, err
		}
		if fingerprint != "" && stringField(saved, "registerTokenFingerprint") != fingerprint {
			// A registration token that did not produce this identity means the
			// host is being re-onboarded (node deleted/recreated, VPS repurposed)
			// on top of a stale identity. Silently keeping the old one leaves the
			// new node pending forever while retrying a possibly revoked
			// credential, so stop and require explicit consent.
			if !r.Config.ResetIdentity {
				return nil, fmt.Errorf(
					"本机已存在其他注册令牌签发的 Agent 身份（%s / 节点 %s），拒绝用新的注册令牌静默复用。"+
						"若确认要把本机重新接入为新节点：先在后台撤销旧节点的 Agent 凭据，"+
						"再以 CHORDV_AGENT_RESET_IDENTITY=1 启动一次（旧凭据会被改名保留为 %s.replaced.<时间戳>），"+
						"或停止服务后把 %s 一并移走再重启"+
						"（运行状态必须跟着身份一起移走：只删凭据会让新身份接管旧节点的状态库，导致注册成功却无法启动）",
					credentials.AgentID, credentials.NodeID, r.Config.CredentialsPath,
					strings.Join(r.Config.ArchiveCandidates(), "、"))
			}
			archived, err := r.archiveFiles(r.Config.ArchiveCandidates())
			if err != nil {
				return nil, err
			}
			r.logf("[node-agent] 已按 CHORDV_AGENT_RESET_IDENTITY 归档旧身份及运行状态（%s），将以新注册令牌重新接入",
				strings.Join(archived, "、"))
			saved = nil
		} else {
			return credentials, nil
		}
	}

	if r.Config.RegisterToken == "" {
		return nil, errors.New("无可用凭据：本地凭据文件缺失且未提供 CHORDV_REGISTER_TOKEN")
	}
	return r.register(ctx, fingerprint)
}

func (r *Resolver) register(ctx context.Context, fingerprint string) (*Credentials, error) {
	if err := version.Validate(); err != nil {
		return nil, err
	}
	pendingFile := r.Config.PendingCredentialsPath()
	pendingRaw, err := readSecret(pendingFile)
	if err != nil {
		return nil, err
	}
	if pendingRaw != nil && !agentTokenPattern.MatchString(stringField(pendingRaw, "agentToken")) {
		return nil, errors.New("Agent 待注册凭据文件损坏，请恢复原凭据后重试")
	}
	// Never carry a client secret across registration tokens: replaying it for
	// another node is exactly the cross-node credential reuse the control plane
	// rejects. Only a retry of the SAME token may reuse the persisted secret.
	agentToken := ""
	if pendingRaw != nil && stringField(pendingRaw, "registerTokenFingerprint") == fingerprint {
		agentToken = stringField(pendingRaw, "agentToken")
	}
	if agentToken == "" {
		if agentToken, err = apiclient.GenerateAgentToken(); err != nil {
			return nil, err
		}
	}
	// Re-persist on EVERY attempt: an earlier rename may be visible while its
	// directory entry is not yet durable, so holding the same bytes in memory is
	// not proof that they survived. This write must complete before the request
	// that spends the secret — that ordering is what makes a lost response
	// recoverable instead of node-bricking.
	if err := durable.WriteSecret(pendingFile, map[string]string{
		"agentToken":               agentToken,
		"registerTokenFingerprint": fingerprint,
	}); err != nil {
		return nil, err
	}
	r.logf("[node-agent] 待注册凭据已持久化，正在接入…")

	hostname, err := os.Hostname()
	if err != nil {
		return nil, err
	}
	bootID, err := uuid.NewV4()
	if err != nil {
		return nil, err
	}
	response, err := r.Register(ctx, r.Config.APIBaseURL, protocol.RegisterRequest{
		RegisterToken: r.Config.RegisterToken,
		AgentToken:    agentToken,
		Hostname:      hostname,
		Arch:          Arch(),
		AgentVersion:  version.Version,
		BootID:        bootID,
	})
	if err != nil {
		return nil, err
	}
	if !response.Accepted || strings.TrimSpace(response.AgentID) == "" || strings.TrimSpace(response.NodeID) == "" {
		return nil, errors.New("注册接口返回的 Agent 身份无效")
	}
	credentials := &Credentials{AgentID: response.AgentID, NodeID: response.NodeID, Token: agentToken}
	if err := durable.WriteSecret(r.Config.CredentialsPath, map[string]string{
		"agentId":                  credentials.AgentID,
		"nodeId":                   credentials.NodeID,
		"token":                    credentials.Token,
		"registerTokenFingerprint": fingerprint,
	}); err != nil {
		return nil, err
	}
	r.logf("[node-agent] 注册成功 agent=%s node=%s（凭据已持久化）", credentials.AgentID, credentials.NodeID)
	return credentials, nil
}

// Arch reports the value the control plane accepts for this build. The server
// validates against exactly two strings, so an unexpected GOARCH must map to
// the x64 default rather than send a value that fails registration outright.
func Arch() string {
	if runtime.GOOS == "linux" && runtime.GOARCH == "arm64" {
		return protocol.ArchARM64
	}
	return protocol.ArchAMD64
}
