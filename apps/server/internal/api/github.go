package api

import (
	"context"
	"crypto/ed25519"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	releaseprotocol "github.com/Achordchan/ChordV/packages/releaseprotocol"
)

type releaseAsset struct {
	Platform     string `json:"platform"`
	Architecture string `json:"architecture"`
	FileName     string `json:"fileName"`
	SHA256       string `json:"sha256"`
	SizeBytes    int64  `json:"sizeBytes"`
}
type releaseComponent struct {
	releaseAsset
	Component        string `json:"component"`
	Version          string `json:"version"`
	SourceFormat     string `json:"sourceFormat"`
	ArchiveEntryName string `json:"archiveEntryName"`
}
type releaseManifest struct {
	SourceCommit      string                      `json:"sourceCommit"`
	TagBinding        *releaseprotocol.TagBinding `json:"tagBinding,omitempty"`
	SchemaVersion     int                         `json:"schemaVersion"`
	Version           string                      `json:"version"`
	Tag               string                      `json:"tag"`
	Channel           string                      `json:"channel"`
	Build             int                         `json:"build"`
	MinimumVersion    string                      `json:"minimumVersion"`
	ForceUpgrade      bool                        `json:"forceUpgrade"`
	Title             string                      `json:"title"`
	Changelog         []string                    `json:"changelog"`
	PublishedAt       string                      `json:"publishedAt"`
	Installers        []releaseAsset              `json:"installers"`
	RuntimeComponents []releaseComponent          `json:"runtimeComponents"`
}

