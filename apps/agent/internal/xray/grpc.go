package xray

import (
	"context"
	"fmt"
	"net"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/Achordchan/ChordV/apps/agent/internal/protocol"
	handler "github.com/xtls/xray-core/app/proxyman/command"
	stats "github.com/xtls/xray-core/app/stats/command"
	xprotocol "github.com/xtls/xray-core/common/protocol"
	"github.com/xtls/xray-core/common/serial"
	"github.com/xtls/xray-core/common/uuid"
	"github.com/xtls/xray-core/proxy/vless"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/protobuf/proto"
)

const CallTimeout = 5 * time.Second

// GRPC talks only to the configured loopback/socket API. It never creates or
// removes inbounds. Close it after the runner and health probe have finished.
type GRPC struct {
	conn    *grpc.ClientConn
	handler handler.HandlerServiceClient
	stats   stats.StatsServiceClient
	tag     string
}

func New(address, tag string) (*GRPC, error) {
	if strings.TrimSpace(tag) == "" {
		return nil, fmt.Errorf("XRAY_INBOUND_TAG 不能为空")
	}
	network, target := "tcp", address
	if strings.HasPrefix(strings.ToLower(address), "unix:") {
		network, target = "unix", strings.TrimPrefix(address[5:], "//")
		if !filepath.IsAbs(target) {
			return nil, fmt.Errorf("Xray Unix socket 必须是绝对路径")
		}
	} else {
		host, port, err := net.SplitHostPort(address)
		if err != nil {
			return nil, fmt.Errorf("Xray API 地址非法: %w", err)
		}
		// Do not resolve localhost through DNS: the unauthenticated API must stay local.
		if strings.EqualFold(host, "localhost") {
			host = "127.0.0.1"
		}
		if host != "127.0.0.1" && host != "::1" {
			return nil, fmt.Errorf("Xray API 必须是 loopback 地址")
		}
		number, err := strconv.Atoi(port)
		if err != nil || number < 1 || number > 65535 {
			return nil, fmt.Errorf("Xray API 端口非法")
		}
		target = net.JoinHostPort(host, port)
	}
	conn, err := grpc.NewClient("passthrough:///xray-local", grpc.WithTransportCredentials(insecure.NewCredentials()),
		grpc.WithContextDialer(func(ctx context.Context, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, network, target)
		}))
	if err != nil {
		return nil, err
	}
	return &GRPC{conn: conn, handler: handler.NewHandlerServiceClient(conn), stats: stats.NewStatsServiceClient(conn), tag: tag}, nil
}

func (g *GRPC) Close() error                     { return g.conn.Close() }
func (g *GRPC) Health(ctx context.Context) error { _, err := g.UptimeSeconds(ctx); return err }
func (g *GRPC) UptimeSeconds(ctx context.Context) (int64, error) {
	ctx, cancel := context.WithTimeout(ctx, CallTimeout)
	defer cancel()
	response, err := g.stats.GetSysStats(ctx, &stats.SysStatsRequest{})
	if err != nil {
		return 0, fmt.Errorf("Xray StatsService: %w", err)
	}
	return int64(response.GetUptime()), nil
}

// ValidateInbound is read-only and rejects missing tags and non-VLESS accounts.
// An empty inbound is validated by inspecting its proxy config, not by creating
// a probe user. A valid but wrong tag still requires P2-b's port/tag binding.
func (g *GRPC) ValidateInbound(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, CallTimeout)
	defer cancel()
	response, err := g.handler.ListInbounds(ctx, &handler.ListInboundsRequest{})
	if err != nil {
		return fmt.Errorf("校验 Xray 入站 %q: %w", g.tag, err)
	}
	for _, in := range response.GetInbounds() {
		if in.GetTag() != g.tag {
			continue
		}
		if in.GetProxySettings().GetType() != "xray.proxy.vless.inbound.Config" {
			return fmt.Errorf("Xray 入站 %q 不是 VLESS", g.tag)
		}
		_, err := g.ListUsers(ctx)
		return err
	}
	return fmt.Errorf("Xray 入站 tag %q 不存在，请核对面板入站端口与 tag", g.tag)
}

func (g *GRPC) ListUsers(ctx context.Context) ([]LiveUser, error) {
	ctx, cancel := context.WithTimeout(ctx, CallTimeout)
	defer cancel()
	response, err := g.handler.GetInboundUsers(ctx, &handler.GetInboundUserRequest{Tag: g.tag})
	if err != nil {
		return nil, fmt.Errorf("读取 Xray 入站 %q 用户: %w", g.tag, err)
	}
	users := make([]LiveUser, 0, len(response.GetUsers()))
	for _, user := range response.GetUsers() {
		account := user.GetAccount()
		if account == nil || account.GetType() != "xray.proxy.vless.Account" {
			return nil, fmt.Errorf("入站 %q 包含非 VLESS 账号", g.tag)
		}
		var decoded vless.Account
		if err := proto.Unmarshal(account.GetValue(), &decoded); err != nil {
			return nil, fmt.Errorf("解析 VLESS 账号: %w", err)
		}
		id, err := uuid.ParseString(decoded.Id)
		if err != nil {
			return nil, fmt.Errorf("入站 %q 返回无效 UUID", g.tag)
		}
		users = append(users, LiveUser{Email: user.GetEmail(), UUID: id.String(), Flow: decoded.Flow})
	}
	sort.Slice(users, func(i, j int) bool { return users[i].Email < users[j].Email })
	return users, nil
}

