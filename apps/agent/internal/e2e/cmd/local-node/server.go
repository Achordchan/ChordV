//go:build e2e

package main

import (
	"crypto/ecdh"
	"crypto/rand"
	"crypto/tls"
	"encoding/base64"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"

	adapter "github.com/Achordchan/ChordV/apps/agent/internal/xray"
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
	"github.com/xtls/xray-core/common/serial"
	"github.com/xtls/xray-core/core"
	"github.com/xtls/xray-core/proxy/freedom"
	vin "github.com/xtls/xray-core/proxy/vless/inbound"
	"github.com/xtls/xray-core/transport/internet"
	"github.com/xtls/xray-core/transport/internet/reality"
	_ "github.com/xtls/xray-core/transport/internet/tcp"
	"google.golang.org/grpc"
)

const inboundTag = "e2e-reality"

type localNode struct {
	core    *core.Instance
	api     *adapter.GRPC
	grpc    *grpc.Server
	control net.Listener
	echo    net.Listener
	target  *httptest.Server
	public  map[string]any
}

func (n *localNode) close() {
	if n.api != nil {
		n.api.Close()
	}
	if n.grpc != nil {
		n.grpc.Stop()
	}
	if n.control != nil {
		n.control.Close()
	}
	if n.core != nil {
		n.core.Close()
	}
	if n.echo != nil {
		n.echo.Close()
	}
	if n.target != nil {
		n.target.Close()
	}
}

func startNode() (_ *localNode, err error) {
	n := &localNode{}
	defer func() {
		if err != nil {
			n.close()
		}
	}()
	// This TLS destination is local and speaks TLS 1.3/H2, as Reality requires.
	n.target = httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(204) }))
	n.target.EnableHTTP2 = true
	n.target.TLS = &tls.Config{MinVersion: tls.VersionTLS13}
	n.target.Config.ErrorLog = log.New(io.Discard, "", 0)
	n.target.StartTLS()
	key, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	portHolder, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	port := uint32(portHolder.Addr().(*net.TCPAddr).Port)
	portHolder.Close()
	security := serial.ToTypedMessage(&reality.Config{Dest: n.target.Listener.Addr().String(), Type: "tcp", PrivateKey: key.Bytes(), ServerNames: []string{"example.com"}, ShortIds: [][]byte{{1, 2, 3, 4, 5, 6, 7, 8}}})
	n.core, err = core.New(&core.Config{App: []*serial.TypedMessage{
		serial.ToTypedMessage(&policy.Config{Level: map[uint32]*policy.Policy{0: {Stats: &policy.Policy_Stats{UserUplink: true, UserDownlink: true}}}}),
		serial.ToTypedMessage(&dispatcher.Config{}), serial.ToTypedMessage(&proxyman.InboundConfig{}),
		serial.ToTypedMessage(&proxyman.OutboundConfig{}), serial.ToTypedMessage(&statsapp.Config{}),
	}, Outbound: []*core.OutboundHandlerConfig{{Tag: "direct", ProxySettings: serial.ToTypedMessage(&freedom.Config{})}},
		Inbound: []*core.InboundHandlerConfig{{Tag: inboundTag, ReceiverSettings: serial.ToTypedMessage(&proxyman.ReceiverConfig{
			Listen: xnet.NewIPOrDomain(xnet.LocalHostIP), PortList: &xnet.PortList{Range: []*xnet.PortRange{{From: port, To: port}}},
			StreamSettings: &internet.StreamConfig{ProtocolName: "tcp", SecurityType: security.Type, SecuritySettings: []*serial.TypedMessage{security}},
		}), ProxySettings: serial.ToTypedMessage(&vin.Config{Decryption: "none"})}}})
	if err != nil {
		return nil, err
	}
	if err = n.core.Start(); err != nil {
		return nil, err
	}
	n.control, err = net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	n.grpc = grpc.NewServer()
	for _, cfg := range []any{&handler.Config{}, &stats.Config{}} {
		object, objectErr := core.CreateObject(n.core, cfg)
		if objectErr != nil {
			return nil, objectErr
		}
		object.(commander.Service).Register(n.grpc)
	}
	go n.grpc.Serve(n.control)
	n.api, err = adapter.New(n.control.Addr().String(), inboundTag)
	if err != nil {
		return nil, err
	}
	n.echo, err = net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	go func() {
		for {
			conn, err := n.echo.Accept()
			if err != nil {
				return
			}
			go func() { defer conn.Close(); io.Copy(conn, conn) }()
		}
	}()
	n.public = map[string]any{"port": port, "grpc": n.control.Addr().String(), "inboundTag": inboundTag, "publicKey": base64.RawURLEncoding.EncodeToString(key.PublicKey().Bytes()), "serverName": "example.com", "shortId": "0102030405060708"}
	return n, nil
}
