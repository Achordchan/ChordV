package xray

import (
	"context"
	"encoding/hex"
	"errors"
	"github.com/Achordchan/ChordV/apps/agent/internal/connkill"
	xnet "github.com/xtls/xray-core/common/net"
	"io"
	"net"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/Achordchan/ChordV/apps/agent/internal/protocol"
	vin "github.com/xtls/xray-core/proxy/vless/inbound"
)

type recordingKiller struct {
	calls []killCall
	err   error
}

type killCall struct {
	listener connkill.Listener
	ips      []string
}

func (k *recordingKiller) Kill(_ context.Context, listener connkill.Listener, ips []string) (int, error) {
	k.calls = append(k.calls, killCall{listener: listener, ips: append([]string(nil), ips...)})
	return len(ips), k.err
}

// openVLESS opens a VLESS connection from 127.0.0.2 (Xray ignores 127.0.0.1 in
// its online tracking) to a target that keeps the connection open.
func openVLESS(t *testing.T, g *GRPC, uuid string) net.Conn {
	t.Helper()
	target, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { target.Close() })
	go func() {
		for {
			conn, err := target.Accept()
			if err != nil {
				return
			}
			go io.Copy(conn, conn)
		}
	}()
	listener, err := g.Listener(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	port := listener.Port
	dialer := net.Dialer{LocalAddr: &net.TCPAddr{IP: net.ParseIP("127.0.0.2")}, Timeout: 5 * time.Second}
	conn, err := dialer.Dial("tcp", net.JoinHostPort("127.0.0.1", itoa(port)))
	if err != nil {
		t.Skipf("cannot bind 127.0.0.2 on this host: %v", err)
	}
	t.Cleanup(func() { conn.Close() })
	conn.SetDeadline(time.Now().Add(5 * time.Second))
	id, _ := hex.DecodeString(strings.ReplaceAll(uuid, "-", ""))
	targetPort := target.Addr().(*net.TCPAddr).Port
	header := append([]byte{0}, id...)
	header = append(header, 0, 1, byte(targetPort>>8), byte(targetPort), 1, 127, 0, 0, 1)
	if _, err := conn.Write(append(header, []byte("hi")...)); err != nil {
		t.Fatal(err)
	}
	answer := make([]byte, 4)
	if _, err := io.ReadFull(conn, answer); err != nil {
		t.Fatal(err)
	}
	return conn
}

func itoa(value int) string { return strconv.Itoa(value) }

