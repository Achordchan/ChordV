package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

const maxRetentionDays = int((1<<63 - 1) / int64(24*time.Hour))

func (c *Config) loadMeteringRetention() error {
	prefix := "CHORDV_LOCAL_"
	if c.Mode == "production" {
		prefix = "CHORDV_"
	}
	for _, setting := range []struct {
		name     string
		fallback int
		target   *int
	}{
		{"USAGE_PAYLOAD_RETENTION_DAYS", 30, &c.UsagePayloadRetentionDays},
		{"METERING_INCIDENT_RETENTION_DAYS", 90, &c.MeteringIncidentRetentionDays},
	} {
		*setting.target = setting.fallback
		if raw, present := os.LookupEnv(prefix + setting.name); present {
			days, err := strconv.ParseUint(strings.TrimSpace(raw), 10, 32)
			if err != nil || days == 0 || days > uint64(maxRetentionDays) {
				return fmt.Errorf("%s%s 必须为 1 到 %d 的整数天数", prefix, setting.name, maxRetentionDays)
			}
			*setting.target = int(days)
		}
	}
	return nil
}

// A zero-valued programmatic Config retains defaults; explicit environment zero is rejected above.
func (c Config) MeteringRetentionDurations() (time.Duration, time.Duration, error) {
	days := []int{c.UsagePayloadRetentionDays, c.MeteringIncidentRetentionDays}
	defaults := []int{30, 90}
	for i := range days {
		if days[i] == 0 {
			days[i] = defaults[i]
		}
		if days[i] < 1 || days[i] > maxRetentionDays {
			return 0, 0, fmt.Errorf("计量保留天数必须为 1 到 %d 的整数", maxRetentionDays)
		}
	}
	return time.Duration(days[0]) * 24 * time.Hour, time.Duration(days[1]) * 24 * time.Hour, nil
}
