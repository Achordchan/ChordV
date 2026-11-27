package xray

import (
	"context"
	"fmt"
	"strings"

	"github.com/xtls/xray-core/app/proxyman"
	handler "github.com/xtls/xray-core/app/proxyman/command"
	stats "github.com/xtls/xray-core/app/stats/command"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/proto"
)

// OnlineReader exposes Xray's per-account online tracking (the
// `statsUserOnline` policy, on by default in 3x-ui). Adapters that cannot report
// it simply do not implement the interface.
type OnlineReader interface {
	// OnlineUsers maps every account email with at least one live connection to
	// its number of distinct source IPs. It covers all inbounds; callers filter.
	OnlineUsers(ctx context.Context) (map[string]int, error)
	// OnlineIPs lists the source IPs of one account's live connections. An
	// account Xray has never seen online yields an empty list, not an error.
	OnlineIPs(ctx context.Context, email string) ([]string, error)
	// ListenPort is the bound inbound's single listening port.
	ListenPort(ctx context.Context) (int, error)
}

const (
	onlinePrefix = "user>>>"
	onlineSuffix = ">>>online"
)

func onlineName(email string) string { return onlinePrefix + email + onlineSuffix }

// emailFromOnlineName extracts the email from "user>>>EMAIL>>>online".
func emailFromOnlineName(name string) (string, bool) {
	if !strings.HasPrefix(name, onlinePrefix) || !strings.HasSuffix(name, onlineSuffix) {
		return "", false
	}
	email := name[len(onlinePrefix) : len(name)-len(onlineSuffix)]
	return email, email != ""
}

func (g *GRPC) OnlineUsers(ctx context.Context) (map[string]int, error) {
	ctx, cancel := context.WithTimeout(ctx, CallTimeout)
	defer cancel()
	response, err := g.stats.GetAllOnlineUsers(ctx, &stats.GetAllOnlineUsersRequest{})
	if err != nil {
		return nil, fmt.Errorf("读取 Xray 在线账号: %w", err)
	}
	result := make(map[string]int, len(response.GetUsers()))
	for _, name := range response.GetUsers() {
		email, ok := emailFromOnlineName(name)
		if !ok {
			// Older cores returned bare emails; accept them as-is.
			email = name
		}
		count, err := g.stats.GetStatsOnline(ctx, &stats.GetStatsRequest{Name: onlineName(email)})
		if status.Code(err) == codes.NotFound {
			continue
		}
		if err != nil {
			return nil, fmt.Errorf("读取 Xray 在线账号 %q: %w", email, err)
		}
		if value := count.GetStat().GetValue(); value > 0 {
			result[email] = int(value)
		}
	}
	return result, nil
}

func (g *GRPC) OnlineIPs(ctx context.Context, email string) ([]string, error) {
	ctx, cancel := context.WithTimeout(ctx, CallTimeout)
	defer cancel()
	response, err := g.stats.GetStatsOnlineIpList(ctx, &stats.GetStatsRequest{Name: onlineName(email)})
	if status.Code(err) == codes.NotFound {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("读取 Xray 账号 %q 的在线 IP: %w", email, err)
	}
	ips := make([]string, 0, len(response.GetIps()))
	for ip := range response.GetIps() {
		ips = append(ips, ip)
	}
	return ips, nil
}

func (g *GRPC) ListenPort(ctx context.Context) (int, error) {
	if g.tag == "" {
		return 0, fmt.Errorf("尚未绑定节点入站")
	}
	ctx, cancel := context.WithTimeout(ctx, CallTimeout)
	defer cancel()
	response, err := g.handler.ListInbounds(ctx, &handler.ListInboundsRequest{})
	if err != nil {
		return 0, fmt.Errorf("读取 Xray 入站列表: %w", err)
	}
	for _, inbound := range response.GetInbounds() {
		if inbound.GetTag() != g.tag {
			continue
		}
		var receiver proxyman.ReceiverConfig
		if err := proto.Unmarshal(inbound.GetReceiverSettings().GetValue(), &receiver); err != nil {
			return 0, fmt.Errorf("无法读取入站监听配置")
		}
		ranges := receiver.GetPortList().GetRange()
		if len(ranges) != 1 || ranges[0].From != ranges[0].To || ranges[0].From == 0 {
			return 0, fmt.Errorf("入站不是单一监听端口")
		}
		return int(ranges[0].From), nil
	}
	return 0, fmt.Errorf("入站 %q 不存在", g.tag)
}
