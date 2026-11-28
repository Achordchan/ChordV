package api

import (
	"errors"
	"net/netip"
	"regexp"
	"strings"
	"unicode"
)

var supportSensitivePatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)[a-z][a-z0-9+.-]*://`),
	regexp.MustCompile(`(?i)(?:^|[^a-z0-9.-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]*[a-z](?::[0-9]{1,5})?(?:[^a-z0-9-]|$)`),
	regexp.MustCompile(`(?i)(?:^|[^a-z0-9.-])[a-z][a-z0-9.-]*:[0-9]{2,5}`),
	regexp.MustCompile(`[^\s@]+@[^\s@]+\.[^\s@]+`),
	regexp.MustCompile(`(?:^|[^0-9.])[0-9]{1,3}(?:\.[0-9]{1,3}){3}(?:$|[^0-9.])`),
	regexp.MustCompile(`(?i)(?:^|[\s（(])(?:/|~/|[a-z]:\\|\\\\)`),
	regexp.MustCompile(`[A-Za-z0-9+/_=-]{32,}`),
}
var supportUTC = regexp.MustCompile(`(?i)\bUTC[+-][0-9]{1,2}(?::[0-9]{2})?`)
var ipv6Token = regexp.MustCompile(`[0-9a-fA-F:.%]+`)

func isNoSubscription(err error) bool { return errors.Is(err, errNoSubscription) }
func sanitizeSupportText(value string) string {
	clean := strings.Join(strings.Fields(strings.Map(func(ch rune) rune {
		if unicode.IsControl(ch) || (ch >= 0x200b && ch <= 0x200f) || (ch >= 0x2028 && ch <= 0x202e) || (ch >= 0x2066 && ch <= 0x2069) || ch == 0xfeff {
			return ' '
		}
		return ch
	}, value)), " ")
	check := supportUTC.ReplaceAllString(clean, " ")
	for _, pattern := range supportSensitivePatterns {
		if pattern.MatchString(check) {
			return ""
		}
	}
	for _, token := range ipv6Token.FindAllString(check, -1) {
		if strings.Count(token, ":") < 2 {
			continue
		}
		if len(token) > 64 {
			return ""
		}
		token = strings.Split(token, "%")[0]
		for start := 0; start < len(token); start++ {
			for end := len(token); end > start+1; end-- {
				if ip, e := netip.ParseAddr(token[start:end]); e == nil && ip.Is6() {
					return ""
				}
			}
		}
	}
	return clean
}
