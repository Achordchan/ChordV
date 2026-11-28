package api

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func rewriteAgentManifest(t *testing.T, source *agentReleaseSource, change func(*agentDistribution)) {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(source.directory, "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	var manifest agentDistribution
	if err = json.Unmarshal(raw, &manifest); err != nil {
		t.Fatal(err)
	}
	change(&manifest)
	raw, err = json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(source.directory, "manifest.json"), raw, 0600); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(raw)
	source.manifestSHA256 = hex.EncodeToString(sum[:])
}

func TestAgentReleaseRejectsBrokenTrustAndWrongActualBinaries(t *testing.T) {
	cases := map[string]func(*testing.T, *Server, *agentReleaseSource){
		"missing trust anchor": func(_ *testing.T, _ *Server, s *agentReleaseSource) { s.manifestSHA256 = "" },
		"wrong commit": func(_ *testing.T, _ *Server, s *agentReleaseSource) {
			s.commit = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
		},
		"wrong version": func(_ *testing.T, _ *Server, s *agentReleaseSource) { s.version = "2.0.1" },
		"tampered manifest": func(t *testing.T, _ *Server, s *agentReleaseSource) {
			if err := os.WriteFile(filepath.Join(s.directory, "manifest.json"), []byte("{}"), 0600); err != nil {
				t.Fatal(err)
			}
		},
		"missing architecture": func(t *testing.T, _ *Server, s *agentReleaseSource) {
			rewriteAgentManifest(t, s, func(m *agentDistribution) { delete(m.SHA256, "arm64") })
		},
		"missing binary": func(t *testing.T, _ *Server, s *agentReleaseSource) {
			if err := os.Remove(filepath.Join(s.directory, "chordv-agent-linux-amd64")); err != nil {
				t.Fatal(err)
			}
		},
		"tampered binary": func(t *testing.T, _ *Server, s *agentReleaseSource) {
			if err := os.WriteFile(filepath.Join(s.directory, "chordv-agent-linux-amd64"), []byte("tampered"), 0600); err != nil {
				t.Fatal(err)
			}
		},
		"text despite matching hash": func(t *testing.T, _ *Server, s *agentReleaseSource) {
			contents := []byte("test-only-not-an-executable")
			sum := sha256.Sum256(contents)
			if err := os.WriteFile(filepath.Join(s.directory, "chordv-agent-linux-amd64"), contents, 0600); err != nil {
				t.Fatal(err)
			}
			rewriteAgentManifest(t, s, func(m *agentDistribution) { m.SHA256["amd64"] = hex.EncodeToString(sum[:]) })
		},
		"wrong actual architecture despite matching hash": func(t *testing.T, _ *Server, s *agentReleaseSource) {
			contents := agentFixtureFiles["chordv-agent-linux-arm64"]
			sum := sha256.Sum256(contents)
			if err := os.WriteFile(filepath.Join(s.directory, "chordv-agent-linux-amd64"), contents, 0600); err != nil {
				t.Fatal(err)
			}
			rewriteAgentManifest(t, s, func(m *agentDistribution) { m.SHA256["amd64"] = hex.EncodeToString(sum[:]) })
		},
		"wrong embedded version despite matching manifest": func(t *testing.T, _ *Server, s *agentReleaseSource) {
			s.version = "2.0.1"
			rewriteAgentManifest(t, s, func(m *agentDistribution) { m.Version = s.version })
		},
		"binary symlink": func(t *testing.T, _ *Server, s *agentReleaseSource) {
			file := filepath.Join(s.directory, "chordv-agent-linux-amd64")
			if err := os.Remove(file); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink("chordv-agent-linux-arm64", file); err != nil {
				t.Fatal(err)
			}
		},
	}
	for name, corrupt := range cases {
		t.Run(name, func(t *testing.T) {
			s := &Server{}
			source := installAgentFixture(t, s)
			corrupt(t, s, source)
			r := httptest.NewRequest("GET", "/api/agent-download/go/"+source.version+"/amd64", nil)
			r.SetPathValue("version", source.version)
			r.SetPathValue("arch", "amd64")
			_, err := s.agentDownload(httptest.NewRecorder(), r, nil)
			if failure, ok := err.(HTTPError); !ok || failure.Status != 503 {
				t.Fatalf("破损发布应返回503: %v", err)
			}
		})
	}
}

func TestAgentReleaseDownloadsBothActualArchitecturesAndNeverReadsDataDir(t *testing.T) {
	s := &Server{}
	source := installAgentFixture(t, s)
	for _, arch := range []string{"amd64", "arm64"} {
		r := httptest.NewRequest(http.MethodGet, "/api/agent-download/go/"+source.version+"/"+arch, nil)
		r.SetPathValue("version", source.version)
		r.SetPathValue("arch", arch)
		w := httptest.NewRecorder()
		if _, err := s.agentDownload(w, r, nil); err != nil {
			t.Fatal(err)
		}
		if w.Code != 200 || !bytes.Equal(w.Body.Bytes(), agentFixtureFiles["chordv-agent-linux-"+arch]) {
			t.Fatal("下载字节与实际Agent不一致", arch)
		}
	}
	s.Config.DataDir = source.directory
	s.agentRelease = nil
	if _, root, err := s.loadAgentDistribution(); err == nil {
		root.Close()
		t.Fatal("未绑定的测试可执行文件不能使用DataDir中的Agent")
	}
}
