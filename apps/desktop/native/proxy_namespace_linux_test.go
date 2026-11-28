//go:build linux

package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/sys/unix"
)

func TestLinuxGNOMENamespaceBindsConfigRuntimeAndProfileContent(t *testing.T) {
	root := t.TempDir()
	profile := filepath.Join(root, "profile")
	if err := os.WriteFile(profile, []byte("user-db:first\n"), 0600); err != nil {
		t.Fatal(err)
	}
	environment := []string{"HOME=" + root, "XDG_CONFIG_HOME=" + filepath.Join(root, "config"), "XDG_RUNTIME_DIR=" + filepath.Join(root, "runtime"), "DCONF_PROFILE=" + profile}
	first, err := gnomeProxyNamespace(environment)
	if err != nil || len(first) != 64 {
		t.Fatal(first, err)
	}
	for _, field := range []string{"XDG_CONFIG_HOME", "XDG_RUNTIME_DIR"} {
		changed := append([]string{}, environment...)
		for index, entry := range changed {
			if strings.HasPrefix(entry, field+"=") {
				changed[index] += "-other"
			}
		}
		if other, err := gnomeProxyNamespace(changed); err != nil || other == first {
			t.Fatal("namespace ignored configuration location", field, err)
		}
	}
	if err = os.WriteFile(profile, []byte("user-db:second\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if other, err := gnomeProxyNamespace(environment); err != nil || other == first {
		t.Fatal("same profile path changed content without changing scope", err)
	}
	if err = os.WriteFile(profile, []byte("user-db:first\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if restored, err := gnomeProxyNamespace(environment); err != nil || restored != first {
		t.Fatal("original namespace cannot be recognized after returning", err)
	}
}

func TestLinuxGNOMENamespaceRejectsInvalidExplicitProfile(t *testing.T) {
	root := t.TempDir()
	profile := filepath.Join(root, "profile")
	environment := []string{"HOME=" + root, "XDG_RUNTIME_DIR=" + root, "DCONF_PROFILE=" + profile}
	if _, err := gnomeProxyNamespace(environment); err == nil {
		t.Fatal("missing explicit profile guessed the implicit fallback")
	}
	if err := unix.Mkfifo(profile, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := gnomeProxyNamespace(environment); err == nil {
		t.Fatal("non-regular profile accepted")
	}
	if err := os.Remove(profile); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(profile, []byte(strings.Repeat("x", 65537)), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := gnomeProxyNamespace(environment); err == nil {
		t.Fatal("unbounded profile accepted")
	}
}