var semverPattern = regexp.MustCompile(`^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$`)
var numericIdentifier = regexp.MustCompile(`^[0-9]+$`)
var sha256Pattern = regexp.MustCompile(`^[0-9a-f]{64}$`)
var filePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._+() -]{0,199}$`)

func parseVersion(value string) ([]string, error) {
	m := semverPattern.FindStringSubmatch(value)
	if m == nil {
		return nil, fail(400, "版本号不是有效的 SemVer")
	}
	if m[4] != "" {
		for _, part := range strings.Split(m[4], ".") {
			numeric := numericIdentifier.MatchString(part)
			if numeric && len(part) > 1 && part[0] == '0' {
				return nil, fail(400, "预发布数字标识不能有前导零")
			}
		}
	}
	return m, nil
}
func compareVersion(a, b string) (int, error) {
	av, err := parseVersion(a)
	if err != nil {
		return 0, err
	}
	bv, err := parseVersion(b)
	if err != nil {
		return 0, err
	}
	numeric := func(x, y string) int {
		if len(x) < len(y) {
			return -1
		}
		if len(x) > len(y) {
			return 1
		}
		return strings.Compare(x, y)
	}
	for i := 1; i <= 3; i++ {
		if n := numeric(av[i], bv[i]); n != 0 {
			return n, nil
		}
	}
	if av[4] == bv[4] {
		return 0, nil
	}
	if av[4] == "" {
		return 1, nil
	}
	if bv[4] == "" {
		return -1, nil
	}
	ap, bp := strings.Split(av[4], "."), strings.Split(bv[4], ".")
	for i := 0; i < len(ap) && i < len(bp); i++ {
		if ap[i] == bp[i] {
			continue
		}
		an, bn := numericIdentifier.MatchString(ap[i]), numericIdentifier.MatchString(bp[i])
		if an && bn {
			return numeric(ap[i], bp[i]), nil
		}
		if an {
			return -1, nil
		}
		if bn {
			return 1, nil
		}
		return strings.Compare(ap[i], bp[i]), nil
	}
	if len(ap) < len(bp) {
		return -1, nil
	}
	return 1, nil
}
func parsePublicKey(raw string) (ed25519.PublicKey, error) {
	var decoded []byte
	var err error
	if block, _ := pem.Decode([]byte(raw)); block != nil {
		decoded = block.Bytes
	} else {
		decoded, err = base64.StdEncoding.DecodeString(strings.TrimSpace(raw))
		if err != nil {
			return nil, fail(500, "发布公钥格式无效")
		}
		if len(decoded) == ed25519.PublicKeySize {
			return ed25519.PublicKey(decoded), nil
		}
	}
	key, err := x509.ParsePKIXPublicKey(decoded)
	if err != nil {
		return nil, fail(500, "发布公钥格式无效")
	}
	public, ok := key.(ed25519.PublicKey)
	if !ok {
		return nil, fail(500, "发布公钥不是 Ed25519")
	}
	return public, nil
}
func validateManifest(m releaseManifest, channel string) error {
	repo := ""
	if m.TagBinding != nil {
		repo = m.TagBinding.Repository
	}
	if _, err := releaseprotocol.Validate(m.SchemaVersion, m.TagBinding, m.SourceCommit, repo, true); err != nil {
		return fail(502, err.Error())
	}
	if m.Tag != "v"+m.Version || m.Channel != channel || m.Build < 1 || m.Build > 999999999 || m.Changelog == nil {
		return fail(502, "GitHub 发布清单的版本、渠道或标签不一致")
	}
	if _, err := time.Parse(time.RFC3339, m.PublishedAt); err != nil {
		return fail(502, "GitHub 发布清单缺少有效发布时间")
	}
	version, err := parseVersion(m.Version)
	if err != nil {
		return err
	}
	if order, err := compareVersion(m.MinimumVersion, m.Version); err != nil || order > 0 {
		return fail(502, "GitHub 发布清单的最低支持版本无效或高于发布版本")
	}
	if (channel == "stable" && version[4] != "") || (channel == "beta" && version[4] == "") {
		return fail(502, "发布渠道与预发布版本不匹配")
	}
	seen := map[string]bool{}
	validate := func(a releaseAsset, key string) error {
		if a.Platform != "windows" && a.Platform != "macos" && a.Platform != "linux" && a.Platform != "android" {
			return fail(502, "发布平台无效")
		}
		if a.Architecture != "x64" && a.Architecture != "arm64" {
			return fail(502, "发布架构无效")
		}
		if !filePattern.MatchString(a.FileName) || strings.Contains(a.FileName, "..") || !sha256Pattern.MatchString(a.SHA256) || a.SizeBytes <= 0 {
			return fail(502, "发布资产名称、校验和或长度无效")
		}
		if seen[key] {
			return fail(502, "发布清单存在重复资产")
		}
		seen[key] = true
		return nil
	}
	for _, a := range m.Installers {
		if err = validate(a, "installer:"+a.Platform+":"+a.Architecture); err != nil {
			return err
		}
	}
	for _, c := range m.RuntimeComponents {
		if err = validate(c.releaseAsset, c.Component+":"+c.Platform+":"+c.Architecture); err != nil {
			return err
		}
		if c.Component != "xray" && c.Component != "geoip" && c.Component != "geosite" {
			return fail(502, "运行组件类型无效")
		}
		if c.SourceFormat != "direct" && c.SourceFormat != "zip_entry" {
			return fail(502, "运行组件格式无效")
		}
		if c.SourceFormat == "zip_entry" && (c.ArchiveEntryName == "" || strings.Contains(c.ArchiveEntryName, "..") || strings.HasPrefix(c.ArchiveEntryName, "/") || strings.Contains(c.ArchiveEntryName, "\\")) {
			return fail(502, "归档条目路径无效")
		}
	}
	return nil
}
func (s *Server) githubBytes(ctx context.Context, address string, max int64) ([]byte, int, http.Header, error) {
	request, err := http.NewRequestWithContext(ctx, "GET", address, nil)
	if err != nil {
		return nil, 0, nil, err
	}
	request.Header.Set("Accept", "application/vnd.github+json")
	client := *s.HTTP
	client.CheckRedirect = func(r *http.Request, via []*http.Request) error {
		if len(via) > 5 || r.URL.Scheme != "https" {
			return fail(502, "GitHub 重定向无效")
		}
		host := r.URL.Hostname()
		if host != "github.com" && host != "raw.githubusercontent.com" && host != "release-assets.githubusercontent.com" && host != "objects.githubusercontent.com" {
			return fail(502, "GitHub 重定向目标未获授权")
		}
		return nil
	}
	response, err := client.Do(request)
	if err != nil {
		return nil, 0, nil, fail(502, "GitHub 发布源连接失败")
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, max+1))
	if err != nil || int64(len(raw)) > max {
		return nil, response.StatusCode, nil, fail(502, "GitHub 响应超过限制")
	}
	if response.StatusCode != 200 {
		return nil, response.StatusCode, nil, fail(502, "GitHub 发布源返回 HTTP "+strconv.Itoa(response.StatusCode))
	}
	return raw, response.StatusCode, response.Header, nil
}
func (s *Server) readManifest(ctx context.Context, address, channel string) (releaseManifest, int, error) {
	var m releaseManifest
	raw, status, _, err := s.githubBytes(ctx, address, 1<<20)
	if err != nil {
		return m, status, err
	}
	var signatureRaw []byte
	if s.Config.GitHubPublicKey != "" {
		key, err := parsePublicKey(s.Config.GitHubPublicKey)
		if err != nil {
			return m, status, err
		}
		signatureRaw, _, _, err = s.githubBytes(ctx, address+".sig", 1024)
		if err != nil {
			return m, status, err
		}
		signature, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(signatureRaw)))
		if err != nil || !ed25519.Verify(key, raw, signature) {
			return m, status, fail(502, "GitHub 发布清单签名校验失败")
		}
	}
	if err = json.Unmarshal(raw, &m); err != nil {
		return m, status, fail(502, "GitHub 发布清单格式无效")
	}
	if err = validateManifest(m, channel); err != nil {
		return m, status, err
	}
	if err = s.verifyReleaseBinding(ctx, m, raw, signatureRaw); err != nil {
		return m, status, fail(502, err.Error())
	}
	return m, status, nil
}
func (s *Server) latestManifest(ctx context.Context, channel string) (releaseManifest, error) {
	var m releaseManifest
	if s.Config.GitHubRepository == "" {
		return m, fail(503, "尚未配置 GitHub 发布仓库")
	}
	if channel != "stable" && channel != "beta" {
		return m, fail(400, "发布渠道无效")
	}
	m, status, err := s.readManifest(ctx, "https://raw.githubusercontent.com/"+s.Config.GitHubRepository+"/release-channels/"+channel+".json", channel)
	if channel == "beta" && status == 404 {
		return s.latestManifest(ctx, "stable")
	}
	return m, err
}
func (s *Server) assetURL(m releaseManifest, a releaseAsset) string {
	return "https://github.com/" + s.Config.GitHubRepository + "/releases/download/" + url.PathEscape(m.Tag) + "/" + url.PathEscape(a.FileName)
}
