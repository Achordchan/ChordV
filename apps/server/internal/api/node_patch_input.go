package api

import (
	_ "embed"
	"encoding/json"
	"math"
	"regexp"
	"strings"
	"unicode"
)

//go:embed node_patch_countries.json
var nodePatchCountryJSON []byte

var nodePatchCountries = func() struct {
	Codes           map[string]string `json:"codes"`
	Names           map[string]string `json:"names"`
	UpperExpansions map[string]string `json:"upperExpansions"`
} {
	var data struct {
		Codes           map[string]string `json:"codes"`
		Names           map[string]string `json:"names"`
		UpperExpansions map[string]string `json:"upperExpansions"`
	}
	if err := json.Unmarshal(nodePatchCountryJSON, &data); err != nil {
		panic(err)
	}
	return data
}()

var nodePatchCountryPattern = regexp.MustCompile(`^[A-Za-z]{2}$`)

func validateNodePatchInput(input Object) (Object, error) {
	input = pick(input, "name", "countryCode", "region", "provider", "tags", "isActive", "recommended")
	for _, field := range []string{"name", "countryCode", "region", "provider"} {
		if raw, exists := input[field]; exists {
			value, ok := raw.(string)
			if !ok || value == "" || (field == "countryCode" && !nodePatchCountryPattern.MatchString(value)) {
				return nil, fail(400, field+" 必须是有效的非空字符串")
			}
		}
	}
	for _, field := range []string{"isActive", "recommended"} {
		if value, exists := input[field]; exists {
			if _, ok := value.(bool); !ok {
				return nil, fail(400, field+" 必须是JSON布尔值")
			}
		}
	}
	if raw, exists := input["tags"]; exists {
		values, ok := raw.([]any)
		if !ok {
			return nil, fail(400, "tags 必须是字符串数组")
		}
		for _, value := range values {
			if _, ok := value.(string); !ok {
				return nil, fail(400, "tags 必须是字符串数组")
			}
		}
	}
	return input, nil
}

// ECMAScript trim excludes U+0085 and includes U+FEFF, unlike TrimSpace.
func nodePatchTrim(value string) string {
	return strings.TrimFunc(value, func(r rune) bool {
		return unicode.Is(unicode.Zs, r) || strings.ContainsRune("\t\n\v\f\r\u2028\u2029\ufeff", r)
	})
}

func nodePatchCountryCode(value any) string {
	text, _ := value.(string)
	var upper strings.Builder
	for _, r := range nodePatchTrim(text) {
		if expanded, exists := nodePatchCountries.UpperExpansions[string(r)]; exists {
			upper.WriteString(expanded)
		} else {
			upper.WriteRune(unicode.ToUpper(r))
		}
	}
	code := upper.String()
	if _, exists := nodePatchCountries.Codes[code]; exists {
		return code
	}
	return ""
}

func nodePatchCountryFromName(value any) string {
	if code := nodePatchCountryCode(value); code != "" {
		return code
	}
	text, _ := value.(string)
	// JS lowercasing expands capital I-with-dot, unlike Go's single-rune fold.
	key := strings.ToLower(strings.ReplaceAll(nodePatchTrim(text), "\u0130", "i\u0307"))
	return nodePatchCountries.Names[key]
}

func nodePatchInferredRegion(name, host string) string {
	value := strings.ToLower(strings.ReplaceAll(name+" "+host, "\u0130", "i\u0307"))
	for _, group := range [][]string{{"香港", "hk", "hong kong", "香港"}, {"新加坡", "sg", "singapore", "新加坡"}, {"日本", "jp", "japan", "日本"}, {"美国", "us", "united states", "america", "美国"}} {
		for _, match := range group[1:] {
			if strings.Contains(value, match) {
				return group[0]
			}
		}
	}
	return "未分组"
}

func normalizeNodePatchMetadata(input, current Object) {
	for _, field := range []string{"name", "provider"} {
		if value, exists := input[field].(string); exists {
			input[field] = nodePatchTrim(value)
		}
	}
	name, _ := input["name"].(string)
	if name == "" {
		name, _ = current["name"].(string)
	}
	if values, exists := input["tags"].([]any); exists {
		tags := []string{}
		for _, value := range values {
			if tag := nodePatchTrim(value.(string)); tag != "" {
				tags = append(tags, tag)
			}
		}
		if len(values) == 0 {
			tags = []string{"导入"}
			lower := strings.ToLower(name)
			for _, group := range [][]string{{"香港", "hk", "香港"}, {"新加坡", "sg", "新加坡"}, {"日本", "jp", "日本"}, {"美国", "us", "美国"}} {
				if strings.Contains(lower, group[1]) || strings.Contains(lower, group[2]) {
					tags = []string{group[0]}
					break
				}
			}
		}
		input["tags"] = tags
	}
	_, countryTouched := input["countryCode"]
	_, regionTouched := input["region"]
	if !countryTouched && !regionTouched {
		return
	}
	country, region := current["countryCode"], current["region"]
	if countryTouched {
		country = input["countryCode"]
	}
	if regionTouched {
		region = input["region"]
	}
	code := nodePatchCountryCode(country)
	for _, value := range []any{region, name, current["serverHost"]} {
		if code == "" {
			code = nodePatchCountryFromName(value)
		}
	}
	regionText, _ := region.(string)
	regionText = nodePatchTrim(regionText)
	if label := nodePatchCountries.Codes[code]; label != "" {
		regionText = label
	} else if regionText == "" {
		host, _ := current["serverHost"].(string)
		regionText = nodePatchInferredRegion(name, host)
	}
	input["countryCode"], input["region"] = nil, regionText
	if code != "" {
		input["countryCode"] = code
	}
}

func nodePatchOnboardingReady(node Object) bool {
	read := func(field string) string {
		value, _ := node[field].(string)
		return nodePatchTrim(value)
	}
	host, port := read("serverHost"), number(node, "serverPort")
	if host == "" || strings.EqualFold(host, "pending-agent") || port < 1 || port > 65535 || math.Trunc(port) != port {
		return false
	}
	if node["registrationStatus"] == nil {
		return true
	}
	return node["registrationStatus"] == "agent_ready" && node["protocol"] == "vless" && node["security"] == "reality" && read("uuid") != "" && read("realityPublicKey") != "" && read("serverName") != "" && read("fingerprint") != ""
}
