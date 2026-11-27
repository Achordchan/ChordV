package xray

import (
	"context"
	"fmt"
	"strings"

	"github.com/Achordchan/ChordV/apps/agent/internal/connkill"
	"github.com/Achordchan/ChordV/apps/agent/internal/protocol"
	handler "github.com/xtls/xray-core/app/proxyman/command"
)

// BindingState travels with the node identity and unsettled usage database.
type BindingState interface {
	InboundBinding() (string, error)
	SaveInboundBinding(string) error
}

// Binding is serialized by the runner's state lock, just like its state store.
// The underlying connection stays immutable; selecting a tag creates a copy.
type Binding struct {
	*GRPC
	state BindingState
	// killer, when set, closes the connections an account still holds after it
	// is removed. See package connkill for why removal alone is not enough.
	killer connkill.Killer
	logf   func(string, ...any)
}

// SetConnectionKiller enables disconnecting removed accounts. logf receives
// the outcome of each attempt; a failed kill never fails the removal.
func (b *Binding) SetConnectionKiller(killer connkill.Killer, logf func(string, ...any)) {
	b.killer = killer
	b.logf = logf
}

func NewBinding(connection *GRPC, state BindingState) (*Binding, error) {
	tag, err := state.InboundBinding()
	if err != nil {
		return nil, err
	}
	if tag != "" {
		if !panelTagPattern.MatchString(tag) {
			return nil, fmt.Errorf("持久化入站 tag 无效")
		}
		if connection.tag != "" && connection.tag != tag {
			return nil, fmt.Errorf("环境入站 tag 与本机已绑定身份不一致")
		}
		copy := *connection
		copy.tag = tag
		connection = &copy
	}
	return &Binding{GRPC: connection, state: state}, nil
}

func (g *GRPC) ValidateEnvironment(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, CallTimeout)
	defer cancel()
	if _, err := g.handler.ListInbounds(ctx, &handler.ListInboundsRequest{}); err != nil {
		return fmt.Errorf("面板 HandlerService 不可用：%w", err)
	}
	return g.Health(ctx)
}

func (b *Binding) InboundReady() bool { return b.tag != "" }

func (b *Binding) Health(ctx context.Context) error {
	if !b.InboundReady() {
		return b.GRPC.ValidateEnvironment(ctx)
	}
	return b.GRPC.Health(ctx)
}

func (b *Binding) ValidatePanel(ctx context.Context, payload map[string]any) (map[string]any, error) {
	spec := make(map[string]any, len(payload))
	for key, value := range payload {
		spec[key] = value
	}
	tag := b.tag
	var err error
	if tag == "" {
		if payload["tagOverrideConfirmed"] == true {
			tag, _ = payload["inboundTag"].(string)
			if !panelTagPattern.MatchString(tag) {
				return nil, fmt.Errorf("入站 tag 无效")
			}
		} else {
			tag, err = b.GRPC.DiscoverPanelTag(ctx, spec)
			if err != nil {
				return nil, err
			}
		}
	} else if payload["tagOverrideConfirmed"] == true && payload["inboundTag"] != tag {
		return nil, fmt.Errorf("此 Agent 已绑定其他入站，禁止切换现有身份的计量目标")
	}
	spec["inboundTag"] = tag
	candidate := *b.GRPC
	candidate.tag = tag
	result, err := candidate.ValidatePanel(ctx, spec)
	if err != nil {
		return nil, err
	}
	// Persist before reporting success. A crash before command completion can
	// only replay validation against this same tag, never select another one.
	if err := b.state.SaveInboundBinding(tag); err != nil {
		return nil, err
	}
	b.GRPC = &candidate
	return result, nil
}

