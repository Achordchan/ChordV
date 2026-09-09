// Package decimal handles the wire format the control plane uses for every
// number that must not lose precision: a non-negative integer as a decimal
// string. Byte counters, quotas and config revisions all travel this way, and
// the server validates them with /^(0|[1-9]\d*)$/ — so a value that only
// round-trips through float64 (or that carries a leading zero, a sign, or
// whitespace) is rejected there rather than here, which is far harder to debug.
package decimal

import (
	"fmt"
	"math/big"
)

// Normalize validates the wire form and returns its canonical spelling.
// It is the Go counterpart of the Node agent's decimal() guard.
func Normalize(value string) (string, error) {
	parsed, err := Parse(value)
	if err != nil {
		return "", err
	}
	return parsed.String(), nil
}

// Parse validates and returns the value. The result is a fresh big.Int the
// caller may mutate.
func Parse(value string) (*big.Int, error) {
	if !valid(value) {
		return nil, fmt.Errorf("无效的非负十进制整数字符串: %q", value)
	}
	parsed, ok := new(big.Int).SetString(value, 10)
	if !ok {
		return nil, fmt.Errorf("无效的非负十进制整数字符串: %q", value)
	}
	return parsed, nil
}

// Cmp reports -1, 0 or 1 for a against b, rejecting either malformed operand.
// Revisions are compared this way rather than as int64: the control plane's
// revision is a monotonic counter with no documented ceiling, and a silent
// wrap would make an old command look newer than the state it must not undo.
func Cmp(a, b string) (int, error) {
	left, err := Parse(a)
	if err != nil {
		return 0, err
	}
	right, err := Parse(b)
	if err != nil {
		return 0, err
	}
	return left.Cmp(right), nil
}

// Less is Cmp < 0, reporting the error separately so callers that treat a
// malformed revision as fatal do not have to spell out the comparison.
func Less(a, b string) (bool, error) {
	order, err := Cmp(a, b)
	return order < 0, err
}

// valid implements ^(0|[1-9]\d*)$ without a regexp: this runs on every sample
// for every user, and the rule is three lines.
func valid(value string) bool {
	if value == "" {
		return false
	}
	if value == "0" {
		return true
	}
	if value[0] < '1' || value[0] > '9' {
		return false
	}
	for i := 1; i < len(value); i++ {
		if value[i] < '0' || value[i] > '9' {
			return false
		}
	}
	return true
}
