package main

import (
	"errors"
	"strings"
	"unicode"
	"unicode/utf8"
)

func nsisInstallerCommandLine(installer, installDir string) (string, error) {
	if !validWindowsInstallerPath(installer) || !strings.HasSuffix(strings.ToLower(installer), ".exe") || !validWindowsInstallerPath(installDir) {
		return "", errors.New("Windows 安装程序或安装目录路径无效")
	}
	// NSIS consumes the unquoted /D= tail, including spaces, as its directory.
	return `"` + installer + `" /D=` + installDir, nil
}

func validWindowsInstallerPath(path string) bool {
	if !utf8.ValidString(path) || strings.TrimSpace(path) != path || strings.ContainsAny(path, `"<>|?*/`) {
		return false
	}
	for _, char := range path {
		if unicode.IsControl(char) || char == '\u2028' || char == '\u2029' {
			return false
		}
	}
	rest := ""
	switch {
	case len(path) >= 3 && ((path[0] >= 'A' && path[0] <= 'Z') || (path[0] >= 'a' && path[0] <= 'z')) && path[1:3] == `:\`:
		rest = path[3:]
		if rest == "" {
			return false
		}
	case strings.HasPrefix(path, `\\`):
		rest = path[2:]
		parts := strings.Split(rest, `\`)
		if len(parts) < 3 || parts[0] == "" || parts[1] == "" || parts[2] == "" {
			return false
		}
	default:
		return false
	}
	if strings.Contains(rest, ":") {
		return false
	}
	for _, part := range strings.Split(rest, `\`) {
		if part == "." || part == ".." {
			return false
		}
	}
	return true
}
