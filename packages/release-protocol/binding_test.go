package releaseprotocol

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestDeclarationSchemaRepositoryAndLegacy(t *testing.T) {
	valid := &TagBinding{Mode: "signed-manifest-tree", Repository: "owner/repo"}
	source := strings.Repeat("a", 40)
	for _, schema := range []int{0, 1, 3} {
		if _, err := Validate(schema, valid, source, "owner/repo", true); err == nil {
			t.Fatal("schema accepted", schema)
		}
	}
	for _, input := range []struct {
		b            *TagBinding
		repo, source string
		key          bool
	}{{valid, "other/repo", source, true}, {valid, "owner/repo", source, false}, {nil, "owner/repo", source, true}, {&TagBinding{Mode: "unknown"}, "owner/repo", source, true}, {valid, "owner/repo", "bad", true}} {
		if _, err := Validate(2, input.b, input.source, input.repo, input.key); err == nil {
			t.Fatal("invalid new declaration accepted")
		}
	}
	if projected, err := Validate(2, valid, source, "Owner/Repo", true); err != nil || !projected {
		t.Fatal(err)
	}
	for _, binding := range []*TagBinding{nil, {Mode: "source-commit"}} {
		if projected, err := Validate(1, binding, "", "", false); err != nil || projected {
			t.Fatal("legacy semantics changed", err)
		}
	}
}
func TestActualGitMetadataObjectsAndRawByteMutants(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "metadata.git")
	cmd := exec.Command("git", "init", "--bare", dir)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("%v %s", err, out)
	}
	git := func(input string, args ...string) string {
		cmd := exec.Command("git", append([]string{"--git-dir=" + dir, "-c", "commit.gpgsign=false"}, args...)...)
		cmd.Stdin = strings.NewReader(input)
		cmd.Env = append(os.Environ(), "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL="+os.DevNull, "GIT_AUTHOR_NAME=Protocol Test", "GIT_AUTHOR_EMAIL=test@example.invalid", "GIT_COMMITTER_NAME=Protocol Test", "GIT_COMMITTER_EMAIL=test@example.invalid")
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("%v %s", err, out)
		}
		return strings.TrimSpace(string(out))
	}
	_, private, _ := ed25519.GenerateKey(rand.Reader)
	body := []byte("{\"schemaVersion\":2}\n")
	signature := []byte(base64.StdEncoding.EncodeToString(ed25519.Sign(private, body)) + "\n")
	m := git(string(body), "hash-object", "-w", "--stdin")
	s := git(string(signature), "hash-object", "-w", "--stdin")
	tree := git(fmt.Sprintf("100644 blob %s\tchordv-release.json\n100644 blob %s\tchordv-release.json.sig\n", m, s), "mktree")
	commit := git("", "commit-tree", tree, "-m", "metadata only")
	encode := func(value any) []byte { bytes, _ := json.Marshal(value); return bytes }
	prefix := "/repos/owner/repo/git/"
	responses := map[string][]byte{prefix + "ref/tags/v2.0.0": encode(map[string]any{"object": map[string]any{"type": "commit", "sha": commit}}), prefix + "commits/" + commit: encode(map[string]any{"sha": commit, "tree": map[string]any{"sha": tree}, "parents": []any{}}), prefix + "trees/" + tree: encode(map[string]any{"sha": tree, "truncated": false, "tree": []any{map[string]any{"mode": "100644", "type": "blob", "path": "chordv-release.json", "sha": m}, map[string]any{"mode": "100644", "type": "blob", "path": "chordv-release.json.sig", "sha": s}}})}
	for oid, data := range map[string][]byte{m: body, s: signature} {
		responses[prefix+"blobs/"+oid] = encode(map[string]any{"sha": oid, "encoding": "base64", "size": len(data), "content": base64.StdEncoding.EncodeToString(data)})
	}
	read := func(ctx context.Context, path string, max int64) ([]byte, error) {
		raw, ok := responses[path]
		if !ok {
			return nil, fmt.Errorf("unexpected typed path %s", path)
		}
		if int64(len(raw)) > max {
			t.Fatal("read limit ignored")
		}
		return raw, nil
	}
	if observation, err := Verify(context.Background(), read, "Owner/Repo", "v2.0.0", "chordv-release.json", body, signature); err != nil || observation.Commit != commit {
		t.Fatal("actual Git objects rejected", err)
	}
	annotated := git(fmt.Sprintf("object %s\ntype commit\ntag v2.0.0\ntagger Protocol Test <test@example.invalid> 1794960000 +0000\n\nmetadata tag\n", commit), "mktag")
	responses[prefix+"ref/tags/v2.0.0"] = encode(map[string]any{"object": map[string]any{"type": "tag", "sha": annotated}})
	responses[prefix+"tags/"+annotated] = encode(map[string]any{"sha": annotated, "object": map[string]any{"type": "commit", "sha": commit}})
	if observation, err := Verify(context.Background(), read, "owner/repo", "v2.0.0", "chordv-release.json", body, signature); err != nil || observation.Commit != commit {
		t.Fatal("actual annotated tag rejected", err)
	}
	if _, err := Verify(context.Background(), read, "owner/repo", "v2.0.0", "chordv-release.json", body, []byte(strings.TrimSpace(string(signature)))); err == nil {
		t.Fatal("raw signature mutation accepted")
	}
	responses[prefix+"commits/"+commit] = encode(map[string]any{"sha": commit, "tree": map[string]any{"sha": tree}, "parents": []any{map[string]any{"sha": strings.Repeat("a", 40)}}})
	if _, err := Verify(context.Background(), read, "owner/repo", "v2.0.0", "chordv-release.json", body, signature); err == nil {
		t.Fatal("parent history accepted")
	}
}
