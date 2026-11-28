package api

import "testing"

func TestConfiguredIssuerUsedForLoginAndVerification(t *testing.T) {
	t.Setenv("CHORDV_JWT_ISSUER", "production-only")
	t.Setenv("CHORDV_LOCAL_JWT_ISSUER", " legacy-local ")
	local := newTestAPI(t)
	claims, err := local.server.verifyJWT(local.token)
	if err != nil || claims["iss"] != "legacy-local" {
		t.Fatal("登录与校验必须使用显式本地签发方", err)
	}
	local.call("GET", "/api/admin/system/version", nil, 200)
	t.Setenv("CHORDV_LOCAL_JWT_ISSUER", "")
	standard := newTestAPI(t)
	claims, err = standard.server.verifyJWT(standard.token)
	if err != nil || claims["iss"] != "chordv-api" {
		t.Fatal("本地默认签发方不应继承生产覆盖", err)
	}
	if _, err = standard.server.verifyJWT(local.token); err == nil {
		t.Fatal("默认签发方接受了不同签发方的令牌")
	}
	if _, err = local.server.verifyJWT(standard.token); err == nil {
		t.Fatal("自定义签发方接受了默认令牌")
	}
}
