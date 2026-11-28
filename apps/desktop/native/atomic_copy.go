package main

import (
	"context"
	"io"
	"os"
	"path/filepath"
)

func copyAtomicContext(ctx context.Context, source, destination string, mode os.FileMode) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	src, err := os.Open(source)
	if err != nil {
		return err
	}
	defer src.Close()
	return writeAtomicContext(ctx, src, destination, mode)
}

func writeAtomicContext(ctx context.Context, source io.Reader, destination string, mode os.FileMode) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(destination), 0700); err != nil {
		return err
	}
	dst, err := os.CreateTemp(filepath.Dir(destination), ".component-*")
	if err != nil {
		return err
	}
	defer os.Remove(dst.Name())
	if err = dst.Chmod(mode); err == nil {
		err = copyContextReader(ctx, dst, source)
	}
	if err == nil {
		err = dst.Sync()
	}
	closeErr := dst.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	// Successful rename commits the replacement. Cancellation after this point
	// must not report that the previous file was preserved.
	return os.Rename(dst.Name(), destination)
}

func copyContextReader(ctx context.Context, destination io.Writer, source io.Reader) error {
	buffer := make([]byte, 128*1024)
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		n, readErr := source.Read(buffer)
		if err := ctx.Err(); err != nil {
			return err
		}
		if n > 0 {
			written, err := destination.Write(buffer[:n])
			if err != nil {
				return err
			}
			if written != n {
				return io.ErrShortWrite
			}
		}
		if readErr != nil {
			if readErr == io.EOF {
				return nil
			}
			return readErr
		}
	}
}
