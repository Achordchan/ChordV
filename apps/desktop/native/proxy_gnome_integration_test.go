package main

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

func TestGNOMEActualGSettingsIsolatedKeyfile(t *testing.T) {
	schema := os.Getenv("CHORDV_TEST_GNOME_SCHEMA_DIR")
	if schema == "" {
		t.Skip("requires explicit official proxy schemas; never use host configuration")
	}
	schema, err := filepath.Abs(schema)
	if err != nil {
		t.Fatal(err)
	}
	binary, err := exec.LookPath("gsettings")
	if err != nil {
		t.Skip("gsettings is not installed")
	}
	root := t.TempDir()
	environment := []string{"PATH=" + os.Getenv("PATH"), "HOME=" + root, "XDG_CONFIG_HOME=" + filepath.Join(root, "config"), "GSETTINGS_BACKEND=keyfile", "GSETTINGS_SCHEMA_DIR=" + schema, "LANG=C"}
	actual := func(ctx context.Context, args ...string) (string, error) {
		ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
		defer cancel()
		command := exec.CommandContext(ctx, binary, args...)
		command.Env = environment
		output, err := command.CombinedOutput()
		if err != nil {
			return "", errors.Join(err, errors.New(string(output)))
		}
		return string(output), nil
	}
	backend := gnomeProxyBackend{run: actual}
	original := gnomeTestSnapshot("'auto'")
	marker := filepath.Join(root, "shell-would-have-run")
	original.Values["http.host"] = "'old; $(touch " + marker + ")'"
	for _, key := range gnomeProxyKeys {
		if _, err = actual(context.Background(), "set", key.schema, key.key, original.Values[key.field]); err != nil {
			t.Fatal(err)
		}
	}
	original, err = backend.read(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	owned, err := gnomeOwnedProxy(original, 10809, 10808)
	if err != nil {
		t.Fatal(err)
	}
	if err = backend.write(context.Background(), owned, original); err != nil {
		t.Fatal(err)
	}
	installed, err := backend.read(context.Background())
	if err != nil || !reflect.DeepEqual(installed, owned) {
		t.Fatal("real GLib takeover mismatch", err)
	}
	if err = backend.write(context.Background(), original, owned); err != nil {
		t.Fatal(err)
	}
	restored, err := backend.read(context.Background())
	if err != nil || !reflect.DeepEqual(restored, original) {
		t.Fatal("real GLib original snapshot not restored", err)
	}
	if _, err = os.Stat(marker); !os.IsNotExist(err) {
		t.Fatal("GVariant value was executed as shell text")
	}
	sets := 0
	failed := gnomeProxyBackend{run: func(ctx context.Context, args ...string) (string, error) {
		if args[0] == "set" {
			sets++
			if sets == 5 {
				return "", errors.New("isolated injected transport failure")
			}
		}
		return actual(ctx, args...)
	}}
	if err = failed.write(context.Background(), owned, original); err == nil {
		t.Fatal("real backend partial failure reported success")
	}
	restored, err = backend.read(context.Background())
	if err != nil || !reflect.DeepEqual(restored, original) {
		t.Fatal("real keyfile backend partial mutation not rolled back", err)
	}
	if _, err = actual(context.Background(), "set", "org.gnome.system.proxy.http", "use-authentication", "true"); err != nil {
		t.Fatal(err)
	}
	authenticated, err := backend.read(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if authenticated.Values["authenticated"] != "1" {
		t.Fatal("real authentication flag not detected")
	}
	if _, err = gnomeOwnedProxy(authenticated, 10809, 10808); err == nil {
		t.Fatal("real authenticated configuration accepted")
	}
	t.Log("actual GLib gsettings, official GNOME schema, private keyfile backend; not a Linux GNOME desktop/dconf integration claim")
}
