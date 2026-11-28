package config

import (
	"strconv"
	"testing"
	"time"
)

func TestMeteringRetentionConfigDefaultsAndIsolation(t *testing.T) {
	for _, mode := range []string{"local", "production"} {
		t.Run(mode, func(t *testing.T) {
			c := Config{Mode: mode}
			if err := c.loadMeteringRetention(); err != nil {
				t.Fatal(err)
			}
			if c.UsagePayloadRetentionDays != 30 || c.MeteringIncidentRetentionDays != 90 {
				t.Fatal("默认保留期变化", c)
			}
			prefix, other := "CHORDV_LOCAL_", "CHORDV_"
			if mode == "production" {
				prefix, other = other, prefix
			}
			t.Setenv(other+"USAGE_PAYLOAD_RETENTION_DAYS", "bad")
			t.Setenv(other+"METERING_INCIDENT_RETENTION_DAYS", "0")
			t.Setenv(prefix+"USAGE_PAYLOAD_RETENTION_DAYS", "45")
			t.Setenv(prefix+"METERING_INCIDENT_RETENTION_DAYS", "120")
			if err := c.loadMeteringRetention(); err != nil {
				t.Fatal(err)
			}
			payload, incident, err := c.MeteringRetentionDurations()
			if err != nil || payload != 45*24*time.Hour || incident != 120*24*time.Hour {
				t.Fatal("环境前缀隔离或保留期失效", payload, incident, err)
			}
		})
	}
}

func TestMeteringRetentionConfigRejectsInvalidAndOverflow(t *testing.T) {
	for _, mode := range []string{"local", "production"} {
		for _, field := range []string{"USAGE_PAYLOAD_RETENTION_DAYS", "METERING_INCIDENT_RETENTION_DAYS"} {
			for _, raw := range []string{"", "0", "-1", "NaN", "30tail", "1.5", "106752", "999999999999999999999999999999"} {
				t.Run(mode+field+raw, func(t *testing.T) {
					prefix := "CHORDV_LOCAL_"
					if mode == "production" {
						prefix = "CHORDV_"
					}
					t.Setenv(prefix+field, raw)
					c := Config{Mode: mode}
					if c.loadMeteringRetention() == nil {
						t.Fatal("非法配置不得回退到较短默认")
					}
				})
			}
		}
	}
	for _, c := range []Config{{UsagePayloadRetentionDays: -1}, {MeteringIncidentRetentionDays: 106752}} {
		if _, _, err := c.MeteringRetentionDurations(); err == nil {
			t.Fatal("直接构造Config也必须拒绝非法天数")
		}
	}
	c := Config{}
	if p, i, err := c.MeteringRetentionDurations(); err != nil || p != 30*24*time.Hour || i != 90*24*time.Hour {
		t.Fatal("零值Config兼容失效")
	}
	t.Setenv("CHORDV_LOCAL_USAGE_PAYLOAD_RETENTION_DAYS", strconv.Itoa(maxRetentionDays))
	if err := c.loadMeteringRetention(); err != nil {
		t.Fatal(err)
	}
	if p, _, err := c.MeteringRetentionDurations(); err != nil || p <= 0 {
		t.Fatal("最大合法保留期溢出", p, err)
	}
	c = productionConfig()
	c.UsagePayloadRetentionDays = 106752
	if c.Validate() == nil {
		t.Fatal("生产Validate提前返回遗漏了保留期校验")
	}
}
