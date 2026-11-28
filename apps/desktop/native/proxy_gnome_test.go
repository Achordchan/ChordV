package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"reflect"
	"strings"
	"testing"
)

func gnomeTestSnapshot(mode string) proxySetting {
	values := map[string]string{"mode": mode, "autoconfig-url": "'https://previous.test/proxy.pac'", "ignore-hosts": "['localhost', '127.0.0.0/8', '*.internal.test']", "use-same-proxy": "true", "http.enabled": "false", "http.host": "'previous.test'", "http.port": "8181", "http.use-authentication": "false", "https.host": "'secure.test'", "https.port": "8443", "ftp.host": "'ftp.test'", "ftp.port": "2121", "socks.host": "'socks.test'", "socks.port": "1080"}
	gnomeDerived(values)
	return proxySetting{Service: gnomeProxyService, Kind: gnomeProxyKind, Values: values}
}

type isolatedGNOMEState struct {
	setting          proxySetting
	sets             [][]string
	failSet          int
	failureCommitted bool
	foreignAtSet     int
	policyLocked     string
	cancel           context.CancelFunc
	cancelAtSet      int
}

func cloneGNOMESetting(s proxySetting) proxySetting {
	r := proxySetting{Service: s.Service, Kind: s.Kind, Scope: s.Scope, Values: map[string]string{}}
	for k, v := range s.Values {
		r.Values[k] = v
	}
	return r
}
func (s *isolatedGNOMEState) run(ctx context.Context, args ...string) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if len(args) < 3 {
		return "", errors.New("test runner requires fixed schema/key")
	}
	var key *gnomeProxyKey
	for n := range gnomeProxyKeys {
		if gnomeProxyKeys[n].schema == args[1] && gnomeProxyKeys[n].key == args[2] {
			key = &gnomeProxyKeys[n]
			break
		}
	}
	if key == nil {
		return "", errors.New("unknown schema/key")
	}
	switch args[0] {
	case "get":
		if len(args) != 3 {
			return "", errors.New("get argument injection")
		}
		return s.setting.Values[key.field], nil
	case "writable":
		if len(args) != 3 {
			return "", errors.New("writable argument injection")
		}
		if key.field == s.policyLocked {
			return "false", nil
		}
		return "true", nil
	case "set":
		if len(args) != 4 {
			return "", errors.New("set argument injection")
		}
		s.sets = append(s.sets, append([]string{}, args...))
		n := len(s.sets)
		if n == s.failSet && !s.failureCommitted {
			return "", errors.New("isolated backend write failure")
		}
		s.setting.Values[key.field] = args[3]
		gnomeDerived(s.setting.Values)
		if n == s.foreignAtSet {
			s.setting.Values["https.host"] = "'foreign.application.test'"
		}
		if n == s.cancelAtSet && s.cancel != nil {
			s.cancel()
		}
		if n == s.failSet {
			return "", errors.New("isolated backend committed then returned error")
		}
		return "", nil
	default:
		return "", errors.New("unsupported command")
	}
}

