package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"testing"

	"github.com/Achordchan/ChordV/apps/server/internal/config"
)

func TestAllRoutesRegisterWithoutPatternConflicts(t *testing.T) {
	s := New(nil, config.Config{})
	defer s.Close()
	handler := s.Handler()
	for _, path := range []string{"/api/admin/nodes/node-id/lease-revocation-jobs/retry", "/api/admin/nodes/lease-revocation-jobs/job-id/retry", "/api/admin/nodes/node-id/onboarding/retry"} {
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, httptest.NewRequest("POST", path, nil))
		if recorder.Code != 401 {
			t.Fatalf("注册后的兼容路由未进入鉴权: %s status=%d", path, recorder.Code)
		}
	}
}

func TestRetiredPublishingRoutesAreNotRegistered(t *testing.T) {
	raw, err := os.ReadFile("../../legacy-routes.json")
	if err != nil {
		t.Fatal(err)
	}
	var routes []struct{ Method, Path, Status string }
	if err := json.Unmarshal(raw, &routes); err != nil {
		t.Fatal(err)
	}
	want := map[string]int{"retired_release_center": 30, "retired_server_self_update": 8, "retired_github_delivery": 5}
	seen := make(map[string]bool)
	counts := make(map[string]int)
	parameters := regexp.MustCompile(`:[A-Za-z][A-Za-z0-9_]*`)
	mux := http.NewServeMux()
	s := New(nil, config.Config{})
	defer s.Close()
	s.routes(mux)
	const current = "GET /api/admin/system/version"
	if _, pattern := mux.Handler(httptest.NewRequest(http.MethodGet, "/api/admin/system/version", nil)); pattern != current {
		t.Fatalf("现行版本查询路由缺失: %q", pattern)
	}
	for _, route := range routes {
		if _, retired := want[route.Status]; !retired {
			continue
		}
		path := parameters.ReplaceAllString(route.Path, "qa-retired")
		key := route.Method + " " + path
		if seen[key] {
			t.Fatalf("退役接口清单存在重复: %s", key)
		}
		seen[key] = true
		counts[route.Status]++
		if _, pattern := mux.Handler(httptest.NewRequest(route.Method, path, nil)); pattern != "" {
			t.Errorf("退役接口 %s 仍匹配路由 %q", key, pattern)
		}
	}
	for status, expected := range want {
		if counts[status] != expected {
			t.Errorf("退役接口清单 %s: 核对 %d 条，应为 %d 条", status, counts[status], expected)
		}
	}
}
