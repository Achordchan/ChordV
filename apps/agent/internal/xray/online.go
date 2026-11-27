package xray

import (
	"context"
	"fmt"
	"net"
	"strings"
	"sync"
	"time"

	"github.com/Achordchan/ChordV/apps/agent/internal/connkill"
	"github.com/xtls/xray-core/app/proxyman"
	handler "github.com/xtls/xray-core/app/proxyman/command"
	stats "github.com/xtls/xray-core/app/stats/command"
	xnet "github.com/xtls/xray-core/common/net"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/proto"
)

// OnlineReader exposes Xray's per-account online tracking (the
// `statsUserOnline` policy, on by default in 3x-ui). Adapters that cannot report
// it simply do not implement the interface.
type OnlineReader interface {
	// OnlineUsers maps the online accounts that include accepts to their number
	// of distinct source IPs. Counts are only fetched for accepted emails, so
	// unmanaged panel accounts cost nothing.
	OnlineUsers(ctx context.Context, include func(email string) bool) (map[string]int, error)
	// OnlineIPs lists the source IPs of one account's live connections. An
	// account Xray has never seen online yields an empty list, not an error.
	OnlineIPs(ctx context.Context, email string) ([]string, error)
	// SharedEmails reports which emails also exist on another inbound of this
	// Xray process. Online statistics are process-wide by email, so such an
	// email's online record cannot be attributed to the bound inbound.
	SharedEmails(ctx context.Context) (map[string]bool, error)
	// Listener is the bound inbound's local address and single port.
	Listener(ctx context.Context) (connkill.Listener, error)
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

// OnlineReadBudget bounds one whole OnlineUsers call; onlineReadWorkers bounds
// how many count requests run at once. The call runs under the runner's state
// lock, so it must stay short however many accounts are online.
const (
	OnlineReadBudget  = 5 * time.Second
	onlineReadWorkers = 8
)

func (g *GRPC) OnlineUsers(ctx context.Context, include func(email string) bool) (map[string]int, error) {
	ctx, cancel := context.WithTimeout(ctx, OnlineReadBudget)
	defer cancel()
	listCtx, listCancel := context.WithTimeout(ctx, CallTimeout)
	response, err := g.stats.GetAllOnlineUsers(listCtx, &stats.GetAllOnlineUsersRequest{})
	listCancel()
	if err != nil {
		return nil, fmt.Errorf("读取 Xray 在线账号: %w", err)
	}
	emails := make([]string, 0, len(response.GetUsers()))
	seen := map[string]bool{}
	for _, name := range response.GetUsers() {
		email, ok := emailFromOnlineName(name)
		if !ok {
			// Older cores returned bare emails; accept them as-is.
			email = name
		}
		if email == "" || seen[email] || (include != nil && !include(email)) {
			continue
		}
		seen[email] = true
		emails = append(emails, email)
	}
	type outcome struct {
		email string
		count int64
		err   error
	}
	jobs := make(chan string)
	results := make(chan outcome, len(emails))
	workers := onlineReadWorkers
	if len(emails) < workers {
		workers = len(emails)
	}
	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for email := range jobs {
				callCtx, callCancel := context.WithTimeout(ctx, CallTimeout)
				count, err := g.stats.GetStatsOnline(callCtx, &stats.GetStatsRequest{Name: onlineName(email)})
				callCancel()
				if status.Code(err) == codes.NotFound {
					results <- outcome{email: email}
					continue
				}
				results <- outcome{email: email, count: count.GetStat().GetValue(), err: err}
			}
		}()
	}
	go func() {
		defer close(jobs)
		for _, email := range emails {
			select {
			case jobs <- email:
			case <-ctx.Done():
				return
			}
		}
	}()
	wg.Wait()
	close(results)
	result := make(map[string]int, len(emails))
	received := 0
	for item := range results {
		received++
		if item.err != nil {
			return nil, fmt.Errorf("读取 Xray 在线账号 %q: %w", item.email, item.err)
		}
		if item.count > 0 {
			result[item.email] = int(item.count)
		}
	}
	if received != len(emails) {
		return nil, fmt.Errorf("读取 Xray 在线账号超时（%d/%d）", received, len(emails))
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

func (g *GRPC) Listener(ctx context.Context) (connkill.Listener, error) {
	if g.tag == "" {
		return connkill.Listener{}, fmt.Errorf("尚未绑定节点入站")
	}
	ctx, cancel := context.WithTimeout(ctx, CallTimeout)
	defer cancel()
	response, err := g.handler.ListInbounds(ctx, &handler.ListInboundsRequest{})
	if err != nil {
		return connkill.Listener{}, fmt.Errorf("读取 Xray 入站列表: %w", err)
	}
	for _, inbound := range response.GetInbounds() {
		if inbound.GetTag() != g.tag {
			continue
		}
		var receiver proxyman.ReceiverConfig
		if err := proto.Unmarshal(inbound.GetReceiverSettings().GetValue(), &receiver); err != nil {
			return connkill.Listener{}, fmt.Errorf("无法读取入站监听配置")
		}
		ranges := receiver.GetPortList().GetRange()
		if len(ranges) != 1 || ranges[0].From != ranges[0].To || ranges[0].From == 0 {
			return connkill.Listener{}, fmt.Errorf("入站不是单一监听端口")
		}
		ip, err := listenIP(receiver.GetListen())
		if err != nil {
			return connkill.Listener{}, err
		}
		return connkill.Listener{IP: ip, Port: int(ranges[0].From)}, nil
	}
	return connkill.Listener{}, fmt.Errorf("入站 %q 不存在", g.tag)
}

// listenIP reads the inbound's listen address: nil for every address, the IP
// for a specific one. A domain or Unix socket listener cannot be matched by
// address, so it is refused rather than widened to the port alone.
func listenIP(listen *xnet.IPOrDomain) (net.IP, error) {
	if listen == nil {
		return nil, nil
	}
	if raw := listen.GetIp(); len(raw) > 0 {
		ip := net.IP(raw)
		if len(raw) != net.IPv4len && len(raw) != net.IPv6len {
			return nil, fmt.Errorf("入站监听地址无法识别")
		}
		if ip.IsUnspecified() {
			return nil, nil
		}
		return ip, nil
	}
	if domain := listen.GetDomain(); domain != "" {
		return nil, fmt.Errorf("入站监听 %q 不是 IP 地址，无法按地址断开连接", domain)
	}
	return nil, nil
}

func (g *GRPC) SharedEmails(ctx context.Context) (map[string]bool, error) {
	ctx, cancel := context.WithTimeout(ctx, CallTimeout)
	defer cancel()
	others, err := g.otherInboundEmails(ctx)
	if err != nil {
		return nil, err
	}
	result := make(map[string]bool, len(others))
	for email := range others {
		result[email] = true
	}
	return result, nil
}
