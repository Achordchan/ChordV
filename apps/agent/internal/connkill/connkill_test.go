package connkill

import (
	"context"
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
	got := Filter(443, ip)
	want := []string{"(", "sport", "=", ":443", ")", "and", "(", "dst", "180.124.1.2", "or", "dst", "[::ffff:180.124.1.2]", ")"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Filter = %v", got)
	}
	ip6, _ := NormalizeIP("[2001:db8::1]")
	if got := strings.Join(Filter(8443, ip6), " "); got != "( sport = :8443 ) and ( dst [2001:db8::1] )" {
		t.Fatalf("Filter v6 = %q", got)
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
	killed, err := ss.Kill(context.Background(), 443, []string{"180.124.1.2", "180.124.1.2", "127.0.0.1"})
	if err != nil || killed != 2 {
		t.Fatalf("Kill = %d, %v", killed, err)
	}
	calls, _ := os.ReadFile(log)
	if lines := strings.Count(string(calls), "\n"); lines != 1 {
		t.Fatalf("ss ran %d times: %s", lines, calls)
	}
	if !strings.HasPrefix(string(calls), "-K -H -t -n state established ( sport = :443 )") {
		t.Fatalf("unexpected args: %s", calls)
	}
}

func TestKillReportsPermissionDenied(t *testing.T) {
	ss := fakeSS(t, `echo "SOCK_DESTROY answers: Operation not permitted" >&2`)
	if _, err := ss.Kill(context.Background(), 443, []string{"1.2.3.4"}); err == nil || !strings.Contains(err.Error(), "CAP_NET_ADMIN") {
		t.Fatalf("expected permission error, got %v", err)
	}
}

func TestKillRefusesTooManyAddresses(t *testing.T) {
	ss := fakeSS(t, "exit 0")
	ips := make([]string, MaxIPs+1)
	for i := range ips {
		ips[i] = "10.0.0.1"
	}
	if _, err := ss.Kill(context.Background(), 443, ips); err == nil {
		t.Fatal("expected refusal")
	}
	if _, err := ss.Kill(context.Background(), 0, []string{"1.2.3.4"}); err == nil {
		t.Fatal("expected port refusal")
	}
}

func TestKillIsBoundedAsAWhole(t *testing.T) {
	ss := fakeSS(t, "sleep 5")
	ips := []string{"10.0.0.1", "10.0.0.2", "10.0.0.3"}
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	started := time.Now()
	if _, err := ss.Kill(ctx, 443, ips); err == nil {
		t.Fatal("expected timeout error")
	}
	if elapsed := time.Since(started); elapsed > 2*time.Second {
		t.Fatalf("Kill took %v; the deadline must cover all addresses", elapsed)
	}
}
