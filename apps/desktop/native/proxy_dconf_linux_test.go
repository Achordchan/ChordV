//go:build linux

package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func runIsolatedDconfSession(t *testing.T, role string) {
	t.Helper()
	if os.Getenv("CHORDV_TEST_ISOLATED_DCONF") != "1" {
		t.Skip("requires explicitly provisioned Linux dbus/dconf tools; never uses the host session")
	}
	if os.Geteuid() == 0 {
		t.Fatal("dconf integration must run as an unprivileged user")
	}
	root := t.TempDir()
	for _, name := range []string{"runtime", "config"} {
		if err := os.Mkdir(filepath.Join(root, name), 0700); err != nil {
			t.Fatal(err)
		}
	}
	profile := filepath.Join(root, "profile")
	if err := os.WriteFile(profile, []byte("user-db:chordv_integration\n"), 0600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, "dbus-run-session", "--", os.Args[0], "-test.run=^TestLinuxDconfSessionHelper$", "-test.v")
	command.Env = []string{"PATH=" + os.Getenv("PATH"), "HOME=" + root, "XDG_CONFIG_HOME=" + filepath.Join(root, "config"), "XDG_RUNTIME_DIR=" + filepath.Join(root, "runtime"), "XDG_CURRENT_DESKTOP=GNOME", "LANG=C.UTF-8", "DCONF_PROFILE=" + profile, "CHORDV_DCONF_TEST_ROOT=" + root, "CHORDV_DCONF_TEST_ROLE=" + role}
	if assets := os.Getenv("CHORDV_TEST_XRAY_DIR"); assets != "" {
		command.Env = append(command.Env, "CHORDV_TEST_XRAY_DIR="+assets)
	}
	if probe := os.Getenv("CHORDV_TEST_GIO_PROBE"); probe != "" {
		command.Env = append(command.Env, "CHORDV_TEST_GIO_PROBE="+probe)
	}
	output, err := command.CombinedOutput()
	t.Logf("isolated real dconf session: %s", output)
	if err != nil {
		t.Fatal("isolated D-Bus session failed", err)
	}
	if _, err = os.Stat(filepath.Join(root, "config", "dconf", "chordv_integration")); err != nil {
		t.Fatal("no real custom-profile dconf database was written", err)
	}
	if _, err = os.Stat(filepath.Join(root, "config", "dconf", "user")); !os.IsNotExist(err) {
		t.Fatal("production backend escaped the session profile into the default user database", err)
	}
}

func realDconfCommand(t *testing.T, args ...string) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, "gsettings", args...)
	command.Env = append(os.Environ(), "GSETTINGS_BACKEND=dconf")
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatal("real gsettings failed", args, string(output), err)
	}
	return strings.TrimSpace(string(output))
}

func TestLinuxDconfCustomProfileMatchesSession(t *testing.T) {
	runIsolatedDconfSession(t, "profile")
}

func TestLinuxDconfTakeoverAndRestore(t *testing.T) {
	runIsolatedDconfSession(t, "roundtrip")
}

func TestLinuxDconfWatchdogEOF(t *testing.T) {
	runIsolatedDconfSession(t, "watchdog-eof")
}

func TestLinuxDconfWatchdogParentSIGKILL(t *testing.T) {
	runIsolatedDconfSession(t, "watchdog-sigkill")
}

func TestLinuxDconfWatchdogForeignChangePreserved(t *testing.T) {
	runIsolatedDconfSession(t, "watchdog-foreign")
}

func TestLinuxDconfRecoveryNeverCrossesProfileNamespace(t *testing.T) {
	runIsolatedDconfSession(t, "namespace")
}

func TestLinuxDconfRealXrayTrafficAndCrashRecovery(t *testing.T) {
	if os.Getenv("CHORDV_TEST_XRAY_DIR") == "" {
		t.Skip("requires explicit genuine Linux Xray/GEO assets in an isolated session")
	}
	runIsolatedDconfSession(t, "runtime")
}

