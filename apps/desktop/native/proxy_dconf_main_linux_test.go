//go:build linux

package main

import (
	"os"
	"testing"
)

func TestMain(m *testing.M) {
	if len(os.Args) == 3 && os.Args[1] == "--proxy-watchdog" {
		// Exercise the production child entry point, not a replacement proxy store.
		main()
		return
	}
	os.Exit(m.Run())
}
