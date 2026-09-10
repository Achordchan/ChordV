// Command chordv-agent is the ChordV node agent.
//
// It replaces apps/node-agent on a host by swapping the binary: every
// environment variable, every wire field and the systemd unit name are
// unchanged (see apps/agent/README.md).
//
// The real adapter is available, but P2-b control-plane onboarding must land
// before production migration. This binary never creates panel inbounds.
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

	// One context for the whole process. It is established BEFORE registration
	// so a Ctrl-C during a slow first boot stops at the network call instead of
	// being ignored until the loop starts.
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	adapter, err := xray.New(config.XrayAPIAddress, config.XrayInboundTag)
	if err != nil {
		return err
	}
	defer adapter.Close()
	// Validate read-only before registering or opening a writable database.
	if err := adapter.ValidateInbound(ctx); err != nil {
		return err
	}
	if err := adapter.Health(ctx); err != nil {
		return err
	}

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
		Xray: adapter,
		Commands: commands.New(commands.Deps{
			Store:                 state,
			Xray:                  adapter,
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
// Health checks the real API and target tag without adding a probe account.
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
	adapter, err := xray.New(config.XrayAPIAddress, config.XrayInboundTag)
	if err != nil {
		return fail(err.Error())
	}
	defer adapter.Close()
	if err := adapter.ValidateInbound(context.Background()); err != nil {
		return fail(err.Error())
	}
	if err := adapter.Health(context.Background()); err != nil {
		return fail(fmt.Sprintf("Xray 不可用：%v（本地状态：revision=%v 待上报批次=%v）",
			err, snapshot["configRevision"], snapshot["pendingBatches"]))
	}
	snapshot["ok"] = true
	report(snapshot)
	return true
}
