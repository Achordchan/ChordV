package main

import (
	"testing"
	"time"
)

func TestLeaseFirstFailureGraceAndRecovery(t *testing.T) {
	var window leaseFailureWindow
	start := time.Unix(1700000000, 0)
	grace := 300 * time.Second
	for _, step := range []struct {
		seconds int
		ok      bool
		expired bool
	}{{0, true, false}, {1000, false, false}, {1299, false, false}, {1300, false, true},
		{1301, true, false}, {2000, false, false}, {2299, false, false}, {2300, false, true}} {
		if got := window.observe(start.Add(time.Duration(step.seconds)*time.Second), grace, step.ok); got != step.expired {
			t.Fatalf("at %ds ok=%v expiry=%v want=%v", step.seconds, step.ok, got, step.expired)
		}
	}
}