func TestLinuxDconfRealXrayParentSIGKILL(t *testing.T) {
	if os.Getenv("CHORDV_TEST_XRAY_DIR") == "" {
		t.Skip("requires explicit genuine Linux Xray/GEO assets in an isolated session")
	}
	runIsolatedDconfSession(t, "runtime-sigkill")
}

func TestLinuxDconfDefaultGIOProxyDiscovery(t *testing.T) {
	if os.Getenv("CHORDV_TEST_XRAY_DIR") == "" || os.Getenv("CHORDV_TEST_GIO_PROBE") == "" {
		t.Skip("requires explicit genuine Linux Xray and compiled system GIO probe in an isolated session")
	}
	runIsolatedDconfSession(t, "gio")
}

func TestLinuxDconfSessionHelper(t *testing.T) {
	role := os.Getenv("CHORDV_DCONF_TEST_ROLE")
	if role == "" {
		return
	}
	root := os.Getenv("CHORDV_DCONF_TEST_ROOT")
	if !filepath.IsAbs(root) || os.Getenv("HOME") != root || os.Getenv("XDG_CONFIG_HOME") != filepath.Join(root, "config") || os.Getenv("XDG_RUNTIME_DIR") != filepath.Join(root, "runtime") || os.Getenv("DCONF_PROFILE") != filepath.Join(root, "profile") {
		t.Fatal("test subprocess must use its exact private session paths")
	}
	if role == "holder" {
		runDconfWatchdogHolder(t, root)
		return
	}
	if role == "runtime-holder" {
		runDconfRuntimeHolder(t, root)
		return
	}
	mode := "'auto'"
	if role == "gio" {
		mode = "'none'"
	}
	original := gnomeTestSnapshot(mode)
	for _, key := range gnomeProxyKeys {
		realDconfCommand(t, "set", key.schema, key.key, original.Values[key.field])
	}
	backend, err := linuxGNOMEBackend()
	if err != nil {
		t.Fatal(err)
	}
	actual, err := backend.read(context.Background())
	if err != nil || actual.Kind != original.Kind || actual.Service != original.Service || !reflect.DeepEqual(actual.Values, original.Values) {
		t.Fatalf("production backend read a different profile: want=%+v actual=%+v error=%v", original, actual, err)
	}
	original = actual
	switch role {
	case "profile":
	case "roundtrip":
		testRealDconfRoundtrip(t, backend, original)
	case "watchdog-eof":
		testRealDconfWatchdogEOF(t, root, original)
	case "watchdog-sigkill":
		testRealDconfWatchdogSIGKILL(t, root, original, "holder")
	case "watchdog-foreign":
		testRealDconfForeignChange(t, root)
	case "namespace":
		testDconfNamespaceIsolation(t, root, original)
	case "runtime":
		testDconfRuntimeTraffic(t, root, original)
	case "runtime-sigkill":
		testRealDconfWatchdogSIGKILL(t, root, original, "runtime-holder")
	case "gio":
		testDconfDefaultGIO(t, root, original)
	default:
		t.Fatal("unknown isolated dconf test role")
	}
	t.Log("production gsettings honors the real session DCONF_PROFILE; no host session or keyfile backend")
}

func testRealDconfRoundtrip(t *testing.T, backend gnomeProxyBackend, original proxySetting) {
	owned, err := gnomeOwnedProxy(original, 10809, 10808)
	if err != nil {
		t.Fatal(err)
	}
	if err = platformWriteProxy(expectedProxyContext(context.Background(), original), owned); err != nil {
		t.Fatal(err)
	}
	if got, err := backend.read(context.Background()); err != nil || !reflect.DeepEqual(got, owned) {
		t.Fatal("real dconf takeover mismatch", got, err)
	}
	if err = platformWriteProxy(expectedProxyContext(context.Background(), owned), original); err != nil {
		t.Fatal(err)
	}
	if got, err := backend.read(context.Background()); err != nil || !reflect.DeepEqual(got, original) {
		t.Fatal("real dconf snapshot was not restored", got, err)
	}
}
