package connkill

import (
	"context"
	"net"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestNormalizeIP(t *testing.T) {
	for input, want := range map[string]string{"1.2.3.4": "1.2.3.4", "[2001:db8::1]": "2001:db8::1", " 2001:db8::2 ": "2001:db8::2"} {
		ip, err := NormalizeIP(input)
		if err != nil || ip.String() != want {
			t.Fatalf("NormalizeIP(%q) = %v, %v", input, ip, err)
		}
	}
	for _, bad := range []string{"", "example.com", "1.2.3.4; rm -rf /", "1.2.3.4:443"} {
		if _, err := NormalizeIP(bad); err == nil {
			t.Fatalf("NormalizeIP(%q) accepted", bad)
		}
	}
}

func TestFilterCoversMappedIPv4(t *testing.T) {
	ip, _ := NormalizeIP("180.124.1.2")
	got := Filter(Listener{Port: 443}, ip)
	want := []string{"(", "sport", "=", ":443", ")", "and", "(", "dst", "180.124.1.2", "or", "dst", "[::ffff:180.124.1.2]", ")"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Filter = %v", got)
	}
	ip6, _ := NormalizeIP("[2001:db8::1]")
	if got := strings.Join(Filter(Listener{Port: 8443}, ip6), " "); got != "( sport = :8443 ) and ( dst [2001:db8::1] )" {
		t.Fatalf("Filter v6 = %q", got)
	}
}

// Two inbounds may share a port on different local addresses. A listener bound
// to one address must constrain the local address, so disabling an account on
// it never touches connections to the other inbound.
func TestFilterConstrainsTheListenAddress(t *testing.T) {
	client, _ := NormalizeIP("180.124.1.2")
	first := strings.Join(Filter(Listener{IP: net.ParseIP("10.0.0.1"), Port: 443}, client), " ")
	want := "( sport = :443 ) and ( src 10.0.0.1 or src [::ffff:10.0.0.1] ) and ( dst 180.124.1.2 or dst [::ffff:180.124.1.2] )"
	if first != want {
		t.Fatalf("Filter = %q", first)
	}
	second := strings.Join(Filter(Listener{IP: net.ParseIP("10.0.0.2"), Port: 443}, client), " ")
	if strings.Contains(second, "10.0.0.1") || !strings.Contains(second, "src 10.0.0.2") {
		t.Fatalf("second listener filter = %q", second)
	}
	v6 := strings.Join(Filter(Listener{IP: net.ParseIP("2001:db8::10"), Port: 443}, client), " ")
	if !strings.Contains(v6, "( src [2001:db8::10] )") {
		t.Fatalf("v6 listener filter = %q", v6)
	}
}

// The listen address reaches ss; an unspecified one widens to the port only.
func TestKillPassesTheListenAddressToSS(t *testing.T) {
	dir := t.TempDir()
	log := filepath.Join(dir, "calls")
	ss := fakeSS(t, `echo "$@" >> `+log)
	if _, err := ss.Kill(context.Background(), Listener{IP: net.ParseIP("10.0.0.1"), Port: 443}, []string{"180.124.1.2"}); err != nil {
		t.Fatal(err)
	}
	if _, err := ss.Kill(context.Background(), Listener{IP: net.IPv4zero, Port: 443}, []string{"180.124.1.2"}); err != nil {
		t.Fatal(err)
	}
	calls, _ := os.ReadFile(log)
	lines := strings.Split(strings.TrimSpace(string(calls)), "\n")
	if len(lines) != 2 || !strings.Contains(lines[0], "( src 10.0.0.1 or src [::ffff:10.0.0.1] )") || strings.Contains(lines[1], "src") {
		t.Fatalf("ss args: %q", lines)
	}
}

func fakeSS(t *testing.T, script string) *SS {
	t.Helper()
	path := filepath.Join(t.TempDir(), "ss")
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"+script), 0o755); err != nil {
		t.Fatal(err)
	}
	return &SS{Path: path}
}

func TestKillCountsAndDeduplicates(t *testing.T) {
	dir := t.TempDir()
	log := filepath.Join(dir, "calls")
	ss := fakeSS(t, `echo "$@" >> `+log+`
echo "ESTAB 0 0 [::ffff:10.0.0.1]:443 [::ffff:180.124.1.2]:5555"
echo "ESTAB 0 0 [::ffff:10.0.0.1]:443 [::ffff:180.124.1.2]:5556"
`)
	killed, err := ss.Kill(context.Background(), Listener{Port: 443}, []string{"180.124.1.2", "180.124.1.2", "127.0.0.1"})
	if err != nil || killed != 2 {
		t.Fatalf("Kill = %d, %v", killed, err)
	}
	calls, _ := os.ReadFile(log)
	if lines := strings.Count(string(calls), "\n"); lines != 1 {
		t.Fatalf("ss ran %d times: %s", lines, calls)
	}
	if !strings.HasPrefix(string(calls), "-K -H -t -n state established state close-wait state fin-wait-1 state fin-wait-2 ( sport = :443 )") {
		t.Fatalf("unexpected args: %s", calls)
	}
}

