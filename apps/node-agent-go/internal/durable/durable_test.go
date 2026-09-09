package durable

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWriteFileIsOwnerReadWriteUnderAnyUmask(t *testing.T) {
	// umask can only NARROW the requested mode, so no umask can widen 0600 past
	// owner-only. The failure it CAN cause is the opposite one: under 0277 the
	// create lands as 0400, and the agent rewrites both the pending secret (on
	// every registration attempt) and the credentials file (on re-registration).
	// A read-only credential file turns a recoverable retry into a host that
	// must be fixed by hand. The explicit fchmod is what prevents that.
	// 0200 and 0277 clear an OWNER bit, which is the only kind of mask that
	// changes the outcome: 0022 and 0077 only clear group/other bits, which
	// 0600 does not carry.
	for _, mask := range []int{0, 0o022, 0o077, 0o200, 0o277} {
		// The directory is created BEFORE the mask is applied: a umask that
		// strips owner-write would also strip it from the temp directory, and
		// the test would then fail on the harness rather than on the mode.
		directory := t.TempDir()
		file := filepath.Join(directory, "secret.json")

		original := umask(mask)
		err := WriteSecret(file, map[string]string{"token": "chordv_agent_x"})
		umask(original)

		if err != nil {
			t.Fatalf("umask %o: %v", mask, err)
		}
		info, statErr := os.Stat(file)
		if statErr != nil {
			t.Fatalf("umask %o: %v", mask, statErr)
		}
		if info.Mode().Perm() != SecretMode {
			t.Fatalf("umask %o produced mode %o, want %o", mask, info.Mode().Perm(), SecretMode)
		}
	}
}

func TestWriteFileCanReplaceAFileItAlreadyWrote(t *testing.T) {
	// The end-to-end consequence of the mode above: a registration retry must be
	// able to overwrite the secret it parked on the previous attempt.
	file := filepath.Join(t.TempDir(), "secret.json")
	original := umask(0o200)
	t.Cleanup(func() { umask(original) })
	if err := WriteSecret(file, map[string]string{"attempt": "1"}); err != nil {
		t.Fatal(err)
	}
	if err := WriteSecret(file, map[string]string{"attempt": "2"}); err != nil {
		t.Fatalf("a second write to the agent's own secret failed: %v", err)
	}
	raw, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), `"2"`) {
		t.Fatalf("content = %q, want the second attempt", string(raw))
	}
}

func TestWriteSecretRoundTripsAndEndsWithNewline(t *testing.T) {
	file := filepath.Join(t.TempDir(), "secret.json")
	if err := WriteSecret(file, map[string]string{"agentId": "a1", "nodeId": "n1"}); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	// The Node agent writes a trailing newline; an operator moving between the
	// two implementations must see the same file, not a diff.
	if !strings.HasSuffix(string(raw), "\n") {
		t.Fatalf("secret file has no trailing newline: %q", string(raw))
	}
	var parsed map[string]string
	if err := json.Unmarshal(raw, &parsed); err != nil {
		t.Fatal(err)
	}
	if parsed["agentId"] != "a1" || parsed["nodeId"] != "n1" {
		t.Fatalf("round trip lost fields: %v", parsed)
	}
}

func TestWriteFileLeavesNoTemporaryFilesBehind(t *testing.T) {
	directory := t.TempDir()
	file := filepath.Join(directory, "secret.json")
	if err := WriteSecret(file, map[string]string{"a": "b"}); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(directory)
	if err != nil {
		t.Fatal(err)
	}
	// A stray temp file is not cosmetic: the credentials directory is archived
	// wholesale on an identity reset, and an unexpected member of it would be
	// carried along as if it were state.
	if len(entries) != 1 || entries[0].Name() != "secret.json" {
		names := make([]string, 0, len(entries))
		for _, entry := range entries {
			names = append(names, entry.Name())
		}
		t.Fatalf("directory holds %v, want only secret.json", names)
	}
}

func TestWriteFileReplacesExistingContentAtomically(t *testing.T) {
	file := filepath.Join(t.TempDir(), "secret.json")
	if err := WriteFile(file, []byte("aaaaaaaaaaaaaaaaaaaa"), SecretMode); err != nil {
		t.Fatal(err)
	}
	if err := WriteFile(file, []byte("bb"), SecretMode); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	// Truncate-in-place would leave "bbaaaaaaaaaaaaaaaaaa"; the rename cannot.
	if string(raw) != "bb" {
		t.Fatalf("content = %q, want %q — the write was not a rename", string(raw), "bb")
	}
}

func TestSyncDirRejectsMissingDirectory(t *testing.T) {
	if err := SyncDir(filepath.Join(t.TempDir(), "absent")); err == nil {
		t.Fatal("SyncDir reported success for a directory that does not exist")
	}
}