func (b *Binding) ListUsers(ctx context.Context) ([]LiveUser, error) {
	if !b.InboundReady() {
		return nil, fmt.Errorf("等待绑定节点入站")
	}
	return b.GRPC.ListUsers(ctx)
}
func (b *Binding) EnsureUser(ctx context.Context, user protocol.DesiredUser, expect Expectation) error {
	if !b.InboundReady() {
		return fmt.Errorf("等待绑定节点入站，禁止修改账号")
	}
	// Replacing an account's UUID removes and reinstalls it; sessions that
	// authenticated with the old credential would otherwise keep working.
	previous := b.installedUUID(ctx, user.Email)
	var before []string
	watch := false
	if previous != "" && !strings.EqualFold(previous, user.UUID) {
		before, watch = b.killTargets(ctx, user.Email)
	}
	if err := b.GRPC.EnsureUser(ctx, user, expect); err != nil {
		return err
	}
	if watch {
		if current := b.installedUUID(ctx, user.Email); current != "" && !strings.EqualFold(current, previous) {
			b.disconnect(ctx, user.Email, before)
		}
	}
	return nil
}
func (b *Binding) RemoveUser(ctx context.Context, email string, expect Expectation) error {
	if !b.InboundReady() {
		return fmt.Errorf("等待绑定节点入站，禁止修改账号")
	}
	before, watch := b.killTargets(ctx, email)
	if err := b.GRPC.RemoveUser(ctx, email, expect); err != nil {
		return err
	}
	if watch {
		b.disconnect(ctx, email, before)
	}
	return nil
}

// installedUUID is the UUID currently installed for email on the bound
// inbound, or "" when absent or unreadable. Only used to decide whether a
// credential is being replaced.
func (b *Binding) installedUUID(ctx context.Context, email string) string {
	if b.killer == nil {
		return ""
	}
	users, err := b.GRPC.ListUsers(ctx)
	if err != nil {
		return ""
	}
	for _, user := range users {
		if user.Email == email {
			return user.UUID
		}
	}
	return ""
}

// killTargets decides whether email's connections may be destroyed and reads
// its current source IPs. Xray's online statistics are process-wide, keyed by
// email only: if another inbound carries the same email, its IPs would be
// mixed in and an unrelated user could be disconnected, so the disconnect is
// skipped (removal still proceeds).
func (b *Binding) killTargets(ctx context.Context, email string) ([]string, bool) {
	if b.killer == nil {
		return nil, false
	}
	if err := b.GRPC.uniqueCounterEmails(ctx, []LiveUser{{Email: email}}); err != nil {
		b.log("账号 %s 的 email 无法确认在本机唯一，不断开其现有连接：%v", email, err)
		return nil, false
	}
	// Read before changing the account: the online entry outlives removal while
	// the connections do, but reading both sides costs nothing and covers a
	// connection that closes in between.
	before, _ := b.GRPC.OnlineIPs(ctx, email)
	return before, true
}

// disconnect destroys the removed account's established connections. It runs
// AFTER removal, so a client that reconnects is refused at the handshake.
func (b *Binding) disconnect(ctx context.Context, email string, before []string) {
	ips := map[string]bool{}
	for _, ip := range before {
		ips[ip] = true
	}
	after, err := b.GRPC.OnlineIPs(ctx, email)
	if err != nil {
		b.log("账号 %s 已移除，但读取其在线 IP 失败，未断开现有连接：%v", email, err)
	}
	for _, ip := range after {
		ips[ip] = true
	}
	if len(ips) == 0 {
		return
	}
	list := make([]string, 0, len(ips))
	for ip := range ips {
		list = append(list, ip)
	}
	listener, err := b.GRPC.Listener(ctx)
	if err != nil {
		b.log("账号 %s 已移除，但无法确定入站监听地址，未断开现有连接：%v", email, err)
		return
	}
	killed, err := b.killer.Kill(ctx, listener, list)
	if err != nil {
		b.log("账号 %s 已移除，断开现有连接未完全成功（已断开 %d 条，来源 %d 个）：%v", email, killed, len(list), err)
		return
	}
	b.log("账号 %s 已移除，已断开其现有连接 %d 条（来源 %d 个）", email, killed, len(list))
}

func (b *Binding) log(format string, args ...any) {
	if b.logf != nil {
		b.logf(format, args...)
	}
}
func (b *Binding) ReadAbsoluteCounters(ctx context.Context) ([]protocol.AbsoluteCounter, error) {
	if !b.InboundReady() {
		return nil, fmt.Errorf("等待绑定节点入站，尚未开始计量")
	}
	return b.GRPC.ReadAbsoluteCounters(ctx)
}

// InboundReady preserves the contract of existing adapters with a fixed tag.
func InboundReady(adapter Adapter) bool {
	if binding, ok := adapter.(interface{ InboundReady() bool }); ok {
		return binding.InboundReady()
	}
	return true
}
