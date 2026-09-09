package decimal

import "testing"

func TestNormalizeAcceptsOnlyCanonicalNonNegativeIntegers(t *testing.T) {
	for _, value := range []string{"0", "1", "42", "18446744073709551616"} {
		got, err := Normalize(value)
		if err != nil || got != value {
			t.Fatalf("Normalize(%q) = %q, %v; want %q, nil", value, got, err, value)
		}
	}
	// Every one of these would be accepted by a naive strconv/float parse and
	// then REJECTED by the server's regexp, turning a local bug into a remote
	// 400 that is far harder to attribute.
	for _, value := range []string{"", " 1", "1 ", "01", "+1", "-1", "1.0", "1e3", "0x10", "abc", "١٢٣"} {
		if _, err := Normalize(value); err == nil {
			t.Fatalf("Normalize(%q) accepted a value the control plane rejects", value)
		}
	}
}

func TestCmpUsesArbitraryPrecision(t *testing.T) {
	// Beyond float64's exact range: parsed as a float, these two compare EQUAL,
	// which would let a stale revision overwrite a newer one.
	low := "9007199254740993"
	high := "9007199254740994"
	order, err := Cmp(low, high)
	if err != nil || order != -1 {
		t.Fatalf("Cmp(%s, %s) = %d, %v; want -1, nil", low, high, order, err)
	}
	less, err := Less(high, low)
	if err != nil || less {
		t.Fatalf("Less(%s, %s) = %v, %v; want false, nil", high, low, less, err)
	}
	if _, err := Cmp("1", "-1"); err == nil {
		t.Fatal("Cmp accepted a malformed operand instead of reporting it")
	}
}

func TestParseReturnsIndependentValues(t *testing.T) {
	first, err := Parse("10")
	if err != nil {
		t.Fatal(err)
	}
	first.SetInt64(99)
	second, err := Parse("10")
	if err != nil || second.String() != "10" {
		t.Fatalf("Parse returned shared state: %v, %v", second, err)
	}
}
