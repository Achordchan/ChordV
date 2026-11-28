package api

import (
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/Achordchan/ChordV/apps/server/internal/buildinfo"
)

//go:embed assets/install-go-agent.sh
var agentInstallTemplate embed.FS

type agentDistribution struct {
	Version string            `json:"version"`
	Commit  string            `json:"commit"`
	SHA256  map[string]string `json:"sha256"`
}

// Captured when New constructs the server, so changing a current symlink cannot
// redirect a running instance to a different release. Only tests override this.
type agentReleaseSource struct{ directory, version, commit, manifestSHA256 string }

func executableAgentRelease() *agentReleaseSource {
	source := &agentReleaseSource{version: buildinfo.Version, commit: buildinfo.Commit, manifestSHA256: buildinfo.AgentManifestSHA256}
	executable, err := os.Executable()
	if err != nil {
		return source
	}
	executable, err = filepath.EvalSymlinks(executable)
	if err != nil {
		return source
	}
	source.directory = filepath.Join(filepath.Dir(executable), "agent-dist")
	return source
}

func (s *Server) loadAgentDistribution() (agentDistribution, *os.Root, error) {
	var release agentDistribution
	source := s.agentRelease
	if source == nil {
		source = executableAgentRelease()
	}
	if !sha256Pattern.MatchString(source.manifestSHA256) || !agentCommitPattern.MatchString(source.commit) {
		return release, nil, fail(503, "服务端缺少 Agent 构建信任锚，请使用包含双架构 Agent 的完整服务端构建包")
	}
	info, err := os.Lstat(source.directory)
	if err != nil || !info.IsDir() {
		return release, nil, fail(503, "服务端发布目录缺少 Agent 构建产物")
	}
	root, err := os.OpenRoot(source.directory)
	if err != nil {
		return release, nil, fail(503, "本地缺少 Go Agent 构建产物，请先构建双架构 Agent")
	}
	info, err = root.Lstat("manifest.json")
	if err != nil || !info.Mode().IsRegular() {
		root.Close()
		return release, nil, fail(503, "Agent 构建清单缺失或不是普通文件")
	}
	file, err := root.Open("manifest.json")
	if err != nil {
		root.Close()
		return release, nil, fail(503, "本地缺少 Go Agent 构建清单")
	}
	defer file.Close()
	raw, err := io.ReadAll(io.LimitReader(file, (64<<10)+1))
	if err != nil {
		root.Close()
		return release, nil, err
	}
	sum := sha256.Sum256(raw)
	if len(raw) > 64<<10 || hex.EncodeToString(sum[:]) != source.manifestSHA256 {
		root.Close()
		return release, nil, fail(503, "Agent 构建清单与服务端内嵌信任锚不一致")
	}
	if err = json.Unmarshal(raw, &release); err != nil {
		root.Close()
		return release, nil, fail(503, "Agent 构建清单格式无效")
	}
	if _, err = parseVersion(release.Version); err != nil {
		root.Close()
		return release, nil, fail(503, "Agent 构建版本号无效")
	}
	if release.Version != source.version || release.Commit != source.commit || len(release.SHA256) != 2 {
		root.Close()
		return release, nil, fail(503, "Agent 版本、源码提交或架构与运行中的服务端不一致")
	}
	for _, arch := range []string{"amd64", "arm64"} {
		if !sha256Pattern.MatchString(release.SHA256[arch]) {
			root.Close()
			return release, nil, fail(503, "Agent 双架构构建清单缺少校验和")
		}
	}
	return release, root, nil
}
func checkedAgentBinary(root *os.Root, release agentDistribution, arch string) (*os.File, error) {
	name := "chordv-agent-linux-" + arch
	info, err := root.Lstat(name)
	if err != nil || !info.Mode().IsRegular() {
		return nil, fail(503, "Agent 构建产物缺失或不是普通文件")
	}
	file, err := root.Open(name)
	if err != nil {
		return nil, err
	}
	hash := sha256.New()
	if _, err = io.Copy(hash, file); err != nil {
		file.Close()
		return nil, err
	}
	if hex.EncodeToString(hash.Sum(nil)) != release.SHA256[arch] {
		file.Close()
		return nil, fail(503, "Agent 构建产物校验失败")
	}
	if err := checkAgentBuildInfo(file, release, arch); err != nil {
		file.Close()
		return nil, err
	}
	if _, err = file.Seek(0, io.SeekStart); err != nil {
		file.Close()
		return nil, err
	}
	return file, nil
}
func (s *Server) agentDownload(w http.ResponseWriter, r *http.Request, _ Object) (any, error) {
	arch := r.PathValue("arch")
	if arch != "amd64" && arch != "arm64" {
		return nil, fail(400, "Agent 架构无效")
	}
	release, root, err := s.loadAgentDistribution()
	if err != nil {
		return nil, err
	}
	defer root.Close()
	if release.Version != r.PathValue("version") {
		return nil, fail(404, "Agent 构建版本已改变，请重新生成安装命令")
	}
	file, err := checkedAgentBinary(root, release, arch)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	http.ServeContent(w, r, file.Name(), info.ModTime(), file)
	return nil, nil
}
func shellLiteral(value string) string { return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'" }
func (s *Server) installScript(w http.ResponseWriter, r *http.Request, _ Object) (any, error) {
	input, err := body(w, r)
	if err != nil {
		return nil, err
	}
	token := text(input, "token")
	if !strings.HasPrefix(token, "chordv_register_") || len(token) > 128 {
		return nil, fail(400, "安装令牌格式无效")
	}
	record, err := one(r.Context(), s.DB, `SELECT to_jsonb(t)||jsonb_build_object('node',to_jsonb(n)) FROM "AgentRegisterToken" t JOIN "Node" n ON n.id=t."nodeId" WHERE "tokenHash"=$1`, s.agentHash(token))
	if err != nil {
		return nil, fail(401, "安装令牌无效")
	}
	expiry, _ := parseTimestamp(text(record, "expiresAt"))
	usable := record["usedAt"] == nil && expiry.After(time.Now())
	if !usable && record["usedAt"] == nil {
		return nil, fail(401, "安装令牌已过期，请重新生成")
	}
	node, _ := record["node"].(map[string]any)
	spec, _ := node["onboardingSpec"].(map[string]any)
	if spec == nil {
		spec = Object{"mode": "awaiting_panel"}
	}
	release, root, err := s.loadAgentDistribution()
	if err != nil {
		return nil, err
	}
	defer root.Close()
	for _, arch := range []string{"amd64", "arm64"} {
		file, err := checkedAgentBinary(root, release, arch)
		if err != nil {
			return nil, err
		}
		file.Close()
	}
	template, err := agentInstallTemplate.ReadFile("assets/install-go-agent.sh")
	if err != nil {
		return nil, err
	}
	specJSON, err := json.Marshal(spec)
	if err != nil {
		return nil, err
	}
	usableFlag := "0"
	if usable {
		usableFlag = "1"
	}
	origin, err := s.publicOrigin(r.Context())
	if err != nil {
		return nil, err
	}
	values := map[string]string{"ORIGIN": origin, "TOKEN": token, "NODE_ID": text(record, "nodeId"), "USABLE": usableFlag, "TOKEN_HASH": tokenHash(token), "SPEC": string(specJSON), "VERSION": release.Version, "AMD64_SHA": release.SHA256["amd64"], "ARM64_SHA": release.SHA256["arm64"]}
	output := string(template)
	for key, value := range values {
		output = strings.ReplaceAll(output, "@@"+key+"@@", shellLiteral(value))
	}
	if strings.Contains(output, "@@") {
		return nil, fail(500, "Agent 安装模板参数缺失")
	}
	w.Header().Set("Content-Type", "text/x-shellscript; charset=utf-8")
	_, err = io.WriteString(w, output)
	return nil, err
}
