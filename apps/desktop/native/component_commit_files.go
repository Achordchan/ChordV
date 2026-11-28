package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"runtime"
)

type componentFileState struct {
	SHA256 string
	Size   int64
	Mode   uint32
}

func componentWorkName(kind string) string { return ".component-install-" + kind }
func componentFileStateAt(root *os.Root, name string) (*componentFileState, error) {
	info, err := root.Lstat(name)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, errors.New("组件安装路径不是普通文件")
	}
	f, err := root.Open(name)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	hash := sha256.New()
	size, err := io.Copy(hash, f)
	if err != nil {
		return nil, err
	}
	after, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if size != info.Size() || after.Size() != size || after.ModTime() != info.ModTime() {
		return nil, errors.New("组件文件在核验期间被修改")
	}
	return &componentFileState{SHA256: hex.EncodeToString(hash.Sum(nil)), Size: size, Mode: uint32(info.Mode().Perm())}, nil
}
func componentStateEqual(a, b *componentFileState) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}
func writeComponentFile(ctx context.Context, root *os.Root, name string, reader io.Reader, mode os.FileMode) error {
	f, err := root.OpenFile(name, os.O_CREATE|os.O_EXCL|os.O_WRONLY, mode)
	if err != nil {
		return err
	}
	writeErr := copyContextReader(ctx, f, reader)
	return errors.Join(writeErr, f.Sync(), f.Close())
}
func linkComponentBackup(ctx context.Context, root *os.Root, source, destination string, state *componentFileState) error {
	if state == nil {
		return nil
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	// A same-filesystem hard link preserves the original inode, attributes and ACL.
	// If the filesystem cannot retain it, fail before replacing either visible file.
	if err := root.Link(source, destination); err != nil {
		return err
	}
	actual, err := componentFileStateAt(root, destination)
	if err != nil {
		return err
	}
	if !componentStateEqual(actual, state) {
		return errors.New("组件旧版本备份与原始文件不一致")
	}
	return nil
}
func syncComponentDirectory(root *os.Root, name string) error {
	// Windows directory fsync is not supported here; do not claim power-loss durability.
	if runtime.GOOS == "windows" {
		return nil
	}
	f, err := root.Open(name)
	if err != nil {
		return err
	}
	return errors.Join(f.Sync(), f.Close())
}
func validateComponentWork(root *os.Root, work string) error {
	directory, err := root.Open(work)
	if err != nil {
		return err
	}
	entries, readErr := directory.ReadDir(-1)
	if err = errors.Join(readErr, directory.Close()); err != nil {
		return err
	}
	allowed := map[string]bool{"next-component": true, "next-record": true, "before-component": true, "before-record": true, "state.json": true}
	for _, entry := range entries {
		if !allowed[entry.Name()] || !entry.Type().IsRegular() {
			return errors.New("组件恢复目录包含未知文件，保留全部恢复资料")
		}
	}
	return nil
}
func cleanComponentWork(root *os.Root, work string) error {
	if err := validateComponentWork(root, work); err != nil {
		return err
	}
	// Remove only protocol-owned filenames; never recursively delete unexpected data.
	for _, name := range []string{"next-component", "next-record", "before-component", "before-record", "state.json"} {
		if err := root.Remove(filepath.Join(work, name)); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	if err := root.Remove(work); err != nil && !os.IsNotExist(err) {
		return err
	}
	return syncComponentDirectory(root, ".")
}
