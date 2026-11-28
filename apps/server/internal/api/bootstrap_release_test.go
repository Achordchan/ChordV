package api

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestBootstrapKeepsAccountUsableWithoutVerifiedRelease(t *testing.T) {
	a := newTestAPI(t)
	user, plan := a.createUser(), a.createPlan("personal")
	sub := a.call("POST", "/api/admin/subscriptions", Object{"userId": user["id"], "planId": plan["id"], "expireAt": time.Now().Add(time.Hour).UTC().Format(time.RFC3339)}, 200)
	a.token = ""
	login := a.call("POST", "/api/auth/login", Object{"email": user["email"], "password": "  exact-password  "}, 200)
	clientToken := text(login, "accessToken")
	signed, _ := signedReleaseServer(t, testManifest())
	t.Cleanup(signed.Close)
	a.server.Config.GitHubRepository, a.server.Config.GitHubPublicKey = signed.Config.GitHubRepository, signed.Config.GitHubPublicKey
	var mode atomic.Int32
	a.server.HTTP = &http.Client{Transport: releaseTransport(func(r *http.Request) (*http.Response, error) {
		switch mode.Load() {
		case 1:
			return nil, errors.New("isolated release connection failure")
		case 2:
			if strings.HasSuffix(r.URL.Path, ".sig") {
				return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader("invalid-signature"))}, nil
			}
		}
		return signed.HTTP.Transport.RoundTrip(r)
	})}
	const path = "/api/client/bootstrap?platform=windows&architecture=x64"
	for _, tc := range []struct {
		name string
		mode int32
	}{{"unreachable", 1}, {"unverified-signature", 2}} {
		t.Run(tc.name, func(t *testing.T) {
			fixture := *a
			fixture.t = t
			mode.Store(tc.mode)
			fixture.token = clientToken
			bootstrap := fixture.call("GET", path, nil, 200)
			version, present := bootstrap["version"]
			if !present || version != nil {
				t.Fatal("unavailable version must be explicitly unknown, without policy or download data", version)
			}
			if bootstrap["user"].(map[string]any)["id"] != user["id"] || bootstrap["subscription"].(map[string]any)["id"] != sub["id"] ||
				bootstrap["policies"] == nil || bootstrap["announcements"] == nil || bootstrap["supportTickets"] == nil {
				t.Fatal("release lookup changed the rest of the account bootstrap")
			}
			fixture.token = ""
			fixture.request("GET", "/api/client/version?platform=windows&architecture=x64", nil, 502)
			fixture.request("POST", "/api/client/update/check", Object{"currentVersion": "1.1.12", "platform": "windows", "architecture": "x64"}, 502)
			fixture.request("GET", "/api/client/bootstrap?platform=windows", nil, 401)
		})
	}
	mode.Store(0)
	a.token = clientToken
	result := a.call("GET", path, nil, 200)
	if version := result["version"].(map[string]any); version["currentVersion"] != "2.0.0" || version["downloadUrl"] != "https://github.com/local-fixture/binaries/releases/download/v2.0.0/ChordV_2.0.0_windows_x64.exe" {
		t.Fatal("recovering GitHub did not restore its verified version", version)
	}
}

func TestBootstrapReleaseLookupHasOwnDeadlineAndRespectsParent(t *testing.T) {
	s, _ := signedReleaseServer(t, testManifest())
	t.Cleanup(s.Close)
	calls := 0
	s.HTTP = &http.Client{Transport: releaseTransport(func(r *http.Request) (*http.Response, error) {
		calls++
		deadline, ok := r.Context().Deadline()
		if !ok || time.Until(deadline) > 2*time.Second {
			t.Error("bootstrap did not limit its optional lookup to two seconds", deadline)
			return nil, context.DeadlineExceeded
		}
		<-r.Context().Done()
		return nil, r.Context().Err()
	})}
	if version, err := s.bootstrapVersion(context.Background(), "windows", "x64"); version != nil || err != nil || calls != 1 {
		t.Fatal("optional timeout must leave version unknown without failing bootstrap", version, err, calls)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if version, err := s.bootstrapVersion(ctx, "windows", "x64"); version != nil || !errors.Is(err, context.Canceled) || calls != 1 {
		t.Fatal("parent cancellation authorized another lookup or returned a result", version, err, calls)
	}
}
