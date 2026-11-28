package main

import (
	"context"
	"strings"
	"testing"
)

func TestGNOMERestoreRequiresMatchingRecordedNamespace(t *testing.T) {
	before := gnomeTestSnapshot("'auto'")
	before.Scope = strings.Repeat("a", 64)
	owned, err := gnomeOwnedProxy(before, 10809, 10808)
	if err != nil {
		t.Fatal(err)
	}
	write := writeProxySetting
	t.Cleanup(func() { writeProxySetting = write })
	writes := 0
	writeProxySetting = func(context.Context, proxySetting) error { writes++; return nil }
	for _, recordedScope := range []string{"", strings.Repeat("b", 64)} {
		old, wanted := cloneGNOMESetting(before), cloneGNOMESetting(owned)
		old.Scope, wanted.Scope = recordedScope, recordedScope
		if err = restoreGNOMEProxyChange(context.Background(), proxyChange{Before: old, Owned: wanted}, []proxySetting{owned}); err == nil {
			t.Fatal("legacy or foreign namespace authorized restoration")
		}
		if gnomePartiallyOwned(owned, old, wanted) {
			t.Fatal("partial ownership ignored namespace")
		}
	}
	if writes != 0 {
		t.Fatal("namespace mismatch invoked a proxy write", writes)
	}
	if err = restoreGNOMEProxyChange(context.Background(), proxyChange{Before: before, Owned: owned}, []proxySetting{owned}); err != nil || writes != 1 {
		t.Fatal("same namespace did not permit the original recovery", err, writes)
	}
}

func TestGNOMEWriteCannotMoveSnapshotAcrossNamespaces(t *testing.T) {
	before := gnomeTestSnapshot("'auto'")
	before.Scope = strings.Repeat("a", 64)
	owned, err := gnomeOwnedProxy(before, 10809, 10808)
	if err != nil || owned.Scope != before.Scope {
		t.Fatal("desired snapshot lost namespace", err)
	}
	owned.Scope = strings.Repeat("b", 64)
	called := false
	backend := gnomeProxyBackend{run: func(context.Context, ...string) (string, error) { called = true; return "", nil }}
	if err = backend.write(context.Background(), owned, before); err == nil || called {
		t.Fatal("cross-namespace snapshot reached settings backend", err, called)
	}
	owned.Scope = "INVALID"
	if validateGNOMEProxy(owned) == nil {
		t.Fatal("malformed namespace accepted")
	}
}
