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
// or a deliberate operator permission would be silently undone. The returned
// list is what was ACTUALLY created, which is also the only thing that may be
// rolled back.
func makeDirs(chain []string) ([]string, error) {
	var made []string
	for _, directory := range chain {
		switch err := os.Mkdir(directory, DirMode); {
		case err == nil:
			made = append(made, directory)
			if err := os.Chmod(directory, DirMode); err != nil {
				return made, err
			}
		case errors.Is(err, os.ErrExist):
			continue
		default:
			return made, err
		}
	}
	return made, nil
}

// provisionDir creates the target directory and makes its EXISTENCE durable,
// before anything is written into it.
//
// The ordering matters and the rollback is the point. If the new directory's
// entry cannot be made durable, everything this call created is removed again —
// so the next attempt starts from the same state and fails the same way.
//
// Without the rollback, a first attempt that fails at the parent fsync still
// leaves the directory on disk; the RETRY then finds it existing, syncs only
// the leaf, and reports success. Registration would proceed on that "success",
// spend the one-time token, and a later power loss could still take the
// directory — and with it the recovery secret — leaving a node that can never
// register again. A durability requirement that a retry can forget is not a
// durability requirement.
func provisionDir(directory string) (err error) {
	made, err := makeDirs(missingAncestors(directory))
	defer func() {
		if err == nil || len(made) == 0 {
			return
		}
		// Deepest first, and os.Remove (never RemoveAll): these directories were
		// created empty moments ago, so a non-empty one means someone else is
		// using it and it must be left alone.
		for i := len(made) - 1; i >= 0; i-- {
			_ = os.Remove(made[i])
		}
	}()
	if err != nil {
		return err
	}
	if len(made) == 0 {
		// Pre-existing directory: no new entry, nothing to make durable, and no
		// reason to touch an ancestor the agent may not even be allowed to read.
		return nil
	}
	for _, directory := range made {
		if err = SyncDir(directory); err != nil {
			return err
		}
	}
	// The one pre-existing directory involved: it gained the shallowest new
	// entry. Name it precisely on failure — the fix is to provision the data
	// directory ahead of time (which the installer does, as root).
	parent := filepath.Dir(made[0])
	if err = SyncDir(parent); err != nil {
		return fmt.Errorf(
			"无法 fsync 上级目录 %s（新建目录项需要对它有读权限才能确保持久化；"+
				"请预先创建好数据目录再启动服务）: %w", parent, err)
	}
	return nil
}

// WriteFile writes contents to file atomically and durably: the directory is
// provisioned and made durable first, then an exclusive temp file with an
// explicit mode, fsync of the contents, atomic rename, and fsync of the
// directory. A reader therefore never observes a partial file, and a crash
// leaves either the old file or the new one — never a durable file inside a
// directory that the same crash removes.
func WriteFile(file string, contents []byte, mode os.FileMode) (err error) {
	file, err = filepath.Abs(file)
	if err != nil {
		return err
	}
	directory := filepath.Dir(file)
	// The directory's own existence is made durable BEFORE anything is written
	// into it, so a file can never end up inside a directory a crash may remove.
	if err = provisionDir(directory); err != nil {
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
	// Only the leaf: it is the sole directory that gained an entry here, and it
	// is the one directory the agent is guaranteed to own.
	return SyncDir(directory)
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
