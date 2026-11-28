//go:build linux

package main

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

func readActualDconf(t *testing.T) proxySetting {
	t.Helper()
	settings, err := platformReadProxy(context.Background())
	if err != nil || len(settings) != 1 {
		t.Fatal("actual session proxy read failed", settings, err)
	}
	return settings[0]
}

func seedActualDconf(t *testing.T, setting proxySetting) {
	t.Helper()
	for _, key := range gnomeProxyKeys {
		realDconfCommand(t, "set", key.schema, key.key, setting.Values[key.field])
	}
}

func testDconfNamespaceIsolation(t *testing.T, root string, _ proxySetting) {
	profile := filepath.Join(root, "profile")
	original := readActualDconf(t)
	staleBackend, err := linuxGNOMEBackend()
	if err != nil {
		t.Fatal(err)
	}
	target, targetDone := startDconfTarget(t)
	identity := captureDconfProcess(t, target.Process.Pid)
	owned, err := desiredProxy(original, 10809, 10808)
	if err != nil {
		t.Fatal(err)
	}
	journal := proxyJournal{Version: 1, PID: identity.PID, Binary: identity.Binary, ProcessIdentity: identity.Identity, Changes: []proxyChange{{Before: original, Owned: owned}}}
	dir := filepath.Join(root, "recovery")
	if err = atomicJSON(proxyJournalPath(dir), journal); err != nil {
		t.Fatal(err)
	}
	if err = platformWriteProxy(expectedProxyContext(context.Background(), original), owned); err != nil {
		t.Fatal(err)
	}
	// Keep the same profile file path and the same visible owned values, but
	// select another actual dconf database. Value-only ownership cannot see it.
	if err = os.WriteFile(profile, []byte("user-db:foreign_namespace\n"), 0600); err != nil {
		t.Fatal(err)
	}
	seedActualDconf(t, owned)
	foreign := readActualDconf(t)
	if !reflect.DeepEqual(foreign.Values, owned.Values) {
		t.Fatal("foreign namespace did not have the same visible owned values")
	}
	if _, err = staleBackend.read(context.Background()); err == nil {
		t.Error("an already captured backend silently followed a changed profile")
	}
	if err = recoverProxyJournal(dir); err == nil {
		t.Error("journal from profile A was accepted in profile B")
	}
	if got := readActualDconf(t); !reflect.DeepEqual(got, foreign) {
		t.Error("recovery overwrote a different actual dconf database", got)
	}
	if _, err = os.Stat(proxyJournalPath(dir)); err != nil {
		t.Error("namespace mismatch discarded recovery evidence", err)
	}
	select {
	case <-targetDone:
		t.Error("namespace mismatch killed the recorded target")
	default:
	}
	if err = os.WriteFile(profile, []byte("user-db:chordv_integration\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err = recoverProxyJournal(dir); err != nil {
		t.Fatal("returning to the original profile could not recover", err)
	}
	if got := readActualDconf(t); !reflect.DeepEqual(got, original) {
		t.Fatal("original profile snapshot not restored", got)
	}
	select {
	case <-targetDone:
	case <-time.After(time.Second):
		t.Fatal("original namespace recovery did not stop its recorded target")
	}
	t.Log("same path changed profile content: foreign database with identical values preserved; evidence kept; original profile recovers normally")
}
