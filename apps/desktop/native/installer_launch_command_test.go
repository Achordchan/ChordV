package main

import (
	"runtime"
	"strings"
	"testing"
)

func TestNSISInstallerCommandLinePinsUnquotedLastDirectory(t *testing.T) {
	for _, paths := range [][2]string{
		{`C:\Downloads\setup.exe`, `C:\Users\Local\Programs\ChordV`},
		{`C:\Users\张 三\Downloads\ChordV Setup.exe`, `D:\自定义 应用\ChordV`},
		{`\\server\share\下载\setup.exe`, `\\server\share\应用 目录`},
		{`C:\Downloads\setup.EXE`, `D:\Tools & Apps\ChordV (local)`},
	} {
		line, err := nsisInstallerCommandLine(paths[0], paths[1])
		want := `"` + paths[0] + `" /D=` + paths[1]
		if err != nil || line != want || strings.Contains(line, "/S") {
			t.Fatal("NSIS 原始命令行未遵守目录契约", line, err)
		}
	}
}

func TestNSISInstallerCommandLineRejectsInjectionAndRelativePaths(t *testing.T) {
	for _, bad := range []string{"", `relative.exe`, `C:setup.exe`, `\setup.exe`, `C:\`, `\\server\share`, `C:\x\..\setup.exe`, `C:\setup.exe" /S`, "C:\\setup.exe\r\n/S", "C:\\setup.exe\x00", "C:\\setup.exe\t", `C:\setup.exe:other`, `C:/setup.exe`, "C:\\setup\u2028.exe", string([]byte{'C', ':', '\\', 0xff}), `\\server`, `C:\bad|setup.exe`} {
		if _, err := nsisInstallerCommandLine(bad, `C:\Apps\ChordV`); err == nil {
			t.Fatalf("接受无效安装器路径 %q", bad)
		}
		if _, err := nsisInstallerCommandLine(`C:\Downloads\setup.exe`, bad); err == nil {
			t.Fatalf("接受无效目标路径 %q", bad)
		}
	}
	if _, err := nsisInstallerCommandLine(`C:\Downloads\setup.dmg`, `C:\Apps`); err == nil {
		t.Fatal("接受非 EXE 安装器")
	}
}

func TestWindowsInstallerLauncherRejectsOtherPlatforms(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("非 Windows 平台拒绝门禁；本测试不启动 Windows 安装器")
	}
	if err := startWindowsInstaller(`C:\test-only\never-executed.exe`); err == nil {
		t.Fatal("非 Windows 平台接受了安装器启动")
	}
}
