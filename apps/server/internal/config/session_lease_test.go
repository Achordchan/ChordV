package config

import (
	"strconv"
	"testing"
)

func TestSessionLeaseTimingDefaultsAndPrefixIsolation(t *testing.T) {
	for _, mode := range []string{"local", "production"} {
		t.Run(mode, func(t *testing.T) {
			c := Config{Mode: mode}
			if err := c.loadSessionLeaseTiming(); err != nil {
				t.Fatal(err)
			}
			l, err := c.SessionLeaseTiming()
			if err != nil || l.TTLSeconds != 1800 || l.HeartbeatIntervalSeconds != 30 || l.GraceSeconds != 300 {
				t.Fatal("默认1800/30/300错误", l, err)
			}
			prefix, other := "CHORDV_LOCAL_SESSION_", "CHORDV_SESSION_"
			if mode == "production" {
				prefix, other = other, prefix
			}
			for _, name := range []string{"LEASE_TTL_SECONDS", "HEARTBEAT_INTERVAL_SECONDS", "GRACE_SECONDS"} {
				t.Setenv(other+name, "bad")
			}
			t.Setenv(prefix+"LEASE_TTL_SECONDS", "90")
			t.Setenv(prefix+"HEARTBEAT_INTERVAL_SECONDS", "5")
			t.Setenv(prefix+"GRACE_SECONDS", "30")
			if err = c.loadSessionLeaseTiming(); err != nil {
				t.Fatal(err)
			}
			l, err = c.SessionLeaseTiming()
			if err != nil || l.TTLSeconds != 90 || l.HeartbeatIntervalSeconds != 5 || l.GraceSeconds != 30 {
				t.Fatal("前缀隔离或自定义值失败", l, err)
			}
		})
	}
}

func TestSessionLeaseTimingRejectsInvalidAndTimerOverflow(t *testing.T) {
	for _, mode := range []string{"local", "production"} {
		for _, field := range []string{"LEASE_TTL_SECONDS", "HEARTBEAT_INTERVAL_SECONDS", "GRACE_SECONDS"} {
			for _, value := range []string{"", "0", "-1", "1.5", "30tail", "NaN", "1e3", "2147484", "999999999999999999999999999"} {
				t.Run(mode+field+value, func(t *testing.T) {
					prefix := "CHORDV_LOCAL_SESSION_"
					if mode == "production" {
						prefix = "CHORDV_SESSION_"
					}
					t.Setenv(prefix+field, value)
					c := Config{Mode: mode}
					if c.loadSessionLeaseTiming() == nil {
						t.Fatal("非法/溢出值不得默认或夹取")
					}
				})
			}
		}
	}
	for _, c := range []Config{{SessionLeaseTTLSeconds: 4}, {SessionHeartbeatIntervalSeconds: 4}, {SessionGraceSeconds: 29}, {SessionLeaseTTLSeconds: 30, SessionHeartbeatIntervalSeconds: 31}, {SessionGraceSeconds: -1}, {SessionLeaseTTLSeconds: 2147484}} {
		if _, err := c.SessionLeaseTiming(); err == nil {
			t.Fatal("手工配置边界无效", c)
		}
	}
	t.Setenv("CHORDV_LOCAL_SESSION_LEASE_TTL_SECONDS", strconv.Itoa(maxSessionTimingSeconds))
	t.Setenv("CHORDV_LOCAL_SESSION_HEARTBEAT_INTERVAL_SECONDS", strconv.Itoa(maxSessionTimingSeconds))
	t.Setenv("CHORDV_LOCAL_SESSION_GRACE_SECONDS", strconv.Itoa(maxSessionTimingSeconds))
	c := Config{}
	if err := c.loadSessionLeaseTiming(); err != nil {
		t.Fatal(err)
	}
	l, err := c.SessionLeaseTiming()
	if err != nil || l.TTL().Milliseconds() > 2147483647 || l.Grace().Milliseconds() > 2147483647 {
		t.Fatal("JS32位毫秒边界溢出", l, err)
	}
	c = productionConfig()
	c.SessionHeartbeatIntervalSeconds = 4
	if c.Validate() == nil {
		t.Fatal("production提前返回遗漏校验")
	}
}
