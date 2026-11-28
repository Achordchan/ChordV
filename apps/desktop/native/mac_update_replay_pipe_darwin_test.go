//go:build darwin

package main

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

func TestMacRecoveryPrivatePipesCancellationWakesReadAndFullWrite(t *testing.T) {
	for _, full := range []bool{false, true} {
		t.Run(map[bool]string{false: "waiting-for-ARM", true: "full-READY-output"}[full], func(t *testing.T) {
			input, inputWriter, err := os.Pipe()
			if err != nil {
				t.Fatal(err)
			}
			defer input.Close()
			defer inputWriter.Close()
			outputReader, output, err := os.Pipe()
			if err != nil {
				t.Fatal(err)
			}
			defer outputReader.Close()
			defer output.Close()
			if full {
				raw, err := output.SyscallConn()
				if err != nil {
					t.Fatal(err)
				}
				var fillErr error
				err = raw.Control(func(fd uintptr) {
					if fillErr = unix.SetNonblock(int(fd), true); fillErr != nil {
						return
					}
					for {
						_, fillErr = unix.Write(int(fd), make([]byte, 4096))
						if fillErr != nil {
							return
						}
					}
				})
				if err != nil || !errors.Is(fillErr, unix.EAGAIN) {
					t.Fatal("could not fill private nonblocking output", err, fillErr)
				}
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			timer := time.AfterFunc(50*time.Millisecond, cancel)
			defer timer.Stop()
			started := time.Now()
			h := macRecoveryHandoff{input: input, output: output}
			err = h.confirm(ctx, "isolated-operation generation challenge", started.Add(30*time.Second))
			if !errors.Is(err, context.Canceled) || time.Since(started) > time.Second {
				t.Fatal("private pipe cancellation was delayed or lost", full, time.Since(started), err)
			}
		})
	}
}
