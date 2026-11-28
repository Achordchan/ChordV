package main

import (
	"errors"
	"os"
	"path/filepath"
)

func validComponentFileState(state *componentFileState) bool {
	if state == nil {
		return true
	}
	_, err := normalizedSHA256(state.SHA256)
	return err == nil && state.Size >= 0 && state.Mode <= 0777
}
func (s *DesktopService) recoverComponentInstall(kind string) error {
	target, err := s.componentPath(kind)
	if err != nil {
		return err
	}
	root, err := os.OpenRoot(s.binDir())
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	defer root.Close()
	work := componentWorkName(kind)
	info, err := root.Lstat(work)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("组件恢复目录不是普通目录")
	}
	if err = validateComponentWork(root, work); err != nil {
		return err
	}
	journal, err := componentFileStateAt(root, filepath.Join(work, "state.json"))
	if err != nil {
		return err
	}
	// No committed intent means preparation never crossed a target rename.
	if journal == nil {
		return cleanComponentWork(root, work)
	}
	if journal.Size > 4<<20 {
		return errors.New("组件恢复记录过大")
	}
	state, err := readComponentCommit(root, work)
	if err != nil {
		return err
	}
	if state.Version != 1 || state.Kind != kind || state.AfterComponent == nil || state.AfterRecord == nil || state.AfterComponent.Size <= 0 || state.AfterRecord.Size <= 0 {
		return errors.New("组件恢复记录结构无效")
	}
	for _, file := range []*componentFileState{state.BeforeComponent, state.BeforeRecord, state.AfterComponent, state.AfterRecord} {
		if !validComponentFileState(file) {
			return errors.New("组件恢复文件快照无效")
		}
	}
	data, err := componentFileStateAt(root, filepath.Base(target))
	if err != nil {
		return err
	}
	metadata, err := componentFileStateAt(root, kind+".json")
	if err != nil {
		return err
	}
	beforeData, beforeRecord := componentStateEqual(data, state.BeforeComponent), componentStateEqual(metadata, state.BeforeRecord)
	afterData, afterRecord := componentStateEqual(data, state.AfterComponent), componentStateEqual(metadata, state.AfterRecord)
	if beforeData && beforeRecord {
		return cleanComponentWork(root, work)
	}
	if (!beforeData && !afterData) || (!beforeRecord && !afterRecord) {
		return errors.New("组件恢复发现外部修改，保留当前文件和恢复资料")
	}
	if err = s.validateComponentCommitReceipt(root, work, state); err != nil {
		return err
	}
	if afterData && afterRecord {
		return cleanComponentWork(root, work)
	}
	// Validate every needed backup before changing either currently visible file.
	for _, backup := range []struct {
		name  string
		state *componentFileState
	}{{"before-component", state.BeforeComponent}, {"before-record", state.BeforeRecord}} {
		if backup.state == nil {
			continue
		}
		actual, err := componentFileStateAt(root, filepath.Join(work, backup.name))
		if err != nil {
			return err
		}
		if !componentStateEqual(actual, backup.state) {
			return errors.New("组件恢复旧版本备份校验失败")
		}
	}
	for _, file := range []struct {
		target, backup string
		actual, before *componentFileState
	}{{filepath.Base(target), "before-component", data, state.BeforeComponent}, {kind + ".json", "before-record", metadata, state.BeforeRecord}} {
		if componentStateEqual(file.actual, file.before) {
			continue
		}
		if file.before == nil {
			err = root.Remove(file.target)
		} else {
			err = root.Rename(filepath.Join(work, file.backup), file.target)
		}
		if err != nil {
			return err
		}
	}
	if err = syncComponentDirectory(root, "."); err != nil {
		return err
	}
	return cleanComponentWork(root, work)
}
func (s *DesktopService) recoverComponentInstalls() error {
	for _, kind := range []string{"xray", "geoip", "geosite"} {
		// A freshly launched candidate must be able to acknowledge health while
		// the updater holds the lock. Only contend when there is work to recover.
		if _, err := os.Lstat(filepath.Join(s.binDir(), componentWorkName(kind))); os.IsNotExist(err) {
			continue
		} else if err != nil {
			return err
		}
		release, err := lockRuntimeMutation(s.cfg.DataDir)
		if err != nil {
			return err
		}
		err = s.recoverComponentInstall(kind) // Re-inspects the actual pair under the lock.
		release()
		if err != nil {
			return err
		}
	}
	return nil
}
