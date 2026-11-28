package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestLocalConfigNeverAcceptsProductionOrPathInjection(t *testing.T) {
	for _, base := range []string{"https://v.achord.cn", "http://localhost:3100", "http://127.0.0.1:3100/api", "http://127.0.0.1:3100?redirect=1", "http://user:pass@127.0.0.1:3100"} {
		if validateAPIBase(base) == nil {
			t.Fatal("unsafe local API accepted", base)
		}
	}
	if err := validateAPIBase("http://127.0.0.1:3100"); err != nil {
		t.Fatal(err)
	}
	s := testService(t, "http://127.0.0.1:3100")
	for _, path := range []string{"https://evil.test", "//evil.test/path", "/../private", "/api/%2e%2e/private", "/\\evil"} {
		if _, err := s.apiURL(path); err == nil {
			t.Fatal("unsafe path accepted", path)
		}
	}
}

func TestReleaseConfigPinsEmbeddedAPIOrigin(t *testing.T) {
	mode, origin := buildMode, defaultAPIBase
	t.Cleanup(func() { buildMode, defaultAPIBase = mode, origin })
	buildMode, defaultAPIBase = "release", "https://api.chordv.invalid:8443"
	t.Setenv("CHORDV_MYGO_DATA_DIR", t.TempDir())
	t.Setenv("CHORDV_API_BASE_URL", "https://other-service.invalid")
	config, err := loadConfig()
	if err != nil || config.APIBase != defaultAPIBase {
		t.Fatalf("release runtime did not use the packaged origin: %q, %v", config.APIBase, err)
	}
	if err = validateAPIBase("https://other-service.invalid"); err == nil {
		t.Fatal("release plan accepted an origin different from the packaged origin")
	}
	defaultAPIBase = "http://127.0.0.1:3100"
	if _, err = loadConfig(); err == nil {
		t.Fatal("runtime override hid an invalid embedded release origin")
	}
}

func TestLocalConfigUsesOnlyLoopbackAPIOverride(t *testing.T) {
	mode, origin := buildMode, defaultAPIBase
	t.Cleanup(func() { buildMode, defaultAPIBase = mode, origin })
	buildMode, defaultAPIBase = "local", "http://127.0.0.1:3100"
	t.Setenv("CHORDV_MYGO_DATA_DIR", t.TempDir())
	t.Setenv("CHORDV_API_BASE_URL", "http://127.0.0.1:21300/")
	config, err := loadConfig()
	if err != nil || config.APIBase != "http://127.0.0.1:21300" {
		t.Fatalf("local override did not work: %q, %v", config.APIBase, err)
	}
	t.Setenv("CHORDV_API_BASE_URL", "https://other-service.invalid")
	if _, err = loadConfig(); err == nil {
		t.Fatal("local mode accepted a non-loopback override")
	}
}
func TestAPIRequestPreservesStatusHeadersAndBody(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/client/ping" || r.Header.Get("Authorization") != "Bearer local-test" || r.Method != "POST" {
			t.Error("request contract mismatch")
		}
		w.WriteHeader(403)
		fmt.Fprint(w, `{"message":"会话已失效"}`)
	}))
	defer server.Close()
	s := testService(t, server.URL)
	result, err := s.apiRequest(context.Background(), apiRequest{Method: "POST", Path: "/client/ping", Headers: map[string]string{"Authorization": "Bearer local-test"}, Body: "{}"})
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != 403 || result.Body != `{"message":"会话已失效"}` {
		t.Fatal(result)
	}
}
func TestAPIRejectsCrossOriginRedirect(t *testing.T) {
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { t.Error("cross-origin endpoint was called") }))
	defer other.Close()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, other.URL, http.StatusFound) }))
	defer server.Close()
	s := testService(t, server.URL)
	if _, err := s.apiRequest(context.Background(), apiRequest{Path: "/redirect"}); err == nil {
		t.Fatal("redirect accepted")
	}
}
func TestNativeSSEDeliversEventsAndStopsOnExplicitCancel(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/client/events/stream" {
			http.NotFound(w, r)
			return
		}
		if r.Header.Get("Authorization") != "Bearer local-token" {
			t.Error("missing SSE auth")
		}
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "id: 100-1\ndata: {\"type\":\"subscription.updated\",\n")
		fmt.Fprint(w, "data: \"payload\":{}}\n\n")
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	defer server.Close()
	s := testService(t, server.URL)
	events := make(chan NativeEvent, 8)
	s.emit = func(event NativeEvent) { events <- event }
	input, _ := json.Marshal(eventStreamInput{StreamID: "test-stream", AccessToken: "local-token"})
	if _, err := s.startEventStream(input); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"chordv://client-runtime-event-open", "chordv://client-runtime-event"} {
		select {
		case event := <-events:
			if event.Name != want {
				t.Fatalf("got %s, want %s", event.Name, want)
			}
		case <-time.After(3 * time.Second):
			t.Fatal("SSE event timeout")
		}
	}
	s.stopEventStream("test-stream")
	s.streamsMu.Lock()
	count := len(s.streams)
	s.streamsMu.Unlock()
	if count != 0 {
		t.Fatal("stream not removed")
	}
}

func TestReleaseTextPreservesHTTPStatusAndPagination(t *testing.T) {
	for _, status := range []int{200, 404, 429, 503} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			const link = `<https://api.github.com/repos/example/app/releases?page=2>; rel="next"`
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Link", link)
				w.WriteHeader(status)
				fmt.Fprint(w, "fixture body")
			}))
			defer server.Close()
			value, err := fetchRemoteText(context.Background(), server.URL)
			if err != nil {
				t.Fatal(err)
			}
			got := value.(map[string]any)
			if got["status"] != status {
				t.Fatal("lost HTTP status", got)
			}
			if status == 200 {
				if got["link"] != link || got["body"] != "fixture body" {
					t.Fatal("lost response metadata", got)
				}
			} else if got["body"] != "" {
				t.Fatal("error body forwarded", got)
			}
		})
	}
}

func TestReleaseTextByteLimitsAndUTF8(t *testing.T) {
	for _, tc := range []struct {
		path, body string
		valid      bool
	}{
		{"/stable.json", strings.Repeat("界", (1<<20)/3) + "a", true},
		{"/stable.json", strings.Repeat("界", (1<<20)/3+1), false},
		{"/stable.json.sig", strings.Repeat("a", 1024), true},
		{"/stable.json.sig", strings.Repeat("a", 1025), false},
		{"/stable.json", "\xef\xbb\xbf原文\n", true}, {"/stable.json", "\xe4", false},
	} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.(http.Flusher).Flush() // No Content-Length: check bytes actually received.
			fmt.Fprint(w, tc.body)
		}))
		got, err := fetchRemoteText(context.Background(), server.URL+tc.path)
		server.Close()
		if tc.valid != (err == nil) || tc.valid && got.(map[string]any)["body"] != tc.body {
			t.Fatalf("%s (%d bytes): %v", tc.path, len(tc.body), err)
		}
	}
}
