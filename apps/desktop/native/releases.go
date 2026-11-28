package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"path/filepath"
	"regexp"
	"strings"

	releaseprotocol "github.com/Achordchan/ChordV/packages/releaseprotocol"
)

type releaseAssetGrant struct {
	SHA256           string
	Size             int64
	FileName         string
	Component        string
	SourceFormat     string
	ArchiveEntryName string
	AllowMirror      bool
	Tag              string
	Version          string
	Channel          string
	Build            int64
	Manifest         string
	Signature        string
}
type releaseAsset struct {
	Platform         string `json:"platform"`
	Architecture     string `json:"architecture"`
	FileName         string `json:"fileName"`
	SHA256           string `json:"sha256"`
	SizeBytes        int64  `json:"sizeBytes"`
	Component        string `json:"component"`
	SourceFormat     string `json:"sourceFormat"`
	ArchiveEntryName string `json:"archiveEntryName"`
}
type releaseManifest struct {
	SourceCommit      string                      `json:"sourceCommit"`
	TagBinding        *releaseprotocol.TagBinding `json:"tagBinding,omitempty"`
	SchemaVersion     int                         `json:"schemaVersion"`
	Tag               string                      `json:"tag"`
	Version           string                      `json:"version"`
	Channel           string                      `json:"channel"`
	Build             int64                       `json:"build"`
	Installers        []releaseAsset              `json:"installers"`
	RuntimeComponents []releaseAsset              `json:"runtimeComponents"`
}

var releaseTagPattern = regexp.MustCompile(`^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$`)

func validRepository(repository string) bool {
	_, err := releaseprotocol.CanonicalRepository(repository)
	return err == nil
}

func canonicalGitHubURL(address string) (string, bool, error) {
	u, err := url.Parse(address)
	if err != nil {
		return "", false, errors.New("GitHub 地址无效")
	}
	if strings.EqualFold(u.Hostname(), "ghfast.top") {
		inner, err := url.PathUnescape(strings.TrimPrefix(u.EscapedPath(), "/"))
		if err != nil {
			return "", false, err
		}
		if !strings.HasPrefix(inner, "https://github.com/") && !strings.HasPrefix(inner, "https://raw.githubusercontent.com/") {
			return "", false, errors.New("镜像原始来源无效")
		}
		if u.RawQuery != "" {
			inner += "?" + u.RawQuery
		}
		parsed, err := url.Parse(inner)
		if err != nil {
			return "", false, err
		}
		parsed.RawPath = ""
		return parsed.String(), true, nil
	}
	u.RawPath = ""
	return u.String(), false, nil
}

func (s *DesktopService) validateReleaseTextURL(address string) error {
	if !validRepository(s.cfg.ReleaseRepository) {
		return errors.New("尚未配置 GitHub 发布仓库")
	}
	origin, mirror, err := canonicalGitHubURL(address)
	if err != nil {
		return err
	}
	if mirror && s.cfg.ReleasePublicKey == "" {
		return errors.New("未配置发布验签公钥，不能使用下载镜像")
	}
	u, err := url.Parse(origin)
	if err != nil || u.Scheme != "https" || u.User != nil || u.Fragment != "" {
		return errors.New("GitHub 发布信息地址无效")
	}
	repository := s.cfg.ReleaseRepository
	switch u.Host {
	case "raw.githubusercontent.com":
		prefix := "/" + repository + "/release-channels/"
		name := strings.TrimPrefix(u.Path, prefix)
		if !strings.HasPrefix(u.Path, prefix) || (name != "stable.json" && name != "stable.json.sig" && name != "beta.json" && name != "beta.json.sig") || u.RawQuery != "" {
			return errors.New("仅允许读取已配置仓库的发布渠道清单")
		}
	case "github.com":
		prefix := "/" + repository + "/releases/download/"
		rest := strings.TrimPrefix(u.Path, prefix)
		tag, file, ok := strings.Cut(rest, "/")
		if !strings.HasPrefix(u.Path, prefix) || !ok || !releaseTagPattern.MatchString(tag) || (file != "chordv-release.json" && file != "chordv-release.json.sig") || u.RawQuery != "" {
			return errors.New("仅允许读取固定版本的发布清单")
		}
	case "api.github.com":
		if u.Path != "/repos/"+repository+"/releases" || mirror {
			return errors.New("仅允许读取已配置仓库的发布历史")
		}
	default:
		return errors.New("发布信息来源不受信任")
	}
	return nil
}

