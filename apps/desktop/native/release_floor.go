package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/egoist/mygo"
)

type releaseFloor struct {
	Version string `json:"version"`
	Build   int64  `json:"build"`
	Tag     string `json:"tag"`
	SHA256  string `json:"sha256"`
}

func compareReleaseVersions(left, right string) (int, error) {
	parse := func(value string) ([3]uint64, string, error) {
		value = strings.TrimPrefix(strings.TrimSpace(value), "v")
		if !releaseTagPattern.MatchString("v" + value) {
			return [3]uint64{}, "", errors.New("发布版本格式无效")
		}
		value, _, _ = strings.Cut(value, "+")
		version, prerelease, _ := strings.Cut(value, "-")
		fields := strings.Split(version, ".")
		if len(fields) != 3 {
			return [3]uint64{}, "", errors.New("发布版本格式无效")
		}
		var numbers [3]uint64
		for i, field := range fields {
			number, err := strconv.ParseUint(field, 10, 64)
			if err != nil || number > 9007199254740991 {
				return numbers, "", errors.New("发布版本格式无效")
			}
			numbers[i] = number
		}
		return numbers, prerelease, nil
	}
	a, ap, err := parse(left)
	if err != nil {
		return 0, err
	}
	b, bp, err := parse(right)
	if err != nil {
		return 0, err
	}
	for i := range a {
		if a[i] < b[i] {
			return -1, nil
		}
		if a[i] > b[i] {
			return 1, nil
		}
	}
	if ap == bp {
		return 0, nil
	}
	if ap == "" {
		return 1, nil
	}
	if bp == "" {
		return -1, nil
	}
	partsA, partsB := strings.Split(ap, "."), strings.Split(bp, ".")
	for i := 0; i < min(len(partsA), len(partsB)); i++ {
		if partsA[i] == partsB[i] {
			continue
		}
		isNumeric := func(value string) bool {
			for _, char := range value {
				if char < '0' || char > '9' {
					return false
				}
			}
			return true
		}
		an, bn := isNumeric(partsA[i]), isNumeric(partsB[i])
		if an && bn {
			if len(partsA[i]) < len(partsB[i]) || (len(partsA[i]) == len(partsB[i]) && partsA[i] < partsB[i]) {
				return -1, nil
			}
			return 1, nil
		}
		if an {
			return -1, nil
		}
		if bn {
			return 1, nil
		}
		if partsA[i] < partsB[i] {
			return -1, nil
		}
		return 1, nil
	}
	if len(partsA) < len(partsB) {
		return -1, nil
	}
	return 1, nil
}

func (s *DesktopService) readReleaseFloors() (map[string]releaseFloor, error) {
	data, err := os.ReadFile(filepath.Join(s.cfg.DataDir, "release-floor.json"))
	if os.IsNotExist(err) {
		return map[string]releaseFloor{}, nil
	}
	if err != nil {
		return nil, err
	}
	var floors map[string]releaseFloor
	if json.Unmarshal(data, &floors) != nil || floors == nil {
		return nil, errors.New("本地发布防回滚记录损坏")
	}
	return floors, nil
}
func (s *DesktopService) confirmRelease(manifest releaseManifest, raw string) error {
	if _, err := compareReleaseVersions(manifest.Version, manifest.Version); err != nil {
		return err
	}
	floors, err := s.readReleaseFloors()
	if err != nil {
		return err
	}
	key := s.cfg.ReleaseRepository + ":" + manifest.Channel
	hash := sha256.Sum256([]byte(raw))
	digest := hex.EncodeToString(hash[:])
	if previous, exists := floors[key]; exists {
		comparison, err := compareReleaseVersions(manifest.Version, previous.Version)
		if err != nil {
			return err
		}
		if comparison < 0 || (comparison == 0 && manifest.Build < previous.Build) {
			return errors.New("发布清单低于本地已确认版本，已阻止回滚")
		}
		if comparison == 0 && manifest.Build == previous.Build && digest != previous.SHA256 {
			return errors.New("同一发布版本的清单原文发生变化，已阻止替换")
		}
	}
	floors[key] = releaseFloor{Version: manifest.Version, Build: manifest.Build, Tag: manifest.Tag, SHA256: digest}
	return atomicJSON(filepath.Join(s.cfg.DataDir, "release-floor.json"), floors)
}

