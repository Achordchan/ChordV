//go:build darwin

package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"time"
)

const macUpdateHelperBundleName = "helper.app"

func (p *macUpdatePlan) helperExecutable() string {
	if p.HelperBundle == nil {
		// Historical records still need to be inspectable, not executable.
		return filepath.Join(p.Work, "helper")
	}
	return filepath.Join(p.Work, macUpdateHelperBundleName, "Contents", "MacOS", filepath.Base(p.Current.Executable))
}

func (p *macUpdatePlan) stageHelperBundle(ctx context.Context, scope *macCleanupScope) error {
	if err := p.verifyBoundDirectories(); err != nil {
		return err
	}
	path := filepath.Join(p.Work, macUpdateHelperBundleName)
	if err := os.Mkdir(path, 0700); err != nil {
		return err
	}
	owned, err := macNode(path)
	if err != nil {
		return err
	}
	_, copyErr := runMacUpdateCommand(ctx, 90*time.Second, "/usr/bin/ditto", p.Current.Path, path)
	stable, actual, identityErr := readMacFilesystemNode(path)
	if identityErr != nil || actual != owned || stable.VolumeUUID != scope.workspace.VolumeUUID {
		return errors.Join(copyErr, identityErr, errors.New("复制后的更新助手目录不属于本次操作，已保留"))
	}
	// Even an incomplete copy can be discarded if it still belongs to us.
	p.HelperBundle, scope.helper = &stable, &stable
	if copyErr != nil {
		return copyErr
	}
	p.HelperSHA256, err = fileSHA256(p.Current.Executable)
	if err != nil {
		return err
	}
	return p.verifyHelperBundle(ctx)
}

func (p *macUpdatePlan) verifyHelperBundle(ctx context.Context) error {
	if p.HelperBundle == nil {
		return errors.New("独立安装缺少完整的签名应用副本")
	}
	path := filepath.Join(p.Work, macUpdateHelperBundleName)
	clone, err := readMacBundle(ctx, path, true)
	if err != nil {
		return err
	}
	stable, live, err := readMacFilesystemNode(path)
	if err != nil || stable != *p.HelperBundle || live != clone.Node || clone.Executable != p.helperExecutable() || !macBundleSealMatches(clone, p.Current) {
		return errors.New("独立安装助手与已确认的原应用签名或目录身份不一致")
	}
	return verifyFile(clone.Executable, p.HelperSHA256, 0)
}
