// Package connkill closes the established TCP connections a removed account
// still holds.
//
// Xray authenticates a VLESS account only during the handshake. Removing the
// account over gRPC stops NEW connections, but every connection already
// established keeps working until the client reconnects — a disabled or
// expired user can stay online for hours. xray-core has no "kick user" call, and
// restarting Xray would drop every account this agent installed over gRPC (they
// live only in memory) until the next reconcile.
//
// So the agent asks the kernel to destroy the sockets instead (SOCK_DESTROY,
// the same mechanism as `ss -K`), narrowed to the inbound's listening port and
// the source IPs Xray reports for that account. The cost is bounded: another
// account behind the very same public IP on the same port loses its current
// connections once and reconnects immediately.
//
// SOCK_DESTROY needs CAP_NET_ADMIN and a kernel built with
// CONFIG_INET_DIAG_DESTROY. Without either the kill fails and the caller only
// logs it: removal itself has already succeeded.
package connkill

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// Timeout bounds one whole Kill call, every source IP included. It runs under
// the agent's state lock.
const Timeout = 3 * time.Second

// MaxIPs caps how many source addresses one removal may target. An account
// reporting more than this is not a household; refusing keeps a bad counter
// from turning into a node-wide disconnect.
const MaxIPs = 64

// ErrUnavailable means no ss binary was found on this host.
var ErrUnavailable = errors.New("未找到 ss（iproute2），无法断开已建立连接")

// Killer destroys established connections from the given source IPs to the
// given local port. It reports how many sockets were destroyed.
type Killer interface {
	Kill(ctx context.Context, port int, ips []string) (int, error)
}

// SS drives iproute2's `ss -K`.
type SS struct{ Path string }

var candidates = []string{"/usr/bin/ss", "/bin/ss", "/usr/sbin/ss", "/sbin/ss"}

// Find locates ss at a fixed system path; PATH is not consulted.
func Find() (*SS, error) {
	for _, path := range candidates {
		if info, err := os.Stat(path); err == nil && info.Mode().IsRegular() {
			return &SS{Path: path}, nil
		}
	}
	return nil, ErrUnavailable
}

// NormalizeIP turns an address as Xray prints it ("1.2.3.4", "[2001:db8::1]")
// into a canonical IP string, rejecting anything else.
func NormalizeIP(value string) (net.IP, error) {
	trimmed := strings.TrimSuffix(strings.TrimPrefix(strings.TrimSpace(value), "["), "]")
	ip := net.ParseIP(trimmed)
	if ip == nil {
		return nil, fmt.Errorf("来源地址 %q 不是 IP", value)
	}
	return ip, nil
}

// Filter builds the ss filter tokens for one source IP. An IPv4 client on a
// dual-stack listener appears as ::ffff:a.b.c.d, so IPv4 matches both forms.
func Filter(port int, ip net.IP) []string {
	tokens := []string{"(", "sport", "=", ":" + strconv.Itoa(port), ")", "and", "("}
	if v4 := ip.To4(); v4 != nil {
		tokens = append(tokens, "dst", v4.String(), "or", "dst", "[::ffff:"+v4.String()+"]")
	} else {
		tokens = append(tokens, "dst", "["+ip.String()+"]")
	}
	return append(tokens, ")")
}

func (s *SS) Kill(ctx context.Context, port int, ips []string) (int, error) {
	if port < 1 || port > 65535 {
		return 0, fmt.Errorf("监听端口 %d 非法", port)
	}
	if len(ips) > MaxIPs {
		return 0, fmt.Errorf("来源地址 %d 个，超过上限 %d，拒绝断开", len(ips), MaxIPs)
	}
	ctx, cancel := context.WithTimeout(ctx, Timeout)
	defer cancel()
	seen := map[string]bool{}
	total := 0
	var failures []string
	for _, raw := range ips {
		if ctx.Err() != nil {
			failures = append(failures, "断开超时，剩余来源未处理")
			break
		}
		ip, err := NormalizeIP(raw)
		if err != nil {
			failures = append(failures, err.Error())
			continue
		}
		if ip.IsLoopback() || ip.IsUnspecified() || seen[ip.String()] {
			continue
		}
		seen[ip.String()] = true
		killed, err := s.killOne(ctx, port, ip)
		total += killed
		if err != nil {
			failures = append(failures, err.Error())
		}
	}
	if len(failures) > 0 {
		return total, errors.New(strings.Join(failures, "；"))
	}
	return total, nil
}

func (s *SS) killOne(ctx context.Context, port int, ip net.IP) (int, error) {
	args := append([]string{"-K", "-H", "-t", "-n", "state", "established"}, Filter(port, ip)...)
	command := exec.CommandContext(ctx, s.Path, args...)
	command.Env = []string{"LANG=C", "LC_ALL=C"}
	// After the deadline kills ss, do not keep waiting on a pipe some
	// descendant still holds open.
	command.WaitDelay = 500 * time.Millisecond
	var stdout, stderr bytes.Buffer
	command.Stdout, command.Stderr = &stdout, &stderr
	err := command.Run()
	message := strings.TrimSpace(stderr.String())
	// ss reports a refused SOCK_DESTROY on stderr and may still exit 0.
	if lower := strings.ToLower(message); strings.Contains(lower, "not permitted") || strings.Contains(lower, "not supported") {
		return 0, fmt.Errorf("断开 %s 的连接被拒绝（需要 CAP_NET_ADMIN 与内核 SOCK_DESTROY 支持）：%s", ip, message)
	}
	if err != nil {
		if message == "" {
			message = err.Error()
		}
		return 0, fmt.Errorf("断开 %s 的连接失败：%s", ip, message)
	}
	return CountSockets(stdout.String()), nil
}

// CountSockets counts the socket lines ss printed (-H: no header).
func CountSockets(output string) int {
	count := 0
	for _, line := range strings.Split(output, "\n") {
		if strings.TrimSpace(line) != "" {
			count++
		}
	}
	return count
}
