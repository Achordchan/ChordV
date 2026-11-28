package durable

import (
	"os"
	"path/filepath"
	"testing"
)

func TestProcessLockExcludesSecondAgentAndReleases(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent.db")
	release, err := AcquireProcessLock(path)
	if err != nil {
		t.Fatal(err)
	}
	if second, err := AcquireProcessLock(path); err == nil {
		second()
		t.Fatal("second writer accepted")
	}
	release()
	next, err := AcquireProcessLock(path)
	if err != nil {
		t.Fatal(err)
	}
	next()
}

func TestProcessLockRefusesSymlink(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "other")
	if err := os.WriteFile(target, []byte("preserve"), 0600); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "agent.db")
	if err := os.Symlink(target, path+".lock"); err != nil {
		t.Fatal(err)
	}
	if release, err := AcquireProcessLock(path); err == nil {
		release()
		t.Fatal("symlink accepted")
	}
	data, _ := os.ReadFile(target)
	if string(data) != "preserve" {
		t.Fatal("unrelated file changed")
	}
}

func TestProcessLockFirstBootAndRestartUnderRestrictiveUmask(t *testing.T) {
	for _, nested := range []bool{false, true} {
		name := "provisioned"
		if nested {
			name = "new-directories"
		}
		t.Run(name, func(t *testing.T) {
			root := t.TempDir()
			dir := root
			if nested {
				dir = filepath.Join(dir, "agent", "state")
			}
			db := filepath.Join(dir, "agent.db")
			before, err := os.Stat(root)
			if err != nil {
				t.Fatal(err)
			}
			original := umask(0277)
			defer umask(original)
			first, err := AcquireProcessLock(db)
			if err != nil {
				t.Fatal("first boot", err)
			}
			first()
			next, err := AcquireProcessLock(db)
			if err != nil {
				t.Fatal("restart", err)
			}
			defer next()
			if other, err := AcquireProcessLock(db); err == nil {
				other()
				t.Fatal("accepted duplicate writer")
			}
			info, err := os.Stat(db + ".lock")
			if err != nil || info.Mode().Perm() != SecretMode {
				t.Fatal("new lock mode", info, err)
			}
			after, err := os.Stat(root)
			if err != nil || after.Mode().Perm() != before.Mode().Perm() {
				t.Fatal("pre-existing directory changed", after, err)
			}
		})
	}
}

func TestProcessLockReusesLegacyReadOnlyFileWithoutReplacingIt(t *testing.T) {
	db := filepath.Join(t.TempDir(), "agent.db")
	path := db + ".lock"
	if err := os.WriteFile(path, []byte("keep"), 0400); err != nil {
		t.Fatal(err)
	}
	before, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	release, err := AcquireProcessLock(db)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	if second, err := AcquireProcessLock(db); err == nil {
		second()
		t.Fatal("duplicate writer")
	}
	after, err := os.Stat(path)
	if err != nil || !os.SameFile(before, after) || after.Mode().Perm() != 0400 {
		t.Fatal("legacy lock changed", err)
	}
	data, err := os.ReadFile(path)
	if err != nil || string(data) != "keep" {
		t.Fatal("lock contents changed", err)
	}
}