func TestGNOMEProxyTakeoverAndExactRestore(t *testing.T) {
	for _, mode := range []string{"'none'", "'manual'", "'auto'"} {
		t.Run(mode, func(t *testing.T) {
			original := gnomeTestSnapshot(mode)
			state := &isolatedGNOMEState{setting: cloneGNOMESetting(original)}
			backend := gnomeProxyBackend{run: state.run}
			before, err := backend.read(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			owned, err := desiredProxy(before, 10809, 10808)
			if err != nil {
				t.Fatal(err)
			}
			if before.Values["mode"] != mode || owned.Values["use-same-proxy"] != "false" || owned.Values["socks.port"] != "10808" || owned.Values["https.port"] != "10809" || owned.Values["ftp.host"] != "''" || owned.Values["ignore-hosts"] != original.Values["ignore-hosts"] {
				t.Fatal("invalid GNOME owned configuration")
			}
			if err = backend.write(context.Background(), owned, before); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(state.setting, owned) {
				t.Fatal("takeover mismatch")
			}
			if last := state.sets[len(state.sets)-1]; last[2] != "mode" || last[3] != "'manual'" {
				t.Fatal("manual mode was not committed last", last)
			}
			if err = backend.write(context.Background(), before, owned); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(state.setting, original) {
				t.Fatal("original PAC/manual/ignored values not restored", state.setting)
			}
		})
	}
}

func TestGNOMEProxyEveryPartialWriteFailureRestoresOriginal(t *testing.T) {
	original := gnomeTestSnapshot("'auto'")
	owned, _ := gnomeOwnedProxy(original, 10809, 10808)
	successful := &isolatedGNOMEState{setting: cloneGNOMESetting(original)}
	if err := (gnomeProxyBackend{run: successful.run}).write(context.Background(), owned, original); err != nil {
		t.Fatal(err)
	}
	for _, committed := range []bool{false, true} {
		for position := 1; position <= len(successful.sets); position++ {
			t.Run(fmt.Sprintf("set=%d/committed=%t", position, committed), func(t *testing.T) {
				state := &isolatedGNOMEState{setting: cloneGNOMESetting(original), failSet: position, failureCommitted: committed}
				if err := (gnomeProxyBackend{run: state.run}).write(context.Background(), owned, original); err == nil {
					t.Fatal("failed write reported success")
				}
				if !reflect.DeepEqual(state.setting, original) {
					t.Fatal("partial proxy mutation remained", state.setting)
				}
			})
		}
	}
}

func TestGNOMEProxyCancellationAndForeignMutationRemainProtected(t *testing.T) {
	original := gnomeTestSnapshot("'auto'")
	owned, _ := gnomeOwnedProxy(original, 10809, 10808)
	t.Run("cancel", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		state := &isolatedGNOMEState{setting: cloneGNOMESetting(original), cancel: cancel, cancelAtSet: 3}
		if err := (gnomeProxyBackend{run: state.run}).write(ctx, owned, original); !errors.Is(err, context.Canceled) {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(state.setting, original) {
			t.Fatal("cancelled partial write was not restored")
		}
	})
	t.Run("foreign", func(t *testing.T) {
		state := &isolatedGNOMEState{setting: cloneGNOMESetting(original), foreignAtSet: 3}
		err := (gnomeProxyBackend{run: state.run}).write(context.Background(), owned, original)
		if !errors.Is(err, errProxyChanged) {
			t.Fatal(err)
		}
		if len(state.sets) != 3 || state.setting.Values["https.host"] != "'foreign.application.test'" {
			t.Fatal("foreign settings were overwritten", state.sets)
		}
	})
	t.Run("policy-lock", func(t *testing.T) {
		state := &isolatedGNOMEState{setting: cloneGNOMESetting(original), policyLocked: "https.port"}
		if err := (gnomeProxyBackend{run: state.run}).write(context.Background(), owned, original); err == nil || len(state.sets) != 0 {
			t.Fatal("policy-lock failed after modifying settings", err)
		}
	})
	t.Run("authentication", func(t *testing.T) {
		state := &isolatedGNOMEState{setting: cloneGNOMESetting(original)}
		state.setting.Values["http.use-authentication"] = "true"
		gnomeDerived(state.setting.Values)
		if _, err := gnomeOwnedProxy(state.setting, 10809, 10808); err == nil {
			t.Fatal("authenticated takeover accepted")
		}
		if err := (gnomeProxyBackend{run: state.run}).write(context.Background(), owned, state.setting); err == nil || len(state.sets) != 0 {
			t.Fatal("authenticated settings were modified")
		}
	})
}

func TestGNOMEJournalKeepsForeignStateAndFailureEvidence(t *testing.T) {
	original := gnomeTestSnapshot("'auto'")
	owned, _ := gnomeOwnedProxy(original, 10809, 10808)
	for _, foreign := range []bool{true, false} {
		t.Run(fmt.Sprint(foreign), func(t *testing.T) {
			state := &isolatedGNOMEState{setting: cloneGNOMESetting(owned)}
			if foreign {
				state.setting.Values["https.host"] = "'another.app.test'"
			} else {
				state.setting.Values["mode"] = "'none'"
				state.setting.Values["http.port"] = original.Values["http.port"]
				gnomeDerived(state.setting.Values)
			}
			oldRead, oldWrite := readProxySettings, writeProxySetting
			defer func() { readProxySettings = oldRead; writeProxySetting = oldWrite }()
			readProxySettings = func(ctx context.Context) ([]proxySetting, error) {
				v, err := (gnomeProxyBackend{run: state.run}).read(ctx)
				return []proxySetting{v}, err
			}
			writeProxySetting = func(ctx context.Context, target proxySetting) error {
				expected, ok := ctx.Value(proxyExpectationKey{}).(proxySetting)
				if !ok {
					t.Fatal("missing expected snapshot")
				}
				return (gnomeProxyBackend{run: state.run}).write(ctx, target, expected)
			}
			dir := t.TempDir()
			if err := atomicJSON(proxyJournalPath(dir), proxyJournal{Version: 1, Changes: []proxyChange{{Before: original, Owned: owned}}}); err != nil {
				t.Fatal(err)
			}
			err := restoreProxyJournal(dir, false)
			if foreign {
				if !errors.Is(err, errProxyChanged) || len(state.sets) != 0 {
					t.Fatal("foreign state overwritten", err)
				}
				if _, err = os.Stat(proxyJournalPath(dir)); err != nil {
					t.Fatal("foreign conflict discarded recovery journal")
				}
			} else {
				if err != nil || !reflect.DeepEqual(state.setting, original) {
					t.Fatal("partial journal did not restore exact snapshot", err)
				}
				if _, err = os.Stat(proxyJournalPath(dir)); !os.IsNotExist(err) {
					t.Fatal("successful journal not removed")
				}
			}
		})
	}
}

func TestGNOMEUserSessionEnvironmentNeverForwardsProxyVariables(t *testing.T) {
	source := []string{"XDG_CURRENT_DESKTOP=ubuntu:GNOME", "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus", "XDG_RUNTIME_DIR=/run/user/1000", "XDG_CONFIG_HOME=/home/test/.config", "HTTPS_PROXY=http://secret@evil.test", "GSETTINGS_BACKEND=memory"}
	result := gnomeSessionEnvironment(source)
	if len(result) != 4 {
		t.Fatal("valid GNOME session variables were lost", result)
	}
	for _, entry := range result {
		if strings.Contains(entry, "PROXY") || strings.Contains(entry, "GSETTINGS") {
			t.Fatal("untrusted proxy/backend override forwarded")
		}
	}
	source[0] = "XDG_CURRENT_DESKTOP=KDE"
	if len(gnomeSessionEnvironment(source)) != 0 {
		t.Fatal("KDE claimed GNOME support")
	}
	source[0] = "XDG_CURRENT_DESKTOP=GNOME"
	source[1] = "DBUS_SESSION_BUS_ADDRESS=tcp:host=remote.test"
	if len(gnomeSessionEnvironment(source)) != 0 {
		t.Fatal("non-local session bus accepted")
	}
}

func TestGNOMEUserSessionEnvironmentPreservesDconfProfile(t *testing.T) {
	source := []string{"XDG_CURRENT_DESKTOP=GNOME", "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus", "XDG_RUNTIME_DIR=/run/user/1000", "DCONF_PROFILE=/etc/dconf/profile/company"}
	if !strings.Contains(strings.Join(gnomeSessionEnvironment(source), "\n"), "DCONF_PROFILE=/etc/dconf/profile/company") {
		t.Fatal("gsettings and watchdog must use the same profile as the desktop session")
	}
	source[3] = "DCONF_PROFILE=company\nOTHER=value"
	if len(gnomeSessionEnvironment(source)) != 0 {
		t.Fatal("invalid profile environment accepted")
	}
}

func TestLinuxProcStarttimeIgnoresMutableCountersAndParentheses(t *testing.T) {
	fields := []string{"S", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15", "16", "17", "18", "987654321", "99", "100"}
	one := []byte("123 (worker ) name ( with spaces)) " + strings.Join(fields, " "))
	first, err := linuxProcessStarttime(one, 123)
	if err != nil || first != "123:987654321" {
		t.Fatal(first, err)
	}
	fields[0] = "R"
	fields[11] = "12345678"
	fields[20] = "98765"
	two := []byte("123 (changed comm ())) " + strings.Join(fields, " "))
	second, err := linuxProcessStarttime(two, 123)
	if err != nil || first != second {
		t.Fatal("mutable stat fields changed process identity", first, second, err)
	}
	if string(one) == string(two) {
		t.Fatal("old full /proc/stat identity counterexample not exercised")
	}
	for _, bad := range []string{"123 (unterminated", "124 (other) " + strings.Join(fields, " "), "123 (x) S 1 2"} {
		if _, err = linuxProcessStarttime([]byte(bad), 123); err == nil {
			t.Fatal("malformed PID/stat accepted")
		}
	}
}

func TestGNOMEAlreadyRestoredSnapshotDoesNotToggleOrRequireWritableMode(t *testing.T) {
	for _, mode := range []string{"'none'", "'manual'", "'auto'"} {
		t.Run(mode, func(t *testing.T) {
			original := gnomeTestSnapshot(mode)
			state := &isolatedGNOMEState{setting: cloneGNOMESetting(original), policyLocked: "mode"}
			backend := gnomeProxyBackend{run: state.run}
			if err := backend.write(context.Background(), original, original); err != nil {
				t.Fatal("already restored snapshot must be a no-op, even with policy locked", err)
			}
			if len(state.sets) != 0 || !reflect.DeepEqual(state.setting, original) {
				t.Fatal("an idempotent restore toggled existing configuration")
			}
		})
	}
}
