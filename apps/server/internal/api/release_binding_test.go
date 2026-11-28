package api

import (
	"context"
	"encoding/json"
	"github.com/Achordchan/ChordV/apps/server/internal/config"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func schema2ServerManifest() map[string]any {
	raw, _ := json.Marshal(testManifest())
	var m map[string]any
	_ = json.Unmarshal(raw, &m)
	m["schemaVersion"] = 2
	m["sourceCommit"] = strings.Repeat("a", 40)
	m["tagBinding"] = map[string]any{"mode": "signed-manifest-tree", "repository": "owner/repo"}
	return m
}
func TestSchema2ServerProjectionReadsActualGitOverHTTP(t *testing.T) {
	f := schema2GitFixture(t, schema2ServerManifest())
	s := New(nil, config.Config{GitHubRepository: "owner/repo", GitHubPublicKey: f.public})
	defer s.Close()
	s.HTTP = &http.Client{Transport: f.transport}
	manifest, err := s.latestManifest(context.Background(), "stable")
	if err != nil {
		t.Fatal("schema2 projection failed", err)
	}
	if manifest.Version != "2.0.0" || f.calls.Load() < 8 {
		t.Fatal("schema2 did not inspect original Git tree")
	}
	endpoint := httptest.NewServer(s.Handler())
	defer endpoint.Close()
	api := &testAPI{t: t, server: s, http: endpoint}
	update := api.call("POST", "/api/client/update/check", Object{"currentVersion": "1.1.12", "currentBuild": 1, "platform": "windows", "architecture": "x64", "channel": "stable"}, 200)
	if update["hasUpdate"] != true || update["latestVersion"] != "2.0.0" {
		t.Fatal("schema2 did not reach production compatibility projection", update)
	}
}
func TestSchema2ServerRejectsDeclarationsAndTreeMutants(t *testing.T) {
	for _, kind := range []string{"schema1-new-mode", "wrong-repo", "unknown-mode", "source-mode", "no-key", "parents", "extra-tree", "truncated", "canonical-signature"} {
		t.Run(kind, func(t *testing.T) {
			m := schema2ServerManifest()
			switch kind {
			case "schema1-new-mode":
				m["schemaVersion"] = 1
			case "wrong-repo":
				m["tagBinding"] = map[string]any{"mode": "signed-manifest-tree", "repository": "other/repo"}
			case "unknown-mode":
				m["tagBinding"] = map[string]any{"mode": "unknown", "repository": "owner/repo"}
			case "source-mode":
				m["tagBinding"] = map[string]any{"mode": "source-commit"}
			}
			f := schema2GitFixture(t, m)
			switch kind {
			case "parents":
				f.changeJSON(t, "/commits/", func(v map[string]any) { v["parents"] = []any{map[string]any{"sha": strings.Repeat("b", 40)}} })
			case "extra-tree":
				f.changeJSON(t, "/trees/", func(v map[string]any) {
					v["tree"] = append(v["tree"].([]any), map[string]any{"path": "private.go", "mode": "100644", "type": "blob", "sha": strings.Repeat("b", 40)})
				})
			case "truncated":
				f.changeJSON(t, "/trees/", func(v map[string]any) { v["truncated"] = true })
			case "canonical-signature":
				f.mu.Lock()
				f.routes["/owner/repo/releases/download/v2.0.0/chordv-release.json.sig"] = []byte(strings.TrimSpace(string(f.signature)))
				f.mu.Unlock()
			}
			key := f.public
			if kind == "no-key" {
				key = ""
			}
			s := New(nil, config.Config{GitHubRepository: "owner/repo", GitHubPublicKey: key})
			defer s.Close()
			s.HTTP = &http.Client{Transport: f.transport}
			if _, err := s.latestManifest(context.Background(), "stable"); err == nil {
				t.Fatal("mutant projected")
			}
		})
	}
}
