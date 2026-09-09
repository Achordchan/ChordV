//go:build unix

package store

import (
	"os"
	"syscall"
)

// fileOwner reports the uid owning path. The read-only health probe uses it to
// refuse running as anyone but the service user, BEFORE SQLite is opened — see
// openReadOnly for why ownership rather than file existence is the invariant.
func fileOwner(path string) (int, error) {
	info, err := os.Stat(path)
	if err != nil {
		return 0, err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return 0, os.ErrInvalid
	}
	return int(stat.Uid), nil
}
