// Package version carries the agent build identity sent to the control plane.
package version

import "strings"

// Version is stamped at build time with
//
//	-ldflags "-X .../internal/version.Version=0.1.0"
//
// The Node agent read it back out of the deployed package.json and failed loudly
// when that was missing; a Go binary carries it in the image instead, so the only
// remaining failure mode is a build that forgot the flag. Registration and every
// heartbeat require a non-empty value (server: IsNotEmpty, MaxLength 64), so a
// stamped-empty binary must be rejected before it can register.
var Version = "0.0.0-dev"

// MaxLength mirrors the control plane's AgentRegisterDto/AgentHeartbeatDto bound.
const MaxLength = 64

// Validate reports why the stamped version is unusable, or nil.
func Validate() error {
	trimmed := strings.TrimSpace(Version)
	if trimmed == "" {
		return errEmptyVersion
	}
	if len(trimmed) > MaxLength {
		return errLongVersion
	}
	return nil
}

type versionError string

func (e versionError) Error() string { return string(e) }

const (
	errEmptyVersion = versionError("Agent 版本号为空：构建时缺少 -ldflags -X ...internal/version.Version")
	errLongVersion  = versionError("Agent 版本号超过 64 字节，控制面会拒绝注册")
)
