//go:build e2e

package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"

	"github.com/xtls/xray-core/app/dispatcher"
	"github.com/xtls/xray-core/app/proxyman"
	xnet "github.com/xtls/xray-core/common/net"
	"github.com/xtls/xray-core/common/protocol"
	"github.com/xtls/xray-core/common/serial"
	"github.com/xtls/xray-core/core"
	"github.com/xtls/xray-core/proxy/vless"
	vout "github.com/xtls/xray-core/proxy/vless/outbound"
	"github.com/xtls/xray-core/transport/internet"
	"github.com/xtls/xray-core/transport/internet/reality"
)

func (n *localNode) transfer(ctx context.Context, raw json.RawMessage, size int) (any, error) {
	var runtime struct {
		Outbound struct {
			Server      string `json:"server"`
			Port        uint32 `json:"port"`
			UUID        string `json:"uuid"`
			Flow        string `json:"flow"`
			PublicKey   string `json:"realityPublicKey"`
			ShortID     string `json:"shortId"`
			ServerName  string `json:"serverName"`
			Fingerprint string `json:"fingerprint"`
			SpiderX     string `json:"spiderX"`
		} `json:"outbound"`
	}
	if err := json.Unmarshal(raw, &runtime); err != nil {
		return nil, err
	}
	o := runtime.Outbound
	if o.Server != "127.0.0.1" || o.Port != n.public["port"] || size < 1 || size > 4*1024*1024 {
		return nil, fmt.Errorf("transfer must target this loopback node with 1..4194304 bytes")
	}
	key, err := base64.RawURLEncoding.DecodeString(o.PublicKey)
	if err != nil {
		return nil, err
	}
	short, err := hex.DecodeString(o.ShortID)
	if err != nil {
		return nil, err
	}
	padded := make([]byte, 8)
	copy(padded, short)
	security := serial.ToTypedMessage(&reality.Config{Fingerprint: o.Fingerprint, ServerName: o.ServerName, PublicKey: key, ShortId: padded, SpiderX: o.SpiderX})
	client, err := core.New(&core.Config{App: []*serial.TypedMessage{serial.ToTypedMessage(&dispatcher.Config{}), serial.ToTypedMessage(&proxyman.OutboundConfig{})}, Outbound: []*core.OutboundHandlerConfig{{
		Tag: "reality-client", SenderSettings: serial.ToTypedMessage(&proxyman.SenderConfig{StreamSettings: &internet.StreamConfig{ProtocolName: "tcp", SecurityType: security.Type, SecuritySettings: []*serial.TypedMessage{security}}}),
		ProxySettings: serial.ToTypedMessage(&vout.Config{Vnext: &protocol.ServerEndpoint{Address: xnet.NewIPOrDomain(xnet.LocalHostIP), Port: o.Port, User: &protocol.User{Account: serial.ToTypedMessage(&vless.Account{Id: o.UUID, Flow: o.Flow, Encryption: "none"})}}}),
	}}})
	if err != nil {
		return nil, err
	}
	defer client.Close()
	if err := client.Start(); err != nil {
		return nil, err
	}
	conn, err := core.Dial(ctx, client, xnet.TCPDestination(xnet.LocalHostIP, xnet.Port(n.echo.Addr().(*net.TCPAddr).Port)))
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	finished := make(chan struct{})
	defer close(finished)
	go func() {
		select {
		case <-ctx.Done():
			conn.Close()
		case <-finished:
		}
	}()
	payload := make([]byte, size)
	for i := range payload {
		payload[i] = byte(i*31 + 17)
	}
	written := make(chan error, 1)
	go func() { _, err := io.Copy(conn, bytes.NewReader(payload)); written <- err }()
	answer := make([]byte, size)
	if _, err := io.ReadFull(conn, answer); err != nil {
		return nil, err
	}
	if err := <-written; err != nil {
		return nil, err
	}
	if !bytes.Equal(payload, answer) {
		return nil, fmt.Errorf("Reality echo content mismatch")
	}
	return map[string]any{"uplinkPayloadBytes": size, "downlinkPayloadBytes": len(answer), "contentVerified": true, "security": "reality"}, nil
}
