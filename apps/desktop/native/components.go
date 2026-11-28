package main

import (
	"archive/zip"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
)

type installedComponent struct {
	Kind            string  `json:"kind"`
	VersionLabel    *string `json:"versionLabel"`
	ArtifactSHA256  string  `json:"artifactSha256"`
	InstalledSHA256 string  `json:"installedSha256"`
	InstalledSize   int64   `json:"installedSize"`
}

func (s *DesktopService) componentPath(kind string) (string, error) {
	switch kind {
	case "xray":
		return filepath.Join(s.binDir(), xrayFileName()), nil
	case "geoip", "geosite":
		return filepath.Join(s.binDir(), kind+".dat"), nil
	default:
		return "", errors.New("未知运行组件")
	}
}
func (s *DesktopService) componentMetadata(kind string) (installedComponent, error) {
	var record installedComponent
	if _, err := os.Lstat(filepath.Join(s.binDir(), componentWorkName(kind))); err == nil {
		return record, errors.New("组件安装尚未完成恢复，请重启应用")
	} else if !os.IsNotExist(err) {
		return record, err
	}
	data, err := os.ReadFile(filepath.Join(s.binDir(), kind+".json"))
	if err != nil {
		return record, err
	}
	if err = json.Unmarshal(data, &record); err != nil {
		return record, err
	}
	if record.Kind != kind || record.InstalledSize <= 0 {
		return record, errors.New("运行组件安装记录无效")
	}
	return record, nil
}
func (s *DesktopService) checkComponent(item componentItem) (any, error) {
	path, err := s.componentPath(item.Component)
	if err != nil {
		return nil, err
	}
	result := map[string]any{"ready": false, "exists": false, "path": path, "reasonCode": "component_missing", "message": "运行组件尚未下载"}
	info, err := os.Stat(path)
	if os.IsNotExist(err) {
		return result, nil
	}
	if err != nil {
		return nil, err
	}
	result["exists"] = info.Mode().IsRegular()
	record, err := s.componentMetadata(item.Component)
	if err != nil {
		result["reasonCode"] = "component_invalid"
		result["message"] = "运行组件缺少校验记录，请重新下载"
		return result, nil
	}
	if item.ChecksumSHA256 == nil || !strings.EqualFold(record.ArtifactSHA256, *item.ChecksumSHA256) {
		result["reasonCode"] = "component_invalid"
		result["message"] = "运行组件版本与发布清单不一致"
		return result, nil
	}
	if err := verifyFile(path, record.InstalledSHA256, record.InstalledSize); err != nil {
		result["reasonCode"] = "component_invalid"
		result["message"] = "运行组件校验失败，请重新下载"
		return result, nil
	}
	result["ready"] = true
	result["reasonCode"] = nil
	result["message"] = nil
	return result, nil
}
func (s *DesktopService) componentLocalInfo(kind string) (any, error) {
	path, err := s.componentPath(kind)
	if err != nil {
		return nil, err
	}
	result := map[string]any{"kind": kind, "exists": false, "verified": false, "path": path, "sizeBytes": nil, "checksumSha256": nil, "versionLabel": nil}
	info, err := os.Stat(path)
	if os.IsNotExist(err) {
		return result, nil
	}
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return result, nil
	}
	result["exists"] = true
	result["sizeBytes"] = info.Size()
	hash, err := fileSHA256(path)
	if err != nil {
		return nil, err
	}
	result["checksumSha256"] = hash
	if record, err := s.componentMetadata(kind); err == nil && record.InstalledSize == info.Size() && record.InstalledSHA256 == hash {
		result["verified"] = true
		result["versionLabel"] = record.VersionLabel
	}
	return result, nil
}
func (s *DesktopService) ensureComponents() (any, error) {
	missing := []string{}
	for _, kind := range []string{"xray", "geoip", "geosite"} {
		info, err := s.componentLocalInfo(kind)
		if err != nil || info.(map[string]any)["verified"] != true {
			missing = append(missing, kind)
		}
	}
	return map[string]any{"ready": len(missing) == 0, "runtimeBinDir": s.binDir(), "copiedComponents": []string{}, "missingComponents": missing, "message": nil}, nil
}
func (s *DesktopService) downloadComponent(ctx context.Context, raw json.RawMessage) (result any, err error) {
	if err = requireUnusedMacUpdateJournal(s.cfg.DataDir); err != nil {
		return nil, err
	}
	var input struct {
		Component         componentItem `json:"component"`
		URL               string        `json:"url"`
		MinBytesPerSecond int64         `json:"minBytesPerSecond"`
	}
	if err = decode(raw, &input); err != nil {
		return nil, err
	}
	item := input.Component
	target, err := s.componentPath(item.Component)
	if err != nil {
		return nil, err
	}
	if item.ChecksumSHA256 == nil || item.FileSizeBytes == nil {
		return nil, errors.New("组件发布清单缺少校验值或文件大小")
	}
	hash, err := normalizedSHA256(*item.ChecksumSHA256)
	if err != nil {
		return nil, err
	}
	grant, err := s.authorizedDownload(input.URL, hash, *item.FileSizeBytes)
	if err != nil {
		return nil, err
	}
	entry := ""
	if item.ArchiveEntryName != nil {
		entry = *item.ArchiveEntryName
	}
	if grant.Component != item.Component || grant.FileName != item.FileName || grant.SourceFormat != item.SourceFormat || grant.ArchiveEntryName != entry {
		return nil, errors.New("组件安装目标与已授权发布清单不一致")
	}
	ctx, finish, err := s.beginDownload(ctx)
	if err != nil {
		return nil, err
	}
	defer finish()
	event := downloadProgress{Phase: "preparing", Component: item.Component, FileName: &item.FileName, TotalBytes: item.FileSizeBytes}
	emit := func() { s.publish("chordv://runtime-component-download-progress", event) }
	emit()
	defer func() {
		if err != nil {
			event.Phase = "failed"
			event.Message = pointer(err.Error())
			emit()
		}
	}()
	archive := filepath.Join(s.cfg.DataDir, "downloads", hash+".download")
	event.Phase = "downloading"
	if err = downloadVerified(ctx, input.URL, archive, hash, *item.FileSizeBytes, input.MinBytesPerSecond, func(n int64, total *int64) { event.DownloadedBytes = n; event.TotalBytes = total; emit() }); err != nil {
		return nil, err
	}
	event.Phase = "verifying"
	emit()
	installedPath := archive
	if item.SourceFormat == "zip_entry" {
		if item.ArchiveEntryName == nil || strings.TrimSpace(*item.ArchiveEntryName) == "" {
			return nil, errors.New("组件压缩包缺少文件名称")
		}
		event.Phase = "extracting"
		emit()
		installedPath = archive + ".extracted"
		if err = extractZipEntry(archive, *item.ArchiveEntryName, installedPath); err != nil {
			return nil, err
		}
		defer os.Remove(installedPath)
	} else if item.SourceFormat != "direct" {
		return nil, errors.New("不支持的组件压缩格式")
	}
	installedHash, err := fileSHA256(installedPath)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(installedPath)
	if err != nil {
		return nil, err
	}
	s.operationMu.Lock()
	defer s.operationMu.Unlock()
	if err = ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.Lock()
	active := s.runtime.process != nil
	s.mu.Unlock()
	if active && item.Component == "xray" {
		return nil, errors.New("请先断开连接，再更新运行内核")
	}
	if err = s.verifyGrantReceipt(grant); err != nil {
		return nil, err
	}
	record := installedComponent{Kind: item.Component, VersionLabel: item.VersionLabel, ArtifactSHA256: hash, InstalledSHA256: installedHash, InstalledSize: info.Size()}
	if err = s.installComponent(ctx, installedPath, record, grant); err != nil {
		return nil, err
	}
	_ = os.Remove(archive)
	event.Phase = "completed"
	event.LocalPath = &target
	emit()
	return map[string]any{"component": item.Component, "localPath": target}, nil
}

