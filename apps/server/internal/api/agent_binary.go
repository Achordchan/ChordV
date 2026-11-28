package api

import (
	"debug/buildinfo"
	"os"
	"regexp"
	"strings"
)

var agentCommitPattern = regexp.MustCompile(`^[a-f0-9]{40,64}$`)

func checkAgentBuildInfo(file *os.File, release agentDistribution, arch string) error {
	info, err := buildinfo.Read(file)
	if err != nil || info.Path != "github.com/Achordchan/ChordV/apps/agent/cmd/chordv-agent" {
		return fail(503, "Agent 产物不是预期的 Go Agent 可执行文件")
	}
	settings := map[string]string{}
	for _, setting := range info.Settings {
		if _, exists := settings[setting.Key]; exists {
			return fail(503, "Agent 构建元数据重复")
		}
		settings[setting.Key] = setting.Value
	}
	if settings["GOOS"] != "linux" || settings["GOARCH"] != arch || settings["CGO_ENABLED"] != "0" {
		return fail(503, "Agent 可执行文件平台或架构不一致")
	}
	flags := strings.Fields(settings["-ldflags"])
	for name, expected := range map[string]string{"Version": release.Version, "Commit": release.Commit} {
		prefix := "github.com/Achordchan/ChordV/apps/agent/internal/version." + name + "="
		found := 0
		for index := 0; index+1 < len(flags); index++ {
			if flags[index] == "-X" && strings.HasPrefix(flags[index+1], prefix) {
				if strings.TrimPrefix(flags[index+1], prefix) != expected {
					return fail(503, "Agent 内嵌版本或源码提交不一致")
				}
				found++
			}
		}
		if found != 1 {
			return fail(503, "Agent 缺少唯一的内嵌版本或源码提交")
		}
	}
	return nil
}