func waitOnline(t *testing.T, g *GRPC, email string, want int) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for {
		online, err := g.OnlineUsers(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		if online[email] == want {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("online = %v, want %s=%d", online, email, want)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestRealXrayOnlineTrackingAndDisconnectOnRemoval(t *testing.T) {
	g, _ := configuredPolicyServer(t, false, nil, &vin.Config{Decryption: "none"}, true)
	ctx := context.Background()
	user := protocol.DesiredUser{Email: "online@example.test", UUID: "d52ca32b-784a-4f4b-ab51-b8341884f213"}
	if err := g.EnsureUser(ctx, user, Expectation{Absent: true}); err != nil {
		t.Fatal(err)
	}
	if ips, err := g.OnlineIPs(ctx, user.Email); err != nil || len(ips) != 0 {
		t.Fatalf("never-online account: %v %v", ips, err)
	}
	openVLESS(t, g, user.UUID)
	waitOnline(t, g, user.Email, 1)
	ips, err := g.OnlineIPs(ctx, user.Email)
	if err != nil || len(ips) != 1 || ips[0] != "127.0.0.2" {
		t.Fatalf("online IPs: %v %v", ips, err)
	}

	killer := &recordingKiller{}
	binding := &Binding{GRPC: g}
	var logs []string
	binding.SetConnectionKiller(killer, func(format string, args ...any) { logs = append(logs, format) })
	if err := binding.RemoveUser(ctx, user.Email, Expectation{UUID: user.UUID}); err != nil {
		t.Fatal(err)
	}
	listener, _ := g.Listener(ctx)
	if !listener.IP.Equal(net.ParseIP("127.0.0.1")) {
		t.Fatalf("listener should carry the inbound's bound address: %+v", listener)
	}
	if len(killer.calls) != 1 || killer.calls[0].listener.Port != listener.Port || !killer.calls[0].listener.IP.Equal(listener.IP) || len(killer.calls[0].ips) != 1 || killer.calls[0].ips[0] != "127.0.0.2" {
		t.Fatalf("kill calls: %+v", killer.calls)
	}
	if users, _ := g.ListUsers(ctx); len(users) != 0 {
		t.Fatalf("account still installed: %+v", users)
	}
	if len(logs) != 1 {
		t.Fatalf("logs: %v", logs)
	}

	// Removing an account that is already gone still clears its lingering
	// connections — this is the agent restarting after a disable.
	if err := binding.RemoveUser(ctx, user.Email, Expectation{UUID: user.UUID}); err != nil {
		t.Fatal(err)
	}
	if len(killer.calls) != 2 {
		t.Fatalf("lingering connection not targeted: %+v", killer.calls)
	}
}

func TestBindingRemovalWithoutConnectionsOrKillerFailure(t *testing.T) {
	g, _ := configuredPolicyServer(t, false, nil, &vin.Config{Decryption: "none"}, true)
	ctx := context.Background()
	user := protocol.DesiredUser{Email: "idle@example.test", UUID: "d52ca32b-784a-4f4b-ab51-b8341884f213"}
	if err := g.EnsureUser(ctx, user, Expectation{Absent: true}); err != nil {
		t.Fatal(err)
	}
	killer := &recordingKiller{}
	binding := &Binding{GRPC: g}
	binding.SetConnectionKiller(killer, nil)
	if err := binding.RemoveUser(ctx, user.Email, Expectation{UUID: user.UUID}); err != nil {
		t.Fatal(err)
	}
	if len(killer.calls) != 0 {
		t.Fatalf("killer called without connections: %+v", killer.calls)
	}

	// A failing kill is logged, never turned into a failed removal.
	if err := g.EnsureUser(ctx, user, Expectation{Absent: true}); err != nil {
		t.Fatal(err)
	}
	openVLESS(t, g, user.UUID)
	waitOnline(t, g, user.Email, 1)
	killer.err = errors.New("operation not permitted")
	if err := binding.RemoveUser(ctx, user.Email, Expectation{UUID: user.UUID}); err != nil {
		t.Fatalf("kill failure leaked into removal: %v", err)
	}
	if len(killer.calls) != 1 {
		t.Fatalf("kill calls: %+v", killer.calls)
	}

	// A refused removal never reaches the killer.
	if err := g.EnsureUser(ctx, user, Expectation{Absent: true}); err != nil {
		t.Fatal(err)
	}
	if err := binding.RemoveUser(ctx, user.Email, Expectation{UUID: "11111111-1111-4111-8111-111111111111"}); err == nil {
		t.Fatal("identity mismatch accepted")
	}
	if len(killer.calls) != 1 {
		t.Fatalf("killer called after refused removal: %+v", killer.calls)
	}
}

func TestEmailFromOnlineName(t *testing.T) {
	if email, ok := emailFromOnlineName("user>>>a@b>>>online"); !ok || email != "a@b" {
		t.Fatalf("%q %v", email, ok)
	}
	for _, bad := range []string{"a@b", "user>>>>>>online", "user>>>a@b>>>traffic"} {
		if _, ok := emailFromOnlineName(bad); ok {
			t.Fatalf("accepted %q", bad)
		}
	}
}

func TestListenIP(t *testing.T) {
	if ip, err := listenIP(nil); ip != nil || err != nil {
		t.Fatalf("nil listen: %v %v", ip, err)
	}
	for _, wildcard := range []xnet.Address{xnet.AnyIP, xnet.AnyIPv6} {
		if ip, err := listenIP(xnet.NewIPOrDomain(wildcard)); ip != nil || err != nil {
			t.Fatalf("wildcard %v: %v %v", wildcard, ip, err)
		}
	}
	if ip, err := listenIP(xnet.NewIPOrDomain(xnet.ParseAddress("10.0.0.1"))); err != nil || !ip.Equal(net.ParseIP("10.0.0.1")) {
		t.Fatalf("specific: %v %v", ip, err)
	}
	if _, err := listenIP(xnet.NewIPOrDomain(xnet.DomainAddress("/run/xray.sock"))); err == nil {
		t.Fatal("a socket path listener must be refused, not widened to the port")
	}
}