// Xray matches emails case-insensitively. Never regard a case-only spelling as
// absence; refuse mutation instead of handing another spelling to its remover.
func (g *GRPC) observed(ctx context.Context, email string, expect Expectation) (*LiveUser, error) {
	users, err := g.ListUsers(ctx)
	if err != nil {
		return nil, err
	}
	for _, user := range users {
		if !strings.EqualFold(email, user.Email) {
			continue
		}
		if email != user.Email {
			return nil, fmt.Errorf("账号 %q 与 Xray 既有 email 大小写冲突", email)
		}
		if expect.Absent || (expect.UUID != "" && !strings.EqualFold(expect.UUID, user.UUID)) {
			return nil, fmt.Errorf("账号 %q 身份已变化，拒绝修改", email)
		}
		return &user, nil
	}
	return nil, nil
}

func (g *GRPC) EnsureUser(ctx context.Context, user protocol.DesiredUser, expect Expectation) error {
	ctx, cancel := context.WithTimeout(ctx, CallTimeout)
	defer cancel()
	if user.Email == "" {
		return fmt.Errorf("安装用户缺少 email")
	}
	id, err := canonicalUUID(user.UUID)
	if err != nil {
		return fmt.Errorf("安装用户 UUID 非法: %w", err)
	}
	if user.Flow != protocol.FlowNone && user.Flow != protocol.FlowVision {
		return fmt.Errorf("不支持的 VLESS flow")
	}
	existing, err := g.observed(ctx, user.Email, expect)
	if err != nil {
		return err
	}
	// Xray's VLESS validator keys UUIDs independently of email (and masks two
	// UUID bytes). Reusing that key can silently replace another user's login.
	if err := g.uniqueIdentity(ctx, user.Email, id); err != nil {
		return err
	}
	if existing != nil {
		if existing.UUID == id.String() && existing.Flow == user.Flow {
			return nil
		}
		if err := g.RemoveUser(ctx, user.Email, Expectation{UUID: existing.UUID}); err != nil {
			return err
		}
	}
	// Re-read after the remove/add gap. There is no server-side CAS; a panel
	// write after this reading remains a deployment-level race (PRD §10).
	if _, err := g.observed(ctx, user.Email, Expectation{Absent: true}); err != nil {
		return err
	}
	_, err = g.handler.AlterInbound(ctx, &handler.AlterInboundRequest{Tag: g.tag, Operation: serial.ToTypedMessage(&handler.AddUserOperation{
		User: &xprotocol.User{Email: user.Email, Level: 0, Account: serial.ToTypedMessage(&vless.Account{Id: id.String(), Flow: user.Flow})},
	})})
	if err != nil {
		return fmt.Errorf("安装 Xray 用户 %q: %w", user.Email, err)
	}
	return nil
}

func (g *GRPC) RemoveUser(ctx context.Context, email string, expect Expectation) error {
	ctx, cancel := context.WithTimeout(ctx, CallTimeout)
	defer cancel()
	if email == "" {
		return fmt.Errorf("卸载用户缺少 email")
	}
	existing, err := g.observed(ctx, email, expect)
	if err != nil {
		return err
	}
	if existing == nil {
		return nil
	}
	_, err = g.handler.AlterInbound(ctx, &handler.AlterInboundRequest{Tag: g.tag, Operation: serial.ToTypedMessage(&handler.RemoveUserOperation{Email: email})})
	if err != nil {
		return fmt.Errorf("卸载 Xray 用户 %q: %w", email, err)
	}
	return nil
}

func (g *GRPC) ReadAbsoluteCounters(ctx context.Context) ([]protocol.AbsoluteCounter, error) {
	ctx, cancel := context.WithTimeout(ctx, CallTimeout)
	defer cancel()
	users, err := g.ListUsers(ctx)
	if err != nil {
		return nil, err
	}
	response, err := g.stats.QueryStats(ctx, &stats.QueryStatsRequest{Pattern: "user>>>", Reset_: false})
	if err != nil {
		return nil, fmt.Errorf("读取 Xray 计数: %w", err)
	}
	values := make(map[string]int64, len(response.GetStat()))
	for _, stat := range response.GetStat() {
		if stat.GetValue() < 0 {
			return nil, fmt.Errorf("Xray 计数为负，拒绝入账: %q", stat.GetName())
		}
		if _, exists := values[stat.GetName()]; exists {
			return nil, fmt.Errorf("Xray 重复统计项: %q", stat.GetName())
		}
		values[stat.GetName()] = stat.GetValue()
	}
	result := make([]protocol.AbsoluteCounter, 0, len(users))
	for _, user := range users {
		if user.Email == "" {
			continue
		}
		// Xray registers counters lazily on first use. Missing means zero for a
		// confirmed live account, preserving the initial baseline before traffic.
		prefix := "user>>>" + user.Email + ">>>traffic>>>"
		result = append(result, protocol.AbsoluteCounter{Email: user.Email, UplinkBytes: strconv.FormatInt(values[prefix+"uplink"], 10), DownlinkBytes: strconv.FormatInt(values[prefix+"downlink"], 10)})
	}
	return result, nil
}

func canonicalUUID(value string) (uuid.UUID, error) {
	id, err := uuid.ParseString(value)
	if err != nil || len(value) != 36 || !strings.EqualFold(value, id.String()) {
		return uuid.UUID{}, fmt.Errorf("要求规范的 36 字符 UUID")
	}
	return id, nil
}

func (g *GRPC) uniqueIdentity(ctx context.Context, email string, id uuid.UUID) error {
	users, err := g.ListUsers(ctx)
	if err != nil {
		return err
	}
	key := vless.ProcessUUID(id)
	for _, other := range users {
		if other.Email == email {
			continue
		}
		otherID, err := canonicalUUID(other.UUID)
		if err != nil {
			return err
		}
		if vless.ProcessUUID(otherID) == key {
			return fmt.Errorf("UUID 与入站中另一个账号冲突，拒绝安装")
		}
	}
	return nil
}
