package main

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"
)

type blockedAtomicCopySource struct {
	first   bool
	started chan struct{}
	release chan struct{}
}

func (r *blockedAtomicCopySource) Read(buffer []byte) (int, error) {
	if !r.first {
		r.first = true
		return copy(buffer, []byte("first new component chunk")), nil
	}
	close(r.started)
	<-r.release
	return copy(buffer, []byte("last new component chunk")), io.EOF
}

func TestAtomicCopyCancellationWhileReadingDoesNotCommit(t *testing.T) {
	destination := filepath.Join(t.TempDir(), "geoip.dat")
	previous := []byte("previous verified component")
	if err := os.WriteFile(destination, previous, 0600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	source := &blockedAtomicCopySource{started: make(chan struct{}), release: make(chan struct{})}
	done := make(chan error, 1)
	go func() { done <- writeAtomicContext(ctx, source, destination, 0700) }()
	<-source.started
	// At least one actual chunk has been written to the private temporary file.
	staged, err := filepath.Glob(filepath.Join(filepath.Dir(destination), ".component-*"))
	if err != nil || len(staged) != 1 {
		t.Fatal("copy did not create one staging file", staged, err)
	}
	if info, err := os.Stat(staged[0]); err != nil || info.Size() == 0 {
		t.Fatal("copy barrier was reached before writing bytes", err)
	}
	cancel()
	close(source.release)
	if err = <-done; !errors.Is(err, context.Canceled) {
		t.Fatal("mid-copy cancellation did not propagate", err)
	}
	actual, err := os.ReadFile(destination)
	if err != nil || !bytes.Equal(actual, previous) {
		t.Fatal("cancelled copy replaced destination", err)
	}
	staged, err = filepath.Glob(filepath.Join(filepath.Dir(destination), ".component-*"))
	if err != nil || len(staged) != 0 {
		t.Fatal("cancelled staging file was retained", staged, err)
	}
}

func TestAtomicCopyContextKeepsLegacyAndSuccessSemantics(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "source")
	data := bytes.Repeat([]byte("actual local file bytes"), 10000)
	if err := os.WriteFile(source, data, 0600); err != nil {
		t.Fatal(err)
	}
	for _, legacy := range []bool{false, true} {
		destination := filepath.Join(root, "context-destination")
		if legacy {
			destination = filepath.Join(root, "legacy-destination")
		}
		var err error
		if legacy {
			err = copyAtomic(source, destination, 0700)
		} else {
			err = copyAtomicContext(context.Background(), source, destination, 0700)
		}
		if err != nil {
			t.Fatal(err)
		}
		actual, err := os.ReadFile(destination)
		if err != nil || !bytes.Equal(actual, data) {
			t.Fatal("copy content changed", err)
		}
		info, err := os.Stat(destination)
		if err != nil || info.Mode().Perm() != 0700 {
			t.Fatal("copy mode changed", err)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	nonexistent := filepath.Join(root, "not-created", "destination")
	if err := copyAtomicContext(ctx, source, nonexistent, 0700); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Dir(nonexistent)); !os.IsNotExist(err) {
		t.Fatal("cancelled copy created destination directory")
	}
}