func TestKillReportsPermissionDenied(t *testing.T) {
	ss := fakeSS(t, `echo "SOCK_DESTROY answers: Operation not permitted" >&2`)
	if _, err := ss.Kill(context.Background(), Listener{Port: 443}, []string{"1.2.3.4"}); err == nil || !strings.Contains(err.Error(), "CAP_NET_ADMIN") {
		t.Fatalf("expected permission error, got %v", err)
	}
}

func TestKillRefusesTooManyAddresses(t *testing.T) {
	ss := fakeSS(t, "exit 0")
	ips := make([]string, MaxIPs+1)
	for i := range ips {
		ips[i] = "10.0.0.1"
	}
	if _, err := ss.Kill(context.Background(), Listener{Port: 443}, ips); err == nil {
		t.Fatal("expected refusal")
	}
	if _, err := ss.Kill(context.Background(), Listener{}, []string{"1.2.3.4"}); err == nil {
		t.Fatal("expected port refusal")
	}
}

func TestKillIsBoundedAsAWhole(t *testing.T) {
	ss := fakeSS(t, "sleep 5")
	ips := []string{"10.0.0.1", "10.0.0.2", "10.0.0.3"}
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	started := time.Now()
	if _, err := ss.Kill(ctx, Listener{Port: 443}, ips); err == nil {
		t.Fatal("expected timeout error")
	}
	if elapsed := time.Since(started); elapsed > 2*time.Second {
		t.Fatalf("Kill took %v; the deadline must cover all addresses", elapsed)
	}
}

// A client that half-closes after its request leaves the server socket in
// CLOSE_WAIT while the download continues. The real ss must find and destroy
// it. Skips where ss, CAP_NET_ADMIN or kernel SOCK_DESTROY support is missing.
func TestRealSSDestroysAHalfClosedTransfer(t *testing.T) {
	ss, err := Find()
	if err != nil {
		t.Skip(err)
	}
	server, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	accepted := make(chan net.Conn, 1)
	go func() {
		conn, err := server.Accept()
		if err == nil {
			accepted <- conn
		}
	}()
	dialer := net.Dialer{LocalAddr: &net.TCPAddr{IP: net.ParseIP("127.0.0.2")}, Timeout: 2 * time.Second}
	client, err := dialer.Dial("tcp", server.Addr().String())
	if err != nil {
		t.Skipf("cannot bind 127.0.0.2: %v", err)
	}
	defer client.Close()
	serverSide := <-accepted
	defer serverSide.Close()
	// Client sends its request and half-closes; the server keeps streaming.
	if err := client.(*net.TCPConn).CloseWrite(); err != nil {
		t.Fatal(err)
	}
	serverSide.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, err := serverSide.Read(make([]byte, 1)); err == nil {
		t.Fatal("expected EOF from the half-close")
	}
	if _, err := serverSide.Write([]byte("still downloading")); err != nil {
		t.Fatalf("half-closed transfer should still flow: %v", err)
	}
	listener := Listener{IP: net.ParseIP("127.0.0.1"), Port: server.Addr().(*net.TCPAddr).Port}
	killed, err := ss.killOne(context.Background(), listener, net.ParseIP("127.0.0.2"))
	if err != nil {
		t.Skipf("SOCK_DESTROY unavailable here: %v", err)
	}
	if killed != 1 {
		t.Fatalf("destroyed %d sockets, want the one CLOSE_WAIT socket", killed)
	}
	serverSide.SetWriteDeadline(time.Now().Add(2 * time.Second))
	var writeErr error
	for i := 0; i < 50 && writeErr == nil; i++ {
		_, writeErr = serverSide.Write([]byte("x"))
		time.Sleep(10 * time.Millisecond)
	}
	if writeErr == nil {
		t.Fatal("transfer kept flowing after destruction")
	}
}

func TestEffectiveHasNetAdmin(t *testing.T) {
	if !effectiveHasNetAdmin("Name:\tchordv-agent\nCapEff:\t0000000000001000\n") {
		t.Fatal("CAP_NET_ADMIN bit set")
	}
	if effectiveHasNetAdmin("CapEff:\t0000000000000000\n") || effectiveHasNetAdmin("CapEff:\tzz\n") || effectiveHasNetAdmin("") {
		t.Fatal("no capability")
	}
}
