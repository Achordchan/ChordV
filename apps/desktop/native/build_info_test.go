package main

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/egoist/mygo"
)

func TestNativeBuildInfoChild(t *testing.T) {
	role := os.Getenv("CHORDV_BUILDINFO_TEST_ROLE")
	if role == "" {
		t.Skip("private subprocess entry")
	}
	os.Args = []string{os.Args[0], "--chordv-build-info"}
	mygo.App.SetVersion("2.0.1")
	embeddedBuildNumber = "42"
	if role == "invalid-build" {
		embeddedBuildNumber = "bad"
	} else if role == "extra-argument" {
		os.Args = append(os.Args, "unexpected")
	}
	main()
	os.Exit(0)
}

func TestNativeBuildInfoExitsBeforeConfigurationOrGUI(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	for _, role := range []string{"valid", "invalid-build", "extra-argument"} {
		t.Run(role, func(t *testing.T) {
			data := filepath.Join(t.TempDir(), "must-not-be-created")
			command := exec.Command(executable, "-test.run=^TestNativeBuildInfoChild$")
			command.Env = append(systemProcessEnvironment(), "CHORDV_BUILDINFO_TEST_ROLE="+role, "CHORDV_API_BASE_URL=https://not-local.invalid", "CHORDV_MYGO_DATA_DIR="+data)
			output, runErr := command.CombinedOutput()
			if role == "valid" {
				var info map[string]any
				if runErr != nil || json.Unmarshal(output, &info) != nil || len(info) != 5 || info["version"] != "2.0.1" || info["build"] != float64(42) || info["mode"] != buildMode || info["platform"] != platformName() || info["architecture"] != architectureName() {
					t.Fatal("构建信息必须直接来自原生早退出分支", string(output), runErr)
				}
			} else if runErr == nil || (role == "invalid-build" && !strings.Contains(string(output), "内嵌构建号无效")) || (role == "extra-argument" && !strings.Contains(string(output), "不接受其他参数")) {
				t.Fatal("非法元数据请求必须非零退出，不启动GUI", string(output), runErr)
			}
			if _, err := os.Stat(data); !os.IsNotExist(err) {
				t.Fatal("读取构建信息不能加载配置、创建数据目录或启动GUI", err)
			}
		})
	}
}
