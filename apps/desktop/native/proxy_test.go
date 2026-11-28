package main

import (
	"context"
	"encoding/base64"
	"errors"
	"os"
	"reflect"
	"testing"
)

func testProxySettings(t *testing.T, settings []proxySetting) *[]proxySetting {
	t.Helper()
	state := settings
	originalRead, originalWrite := readProxySettings, writeProxySetting
	readProxySettings = func(context.Context) ([]proxySetting, error) { return state, nil }
	writeProxySetting = func(_ context.Context, setting proxySetting) error {
		for i, current := range state {
			if current.Service == setting.Service && current.Kind == setting.Kind {
				state[i] = setting
				return nil
			}
		}
		return errors.New("unknown proxy setting")
	}
	t.Cleanup(func() { readProxySettings = originalRead; writeProxySetting = originalWrite })
	return &state
}
func TestProxyJournalRestoresPreviousValuesNotBlanketClear(t *testing.T) {
	before := proxySetting{Service: "Wi-Fi", Kind: "web", Values: map[string]string{"enabled": "Yes", "server": "previous.proxy.test", "port": "8181", "authenticated": "0"}}
	owned := testDesiredProxy(before, 10809, 10808)
	state := testProxySettings(t, []proxySetting{owned})
	dir := t.TempDir()
	if err := atomicJSON(proxyJournalPath(dir), proxyJournal{Version: 1, Changes: []proxyChange{{Before: before, Owned: owned}}}); err != nil {
		t.Fatal(err)
	}
	if err := restoreProxyJournal(dir, false); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual((*state)[0], before) {
		t.Fatal("previous proxy was not restored", *state)
	}
	if _, err := os.Stat(proxyJournalPath(dir)); !os.IsNotExist(err) {
		t.Fatal("completed journal remains")
	}
}
func TestProxyRecoveryNeverOverwritesAnotherApplicationsNewSettings(t *testing.T) {
	before := proxySetting{Service: "Wi-Fi", Kind: "web", Values: map[string]string{"enabled": "No", "server": "", "port": "0"}}
	owned := testDesiredProxy(before, 10809, 10808)
	foreign := proxySetting{Service: "Wi-Fi", Kind: "web", Values: map[string]string{"enabled": "Yes", "server": "another.proxy.test", "port": "1234"}}
	state := testProxySettings(t, []proxySetting{foreign})
	dir := t.TempDir()
	atomicJSON(proxyJournalPath(dir), proxyJournal{Version: 1, Changes: []proxyChange{{Before: before, Owned: owned}}})
	if err := restoreProxyJournal(dir, false); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual((*state)[0], foreign) {
		t.Fatal("foreign proxy overwritten")
	}
}
func TestProxyRecoveryPreservesJournalWhenRestoreFails(t *testing.T) {
	before := proxySetting{Service: "Wi-Fi", Kind: "web", Values: map[string]string{"enabled": "No"}}
	owned := testDesiredProxy(before, 10809, 10808)
	testProxySettings(t, []proxySetting{owned})
	dir := t.TempDir()
	writeProxySetting = func(context.Context, proxySetting) error { return errors.New("permission denied") }
	atomicJSON(proxyJournalPath(dir), proxyJournal{Version: 1, Changes: []proxyChange{{Before: before, Owned: owned}}})
	if err := restoreProxyJournal(dir, false); err == nil {
		t.Fatal("restore failure hidden")
	}
	if _, err := os.Stat(proxyJournalPath(dir)); err != nil {
		t.Fatal("failed journal discarded")
	}
}
func TestWindowsDesiredProxyPreservesSnapshotAndUpdatesOwnershipBytes(t *testing.T) {
	connection := make([]byte, 12)
	connection[8] = 9
	before := proxySetting{Service: "current-user", Kind: "windows", Values: map[string]string{"ProxyEnable": "0", "ProxyEnable.missing": "1", "ProxyServer": "", "ProxyServer.missing": "1", "AutoConfigURL": "https://old.example.test/proxy.pac", "AutoDetect": "1", "connectionFlags": "9", "DefaultConnectionSettings": base64.StdEncoding.EncodeToString(connection)}}
	owned := testDesiredProxy(before, 10809, 10808)
	if owned.Values["ProxyEnable"] != "1" || owned.Values["ProxyEnable.missing"] != "" || owned.Values["ProxyServer.missing"] != "" {
		t.Fatal("missing marker prevented enabling proxy")
	}
	decoded, _ := base64.StdEncoding.DecodeString(owned.Values["DefaultConnectionSettings"])
	if decoded[8] != 3 || connection[8] != 9 {
		t.Fatal("proxy connection flags or snapshot corrupted")
	}
}

func TestUnexpectedWatchdogExitDisconnectsAndRestoresOwnedProxy(t *testing.T) {
	before := proxySetting{Service: "test-only", Kind: "web", Values: map[string]string{"enabled": "No", "server": "original.test", "port": "1234"}}
	owned := testDesiredProxy(before, 10809, 10808)
	state := testProxySettings(t, []proxySetting{owned})
	s := testService(t, "http://127.0.0.1:3100")
	atomicJSON(proxyJournalPath(s.cfg.DataDir), proxyJournal{Version: 1, Changes: []proxyChange{{Before: before, Owned: owned}}})
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	guard := &proxyWatchdog{pipe: writer, done: make(chan error, 1)}
	guard.done <- errors.New("watchdog unexpectedly stopped")
	close(guard.done)
	s.runtime.Status = "connected"
	s.runtime.watchdog = guard
	s.monitorWatchdog(guard)
	if s.runtime.Status != "idle" || !reflect.DeepEqual((*state)[0], before) {
		t.Fatal("watchdog failure did not stop and restore")
	}
}

func TestWindowsPartialMutationRemainsRecoverableWithoutOverwritingForeignValues(t *testing.T) {
	before := proxySetting{Kind: "windows", Values: map[string]string{"ProxyEnable": "0", "ProxyServer": "old.test:80", "effectiveFlags": "1", "effectiveProxyServer": "old.test:80"}}
	owned := testDesiredProxy(before, 10809, 10808)
	partial := proxySetting{Kind: "windows", Values: map[string]string{}}
	for key, value := range before.Values {
		partial.Values[key] = value
	}
	partial.Values["effectiveFlags"] = "3"
	partial.Values["effectiveProxyServer"] = owned.Values["effectiveProxyServer"]
	if !proxyPartiallyOwned(partial, before, owned) {
		t.Fatal("interrupted WinINet/registry mutation not recognized")
	}
	partial.Values["ProxyServer"] = "foreign.proxy.test:9999"
	if proxyPartiallyOwned(partial, before, owned) {
		t.Fatal("foreign proxy incorrectly marked as owned")
	}
}
