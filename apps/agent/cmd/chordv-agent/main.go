// Command chordv-agent is the ChordV node agent.
//
// It replaces apps/node-agent on a host by swapping the binary: every
// environment variable, every wire field and the systemd unit name are
// unchanged (see apps/agent/README.md).
//
// THIS BUILD CANNOT PROVISION ANYONE. The Xray gRPC adapter arrives in P2, so
// internal/xray.Unavailable is what gets wired in below and every call to it
// fails loudly. The agent registers, heartbeats (reporting xrayStatus=offline,
// which is the truth) and keeps its local state, which is what the protocol
// canary needs — but a node running it serves no traffic. main refuses to start
// without an explicit acknowledgement for exactly that reason.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"github.com/Achordchan/ChordV/apps/agent/internal/agentcfg"
	"github.com/Achordchan/ChordV/apps/agent/internal/apiclient"
	"github.com/Achordchan/ChordV/apps/agent/internal/commands"
	"github.com/Achordchan/ChordV/apps/agent/internal/credentials"
	"github.com/Achordchan/ChordV/apps/agent/internal/runner"
	"github.com/Achordchan/ChordV/apps/agent/internal/store"
	"github.com/Achordchan/ChordV/apps/agent/internal/uuid"
	"github.com/Achordchan/ChordV/apps/agent/internal/version"
	"github.com/Achordchan/ChordV/apps/agent/internal/xray"
)

// AcknowledgeNoXrayEnv is the operator's explicit consent to run a build that
// cannot talk to Xray at all.
//
// Without it this binary would be a trap: it registers, goes online, reports a
// plausible-looking heartbeat and serves nobody — the "在线但无法服务" state the
// PRD and the ENSURE_INBOUND refusal both warn about. The variable disappears
// with P2, together with the placeholder adapter.
const AcknowledgeNoXrayEnv = "AGENT_ALLOW_NO_XRAY"

func main() {
	health := flag.Bool("health", false, "只读健康检查，输出 JSON 后退出（以服务用户执行）")
	showVersion := flag.Bool("version", false, "打印版本号后退出")
	flag.Parse()

	if *showVersion {
		fmt.Println(version.Version)
		return
	}

	config, err := agentcfg.Load()
	if err != nil {
		if *health {
			_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"ok": false, "reason": err.Error()})
			os.Exit(1)
		}
		fail(err)
	}
	if *health {
		if !healthCheck(config) {
			os.Exit(1)
		}
		return
	}
	if err := serve(config); err != nil {
		fail(err)
	}
}

func fail(err error) {
	fmt.Fprintf(os.Stderr, "[node-agent] 启动失败：%v\n", err)
	os.Exit(1)
}

func logf(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "[node-agent] "+format+"\n", args...)
}

func serve(config *agentcfg.Config) error {
	// Checked before ANYTHING is registered or written. The control plane
	// requires a non-empty version on both register and heartbeat, so a binary
	// stamped with an empty version would otherwise mint an identity and then
	// fail every request it makes with it.
	if err := version.Validate(); err != nil {
		return err
	}
	if !truthy(os.Getenv(AcknowledgeNoXrayEnv)) {
		return fmt.Errorf(
			"本构建尚未包含 Xray gRPC 适配器（P2 提供）：节点会注册成功、心跳正常，但无法给任何用户下发配置。"+
				"若确认只是做协议联调，请以 %s=1 启动；正式节点请等待 P2 构建", AcknowledgeNoXrayEnv)
	}

	// One context for the whole process. It is established BEFORE registration
	// so a Ctrl-C during a slow first boot stops at the network call instead of
	// being ignored until the loop starts.
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	resolver := credentials.NewResolver(config)
	resolver.Logf = logf
	identity, err := resolver.Resolve(ctx)
	if err != nil {
		return err
	}

	bootID, err := uuid.NewV4()
	if err != nil {
		return err
	}
	state, err := openStore(config, resolver, identity, bootID)
	if err != nil {
		return err
	}
	defer state.Close()

	agent, err := runner.New(runner.Deps{
		Config: config,
		Store:  state,
		API: apiclient.New(apiclient.Options{
			BaseURL: config.APIBaseURL,
			Token:   identity.Token,
			AgentID: identity.AgentID,
			NodeID:  identity.NodeID,
		}),
		Xray: xray.Unavailable{},
		Commands: commands.New(commands.Deps{
			Store:                 state,
			Xray:                  xray.Unavailable{},
			RemoveUnknownUsers:    config.RemoveUnknownUsers,
			AdoptExistingAccounts: config.AdoptExistingAccounts,
			Logf:                  logf,
		}),
		BootID: bootID,
		Logf:   logf,
	})
	if err != nil {
		return err
	}

	logf("正在启动，node=%s boot=%s version=%s", identity.NodeID, bootID, version.Version)
	if config.RemoveUnknownUsers {
		logf("警告：AGENT_REMOVE_UNKNOWN_USERS 已开启，本节点会卸载 Xray 中不在下发集合里的账号——" +
			"入站若与 3x-ui 面板共用，面板自己的账号也会被删除")
	}
	if config.AdoptExistingAccounts {
		logf("警告：AGENT_ADOPT_EXISTING_ACCOUNTS 已开启，安装会接管同名的既有账号（仅用于从 Node 版迁移）")
	}
	if err := agent.Run(ctx); err != nil {
		return err
	}
	logf("已退出")
	return nil
}

