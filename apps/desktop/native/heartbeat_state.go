package main

import "time"

type leaseFailureWindow struct{ firstFailure time.Time }

func (w *leaseFailureWindow) observe(now time.Time, grace time.Duration, ok bool) bool {
	if ok {
		w.firstFailure = time.Time{}
		return false
	}
	if w.firstFailure.IsZero() {
		w.firstFailure = now
		return false
	}
	return now.Sub(w.firstFailure) >= grace
}
