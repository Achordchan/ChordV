// Package durable is the agent's only crash-safe write path.
//
// It exists for files whose ABSENCE and whose PRESENCE must both still be true
// after a power loss: the registration secret (writing it must happen strictly
// before the request that spends it) and the reset journal (which turns a
// half-finished identity archive into a resumable one). A plain write gives
// neither guarantee — the bytes may sit in the page cache, and even a synced
// file can lose its directory entry.
package durable

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// SecretMode is owner-read/write. Both the credential file and the pending
// registration secret carry it: the agent runs unprivileged, and anything the
// service user cannot exclusively read is a credential shared with the host.
const SecretMode os.FileMode = 0o600

// DirMode keeps the data directory owner-only for the same reason.
const DirMode os.FileMode = 0o700

// SyncDir flushes a directory's own entries, which is what makes a rename
// survive power loss. Syncing the renamed FILE is not enough: the file's
// contents and its name are durable independently.
func SyncDir(directory string) error {
	handle, err := os.Open(directory)
	if err != nil {
		return err
	}
	defer handle.Close()
	return handle.Sync()
}

// syncChain syncs the directory and every ancestor up to the filesystem root.
// A parent created by an earlier failed attempt can be VISIBLE without its own
// directory entry being durable, so syncing only the immediate parent can leave
// a durable file inside a directory that a crash removes.
func syncChain(directory string) error {
	current := directory
	for {
		if err := SyncDir(current); err != nil {
			return err
		}
		parent := filepath.Dir(current)
		if parent == current {
			return nil
		}
		current = parent
	}
}

// WriteFile writes contents to file atomically and durably: exclusive temp file
// with an explicit mode, fsync of the contents, atomic rename, then fsync of the
// parent chain. A reader therefore never observes a partial file, and a crash
// leaves either the old file or the new one.
func WriteFile(file string, contents []byte, mode os.FileMode) (err error) {
	file, err = filepath.Abs(file)
	if err != nil {
		return err
	}
	directory := filepath.Dir(file)
	if err = os.MkdirAll(directory, DirMode); err != nil {
		return err
	}
	suffix := make([]byte, 8)
	if _, err = rand.Read(suffix); err != nil {
		return err
	}
	temporary := fmt.Sprintf("%s.tmp.%d.%s", file, os.Getpid(), hex.EncodeToString(suffix))

	// O_EXCL so a temp path that somehow already exists (a symlink planted in a
	// world-writable directory) is an error rather than a redirected write.
	handle, err := os.OpenFile(temporary, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if err != nil {
		return err
	}
	defer func() {
		if err != nil {
			// May already have been renamed; either way the caller must not be
			// left with a stray temp file describing a write that did not land.
			_ = os.Remove(temporary)
		}
	}()

	if _, err = handle.Write(contents); err != nil {
		handle.Close()
		return err
	}
	// OpenFile's mode is masked by umask, which can only NARROW it — a service
	// started under umask 0277 gets 0400, a file its own user cannot rewrite.
	// The agent replaces the pending secret on every registration attempt and
	// the credentials file on every re-registration, so a read-only credential
	// file turns a recoverable retry into a permanent failure on that host.
	// Setting the mode on the open descriptor (not the path) also cannot be
	// redirected by a swapped symlink.
	if err = handle.Chmod(mode); err != nil {
		handle.Close()
		return err
	}
	if err = handle.Sync(); err != nil {
		handle.Close()
		return err
	}
	if err = handle.Close(); err != nil {
		return err
	}
	if err = os.Rename(temporary, file); err != nil {
		return err
	}
	return syncChain(directory)
}

// WriteSecret persists a JSON document with owner-only permissions. The
// trailing newline matches the Node agent's on-disk format so an operator
// moving between the two implementations sees the same file.
func WriteSecret(file string, value any) error {
	encoded, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return WriteFile(file, append(encoded, '\n'), SecretMode)
}
