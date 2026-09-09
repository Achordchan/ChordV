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

// TestFirstBootCreatesAWritableDataDirectoryUnderAnyUmask is the case the
// earlier umask test HID by pre-creating the directory. MkdirAll's mode is
// masked just as OpenFile's is, so under 0277 a first boot would create the data
// directory as 0500 — searchable but not writable — and the unprivileged agent
// could never create its temporary secret. Registration would then fail
// permanently until someone repaired the permissions by hand.
func TestFirstBootCreatesAWritableDataDirectoryUnderAnyUmask(t *testing.T) {
	for _, mask := range []int{0, 0o022, 0o077, 0o200, 0o277} {
		root := t.TempDir()
		// Nested and ABSENT: this is a genuine first boot, not a pre-provisioned
		// directory. Both levels are created inside the masked window.
		data := filepath.Join(root, "chordv-node-agent", "state")
		file := filepath.Join(data, "credentials.json")

		original := umask(mask)
		err := WriteSecret(file, map[string]string{"agentId": "a1"})
		umask(original)
		if err != nil {
			t.Fatalf("umask %o: first boot failed: %v", mask, err)
		}

		for _, directory := range []string{filepath.Dir(data), data} {
			info, statErr := os.Stat(directory)
			if statErr != nil {
				t.Fatalf("umask %o: %v", mask, statErr)
			}
			if info.Mode().Perm() != DirMode {
				t.Fatalf("umask %o created %s with mode %o, want %o", mask, directory, info.Mode().Perm(), DirMode)
			}
		}
		// And the agent must be able to write again, which is what a registration
		// retry does.
		original = umask(mask)
		err = WriteSecret(file, map[string]string{"agentId": "a2"})
		umask(original)
		if err != nil {
			t.Fatalf("umask %o: a retry into the freshly created directory failed: %v", mask, err)
		}
	}
}

func TestExistingDirectoryPermissionsAreLeftAlone(t *testing.T) {
	// A pre-existing data directory belongs to the OPERATOR — the installer
	// provisions it. Rewriting its mode would silently undo a deliberate choice
	// (a shared group for an ops account, say).
	root := t.TempDir()
	data := filepath.Join(root, "state")
	if err := os.Mkdir(data, 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(data, 0o750); err != nil {
		t.Fatal(err)
	}
	if err := WriteSecret(filepath.Join(data, "credentials.json"), map[string]string{"a": "b"}); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(data)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o750 {
		t.Fatalf("an operator-owned directory was re-permissioned to %o", info.Mode().Perm())
	}
}

// TestWriteSucceedsUnderASearchableButUnreadableParent covers a hardened
// deployment: a root-owned 0711 parent is searchable but not readable. Syncing
// the whole ancestor chain up to "/" would open it for READ and fail there on
// every single write, even though the agent owns its own data directory
// outright — and the only visible symptom would be registration failing forever.
func TestWriteSucceedsUnderASearchableButUnreadableParent(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root bypasses directory read permission; this case is only meaningful unprivileged")
	}
	root := t.TempDir()
	parent := filepath.Join(root, "lib")
	data := filepath.Join(parent, "chordv-node-agent")
	if err := os.MkdirAll(data, 0o700); err != nil {
		t.Fatal(err)
	}
	// The deployment being modelled is a ROOT-owned 0711 parent, where the agent
	// is "other" and gets --x: traverse, but not list. A test cannot chown to
	// root, so 0311 is used instead — it gives THIS process exactly those
	// effective permissions through the owner bits. Restored on cleanup so
	// t.TempDir can recurse.
	if err := os.Chmod(parent, 0o311); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(parent, 0o700) })

	if handle, err := os.Open(parent); err == nil {
		handle.Close()
		t.Skip("this platform does not enforce directory read permission here (macOS/APFS); the case is exercised on Linux in CI")
	}
	if err := WriteSecret(filepath.Join(data, "credentials.json"), map[string]string{"a": "b"}); err != nil {
		t.Fatalf("a write into an owned directory failed because an ANCESTOR was unreadable: %v", err)
	}
}

