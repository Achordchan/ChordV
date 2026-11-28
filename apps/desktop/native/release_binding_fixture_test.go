package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
)

type schema2Fixture struct {
	body, signature []byte
	public          string
	routes          map[string][]byte
	mu              sync.RWMutex
	calls           atomic.Int32
	transport       *http.Transport
}

func schema2GitFixture(t *testing.T, manifest map[string]any) *schema2Fixture {
	t.Helper()
	public, private, _ := ed25519.GenerateKey(rand.Reader)
	body, _ := json.Marshal(manifest)
	signature := []byte(base64.StdEncoding.EncodeToString(ed25519.Sign(private, body)) + "\n")
	directory := filepath.Join(t.TempDir(), "metadata.git")
	run := func(input []byte, args ...string) string {
		cmd := exec.Command("git", append([]string{"--git-dir=" + directory, "-c", "commit.gpgsign=false"}, args...)...)
		cmd.Stdin = bytes.NewReader(input)
		cmd.Env = append(os.Environ(), "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL="+os.DevNull, "GIT_AUTHOR_NAME=Schema2 Test", "GIT_AUTHOR_EMAIL=test@example.invalid", "GIT_COMMITTER_NAME=Schema2 Test", "GIT_COMMITTER_EMAIL=test@example.invalid")
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v %s", args, err, out)
		}
		return strings.TrimSpace(string(out))
	}
	init := exec.Command("git", "init", "--bare", directory)
	if out, err := init.CombinedOutput(); err != nil {
		t.Fatalf("git init: %v %s", err, out)
	}
	m := run(body, "hash-object", "-w", "--stdin")
	s := run(signature, "hash-object", "-w", "--stdin")
	tree := run([]byte(fmt.Sprintf("100644 blob %s\tchordv-release.json\n100644 blob %s\tchordv-release.json.sig\n", m, s)), "mktree")
	commit := run(nil, "commit-tree", tree, "-m", "public metadata only")
	tag := manifest["tag"].(string)
	prefix := "/repos/owner/repo/git/"
	encode := func(value any) []byte { data, _ := json.Marshal(value); return data }
	f := &schema2Fixture{body: body, signature: signature, public: base64.StdEncoding.EncodeToString(public), routes: map[string][]byte{}}
	f.routes[prefix+"ref/tags/"+tag] = encode(map[string]any{"object": map[string]any{"sha": commit, "type": "commit"}})
	f.routes[prefix+"commits/"+commit] = encode(map[string]any{"sha": commit, "tree": map[string]any{"sha": tree}, "parents": []any{}})
	f.routes[prefix+"trees/"+tree] = encode(map[string]any{"sha": tree, "truncated": false, "tree": []any{map[string]any{"mode": "100644", "type": "blob", "path": "chordv-release.json", "sha": m}, map[string]any{"mode": "100644", "type": "blob", "path": "chordv-release.json.sig", "sha": s}}})
	for oid, data := range map[string][]byte{m: body, s: signature} {
		f.routes[prefix+"blobs/"+oid] = encode(map[string]any{"sha": oid, "encoding": "base64", "size": len(data), "content": base64.StdEncoding.EncodeToString(data)})
	}
	canonical := "/owner/repo/releases/download/" + tag + "/chordv-release.json"
	f.routes[canonical] = body
	f.routes[canonical+".sig"] = signature
	f.routes["/owner/repo/release-channels/stable.json"] = body
	f.routes["/owner/repo/release-channels/stable.json.sig"] = signature
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.calls.Add(1)
		if r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" {
			t.Error("public binding received credentials")
			w.WriteHeader(400)
			return
		}
		f.mu.RLock()
		data, ok := f.routes[r.URL.Path]
		data = bytes.Clone(data)
		f.mu.RUnlock()
		if !ok {
			w.WriteHeader(404)
			return
		}
		_, _ = w.Write(data)
	}))
	t.Cleanup(server.Close)
	address := strings.TrimPrefix(server.URL, "http://")
	f.transport = &http.Transport{Proxy: nil, DialTLSContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, address)
	}}
	t.Cleanup(f.transport.CloseIdleConnections)
	return f
}
func (f *schema2Fixture) changeJSON(t *testing.T, contains string, mutate func(map[string]any)) {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	for path, data := range f.routes {
		if strings.Contains(path, contains) {
			var value map[string]any
			if json.Unmarshal(data, &value) != nil {
				t.Fatal("bad fixture JSON")
			}
			mutate(value)
			f.routes[path], _ = json.Marshal(value)
			return
		}
	}
	t.Fatal("fixture route not found", contains)
}