// openStore opens the state database, archiving a foreign one when the operator
// has consented.
//
// A state database belongs to ONE node identity: it holds that node's users,
// command history and unsettled metering batches, so a new identity inheriting
// it would replay another node's accounting under its own credentials. That is
// why the refusal exists — and why the recovery archives rather than deletes.
func openStore(config *agentcfg.Config, resolver *credentials.Resolver, identity *credentials.Credentials, bootID string) (*store.Store, error) {
	options := store.Options{
		BootID:                  bootID,
		NodeID:                  identity.NodeID,
		DefaultOfflineAllowance: config.OfflineAllowanceBytes,
	}
	state, err := store.Open(config.DatabasePath, options)
	if err == nil {
		return state, nil
	}
	var foreign *store.ForeignStateError
	if !errors.As(err, &foreign) || !config.ResetIdentity {
		return nil, err
	}
	archived, err := resolver.ArchiveForeignState()
	if err != nil {
		return nil, err
	}
	logf("已按 CHORDV_AGENT_RESET_IDENTITY 归档不属于本节点的运行状态（%s）", strings.Join(archived, "、"))
	return store.Open(config.DatabasePath, options)
}

// healthCheck probes existing business state without registration or migration.\n// SQLite may maintain its shared segment; openReadOnly therefore requires the\n// service user and refuses a root probe against an unprivileged database.
//
// deploy/health-check.sh is normally run by an operator as root. Anything this
// path created under the data directory — a credentials file, a sqlite WAL —
// would be owned by root and leave the unprivileged service unable to start, and
// a second generated secret would race the service's own registration. So it
// reports the service's state rather than producing it.
//
// It reports ok:false in this build, always: the Xray adapter is the placeholder
// and its Health call is the last thing checked. That is not a bug in the probe.
func healthCheck(config *agentcfg.Config) bool {
	report := func(payload map[string]any) {
		encoded, err := json.Marshal(payload)
		if err != nil {
			fmt.Fprintf(os.Stderr, "[node-agent] 健康检查结果无法编码：%v\n", err)
			return
		}
		fmt.Println(string(encoded))
	}
	fail := func(reason string) bool {
		report(map[string]any{"ok": false, "reason": reason})
		return false
	}

	identity, err := credentials.NewResolver(config).ReadExisting()
	if err != nil {
		return fail(err.Error())
	}
	if identity == nil {
		return fail("未注册：本机尚无 Agent 凭据，服务尚未完成首次接入")
	}
	state, err := store.Open(config.DatabasePath, store.Options{
		BootID:                  "health-probe",
		NodeID:                  identity.NodeID,
		DefaultOfflineAllowance: config.OfflineAllowanceBytes,
		ReadOnly:                true,
	})
	if err != nil {
		return fail(fmt.Sprintf("本地状态库不可读（服务可能尚未启动过）：%v", err))
	}
	defer state.Close()

	snapshot, err := state.HealthSnapshot()
	if err != nil {
		return fail(err.Error())
	}
	// Xray last, so a failure here still leaves the store's numbers available in
	// the reason line an operator reads.
	if err := (xray.Unavailable{}).Health(context.Background()); err != nil {
		return fail(fmt.Sprintf("Xray 不可用：%v（本地状态：revision=%v 待上报批次=%v）",
			err, snapshot["configRevision"], snapshot["pendingBatches"]))
	}
	snapshot["ok"] = true
	report(snapshot)
	return true
}

func truthy(value string) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "1", "true", "yes":
		return true
	}
	return false
}
