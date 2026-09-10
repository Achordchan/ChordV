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
