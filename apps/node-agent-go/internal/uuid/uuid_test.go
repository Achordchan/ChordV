package uuid

import (
	"regexp"
	"testing"
)

var pattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

func TestNewV4ShapeAndUniqueness(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 1000; i++ {
		value, err := NewV4()
		if err != nil {
			t.Fatal(err)
		}
		if !pattern.MatchString(value) {
			t.Fatalf("NewV4() = %q, not a v4 UUID", value)
		}
		// A boot id collision would make two boots share one metering sequence
		// space, and the control plane would read the second boot's batches as
		// replays of the first's.
		if seen[value] {
			t.Fatalf("NewV4() repeated %q", value)
		}
		seen[value] = true
	}
}
