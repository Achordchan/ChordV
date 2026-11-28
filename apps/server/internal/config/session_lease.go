package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

const maxSessionTimingSeconds = 2147483

type LeaseTiming struct {
	TTLSeconds               int
	HeartbeatIntervalSeconds int
	GraceSeconds             int
}

func (l LeaseTiming) TTL() time.Duration   { return time.Duration(l.TTLSeconds) * time.Second }
func (l LeaseTiming) Grace() time.Duration { return time.Duration(l.GraceSeconds) * time.Second }

func (c *Config) loadSessionLeaseTiming() error {
	prefix := "CHORDV_LOCAL_SESSION_"
	if c.Mode == "production" {
		prefix = "CHORDV_SESSION_"
	}
	for _, setting := range []struct {
		name     string
		fallback int
		target   *int
	}{
		{"LEASE_TTL_SECONDS", 1800, &c.SessionLeaseTTLSeconds},
		{"HEARTBEAT_INTERVAL_SECONDS", 30, &c.SessionHeartbeatIntervalSeconds},
		{"GRACE_SECONDS", 300, &c.SessionGraceSeconds},
	} {
		*setting.target = setting.fallback
		if raw, present := os.LookupEnv(prefix + setting.name); present {
			v, err := strconv.ParseUint(strings.TrimSpace(raw), 10, 32)
			if err != nil || v == 0 || v > maxSessionTimingSeconds {
				return fmt.Errorf("%s%s 必须为1到%d的整数秒", prefix, setting.name, maxSessionTimingSeconds)
			}
			*setting.target = int(v)
		}
	}
	_, err := c.SessionLeaseTiming()
	return err
}

func (c Config) SessionLeaseTiming() (LeaseTiming, error) {
	l := LeaseTiming{c.SessionLeaseTTLSeconds, c.SessionHeartbeatIntervalSeconds, c.SessionGraceSeconds}
	if l.TTLSeconds == 0 {
		l.TTLSeconds = 1800
	}
	if l.HeartbeatIntervalSeconds == 0 {
		l.HeartbeatIntervalSeconds = 30
	}
	if l.GraceSeconds == 0 {
		l.GraceSeconds = 300
	}
	if l.HeartbeatIntervalSeconds < 5 || l.GraceSeconds < 30 || l.TTLSeconds < l.HeartbeatIntervalSeconds || l.TTLSeconds > maxSessionTimingSeconds || l.HeartbeatIntervalSeconds > maxSessionTimingSeconds || l.GraceSeconds > maxSessionTimingSeconds {
		return LeaseTiming{}, fmt.Errorf("租约TTL须不小于心跳间隔，心跳至少5秒、宽限至少30秒，各项最多%d秒", maxSessionTimingSeconds)
	}
	return l, nil
}