func (s *DesktopService) checkReleaseFloor(grant releaseAssetGrant) error {
	if grant.Tag != "v"+grant.Version || !releaseTagPattern.MatchString(grant.Tag) || (grant.Channel != "stable" && grant.Channel != "beta") || grant.Build < 1 {
		return errors.New("原生发布授权记录无效")
	}
	floors, err := s.readReleaseFloors()
	if err != nil {
		return err
	}
	if floor, exists := floors[s.cfg.ReleaseRepository+":"+grant.Channel]; exists {
		comparison, err := compareReleaseVersions(grant.Version, floor.Version)
		if err != nil {
			return err
		}
		if comparison < 0 || (comparison == 0 && grant.Build < floor.Build) {
			return errors.New("下载版本低于本地已确认版本，已阻止降级")
		}
	}
	if grant.Component == "" {
		if comparison, err := compareReleaseVersions(grant.Version, mygo.App.Version()); err == nil {
			if comparison < 0 {
				return errors.New("安装包低于当前应用版本，已阻止降级")
			}
			if installedBuild, parseErr := strconv.ParseInt(embeddedBuildNumber, 10, 64); comparison == 0 && parseErr == nil && installedBuild > 0 && grant.Build < installedBuild {
				return errors.New("安装包构建号低于当前应用，已阻止降级")
			}
		}
	}
	return nil
}

func (s *DesktopService) verifyGrantReceipt(grant releaseAssetGrant) error {
	if !validRepository(s.cfg.ReleaseRepository) || strings.TrimSpace(s.cfg.ReleasePublicKey) == "" {
		return errors.New("安装前必须配置发布仓库和清单验签公钥")
	}
	if err := s.checkReleaseFloor(grant); err != nil {
		return err
	}
	valid, err := verifyManifestSignature(grant.Manifest, grant.Signature, s.cfg.ReleasePublicKey)
	if err != nil || !valid {
		return errors.New("安装前发布清单签名复核失败")
	}
	floors, err := s.readReleaseFloors()
	if err != nil {
		return err
	}
	floor, exists := floors[s.cfg.ReleaseRepository+":"+grant.Channel]
	digest := sha256.Sum256([]byte(grant.Manifest))
	if !exists || hex.EncodeToString(digest[:]) != floor.SHA256 {
		return errors.New("安装清单与本地已确认发布不一致")
	}
	var manifest releaseManifest
	if json.Unmarshal([]byte(grant.Manifest), &manifest) != nil || manifest.Tag != grant.Tag || manifest.Version != grant.Version || manifest.Build != grant.Build || manifest.Channel != grant.Channel {
		return errors.New("安装授权元信息不一致")
	}
	ctx := s.ctx
	if ctx == nil {
		ctx = context.Background()
	}
	if err := s.verifyReleaseBinding(ctx, manifest, grant.Manifest, grant.Signature); err != nil {
		return err
	}
	for _, asset := range append(manifest.Installers, manifest.RuntimeComponents...) {
		if asset.Platform == platformName() && asset.Architecture == architectureName() && asset.FileName == grant.FileName && strings.EqualFold(asset.SHA256, grant.SHA256) && asset.SizeBytes == grant.Size && asset.Component == grant.Component && asset.SourceFormat == grant.SourceFormat && asset.ArchiveEntryName == grant.ArchiveEntryName {
			return nil
		}
	}
	return errors.New("安装文件不在已确认发布清单中")
}
