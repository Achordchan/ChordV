package api

import (
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var imageBedSecretPatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)(authorization\s*[:=]\s*bearer\s+)[^\s,;]+`),
	regexp.MustCompile(`(?i)([?&](?:api_?token|access_token|token|key)=)[^&\s]+`),
	regexp.MustCompile(`(?i)((?:api[-_ ]?token|access[_-]?token|authorization|bearer|token)\s*[:=]\s*)[A-Za-z0-9._~+/=\-]{8,}`),
	regexp.MustCompile(`(?i)((?:api[-_ ]?token|access[_-]?token|authorization|bearer|token)\s+)[A-Za-z0-9._~+/=\-]{8,}`),
}

func sanitizeImageBedError(value, token string) string {
	value = strings.Join(strings.Fields(value), " ")
	for _, pattern := range imageBedSecretPatterns {
		value = pattern.ReplaceAllString(value, "${1}***")
	}
	if token != "" {
		value = strings.ReplaceAll(value, token, "***")
	}
	if runes := []rune(value); len(runes) > 300 {
		value = string(runes[:300]) + "..."
	}
	return value
}

func imageBedText(record Object, keys ...string) string {
	for _, key := range keys {
		if value := text(record, key); value != "" {
			return value
		}
	}
	return ""
}

func imageBedStrings(value any) []string {
	result := []string{}
	if values, ok := value.([]any); ok {
		for _, raw := range values {
			if item, ok := raw.(string); ok {
				result = append(result, item)
			}
		}
	}
	return result
}

func imageBedDeleteDTO(record Object, path, token string) Object {
	deleted, failed := imageBedStrings(record["deleted"]), []string{}
	for _, item := range imageBedStrings(record["failed"]) {
		if detail := sanitizeImageBedError(item, token); detail != "" {
			failed = append(failed, detail)
		}
	}
	success := (record["success"] == true || len(deleted) > 0) && len(failed) == 0
	if len(failed) == 0 && record["success"] == false {
		detail := sanitizeImageBedError(imageBedText(record, "message", "error"), token)
		if detail == "" {
			detail = path
		}
		failed = append(failed, detail)
	}
	fileID := imageBedText(record, "fileId")
	if fileID == "" {
		fileID = path
	}
	return Object{"success": success, "fileId": fileID, "deleted": deleted, "failed": failed}
}

func imageBedOptionalText(record Object, keys ...string) any {
	if value := imageBedText(record, keys...); value != "" {
		return value
	}
	return nil
}

func imageBedSize(metadata Object) any {
	for _, key := range []string{"File-Size", "fileSize"} {
		if value := text(metadata, key); value != "" {
			return value
		}
		if value, ok := metadata[key].(float64); ok && !math.IsNaN(value) && !math.IsInf(value, 0) && value >= 0 && math.Trunc(value) == value {
			return strconv.FormatFloat(value, 'f', -1, 64)
		}
	}
	return nil
}

func imageBedTimestamp(value string) any {
	if value == "" {
		return nil
	}
	var date time.Time
	if numeric, err := strconv.ParseFloat(value, 64); err == nil && !math.IsNaN(numeric) && math.Abs(numeric) <= 8640000000000000 {
		date = time.UnixMilli(int64(numeric))
	} else {
		var err error
		date, err = parseTimestamp(value)
		if err != nil {
			date, err = time.Parse(time.DateOnly, value)
		}
		if err != nil {
			return nil
		}
	}
	return date.UTC().Format("2006-01-02T15:04:05.000Z")
}

func imageBedCount(value any, fallback int) float64 {
	parsed, ok := value.(float64)
	if !ok {
		if raw, isString := value.(string); isString && strings.TrimSpace(raw) != "" {
			var err error
			parsed, err = strconv.ParseFloat(strings.TrimSpace(raw), 64)
			ok = err == nil
		}
	}
	if !ok || math.IsNaN(parsed) || math.IsInf(parsed, 0) {
		return float64(fallback)
	}
	return parsed
}

func imageBedListDTO(record Object, baseURL string) Object {
	rawFiles, _ := record["files"].([]any)
	files := []Object{}
	for _, raw := range rawFiles {
		file, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		name := imageBedText(file, "fullId", "fileId", "path", "key", "name", "id")
		relative, err := imagePath(name)
		if err != nil {
			continue
		}
		metadata, _ := file["metadata"].(map[string]any)
		files = append(files, Object{"name": name, "url": baseURL + "/file/" + relative,
			"mimeType": imageBedOptionalText(metadata, "File-Mime", "fileType"), "fileSizeBytes": imageBedSize(metadata),
			"uploadedAt": imageBedTimestamp(imageBedText(metadata, "TimeStamp", "timestamp")), "channel": imageBedOptionalText(metadata, "Channel", "channel")})
	}
	return Object{"files": files, "directories": imageBedStrings(record["directories"]),
		"totalCount": imageBedCount(record["totalCount"], len(rawFiles)), "returnedCount": imageBedCount(record["returnedCount"], len(rawFiles)),
		"indexLastUpdated": imageBedTimestamp(imageBedText(record, "indexLastUpdated"))}
}
