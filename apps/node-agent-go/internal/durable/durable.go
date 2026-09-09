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
	"errors"
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

// missingAncestors lists the directories of path that do not exist yet,
// shallowest first — i.e. exactly what a following MkdirAll will create.
func missingAncestors(directory string) []string {
	var missing []string
	current := directory
	for {
		if _, err := os.Stat(current); err == nil {
			break
		}
		missing = append(missing, current)
		parent := filepath.Dir(current)
		if parent == current {
			break
		}
		current = parent
	}
	for left, right := 0, len(missing)-1; left < right; left, right = left+1, right-1 {
		missing[left], missing[right] = missing[right], missing[left]
	}
	return missing
}

// makeDirs creates the given chain shallowest-first, fixing each level's mode
// as it goes.
//
// This is os.MkdirAll's job, except that MkdirAll's mode is masked by umask —
// and it does not stop there: under 0277 it creates the first level as 0500 and
// then immediately fails trying to create the NEXT level inside it. A chmod pass
// afterwards is therefore too late; the mode has to be fixed at each level
// before descending.
//
// A level that already exists (another writer raced us) is kept exactly as it
// is: only a directory this call actually created may have its mode rewritten,
// or a deliberate operator permission would be silently undone.
func makeDirs(chain []string) error {
	for _, made := range chain {
		switch err := os.Mkdir(made, DirMode); {
		case err == nil:
			if err := os.Chmod(made, DirMode); err != nil {
				return err
			}
		case errors.Is(err, os.ErrExist):
			continue
		default:
			return err
		}
	}
	return nil
}

// syncAfterWrite makes the new directory entries durable.
//
// A directory created by an earlier failed attempt can be VISIBLE without its
// own entry being durable, so the directories this call created must be synced
// too — along with the ONE pre-existing ancestor that gained the shallowest of
// them.
//
// It deliberately stops there rather than walking to the filesystem root.
// Ancestors above that gained no entry and are already durable, so syncing them
// achieves nothing — while opening them requires READ permission, which a
// hardened deployment need not grant: a root-owned 0711 parent is searchable but
// not readable, and an unprivileged agent would fail there on every write
// despite owning its own data directory outright.
func syncAfterWrite(directory string, created []string) error {
	if len(created) == 0 {
		return SyncDir(directory)
	}
	for _, made := range created {
		if err := SyncDir(made); err != nil {
			return err
		}
	}
	// The only pre-existing directory involved. If it is not readable, say so
	// precisely: the alternative is a silently non-durable first boot, whose
	// failure mode is a lost registration secret on a one-time token.
	parent := filepath.Dir(created[0])
	if err := SyncDir(parent); err != nil {
		return fmt.Errorf("无法 fsync 上级目录 %s（新建目录项需要对它有读权限才能确保持久化）: %w", parent, err)
	}
	return nil
}

// WriteFile writes contents to file atomically and durably: exclusive temp file
// with an explicit mode, fsync of the contents, atomic rename, then fsync of the
// directory entries this call created. A reader therefore never observes a
// partial file, and a crash leaves either the old file or the new one.
func WriteFile(file string, contents []byte, mode os.FileMode) (err error) {
	file, err = filepath.Abs(file)
	if err != nil {
		return err
	}
	directory := filepath.Dir(file)
	// Recorded BEFORE creating anything: which directories are new decides both
	// whose mode may be rewritten (only ours — a pre-existing directory belongs
	// to the operator) and which entries still need an fsync afterwards.
	created := missingAncestors(directory)
	if err = makeDirs(created); err != nil {
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
	return syncAfterWrite(directory, created)
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
