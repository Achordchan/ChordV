package main

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestSchema2BindingCacheBoundsTTLFailureAndSingleFlight(t *testing.T) {
	var cache releaseBindingCache
	var calls atomic.Int32
	work := func() error { calls.Add(1); return nil }
	for i := 0; i < 10; i++ {
		if err := cache.check(context.Background(), fmt.Sprint(i), work); err != nil {
			t.Fatal(err)
		}
	}
	if len(cache.entries) != 8 {
		t.Fatal("cache is not capped", len(cache.entries))
	}
	cache.entries["9"] = time.Now().Add(-31 * time.Second)
	if err := cache.check(context.Background(), "9", work); err != nil || calls.Load() != 11 {
		t.Fatal("expired success reused", err)
	}
	for i := 0; i < 2; i++ {
		if cache.check(context.Background(), "failure", func() error { calls.Add(1); return errors.New("expected") }) == nil {
			t.Fatal("failure accepted")
		}
	}
	if _, ok := cache.entries["failure"]; ok || calls.Load() != 13 {
		t.Fatal("failure was cached")
	}
	var concurrent releaseBindingCache
	start := make(chan struct{})
	release := make(chan struct{})
	var leaders atomic.Int32
	var wg sync.WaitGroup
	leader := func() error { leaders.Add(1); close(start); <-release; return nil }
	wg.Add(1)
	go func() {
		defer wg.Done()
		if err := concurrent.check(context.Background(), "same", leader); err != nil {
			t.Error(err)
		}
	}()
	<-start
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := concurrent.check(context.Background(), "same", leader); err != nil {
				t.Error(err)
			}
		}()
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Millisecond)
	defer cancel()
	if concurrent.check(ctx, "same", leader) == nil {
		t.Fatal("pending waiter ignored cancellation")
	}
	close(release)
	wg.Wait()
	if leaders.Load() != 1 {
		t.Fatal("duplicate verification", leaders.Load())
	}
}
func TestSchema2BindingCacheLimitsConcurrentDistinctKeys(t *testing.T) {
	var cache releaseBindingCache
	release := make(chan struct{})
	started := make(chan struct{}, 8)
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(key int) {
			defer wg.Done()
			_ = cache.check(context.Background(), fmt.Sprint(key), func() error { started <- struct{}{}; <-release; return nil })
		}(i)
	}
	for i := 0; i < 8; i++ {
		<-started
	}
	if cache.check(context.Background(), "ninth", func() error { return nil }) == nil {
		t.Fatal("unbounded parallel verification")
	}
	close(release)
	wg.Wait()
}
