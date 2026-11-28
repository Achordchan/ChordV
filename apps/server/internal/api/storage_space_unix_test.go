//go:build darwin || linux

package api

import (
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

func TestStorageAvailableSpaceUsesTheOpenedRootVolume(t *testing.T) {
	parent := t.TempDir()
	dir := filepath.Join(parent, "managed")
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	root, err := os.OpenRoot(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	if err := os.Rename(dir, filepath.Join(parent, "moved")); err != nil {
		t.Fatal(err)
	}
	// The configured name no longer exists: only the already-open root is valid.
	available, err := storageAvailableBytes(root)
	if err != nil {
		t.Fatal("read available space via stale path instead of root FD", err)
	}
	var stat syscall.Statfs_t
	if err := syscall.Statfs(parent, &stat); err != nil {
		t.Fatal(err)
	}
	expected, err := checkedStorageAvailableBytes(uint64(stat.Bavail), uint64(stat.Bsize))
	if err != nil {
		t.Fatal(err)
	}
	var difference uint64
	if expected > available {
		difference = expected - available
	} else {
		difference = available - expected
	}
	if difference > 1<<30 {
		t.Fatal("root FD did not report the same real volume", available, expected)
	}
	if err := root.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := storageAvailableBytes(root); err == nil {
		t.Fatal("closed root produced fabricated capacity")
	}
}
