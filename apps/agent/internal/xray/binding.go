package xray

import (
	"context"
	"fmt"

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
	return b.GRPC.EnsureUser(ctx, user, expect)
}
func (b *Binding) RemoveUser(ctx context.Context, email string, expect Expectation) error {
	if !b.InboundReady() {
		return fmt.Errorf("等待绑定节点入站，禁止修改账号")
	}
	return b.GRPC.RemoveUser(ctx, email, expect)
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
