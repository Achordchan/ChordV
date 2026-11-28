package api

import (
	"context"
	"encoding/base64"
	"strings"
	"testing"
	"time"

	"github.com/Achordchan/ChordV/apps/server/internal/config"
)

func TestJWTSignatureExpiryAndAlgorithm(t *testing.T) {
	s := New(nil, config.Config{JWTSecret: strings.Repeat("secret", 8)})
	claims := Object{"sub": "u", "sid": "s", "iss": "chordv-api", "exp": time.Now().Add(time.Minute).Unix()}
	token, err := s.signJWT(claims)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.verifyJWT(token); err != nil {
		t.Fatal(err)
	}
	parts := strings.Split(token, ".")
	parts[0] = base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"none"}`))
	if _, err = s.verifyJWT(strings.Join(parts, ".")); err == nil {
		t.Fatal("允许了未签名算法")
	}
	claims["exp"] = time.Now().Add(-time.Minute).Unix()
	expired, _ := s.signJWT(claims)
	if _, err = s.verifyJWT(expired); err == nil {
		t.Fatal("允许了过期令牌")
	}
	wrong := New(nil, config.Config{JWTSecret: "another secret"})
	if _, err = wrong.verifyJWT(token); err == nil {
		t.Fatal("允许了错误签名")
	}
}
func TestRoutingNormalization(t *testing.T) {
	for raw, want := range map[string]string{" .EXAMPLE.com ": "example.com", "github": "github", "api.example.com": "api.example.com"} {
		value, _, err := normalizeRouting(raw)
		if err != nil || value != want {
			t.Fatalf("normalization %q: %v", raw, err)
		}
	}
	for _, raw := range []string{"https://example.com", "a..b", "-bad.com", "abc/def", "bad name", ""} {
		if _, _, err := normalizeRouting(raw); err == nil {
			t.Errorf("允许了无效规则 %q", raw)
		}
	}
}
func TestLocalProbeNeverContactsRemote(t *testing.T) {
	if _, err := probeLocal(context.Background(), Object{"serverHost": "example.com", "serverPort": 443}); err == nil {
		t.Fatal("允许了非本地节点检测")
	}
}
func TestDecimalRange(t *testing.T) {
	for _, v := range []string{"-1", "1.0", "01", "9223372036854775808", ""} {
		if _, err := decimal(v); err == nil {
			t.Errorf("允许了无效整数 %q", v)
		}
	}
}

func TestUsageCanonicalHashMatchesLegacyFieldOrder(t *testing.T) {
	raw, err := canonicalUsageJSON(Object{"bootId": "boot", "sequence": "1", "sampledAt": "2026-11-16T00:00:00Z", "samples": []any{Object{"bindingId": "binding", "counterGeneration": "0", "uplinkBytes": "1", "downlinkBytes": "2", "uplinkDeltaBytes": "1", "downlinkDeltaBytes": "2"}}})
	if err != nil {
		t.Fatal(err)
	}
	want := `{"bootId":"boot","sequence":"1","sampledAt":"2026-11-16T00:00:00Z","samples":[{"bindingId":"binding","counterGeneration":"0","uplinkBytes":"1","downlinkBytes":"2","uplinkDeltaBytes":"1","downlinkDeltaBytes":"2"}]}`
	if string(raw) != want {
		t.Fatal("Go流量批次规范序列化与旧Node字段顺序不同，会破坏旧Agent重放去重")
	}
}
