package api

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

var agentFixtureOnce sync.Once
var agentFixtureFiles map[string][]byte
var agentFixtureError error

// Compile the real Agent command once, not text bytes masquerading as an ELF.
func installAgentFixture(t *testing.T, s *Server) *agentReleaseSource {
	t.Helper()
	agentFixtureOnce.Do(func() {
		directory, err := os.MkdirTemp("", "chordv-real-agent-test-")
		if err != nil {
			agentFixtureError = err
			return
		}
		defer os.RemoveAll(directory)
		agentFixtureFiles = map[string][]byte{}
		hashes := map[string]string{}
		const version = "2.0.0-beta.1"
		commit := strings.Repeat("a", 40)
		for _, arch := range []string{"amd64", "arm64"} {
			name := "chordv-agent-linux-" + arch
			pkg := "github.com/Achordchan/ChordV/apps/agent/internal/version"
			command := exec.Command("go", "build", "-ldflags=-s -w -X "+pkg+".Version="+version+" -X "+pkg+".Commit="+commit, "-o", filepath.Join(directory, name), "./cmd/chordv-agent")
			command.Dir = filepath.Join("..", "..", "..", "agent")
			command.Env = append(os.Environ(), "GOOS=linux", "GOARCH="+arch, "CGO_ENABLED=0")
			if output, err := command.CombinedOutput(); err != nil {
				agentFixtureError = fmt.Errorf("真实Agent构建失败: %w %s", err, output)
				return
			}
			contents, err := os.ReadFile(filepath.Join(directory, name))
			if err != nil {
				agentFixtureError = err
				return
			}
			agentFixtureFiles[name] = contents
			sum := sha256.Sum256(contents)
			hashes[arch] = hex.EncodeToString(sum[:])
		}
		agentFixtureFiles["manifest.json"], agentFixtureError = json.Marshal(agentDistribution{Version: version, Commit: commit, SHA256: hashes})
	})
	if agentFixtureError != nil {
		t.Fatal(agentFixtureError)
	}
	directory := t.TempDir()
	for name, contents := range agentFixtureFiles {
		if err := os.WriteFile(filepath.Join(directory, name), contents, 0600); err != nil {
			t.Fatal(err)
		}
	}
	sum := sha256.Sum256(agentFixtureFiles["manifest.json"])
	source := &agentReleaseSource{directory, "2.0.0-beta.1", strings.Repeat("a", 40), hex.EncodeToString(sum[:])}
	s.agentRelease = source
	return source
}
