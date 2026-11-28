package api

import (
	"strings"
	"time"
)

// Prisma's timestamp columns contain UTC without a zone; all HTTP dates must
// retain that UTC meaning rather than being interpreted in the browser's zone.
func normalizeDates(value any) {
	switch v := value.(type) {
	case map[string]any:
		for key, raw := range v {
			if text, ok := raw.(string); ok && (strings.HasSuffix(key, "At") || strings.HasSuffix(key, "Until") || key == "onlineSince" || key == "serverTime") {
				if date, err := parseTimestamp(text); err == nil {
					v[key] = date.UTC().Format(time.RFC3339Nano)
				}
			} else {
				normalizeDates(raw)
			}
		}
	case []any:
		for _, entry := range v {
			normalizeDates(entry)
		}
	}
}
func parseTimestamp(value string) (time.Time, error) {
	for _, layout := range []string{time.RFC3339Nano, "2006-01-02T15:04:05.999999999", "2006-01-02 15:04:05.999999999"} {
		date, err := time.Parse(layout, value)
		if err == nil {
			return date, nil
		}
	}
	return time.Parse(time.RFC3339Nano, value)
}
