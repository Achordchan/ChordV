package xray

import (
	"context"
	"crypto/ecdh"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"regexp"
	"strings"

	"github.com/xtls/xray-core/app/proxyman"
	handler "github.com/xtls/xray-core/app/proxyman/command"
	vin "github.com/xtls/xray-core/proxy/vless/inbound"
	"github.com/xtls/xray-core/transport/internet/reality"
	"google.golang.org/protobuf/proto"
)

var panelTagPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,32}$`)

// DiscoverPanelTag resolves automatic onboarding from live parameters, not a
// panel-version naming convention. A manual tag is never silently substituted.
func (g *GRPC) DiscoverPanelTag(ctx context.Context, payload map[string]any) (string, error) {
	if payload["tagOverrideConfirmed"] == true {
		_, err := g.ValidatePanel(ctx, payload)
		return g.tag, err
	}
	ctx, cancel := context.WithTimeout(ctx, CallTimeout)
	defer cancel()
	response, err := g.handler.ListInbounds(ctx, &handler.ListInboundsRequest{})
	if err != nil {
		return "", fmt.Errorf("无法读取面板实际入站列表")
	}
	port, ok := payload["listenPort"].(float64)
	if !ok {
		return "", fmt.Errorf("缺少待接入端口")
	}
	var matches []string
	for _, inbound := range response.GetInbounds() {
		if !panelTagPattern.MatchString(inbound.Tag) || inbound.GetProxySettings().GetType() != "xray.proxy.vless.inbound.Config" {
			continue
		}
		var receiver proxyman.ReceiverConfig
		if proto.Unmarshal(inbound.GetReceiverSettings().GetValue(), &receiver) != nil {
			continue
		}
		ranges := receiver.GetPortList().GetRange()
		if len(ranges) != 1 || float64(ranges[0].From) != port || ranges[0].From != ranges[0].To {
			continue
		}
		candidate := *g
		candidate.tag = inbound.Tag
		spec := make(map[string]any, len(payload))
		for key, value := range payload {
			spec[key] = value
		}
		spec["inboundTag"] = inbound.Tag
		if _, err := candidate.ValidatePanel(ctx, spec); err == nil {
			matches = append(matches, inbound.Tag)
		}
	}
	if len(matches) != 1 {
		return "", fmt.Errorf("未找到唯一匹配端口、公钥、SNI 和 shortId 的实际入站，请核对导入链接")
	}
	return matches[0], nil
}

// ValidatePanel compares imported public parameters to the running inbound.
// Private key material is used only to derive its public key, never returned.
func (g *GRPC) ValidatePanel(ctx context.Context, payload map[string]any) (map[string]any, error) {
	ctx, cancel := context.WithTimeout(ctx, CallTimeout)
	defer cancel()
	if payload["mode"] != "validate_panel" {
		return nil, fmt.Errorf("ENSURE_INBOUND 仅支持面板只读校验，不支持部署")
	}
	if payload["inboundTag"] != g.tag {
		return nil, fmt.Errorf("下发 tag 与 XRAY_INBOUND_TAG 不一致")
	}
	if payload["rotateKeys"] == true {
		return nil, fmt.Errorf("只读校验不轮换密钥")
	}
	if err := g.ValidateInbound(ctx); err != nil {
		return nil, err
	}
	response, err := g.handler.ListInbounds(ctx, &handler.ListInboundsRequest{})
	if err != nil {
		return nil, err
	}
	for _, in := range response.GetInbounds() {
		if in.Tag != g.tag {
			continue
		}
		var proxy vin.Config
		if in.GetProxySettings().GetType() != "xray.proxy.vless.inbound.Config" {
			return nil, fmt.Errorf("目标入站不是 VLESS")
		}
		if err := proto.Unmarshal(in.GetProxySettings().GetValue(), &proxy); err != nil {
			return nil, fmt.Errorf("无法读取 VLESS 配置")
		}
		// Upstream treats both empty and none as no extra VLESS encryption.
		if proxy.Decryption != "" && proxy.Decryption != "none" {
			return nil, fmt.Errorf("目标入站启用了不支持的 VLESS decryption，客户端仅支持 encryption=none")
		}
		var receiver proxyman.ReceiverConfig
		if err := proto.Unmarshal(in.GetReceiverSettings().GetValue(), &receiver); err != nil {
			return nil, fmt.Errorf("无法读取入站监听配置")
		}
		port, ok := payload["listenPort"].(float64)
		ranges := receiver.GetPortList().GetRange()
		if !ok || len(ranges) != 1 || port != float64(ranges[0].From) || ranges[0].From != ranges[0].To {
			return nil, fmt.Errorf("导入端口与实际入站监听端口不一致")
		}
		stream := receiver.GetStreamSettings()
		if stream.GetProtocolName() != "tcp" && stream.GetProtocolName() != "raw" && stream.GetProtocolName() != "" {
			return nil, fmt.Errorf("目标入站不是 TCP/RAW")
		}
		if stream.GetSecurityType() != "xray.transport.internet.reality.Config" {
			return nil, fmt.Errorf("目标入站不是 Reality")
		}
		for _, security := range stream.GetSecuritySettings() {
			if security.GetType() != "xray.transport.internet.reality.Config" {
				continue
			}
			var actual reality.Config
			if err := proto.Unmarshal(security.Value, &actual); err != nil {
				return nil, fmt.Errorf("无法读取 Reality 配置")
			}
			key, err := ecdh.X25519().NewPrivateKey(actual.PrivateKey)
			if err != nil {
				return nil, fmt.Errorf("实际 Reality 密钥无效")
			}
			public := base64.RawURLEncoding.EncodeToString(key.PublicKey().Bytes())
			if payload["realityPublicKey"] != public {
				return nil, fmt.Errorf("导入 Reality 公钥与实际入站不一致")
			}
			names, ok := payload["serverNames"].([]any)
			if !ok || len(names) != 1 {
				return nil, fmt.Errorf("缺少单个客户端 SNI")
			}
			name, ok := names[0].(string)
			if !ok || !containsString(actual.ServerNames, name) {
				return nil, fmt.Errorf("导入 SNI 不在实际 Reality 配置中")
			}
			sid, ok := payload["shortId"].(string)
			decoded, err := hex.DecodeString(sid)
			if !ok || err != nil || len(decoded) > 8 {
				return nil, fmt.Errorf("导入 shortId 非法")
			}
			padded := make([]byte, 8)
			copy(padded, decoded)
			found := false
			for _, candidate := range actual.ShortIds {
				if string(candidate) == string(padded) {
					found = true
				}
			}
			if !found {
				return nil, fmt.Errorf("导入 shortId 不在实际 Reality 配置中")
			}
			if len(actual.Mldsa65Seed) > 0 {
				return nil, fmt.Errorf("此导入流程尚不支持 ML-DSA 配置")
			}
			flow, _ := payload["flow"].(string)
			if flow != "" && flow != "xtls-rprx-vision" {
				return nil, fmt.Errorf("不支持的 flow")
			}
			host, _ := payload["serverHost"].(string)
			if strings.TrimSpace(host) == "" {
				return nil, fmt.Errorf("缺少客户端地址")
			}
			return map[string]any{"inbound": map[string]any{
				"mode": "validate_panel", "validated": true, "inboundTag": g.tag, "serverPort": int(port), "serverHost": host,
				"realityPublicKey": public, "shortId": sid, "serverName": name, "flow": flow,
				"fingerprint": payload["fingerprint"], "spiderX": payload["spiderX"],
			}}, nil
		}
		return nil, fmt.Errorf("目标入站缺少 Reality 配置")
	}
	return nil, fmt.Errorf("目标入站不存在")
}

func containsString(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}
