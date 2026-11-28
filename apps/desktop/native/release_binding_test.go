package main

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func schema2NativeManifest() map[string]any {
	return map[string]any{"schemaVersion": 2, "tag": "v9.8.7", "version": "9.8.7", "build": 3, "channel": "stable", "sourceCommit": strings.Repeat("a", 40), "tagBinding": map[string]any{"mode": "signed-manifest-tree", "repository": "owner/repo"}, "installers": []any{map[string]any{"platform": platformName(), "architecture": architectureName(), "fileName": "app.dmg", "sha256": strings.Repeat("a", 64), "sizeBytes": 42}}, "runtimeComponents": []any{}}
}
func TestSchema2NativeBindingUsesRealGitHTTPAndReceipt(t *testing.T) {
	f := schema2GitFixture(t, schema2NativeManifest())
	s := testService(t, "http://127.0.0.1:3100")
	s.cfg.ReleaseRepository = "owner/repo"
	s.cfg.ReleasePublicKey = f.public
	s.apiTransport = f.transport
	input, _ := json.Marshal(map[string]string{"manifest": string(f.body), "signature": string(f.signature), "tag": "v9.8.7"})
	if _, err := s.authorizeReleaseManifest(context.Background(), input); err != nil {
		t.Fatal("schema2 real tree rejected", err)
	}
	count := f.calls.Load()
	if count < 6 {
		t.Fatal("native did not inspect real Git objects", count)
	}
	grant, err := s.authorizedDownload("https://github.com/owner/repo/releases/download/v9.8.7/app.dmg", strings.Repeat("a", 64), 42)
	if err != nil {
		t.Fatal(err)
	}
	if err = s.verifyGrantReceipt(grant); err != nil {
		t.Fatal("schema2 receipt failed", err)
	}
	if f.calls.Load() != count {
		t.Fatal("identical receipt did not reuse bounded successful observation")
	}
	s.cfg.ReleaseRepository = "other/repo"
	if err = s.verifyGrantReceipt(grant); err == nil {
		t.Fatal("cross-repo cached receipt accepted")
	}
	if f.calls.Load() != count {
		t.Fatal("wrong repository should fail before cache/network")
	}
	if s.validateReleaseTextURL("https://api.github.com/repos/owner/repo/git/trees/"+strings.Repeat("a", 40)) == nil {
		t.Fatal("generic API whitelist expanded")
	}
	s.cfg.ReleaseRepository = "owner/repo"
	fresh := testService(t, "http://127.0.0.1:3100")
	fresh.cfg = s.cfg
	fresh.apiTransport = f.transport
	before := f.calls.Load()
	if err := fresh.verifyGrantReceipt(grant); err != nil {
		t.Fatal("restored receipt failed", err)
	}
	if f.calls.Load() <= before {
		t.Fatal("restored receipt trusted a persisted verification flag")
	}
	s.releaseBindings.mu.Lock()
	for key := range s.releaseBindings.entries {
		s.releaseBindings.entries[key] = time.Now().Add(-31 * time.Second)
	}
	s.releaseBindings.mu.Unlock()
	f.changeJSON(t, "/commits/", func(v map[string]any) { v["parents"] = []any{map[string]any{"sha": strings.Repeat("b", 40)}} })
	for i := 0; i < 2; i++ {
		before = f.calls.Load()
		if err := s.verifyGrantReceipt(grant); err == nil {
			t.Fatal("expired cache hid changed metadata history")
		}
		if f.calls.Load() <= before {
			t.Fatal("verification failure cached")
		}
	}
}
func TestSchema2NativeRejectsTreeAndDeclarationMutants(t *testing.T) {
	for _, kind := range []string{"schema1-new-mode", "wrong-repo", "unknown-mode", "source-mode", "no-key", "parents", "extra-tree", "truncated", "signature-newline"} {
		t.Run(kind, func(t *testing.T) {
			m := schema2NativeManifest()
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
			}
			s := testService(t, "http://127.0.0.1:3100")
			s.cfg.ReleaseRepository = "owner/repo"
			s.cfg.ReleasePublicKey = f.public
			s.apiTransport = f.transport
			if kind == "no-key" {
				s.cfg.ReleasePublicKey = ""
			}
			sig := string(f.signature)
			if kind == "signature-newline" {
				sig = strings.TrimSpace(sig)
			}
			input, _ := json.Marshal(map[string]string{"manifest": string(f.body), "signature": sig, "tag": "v9.8.7"})
			if _, err := s.authorizeReleaseManifest(context.Background(), input); err == nil {
				t.Fatal("mutant authorized")
			}
		})
	}
}
