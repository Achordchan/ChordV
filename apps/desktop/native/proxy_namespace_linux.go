//go:build linux

package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/unix"
)

func canonicalGNOMEPath(path string) (string, error) {
	if !filepath.IsAbs(path) {
		return "", errors.New("GNOME代理配置路径必须是绝对路径")
	}
	path = filepath.Clean(path)
	parent, suffix := path, []string{}
	for {
		resolved, err := filepath.EvalSymlinks(parent)
		if err == nil {
			for index := len(suffix) - 1; index >= 0; index-- {
				resolved = filepath.Join(resolved, suffix[index])
			}
			return resolved, nil
		}
		if !os.IsNotExist(err) || filepath.Dir(parent) == parent {
			return "", err
		}
		suffix = append(suffix, filepath.Base(parent))
		parent = filepath.Dir(parent)
	}
}

func gnomeProxyNamespace(environment []string) (string, error) {
	values := map[string]string{}
	for _, entry := range environment {
		if key, value, ok := strings.Cut(entry, "="); ok {
			values[key] = value
		}
	}
	config := values["XDG_CONFIG_HOME"]
	if config == "" {
		if values["HOME"] == "" {
			return "", errors.New("GNOME代理缺少用户配置目录")
		}
		config = filepath.Join(values["HOME"], ".config")
	}
	config, err := canonicalGNOMEPath(config)
	if err != nil {
		return "", err
	}
	runtimeDirectory, err := canonicalGNOMEPath(values["XDG_RUNTIME_DIR"])
	if err != nil {
		return "", err
	}
	profile := values["DCONF_PROFILE"]
	implicit := profile == ""
	if implicit {
		profile = "user"
	}
	if !filepath.IsAbs(profile) {
		profile = filepath.Join("/etc/dconf/profile", profile)
	}
	profile, err = canonicalGNOMEPath(profile)
	if err != nil {
		return "", err
	}
	fd, err := unix.Open(profile, unix.O_RDONLY|unix.O_CLOEXEC|unix.O_NOFOLLOW|unix.O_NONBLOCK, 0)
	var body []byte
	if os.IsNotExist(err) && implicit {
		// dconf's documented implicit fallback; never guess for explicit profiles.
		body = []byte("user-db:user\n")
	} else if err != nil {
		return "", errors.New("无法确认GNOME会话的dconf配置文件")
	} else {
		file := os.NewFile(uintptr(fd), profile)
		defer file.Close()
		info, err := file.Stat()
		if err != nil || !info.Mode().IsRegular() || info.Size() > 65536 {
			return "", errors.New("GNOME会话dconf配置文件无效或过大")
		}
		body, err = io.ReadAll(io.LimitReader(file, 65537))
		if err != nil || len(body) > 65536 {
			return "", errors.New("无法完整读取GNOME会话dconf配置文件")
		}
	}
	identity, _ := json.Marshal(struct {
		UID                      int
		Config, Profile, Runtime string
		Content                  [32]byte
	}{os.Geteuid(), config, profile, runtimeDirectory, sha256.Sum256(body)})
	digest := sha256.Sum256(identity)
	return hex.EncodeToString(digest[:]), nil
}
