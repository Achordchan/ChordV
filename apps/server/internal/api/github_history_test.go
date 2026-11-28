package api

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestGitHubHistoryMixedReleaseFormatsHTTP(t *testing.T) {
	for _, tc := range []struct {
		name        string
		assets      []Object
		status      int
		shouldFetch bool
	}{
		{"legacy-installer", []Object{{"name": "ChordV.dmg"}, {"name": "ChordV.dmg.sig"}}, 200, false},
		{"advertised-manifest-missing", []Object{{"name": "chordv-release.json"}, {"name": "chordv-release.json.sig"}}, 502, true},
		{"orphan-signature", []Object{{"name": "chordv-release.json.sig"}}, 502, true},
		{"asset-list-unavailable", nil, 502, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			m := testManifest()
			s, tamper := signedReleaseServer(t, m)
			defer s.Close()
			signed := s.HTTP.Transport
			legacy := Object{"tag_name": "v1.1.12", "draft": false, "prerelease": false}
			if tc.assets != nil {
				legacy["assets"] = tc.assets
			}
			list, _ := json.Marshal([]Object{legacy, {"tag_name": m.Tag, "draft": false, "prerelease": false, "assets": []Object{{"name": "chordv-release.json"}, {"name": "chordv-release.json.sig"}}}})
			legacyCalls := 0
			s.HTTP.Transport = releaseTransport(func(r *http.Request) (*http.Response, error) {
				if r.URL.Host == "api.github.com" {
					return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(string(list)))}, nil
				}
				if strings.Contains(r.URL.Path, "/v1.1.12/") {
					legacyCalls++
					return &http.Response{StatusCode: 404, Header: http.Header{}, Body: http.NoBody}, nil
				}
				return signed.RoundTrip(r)
			})
			h := httptest.NewServer(s.Handler())
			defer h.Close()
			a := &testAPI{t: t, http: h}
			raw := a.request("GET", "/api/client/releases/history?platform=windows&channel=stable", nil, tc.status)
			if (legacyCalls > 0) != tc.shouldFetch {
				t.Fatalf("legacy metadata requests = %d", legacyCalls)
			}
			if tc.status == 200 {
				var out []Object
				if err := json.Unmarshal(raw, &out); err != nil || len(out) != 1 || out[0]["version"] != m.Version {
					t.Fatalf("unexpected history: %s", raw)
				}
				tamper(true)
				a.request("GET", "/api/client/releases/history?platform=windows&channel=stable", nil, 502)
			}
		})
	}
}

func TestGitHubHistoryFindsDesktopReleaseAfterServerPage(t *testing.T) {
	m := testManifest()
	s, _ := signedReleaseServer(t, m)
	defer s.Close()
	signed := s.HTTP.Transport
	pages := 0
	s.HTTP.Transport = releaseTransport(func(r *http.Request) (*http.Response, error) {
		if r.URL.Host == "github.com" {
			return signed.RoundTrip(r)
		}
		if r.URL.Host != "api.github.com" || r.URL.Path != "/repos/local-fixture/binaries/releases" {
			t.Errorf("unexpected origin: %s", r.URL)
			return nil, io.ErrUnexpectedEOF
		}
		pages++
		headers := http.Header{}
		body := `[{"tag_name":"server-v0.1.0"}]`
		if pages == 1 {
			headers.Set("Link", `<https://example.invalid/must-not-follow>; rel="next"`)
		} else if pages == 2 && r.URL.Query().Get("page") == "2" {
			body = `[{"tag_name":"v2.0.0"},{"tag_name":"v2.0.0"}]`
			headers.Set("Link", `<https://example.invalid/unused>; rel="next"`)
		} else {
			t.Errorf("unexpected page: %s", r.URL)
		}
		return &http.Response{StatusCode: 200, Header: headers, Body: io.NopCloser(strings.NewReader(body))}, nil
	})
	h := httptest.NewServer(s.Handler())
	defer h.Close()
	a := &testAPI{t: t, http: h}
	out := a.array("/api/client/releases/history?platform=windows&channel=stable&limit=1")
	if len(out) != 1 || out[0]["version"] != m.Version || pages != 2 {
		t.Fatalf("desktop history = %v, pages = %d", out, pages)
	}
}

func TestGitHubHistoryStopsAtPageBudget(t *testing.T) {
	s, _ := signedReleaseServer(t, testManifest())
	defer s.Close()
	pages := 0
	s.HTTP.Transport = releaseTransport(func(r *http.Request) (*http.Response, error) {
		pages++
		if r.URL.Host != "api.github.com" {
			t.Error("unexpected manifest fetch")
		}
		header := http.Header{}
		header.Set("Link", `<https://example.invalid/unused>; rel="next"`)
		return &http.Response{StatusCode: 200, Header: header, Body: io.NopCloser(strings.NewReader(`[{"tag_name":"server-v1.0.0"}]`))}, nil
	})
	h := httptest.NewServer(s.Handler())
	defer h.Close()
	a := &testAPI{t: t, http: h}
	a.request("GET", "/api/client/releases/history?channel=typo&platform=windows", nil, 400)
	if pages != 0 {
		t.Fatal("invalid channel requested upstream")
	}
	a.request("GET", "/api/client/releases/history?platform=windows", nil, 503)
	if pages != 5 {
		t.Fatal("unexpected number of pages", pages)
	}
}
