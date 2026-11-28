package api

import (
	"context"
	"net/http"
	"strconv"
	"time"
)

func (s *Server) bootstrapVersion(ctx context.Context, platform, architecture string) (Object, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if s.Config.GitHubRepository == "" {
		return Object{"currentVersion": "0.0.0", "minimumVersion": "0.0.0", "forceUpgrade": false, "changelog": []string{}, "downloadUrl": nil}, nil
	}
	// The version projection is optional in account bootstrap. Update and
	// download endpoints still require a verified GitHub manifest themselves.
	lookup, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	m, err := s.latestManifest(lookup, "stable")
	if requestErr := ctx.Err(); requestErr != nil {
		return nil, requestErr
	}
	if err != nil || lookup.Err() != nil {
		return nil, nil
	}
	return s.versionProjection(m, platform, architecture), nil
}
func (s *Server) releasePageURL(m releaseManifest) string {
	return "https://github.com/" + s.Config.GitHubRepository + "/releases/tag/" + m.Tag
}
func (s *Server) versionProjection(m releaseManifest, platform, architecture string) Object {
	var download any
	for _, a := range m.Installers {
		if a.Platform != platform {
			continue
		}
		if architecture == "" {
			download = s.releasePageURL(m)
			break
		}
		if a.Architecture == architecture {
			download = s.assetURL(m, a)
			break
		}
	}
	return Object{"currentVersion": m.Version, "minimumVersion": m.MinimumVersion, "forceUpgrade": m.ForceUpgrade, "changelog": m.Changelog, "downloadUrl": download}
}
func (s *Server) clientVersion(_ http.ResponseWriter, r *http.Request, _ Object) (any, error) {
	m, err := s.latestManifest(r.Context(), "stable")
	if err != nil {
		return nil, err
	}
	return s.versionProjection(m, r.URL.Query().Get("platform"), r.URL.Query().Get("architecture")), nil
}
func (s *Server) checkUpdate(w http.ResponseWriter, r *http.Request, _ Object) (any, error) {
	input, err := body(w, r)
	if err != nil {
		return nil, err
	}
	if r.Header.Get("Authorization") != "" {
		if user, authErr := s.authenticate(r); authErr == nil {
			report := Object{"platform": input["platform"], "version": input["currentVersion"], "build": input["currentBuild"], "channel": input["channel"]}
			if err = s.recordClientVersion(r.Context(), user, report); err != nil {
				return nil, err
			}
		} else {
			return nil, authErr
		}
	}
	current := text(input, "currentVersion")
	if _, err = parseVersion(current); err != nil {
		return nil, err
	}
	channel := text(input, "channel")
	if channel == "" {
		channel = "stable"
	}
	m, err := s.latestManifest(r.Context(), channel)
	if err != nil {
		return nil, err
	}
	platform := text(input, "platform")
	if platform != "windows" && platform != "macos" && platform != "android" && platform != "ios" {
		return nil, fail(400, "客户端平台无效")
	}
	legacyMac := platform == "macos" && text(input, "architecture") == ""
	architecture := text(input, "architecture")
	if architecture == "" {
		if platform == "macos" {
			architecture = "arm64"
		} else {
			architecture = "x64"
		}
	}
	comparison, _ := compareVersion(m.Version, current)
	hasUpdate := comparison > 0 || (comparison == 0 && number(input, "currentBuild") > 0 && m.Build > int(number(input, "currentBuild")))
	below, _ := compareVersion(current, m.MinimumVersion)
	minimumVersion := m.MinimumVersion
	if m.Channel == "beta" {
		minimumVersion = "0.0.0"
		below = 0
	}
	forced := hasUpdate && m.Channel == "stable" && (m.ForceUpgrade || below < 0)
	requirement := "optional"
	if forced {
		if below < 0 {
			requirement = "required_minimum"
		} else {
			requirement = "required_release"
		}
	}
	out := Object{"hasUpdate": hasUpdate, "forceUpgrade": forced, "blockedByMinimumVersion": below < 0, "forcedByRelease": m.ForceUpgrade && m.Channel == "stable", "updateRequirement": requirement, "currentVersion": current, "latestVersion": m.Version, "minimumVersion": minimumVersion, "platform": platform, "channel": channel, "releaseChannel": m.Channel, "latestBuild": m.Build, "changelog": m.Changelog, "deliveryMode": "none", "downloadUrl": nil, "fileName": nil, "fileSizeBytes": nil, "fileHash": nil, "recommendedArtifact": nil, "publishedAt": m.PublishedAt}
	if legacyMac {
		supported := false
		for _, asset := range m.Installers {
			supported = supported || asset.Platform == platform
		}
		if supported {
			address := s.releasePageURL(m)
			out["deliveryMode"] = "external_download"
			out["downloadUrl"] = address
			out["recommendedArtifact"] = Object{"id": m.Tag + ":legacy-macos", "releaseId": m.Tag, "source": "external", "type": "external", "deliveryMode": "external_download", "downloadUrl": address, "originDownloadUrl": address, "mirrorDownloadUrls": []string{}, "defaultMirrorPrefix": nil, "allowClientMirror": false, "fileName": nil, "fileSizeBytes": nil, "fileHash": nil, "isPrimary": true, "isFullPackage": false, "createdAt": m.PublishedAt, "updatedAt": m.PublishedAt}
			return out, nil
		}
		if hasUpdate {
			return nil, fail(503, "该平台没有 GitHub 安装包")
		}
	}
	for _, a := range m.Installers {
		if a.Platform != platform || a.Architecture != architecture {
			continue
		}
		kind := "external"
		delivery := "external_download"
		switch platform {
		case "windows":
			kind = "setup.exe"
			delivery = "desktop_installer_download"
		case "macos":
			kind = "dmg"
			delivery = "desktop_installer_download"
		case "android":
			kind = "apk"
			delivery = "apk_download"
		}
		address := s.assetURL(m, a)
		artifact := Object{"id": m.Tag + ":" + platform + ":" + architecture, "releaseId": m.Tag, "source": "external", "type": kind, "deliveryMode": delivery, "downloadUrl": address, "originDownloadUrl": address, "mirrorDownloadUrls": []string{}, "defaultMirrorPrefix": nil, "allowClientMirror": false, "fileName": a.FileName, "fileSizeBytes": strconv.FormatInt(a.SizeBytes, 10), "fileHash": a.SHA256, "buildNumber": m.Build, "isPrimary": true, "isFullPackage": true, "createdAt": m.PublishedAt, "updatedAt": m.PublishedAt}
		out["deliveryMode"] = delivery
		out["downloadUrl"] = address
		out["fileName"] = a.FileName
		out["fileSizeBytes"] = strconv.FormatInt(a.SizeBytes, 10)
		out["fileHash"] = a.SHA256
		out["recommendedArtifact"] = artifact
		break
	}
	if out["recommendedArtifact"] == nil && hasUpdate {
		return nil, fail(503, "该平台架构没有匹配的 GitHub 安装包")
	}
	return out, nil
}
func (s *Server) componentPlan(_ http.ResponseWriter, r *http.Request, _ Object) (any, error) {
	platform := r.URL.Query().Get("platform")
	arch := r.URL.Query().Get("architecture")
	if platform != "macos" && platform != "windows" && platform != "android" && platform != "linux" {
		return nil, fail(400, "运行组件平台无效")
	}
	if arch != "x64" && arch != "arm64" {
		return nil, fail(400, "运行组件架构无效")
	}
	m, err := s.latestManifest(r.Context(), "stable")
	if err != nil {
		return nil, err
	}
	components := []Object{}
	for _, c := range m.RuntimeComponents {
		if c.Platform != platform || c.Architecture != arch {
			continue
		}
		address := s.assetURL(m, c.releaseAsset)
		entry := any(nil)
		if c.SourceFormat == "zip_entry" {
			entry = c.ArchiveEntryName
		}
		components = append(components, Object{"id": m.Tag + ":" + c.Component + ":" + platform + ":" + arch, "platform": platform, "architecture": arch, "kind": c.Component, "fileName": c.FileName, "fileSizeBytes": strconv.FormatInt(c.SizeBytes, 10), "archiveEntryName": entry, "expectedHash": c.SHA256, "versionLabel": c.Version, "updatedAt": m.PublishedAt, "allowClientMirror": false, "originUrl": address, "defaultMirrorPrefix": nil, "resolvedUrl": address, "candidates": []Object{{"label": "origin", "url": address}}})
	}
	if len(components) != 3 {
		return nil, fail(503, "该平台的 Xray/GEO 组件发布不完整")
	}
	return Object{"platform": platform, "architecture": arch, "components": components}, nil
}
func (s *Server) reportComponentFailure(w http.ResponseWriter, r *http.Request, user Object) (any, error) {
	input, err := body(w, r)
	if err != nil {
		return nil, err
	}
	data := pick(input, "platform", "architecture", "kind", "reason", "message", "effectiveUrl", "appVersion")
	if err = requireText(data, "platform", "architecture", "kind", "reason"); err != nil {
		return nil, err
	}
	data["userId"] = user["id"]
	_, err = s.DB.Exec(r.Context(), `INSERT INTO "RuntimeComponentFailureReport"(id,platform,architecture,kind,reason,message,"effectiveUrl","appVersion","userId") VALUES($1,$2::"ReleasePlatform",$3::"RuntimeComponentArchitecture",$4::"RuntimeComponentKind",$5,$6,$7,$8,$9)`, newID(), data["platform"], data["architecture"], data["kind"], data["reason"], data["message"], data["effectiveUrl"], data["appVersion"], user["id"])
	if err != nil {
		return nil, err
	}
	return Object{"ok": true}, nil
}
