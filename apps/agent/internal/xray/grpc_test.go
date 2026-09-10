package xray

import (
	"bytes"
	"context"
	"encoding/hex"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Achordchan/ChordV/apps/agent/internal/protocol"
	"github.com/xtls/xray-core/app/commander"
	"github.com/xtls/xray-core/app/dispatcher"
	"github.com/xtls/xray-core/app/policy"
	"github.com/xtls/xray-core/app/proxyman"
	handler "github.com/xtls/xray-core/app/proxyman/command"
	_ "github.com/xtls/xray-core/app/proxyman/inbound"
	_ "github.com/xtls/xray-core/app/proxyman/outbound"
	statsapp "github.com/xtls/xray-core/app/stats"
	stats "github.com/xtls/xray-core/app/stats/command"
	xnet "github.com/xtls/xray-core/common/net"
	xprotocol "github.com/xtls/xray-core/common/protocol"
	"github.com/xtls/xray-core/common/serial"
	"github.com/xtls/xray-core/core"
	fstats "github.com/xtls/xray-core/features/stats"
	"github.com/xtls/xray-core/proxy/freedom"
	"github.com/xtls/xray-core/proxy/vless"
	vin "github.com/xtls/xray-core/proxy/vless/inbound"
	_ "github.com/xtls/xray-core/transport/internet/tcp"
	"google.golang.org/grpc"
	"google.golang.org/protobuf/proto"
)

// The server uses upstream HandlerService, StatsService, and a real VLESS user
// manager, not a mock reproducing our assumptions. All sockets are local.
func realServer(t *testing.T, unix bool) (*GRPC, *core.Instance) {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := uint32(listener.Addr().(*net.TCPAddr).Port)
	listener.Close()
	instance, err := core.New(&core.Config{App: []*serial.TypedMessage{
		serial.ToTypedMessage(&policy.Config{Level: map[uint32]*policy.Policy{0: {Stats: &policy.Policy_Stats{UserUplink: true, UserDownlink: true}}}}),
		serial.ToTypedMessage(&dispatcher.Config{}), serial.ToTypedMessage(&proxyman.InboundConfig{}),
		serial.ToTypedMessage(&proxyman.OutboundConfig{}), serial.ToTypedMessage(&statsapp.Config{}),
	}, Outbound: []*core.OutboundHandlerConfig{{Tag: "direct", ProxySettings: serial.ToTypedMessage(&freedom.Config{})}}, Inbound: []*core.InboundHandlerConfig{{Tag: "inbound-test", ReceiverSettings: serial.ToTypedMessage(&proxyman.ReceiverConfig{
		Listen: xnet.NewIPOrDomain(xnet.LocalHostIP), PortList: &xnet.PortList{Range: []*xnet.PortRange{{From: port, To: port}}},
	}), ProxySettings: serial.ToTypedMessage(&vin.Config{Decryption: "none"})}}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { instance.Close() })
	if err := instance.Start(); err != nil {
		t.Fatal(err)
	}
	network, address := "tcp", "127.0.0.1:0"
	if unix {
		dir, err := os.MkdirTemp("", "x-")
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { os.RemoveAll(dir) })
		network, address = "unix", filepath.Join(dir, "api.sock")
	}
	listener, err = net.Listen(network, address)
	if err != nil {
		t.Fatal(err)
	}
	server := grpc.NewServer()
	for _, config := range []any{&handler.Config{}, &stats.Config{}} {
		object, err := core.CreateObject(instance, config)
		if err != nil {
			t.Fatal(err)
		}
		object.(commander.Service).Register(server)
	}
	go server.Serve(listener)
	t.Cleanup(func() { server.Stop(); listener.Close() })
	address = listener.Addr().String()
	if unix {
		address = "unix:" + address
	}
	client, err := New(address, "inbound-test")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { client.Close() })
	return client, instance
}