func extractZipEntry(archive, entry, destination string) error {
	reader, err := zip.OpenReader(archive)
	if err != nil {
		return errors.New("运行组件压缩包无法打开")
	}
	defer reader.Close()
	var found *zip.File
	for _, file := range reader.File {
		if file.Name == entry {
			if found != nil {
				return errors.New("运行组件压缩包存在同名文件")
			}
			found = file
		}
	}
	if found == nil || !found.Mode().IsRegular() || found.UncompressedSize64 > uint64(maxDownloadBytes) {
		return errors.New("压缩包中的运行组件无效")
	}
	src, err := found.Open()
	if err != nil {
		return err
	}
	defer src.Close()
	dst, err := os.OpenFile(destination, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0700)
	if os.IsExist(err) {
		if err = os.Remove(destination); err == nil {
			dst, err = os.OpenFile(destination, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0700)
		}
	}
	if err != nil {
		return err
	}
	n, err := io.Copy(dst, io.LimitReader(src, maxDownloadBytes+1))
	closeErr := dst.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	if n > maxDownloadBytes || n != int64(found.UncompressedSize64) {
		return errors.New("运行组件解压长度异常")
	}
	return nil
}
func copyAtomic(source, destination string, mode os.FileMode) error {
	return copyAtomicContext(context.Background(), source, destination, mode)
}
