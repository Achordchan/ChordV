//go:build darwin || linux

package main

import "golang.org/x/sys/unix"

// A report replaced by a FIFO between Lstat and Open must not block startup.
const installReportOpenFlags = unix.O_RDONLY | unix.O_NONBLOCK