func TestRealXrayUserLifecycle(t *testing.T) {
	g, _ := realServer(t, false)
	ctx := context.Background()
	if err := g.Health(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := g.UptimeSeconds(ctx); err != nil {
		t.Fatal(err)
	}
	if err := g.ValidateInbound(ctx); err != nil {
		t.Fatal(err)
	}
	user := protocol.DesiredUser{Email: "owned@example.test", UUID: "d52ca32b-784a-4f4b-ab51-b8341884f213", Flow: protocol.FlowVision}
	if err := g.EnsureUser(ctx, user, Expectation{Absent: true}); err != nil {
		t.Fatal(err)
	}
	users, err := g.ListUsers(ctx)
	if err != nil || len(users) != 1 || users[0].UUID != user.UUID || users[0].Flow != user.Flow {
		t.Fatalf("users: %+v %v", users, err)
	}
	if err := g.EnsureUser(ctx, user, Expectation{UUID: user.UUID}); err != nil {
		t.Fatal(err)
	}
	user.Flow = ""
	if err := g.EnsureUser(ctx, user, Expectation{UUID: user.UUID}); err != nil {
		t.Fatal(err)
	}
	users, err = g.ListUsers(ctx)
	if err != nil || users[0].Flow != "" {
		t.Fatalf("flow not updated: %+v %v", users, err)
	}
	old := user.UUID
	user.UUID = "c27b65ce-e1f0-40ac-a8c0-2ad4d606bf64"
	if err := g.EnsureUser(ctx, user, Expectation{UUID: old}); err != nil {
		t.Fatal(err)
	}
	if err := g.RemoveUser(ctx, user.Email, Expectation{UUID: old}); err == nil {
		t.Fatal("stale claim removed rotated user")
	}
	if err := g.RemoveUser(ctx, user.Email, Expectation{UUID: user.UUID}); err != nil {
		t.Fatal(err)
	}
	if err := g.RemoveUser(ctx, user.Email, Expectation{UUID: user.UUID}); err != nil {
		t.Fatal("absent removal not idempotent", err)
	}
}

func TestRealXrayRejectsMissingTag(t *testing.T) {
	g, _ := realServer(t, false)
	g.tag = "does-not-exist"
	ctx := context.Background()
	if err := g.ValidateInbound(ctx); err == nil {
		t.Fatal("missing tag validated")
	}
	if _, err := g.ListUsers(ctx); err == nil {
		t.Fatal("missing tag listed successfully")
	}
	// Bypass adapter preflight to test Xray's actual AddUser behavior on bad tags.
	_, err := g.handler.AlterInbound(ctx, &handler.AlterInboundRequest{Tag: g.tag, Operation: serial.ToTypedMessage(&handler.AddUserOperation{User: &xprotocol.User{Email: "probe", Account: serial.ToTypedMessage(&vless.Account{Id: "d52ca32b-784a-4f4b-ab51-b8341884f213"})}})})
	if err == nil || !strings.Contains(err.Error(), g.tag) {
		t.Fatalf("upstream missing tag result: %v", err)
	}
}

func TestRealXrayCountersAreExactAndNeverReset(t *testing.T) {
	g, instance := realServer(t, false)
	ctx := context.Background()
	user := protocol.DesiredUser{Email: "owned@example.test", UUID: "d52ca32b-784a-4f4b-ab51-b8341884f213"}
	if err := g.EnsureUser(ctx, user, Expectation{Absent: true}); err != nil {
		t.Fatal(err)
	}
	manager := instance.GetFeature(fstats.ManagerType()).(fstats.Manager)
	counter, err := manager.RegisterCounter("user>>>" + user.Email + ">>>traffic>>>uplink")
	if err != nil {
		t.Fatal(err)
	}
	counter.Add(9007199254740993)
	foreign, err := manager.RegisterCounter("user>>>foreign@example.test>>>traffic>>>uplink")
	if err != nil {
		t.Fatal(err)
	}
	foreign.Add(7)
	for i := 0; i < 2; i++ {
		values, err := g.ReadAbsoluteCounters(ctx)
		if err != nil || len(values) != 1 || values[0].UplinkBytes != "9007199254740993" || values[0].DownlinkBytes != "0" {
			t.Fatalf("counters: %+v %v", values, err)
		}
	}
	if counter.Value() != 9007199254740993 {
		t.Fatal("stats read reset counter")
	}
	counter.Set(-1)
	if _, err := g.ReadAbsoluteCounters(ctx); err == nil {
		t.Fatal("negative counter accepted")
	}
}

func TestRealXraySocketAndCancellation(t *testing.T) {
	g, _ := realServer(t, true)
	if err := g.Health(context.Background()); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	before := time.Now()
	if err := g.Health(ctx); err == nil {
		t.Fatal("cancelled health succeeded")
	}
	if time.Since(before) > time.Second {
		t.Fatal("cancellation ignored")
	}
}

func TestLocalAddressValidation(t *testing.T) {
	for _, address := range []string{"example.com:10085", "0.0.0.0:10085", "127.0.0.1:0", "unix:relative.sock"} {
		if g, err := New(address, "inbound-test"); err == nil {
			g.Close()
			t.Fatalf("accepted %s", address)
		}
	}
}

func TestRealXrayRefusesConflictingExpectationsAndIdentityAliases(t *testing.T) {
	g, _ := realServer(t, false)
	ctx := context.Background()
	user := protocol.DesiredUser{Email: "panel@example.test", UUID: "d52ca32b-784a-4f4b-ab51-b8341884f213"}
	if err := g.EnsureUser(ctx, user, Expectation{Absent: true}); err != nil {
		t.Fatal(err)
	}
	if err := g.EnsureUser(ctx, user, Expectation{Absent: true}); err == nil {
		t.Fatal("no-op bypassed absent expectation")
	}
	if err := g.RemoveUser(ctx, user.Email, Expectation{Absent: true}); err == nil {
		t.Fatal("removed unexpected account")
	}
	if err := g.RemoveUser(ctx, "PANEL@example.test", Expectation{}); err == nil {
		t.Fatal("case alias removed account")
	}
	alias := user
	alias.Email = "other@example.test"
	if err := g.EnsureUser(ctx, alias, Expectation{Absent: true}); err == nil {
		t.Fatal("duplicate UUID overwrote login")
	}
	alias.UUID = "d52ca32b-784a-4141-ab51-b8341884f213" // Xray masks bytes 6 and 7
	if err := g.EnsureUser(ctx, alias, Expectation{Absent: true}); err == nil {
		t.Fatal("masked UUID alias overwrote login")
	}
	alias.UUID = "short-name"
	if err := g.EnsureUser(ctx, alias, Expectation{Absent: true}); err == nil {
		t.Fatal("non-UUID shorthand accepted")
	}
	live, err := g.ListUsers(ctx)
	if err != nil || len(live) != 1 || live[0].UUID != user.UUID {
		t.Fatalf("panel changed: %+v %v", live, err)
	}
}

func TestRealVLESSTrafficIsMetered(t *testing.T) {
	g, _ := realServer(t, false)
	ctx := context.Background()
	user := protocol.DesiredUser{Email: "traffic@example.test", UUID: "d52ca32b-784a-4f4b-ab51-b8341884f213"}
	if err := g.EnsureUser(ctx, user, Expectation{Absent: true}); err != nil {
		t.Fatal(err)
	}
	before, err := g.ReadAbsoluteCounters(ctx)
	if err != nil || len(before) != 1 || before[0].UplinkBytes != "0" {
		t.Fatalf("baseline: %+v %v", before, err)
	}
	echo, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer echo.Close()
	finished := make(chan error, 1)
	go func() {
		conn, err := echo.Accept()
		if err != nil {
			finished <- err
			return
		}
		defer conn.Close()
		conn.SetDeadline(time.Now().Add(5 * time.Second))
		payload := make([]byte, 5)
		if _, err = io.ReadFull(conn, payload); err == nil {
			_, err = conn.Write(payload)
		}
		finished <- err
	}()
	response, err := g.handler.ListInbounds(ctx, &handler.ListInboundsRequest{})
	if err != nil {
		t.Fatal(err)
	}
	var receiver proxyman.ReceiverConfig
	if err := proto.Unmarshal(response.Inbounds[0].ReceiverSettings.Value, &receiver); err != nil {
		t.Fatal(err)
	}
	conn, err := net.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", receiver.PortList.Range[0].From))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(5 * time.Second))
	id, _ := hex.DecodeString(strings.ReplaceAll(user.UUID, "-", ""))
	targetPort := echo.Addr().(*net.TCPAddr).Port
	header := append([]byte{0}, id...)
	header = append(header, 0, 1, byte(targetPort>>8), byte(targetPort), 1, 127, 0, 0, 1)
	if _, err := conn.Write(append(header, []byte("hello")...)); err != nil {
		t.Fatal(err)
	}
	answer := make([]byte, 7)
	if _, err := io.ReadFull(conn, answer); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(answer, []byte{0, 0, 'h', 'e', 'l', 'l', 'o'}) {
		t.Fatalf("VLESS reply: %x", answer)
	}
	if err := <-finished; err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		counters, err := g.ReadAbsoluteCounters(ctx)
		if err != nil || len(counters) != 1 || counters[0].UplinkBytes != "5" || counters[0].DownlinkBytes != "5" {
			t.Fatalf("actual traffic: %+v %v", counters, err)
		}
	}
}
