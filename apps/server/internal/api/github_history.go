package api

import (
	"context"
	"encoding/json"
	"net/http"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
)

// Only use the relation as a paging signal; never request a header-supplied URL.
var historyNextLink = regexp.MustCompile(`(?i)(?:^|,)\s*<[^>]+>\s*;\s*rel="next"(?:\s*(?:,|$))`)

func (s *Server) releaseHistory(_ http.ResponseWriter, r *http.Request, _ Object) (any, error) {
	if s.Config.GitHubRepository == "" {
		return nil, fail(503, "尚未配置 GitHub 发布仓库")
	}
	channel := r.URL.Query().Get("channel")
	if channel == "" {
		channel = "stable"
	}
	if channel != "stable" && channel != "beta" {
		return nil, fail(400, "发布渠道无效")
	}
	platform := r.URL.Query().Get("platform")
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit < 1 || limit > 50 {
		limit = 20
	}
	type listedAsset struct {
		Name string `json:"name"`
	}
	type listedRelease struct {
		Assets     []listedAsset `json:"assets"`
		Tag        string        `json:"tag_name"`
		Draft      bool          `json:"draft"`
		Prerelease bool          `json:"prerelease"`
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	out := []Object{}
	seen := make(map[string]bool)
	base := "https://api.github.com/repos/" + s.Config.GitHubRepository + "/releases?per_page=30"
	for page := 1; page <= 5; page++ {
		address := base
		if page > 1 {
			address += "&page=" + strconv.Itoa(page)
		}
		raw, _, header, err := s.githubBytes(ctx, address, 2<<20)
		if err != nil {
			return nil, err
		}
		var releases []listedRelease
		if err = json.Unmarshal(raw, &releases); err != nil || releases == nil || len(releases) > 30 {
			return nil, fail(502, "GitHub 历史版本响应格式无效")
		}
		for _, release := range releases {
			if release.Draft || !strings.HasPrefix(release.Tag, "v") || channel == "stable" && release.Prerelease {
				continue
			}
			// A known pre-MyGo release has neither protocol asset. A missing list is
			// not evidence of that: use the normal fixed-tag read and verification.
			if release.Assets != nil && !slices.ContainsFunc(release.Assets, func(asset listedAsset) bool {
				return asset.Name == "chordv-release.json" || asset.Name == "chordv-release.json.sig"
			}) {
				continue
			}
			if seen[release.Tag] {
				continue
			}
			version, err := parseVersion(strings.TrimPrefix(release.Tag, "v"))
			if err != nil || len(release.Tag) > 65 || (version[4] != "") != release.Prerelease {
				continue
			}
			if len(seen) >= 50 {
				return nil, fail(503, "版本历史查询超过验证上限")
			}
			seen[release.Tag] = true
			expected := "stable"
			if release.Prerelease {
				expected = "beta"
			}
			m, _, err := s.readManifest(ctx, "https://github.com/"+s.Config.GitHubRepository+"/releases/download/"+release.Tag+"/chordv-release.json", expected)
			if err != nil {
				return nil, err
			}
			if m.Tag != release.Tag {
				return nil, fail(502, "历史版本标签与清单不一致")
			}
			supported := false
			for _, a := range m.Installers {
				supported = supported || a.Platform == platform
			}
			if supported {
				out = append(out, Object{"version": m.Version, "build": m.Build, "releaseChannel": m.Channel, "title": m.Title, "changelog": m.Changelog, "publishedAt": m.PublishedAt})
				if len(out) == limit {
					return out, nil
				}
			}
		}
		if !historyNextLink.MatchString(strings.Join(header.Values("Link"), ",")) {
			return out, nil
		}
	}
	return nil, fail(503, "版本历史查询超过分页上限")
}