func TestMissingAncestorsReportsExactlyWhatWillBeCreated(t *testing.T) {
	root := t.TempDir()
	deep := filepath.Join(root, "a", "b", "c")
	got := missingAncestors(deep)
	want := []string{filepath.Join(root, "a"), filepath.Join(root, "a", "b"), deep}
	if len(got) != len(want) {
		t.Fatalf("missingAncestors = %v, want %v", got, want)
	}
	for i := range want {
		// Shallowest first: chmod must follow creation order, and the sync must
		// start from the entry the pre-existing ancestor gained.
		if got[i] != want[i] {
			t.Fatalf("missingAncestors = %v, want %v", got, want)
		}
	}
	if made := missingAncestors(root); len(made) != 0 {
		t.Fatalf("missingAncestors on an existing directory = %v, want none", made)
	}
}

// TestUndurableDirectoryIsRolledBackSoARetryCannotForgetIt is the regression for
// the retry hole.
//
// If a first write creates the data directory but cannot make its entry durable,
// leaving that directory behind is worse than failing: the RETRY finds it
// existing, has nothing new to sync, and reports success. Registration then
// proceeds on that "success" and spends the one-time token, while a later power
// loss can still take the directory — and with it the only copy of the secret
// that makes the registration replayable. The node could never register again.
//
// So an unfinished provision is rolled back, and every attempt fails identically
// until an operator provisions the directory properly.
func TestUndurableDirectoryIsRolledBackSoARetryCannotForgetIt(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root bypasses directory read permission; this case is only meaningful unprivileged")
	}
	root := t.TempDir()
	parent := filepath.Join(root, "lib")
	if err := os.Mkdir(parent, 0o700); err != nil {
		t.Fatal(err)
	}
	// Writable and searchable, NOT readable: creating the data directory
	// succeeds, fsyncing the parent that gained it does not. (0311 gives this
	// process the same effective rights a root-owned 0711 parent gives the
	// unprivileged agent; a test cannot chown to root.)
	if err := os.Chmod(parent, 0o311); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(parent, 0o700) })
	if handle, err := os.Open(parent); err == nil {
		handle.Close()
		t.Skip("this platform does not enforce directory read permission here (macOS/APFS); exercised on Linux in CI")
	}

	data := filepath.Join(parent, "chordv-node-agent")
	secret := filepath.Join(data, "credentials.json.pending")

	first := WriteSecret(secret, map[string]string{"agentToken": "chordv_agent_x"})
	if first == nil {
		t.Fatal("the first write reported success without making the new directory durable")
	}
	// Nothing may be left behind — neither the half-durable directory nor a
	// secret inside it.
	if _, err := os.Stat(data); err == nil {
		t.Fatal("a directory whose entry could not be made durable was left on disk")
	}

	second := WriteSecret(secret, map[string]string{"agentToken": "chordv_agent_x"})
	if second == nil {
		t.Fatal("the retry silently succeeded: the durability requirement was forgotten between attempts")
	}
	// And the failure must keep naming the directory an operator has to fix.
	if !strings.Contains(second.Error(), parent) {
		t.Fatalf("retry error does not name the offending directory: %v", second)
	}
}

func TestProvisionedDirectorySurvivesForLaterWrites(t *testing.T) {
	// The counterpart: once the directory exists durably, writes into it must not
	// touch the ancestor at all — that is what the round-2 fix guaranteed.
	root := t.TempDir()
	parent := filepath.Join(root, "lib")
	data := filepath.Join(parent, "chordv-node-agent")
	if err := os.MkdirAll(data, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(parent, 0o311); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(parent, 0o700) })

	for attempt := 0; attempt < 3; attempt++ {
		if err := WriteSecret(filepath.Join(data, "credentials.json"), map[string]int{"attempt": attempt}); err != nil {
			t.Fatalf("attempt %d into a pre-provisioned directory failed: %v", attempt, err)
		}
	}
}
