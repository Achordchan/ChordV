package main

import (
	"archive/zip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
)

func (s *DesktopService) validateComponentCommitReceipt(root *os.Root, work string, state componentCommitState) error {
	if state.Grant.Component != state.Kind {
		return errors.New("组件恢复授权目标不一致")
	}
	if err := s.verifyGrantReceipt(state.Grant); err != nil {
		return err
	}
	recordPath := filepath.Join(work, "next-record")
	snapshot, err := componentFileStateAt(root, recordPath)
	if err != nil {
		return err
	}
	if !componentStateEqual(snapshot, state.AfterRecord) {
		recordPath = state.Kind + ".json"
		snapshot, err = componentFileStateAt(root, recordPath)
		if err != nil {
			return err
		}
	}
	if !componentStateEqual(snapshot, state.AfterRecord) || snapshot.Size > 16384 {
		return errors.New("组件恢复新安装记录不匹配")
	}
	raw, err := root.ReadFile(recordPath)
	if err != nil {
		return err
	}
	var record installedComponent
	if json.Unmarshal(raw, &record) != nil || record.Kind != state.Kind || record.ArtifactSHA256 != state.Grant.SHA256 || record.InstalledSHA256 != state.AfterComponent.SHA256 || record.InstalledSize != state.AfterComponent.Size {
		return errors.New("组件恢复新记录与发布授权不一致")
	}
	if state.Grant.SourceFormat == "direct" {
		if state.AfterComponent.SHA256 != state.Grant.SHA256 || state.AfterComponent.Size != state.Grant.Size {
			return errors.New("组件恢复内容与已签名资产不一致")
		}
		return nil
	}
	if state.Grant.SourceFormat != "zip_entry" {
		return errors.New("组件恢复压缩类型无效")
	}
	archive, err := os.OpenRoot(filepath.Join(s.cfg.DataDir, "downloads"))
	if err != nil {
		return err
	}
	defer archive.Close()
	name := state.Grant.SHA256 + ".download"
	info, err := componentFileStateAt(archive, name)
	if err != nil {
		return err
	}
	if info == nil || info.SHA256 != state.Grant.SHA256 || info.Size != state.Grant.Size {
		return errors.New("组件恢复所需的签名压缩包不可用")
	}
	f, err := archive.Open(name)
	if err != nil {
		return err
	}
	defer f.Close()
	reader, err := zip.NewReader(f, info.Size)
	if err != nil {
		return err
	}
	var entry *zip.File
	for _, candidate := range reader.File {
		if candidate.Name == state.Grant.ArchiveEntryName {
			if entry != nil {
				return errors.New("组件恢复压缩包含重复条目")
			}
			entry = candidate
		}
	}
	if entry == nil || !entry.Mode().IsRegular() || entry.UncompressedSize64 != uint64(state.AfterComponent.Size) || state.AfterComponent.Size > maxDownloadBytes {
		return errors.New("组件恢复压缩条目不匹配")
	}
	stream, err := entry.Open()
	if err != nil {
		return err
	}
	defer stream.Close()
	hash := sha256.New()
	n, err := io.Copy(hash, io.LimitReader(stream, maxDownloadBytes+1))
	if err != nil {
		return err
	}
	if n != state.AfterComponent.Size || hex.EncodeToString(hash.Sum(nil)) != state.AfterComponent.SHA256 {
		return errors.New("组件恢复解压内容与签名压缩包不一致")
	}
	return nil
}
