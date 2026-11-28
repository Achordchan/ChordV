package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
)

type componentCommitState struct {
	Version                                                    int
	Kind                                                       string
	BeforeComponent, BeforeRecord, AfterComponent, AfterRecord *componentFileState
	Grant                                                      releaseAssetGrant
}
type componentInstall struct {
	root                   *os.Root
	work, target, metadata string
	state                  componentCommitState
}

func (s *DesktopService) prepareComponentInstall(ctx context.Context, source string, record installedComponent, grant releaseAssetGrant) (tx *componentInstall, result error) {
	target, err := s.componentPath(record.Kind)
	if err != nil {
		return nil, err
	}
	if record.Kind != grant.Component || record.InstalledSize <= 0 || record.ArtifactSHA256 != grant.SHA256 {
		return nil, errors.New("组件安装记录与授权不一致")
	}
	if err = s.recoverComponentInstall(record.Kind); err != nil {
		return nil, err
	}
	if err = os.MkdirAll(s.binDir(), 0700); err != nil {
		return nil, err
	}
	root, err := os.OpenRoot(s.binDir())
	if err != nil {
		return nil, err
	}
	tx = &componentInstall{root: root, work: componentWorkName(record.Kind), target: filepath.Base(target), metadata: record.Kind + ".json", state: componentCommitState{Version: 1, Kind: record.Kind, Grant: grant}}
	created := false
	defer func() {
		if result != nil {
			if created {
				result = errors.Join(result, cleanComponentWork(root, tx.work))
			}
			root.Close()
		}
	}()
	if tx.state.BeforeComponent, err = componentFileStateAt(root, tx.target); err != nil {
		return tx, err
	}
	if tx.state.BeforeRecord, err = componentFileStateAt(root, tx.metadata); err != nil {
		return tx, err
	}
	if err = root.Mkdir(tx.work, 0700); err != nil {
		return tx, err
	}
	created = true
	for _, backup := range []struct {
		name, file string
		state      *componentFileState
	}{{tx.target, "before-component", tx.state.BeforeComponent}, {tx.metadata, "before-record", tx.state.BeforeRecord}} {
		if err = linkComponentBackup(ctx, root, backup.name, filepath.Join(tx.work, backup.file), backup.state); err != nil {
			return tx, err
		}
	}
	src, err := os.Open(source)
	if err != nil {
		return tx, err
	}
	err = writeComponentFile(ctx, root, filepath.Join(tx.work, "next-component"), src, 0700)
	closeErr := src.Close()
	if err = errors.Join(err, closeErr); err != nil {
		return tx, err
	}
	tx.state.AfterComponent, err = componentFileStateAt(root, filepath.Join(tx.work, "next-component"))
	if err != nil {
		return tx, err
	}
	if tx.state.AfterComponent.SHA256 != record.InstalledSHA256 || tx.state.AfterComponent.Size != record.InstalledSize {
		return tx, errors.New("暂存组件与已核验内容不一致")
	}
	metadata, err := json.MarshalIndent(record, "", "  ")
	if err != nil {
		return tx, err
	}
	if len(metadata) > 16384 {
		return tx, errors.New("组件安装记录过大")
	}
	if err = writeComponentFile(ctx, root, filepath.Join(tx.work, "next-record"), bytes.NewReader(metadata), 0600); err != nil {
		return tx, err
	}
	tx.state.AfterRecord, err = componentFileStateAt(root, filepath.Join(tx.work, "next-record"))
	if err != nil {
		return tx, err
	}
	if err = s.validateComponentCommitReceipt(root, tx.work, tx.state); err != nil {
		return tx, err
	}
	if err = syncComponentDirectory(root, tx.work); err != nil {
		return tx, err
	}
	state, err := json.Marshal(tx.state)
	if err != nil {
		return tx, err
	}
	if len(state) > 4<<20 {
		return tx, errors.New("组件恢复记录过大")
	}
	if err = writeComponentFile(ctx, root, filepath.Join(tx.work, "state.json"), bytes.NewReader(state), 0600); err != nil {
		return tx, err
	}
	if err = syncComponentDirectory(root, tx.work); err != nil {
		return tx, err
	}
	if err = syncComponentDirectory(root, "."); err != nil {
		return tx, err
	}
	return tx, nil
}
func (tx *componentInstall) apply(ctx context.Context, rename func(string, string) error) error {
	if rename == nil {
		rename = tx.root.Rename
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	before, err := componentFileStateAt(tx.root, tx.target)
	if err != nil {
		return err
	}
	metadata, err := componentFileStateAt(tx.root, tx.metadata)
	if err != nil {
		return err
	}
	if !componentStateEqual(before, tx.state.BeforeComponent) || !componentStateEqual(metadata, tx.state.BeforeRecord) {
		return errors.New("组件安装前当前文件已被其他操作修改")
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	if err = rename(filepath.Join(tx.work, "next-component"), tx.target); err != nil {
		return err
	}
	// Once replacement starts, finish or recover the pair even if canceled.
	if err = rename(filepath.Join(tx.work, "next-record"), tx.metadata); err != nil {
		return err
	}
	return errors.Join(syncComponentDirectory(tx.root, "."), syncComponentDirectory(tx.root, tx.work))
}
func (s *DesktopService) installComponent(ctx context.Context, source string, record installedComponent, grant releaseAssetGrant) error {
	release, err := lockRuntimeMutation(s.cfg.DataDir)
	if err != nil {
		return err
	}
	defer release()
	tx, err := s.prepareComponentInstall(ctx, source, record, grant)
	if err != nil {
		return err
	}
	defer tx.root.Close()
	if err = s.verifyGrantReceipt(grant); err == nil {
		err = tx.apply(ctx, nil)
	}
	if err != nil {
		return errors.Join(err, s.recoverComponentInstall(record.Kind))
	}
	return cleanComponentWork(tx.root, tx.work)
}
func readComponentCommit(root *os.Root, work string) (componentCommitState, error) {
	var state componentCommitState
	f, err := root.Open(filepath.Join(work, "state.json"))
	if err != nil {
		return state, err
	}
	defer f.Close()
	decoder := json.NewDecoder(io.LimitReader(f, 4<<20))
	decoder.DisallowUnknownFields()
	if err = decoder.Decode(&state); err != nil {
		return state, err
	}
	if err = decoder.Decode(&struct{}{}); err != io.EOF {
		return state, errors.New("组件安装记录包含额外内容")
	}
	return state, nil
}