func (s *DesktopService) authorizeReleaseManifest(ctx context.Context, raw json.RawMessage) (any, error) {
	var input struct {
		Manifest  string `json:"manifest"`
		Signature string `json:"signature"`
		Tag       string `json:"tag"`
	}
	if err := decode(raw, &input); err != nil {
		return nil, err
	}
	if !validRepository(s.cfg.ReleaseRepository) || !releaseTagPattern.MatchString(input.Tag) {
		return nil, errors.New("发布仓库或固定版本标签无效")
	}
	if len(input.Manifest) > 1<<20 {
		return nil, errors.New("发布清单过大")
	}
	var manifest releaseManifest
	if err := json.Unmarshal([]byte(input.Manifest), &manifest); err != nil {
		return nil, errors.New("发布清单格式无效")
	}
	if _, err := releaseprotocol.Validate(manifest.SchemaVersion, manifest.TagBinding, manifest.SourceCommit, s.cfg.ReleaseRepository, s.cfg.ReleasePublicKey != ""); err != nil {
		return nil, err
	}
	allowMirror := false
	if s.cfg.ReleasePublicKey != "" {
		verified, err := verifyManifestSignature(input.Manifest, input.Signature, s.cfg.ReleasePublicKey)
		if err != nil || !verified {
			return nil, errors.New("GitHub 发布清单签名验证失败")
		}
		allowMirror = true
	} else {
		address := "https://github.com/" + s.cfg.ReleaseRepository + "/releases/download/" + url.PathEscape(input.Tag) + "/chordv-release.json"
		response, err := fetchRemoteText(ctx, address)
		if err != nil {
			return nil, err
		}
		result, ok := response.(map[string]any)
		if !ok || result["status"] != http.StatusOK || result["body"] != input.Manifest {
			return nil, errors.New("发布清单与 GitHub 固定版本原文不一致")
		}
	}
	if manifest.Tag != input.Tag || manifest.Tag != "v"+manifest.Version || len(manifest.Version) > 64 || (manifest.Channel != "stable" && manifest.Channel != "beta") || manifest.Build < 1 || len(manifest.Installers) == 0 {
		return nil, errors.New("发布清单版本或渠道无效")
	}
	grants := map[string]releaseAssetGrant{}
	for _, asset := range append(manifest.Installers, manifest.RuntimeComponents...) {
		hash, err := normalizedSHA256(asset.SHA256)
		if err != nil {
			return nil, err
		}
		if asset.FileName == "" || asset.FileName != filepath.Base(asset.FileName) || strings.ContainsAny(asset.FileName, "\\/:") || strings.Contains(asset.FileName, "..") || asset.SizeBytes <= 0 || asset.SizeBytes > maxDownloadBytes {
			return nil, errors.New("发布清单文件名称或大小无效")
		}
		if asset.Platform != platformName() || asset.Architecture != architectureName() {
			continue
		}
		address := "https://github.com/" + s.cfg.ReleaseRepository + "/releases/download/" + url.PathEscape(manifest.Tag) + "/" + url.PathEscape(asset.FileName)
		if _, exists := grants[address]; exists {
			return nil, errors.New("发布清单包含重复文件")
		}
		grants[address] = releaseAssetGrant{SHA256: hash, Size: asset.SizeBytes, FileName: asset.FileName, Component: asset.Component, SourceFormat: asset.SourceFormat, ArchiveEntryName: asset.ArchiveEntryName, AllowMirror: allowMirror, Tag: manifest.Tag, Version: manifest.Version, Build: manifest.Build, Channel: manifest.Channel, Manifest: input.Manifest, Signature: input.Signature}
	}
	if err := s.verifyReleaseBinding(ctx, manifest, input.Manifest, input.Signature); err != nil {
		return nil, err
	}
	s.authorizedMu.Lock()
	defer s.authorizedMu.Unlock()
	if err := s.confirmRelease(manifest, input.Manifest); err != nil {
		return nil, err
	}
	for address, grant := range grants {
		s.authorized[address] = grant
	}
	return map[string]any{"ok": true, "authorizedAssets": len(grants)}, nil
}

func (s *DesktopService) authorizedDownload(address, hash string, size int64) (releaseAssetGrant, error) {
	origin, mirror, err := canonicalGitHubURL(address)
	if err != nil {
		return releaseAssetGrant{}, err
	}
	s.authorizedMu.Lock()
	defer s.authorizedMu.Unlock()
	grant, exists := s.authorized[origin]
	if !exists || !strings.EqualFold(grant.SHA256, hash) || grant.Size != size {
		return releaseAssetGrant{}, errors.New("下载未获得原生发布清单授权，请重新检查更新")
	}
	if err := s.checkReleaseFloor(grant); err != nil {
		return releaseAssetGrant{}, err
	}
	if mirror && !grant.AllowMirror {
		return releaseAssetGrant{}, errors.New("未验签的发布清单不能使用镜像下载")
	}
	return grant, nil
}

func (s *DesktopService) authorizedProbe(address string) error {
	origin, mirror, err := canonicalGitHubURL(address)
	if err != nil {
		return err
	}
	s.authorizedMu.Lock()
	defer s.authorizedMu.Unlock()
	grant, exists := s.authorized[origin]
	if !exists || (mirror && !grant.AllowMirror) {
		return errors.New("下载源未获得原生发布清单授权")
	}
	return nil
}
