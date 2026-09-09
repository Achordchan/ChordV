//go:build unix

package durable

import "syscall"

// umask is test-only: the mode guarantee is only meaningful when the process
// umask cannot mask it away, so the test sets it explicitly. syscall keeps this
// package dependency-free.
func umask(mask int) int { return syscall.Umask(mask) }
