package version

import (
	"strings"
	"testing"
)

func TestValidateRejectsUnusableStampedVersions(t *testing.T) {
	original := Version
	t.Cleanup(func() { Version = original })

	// The server requires IsNotEmpty; an empty stamp would fail registration
	// with a validation error that says nothing about the build.
	for _, bad := range []string{"", "   ", strings.Repeat("v", MaxLength+1)} {
		Version = bad
		if err := Validate(); err == nil {
			t.Fatalf("Validate accepted %q, which the control plane rejects", bad)
		}
	}
	Version = "0.1.0"
	if err := Validate(); err != nil {
		t.Fatalf("Validate rejected a normal version: %v", err)
	}
}

func TestDefaultVersionIsUsable(t *testing.T) {
	// A build that forgets -ldflags must still be able to register and report,
	// so the compiled-in default has to satisfy the same contract.
	if err := Validate(); err != nil {
		t.Fatalf("the default stamped version is unusable: %v", err)
	}
}

func TestWireAlwaysIdentifiesGoAndFitsServerBound(t *testing.T) {
	original := Version
	t.Cleanup(func() { Version = original })
	for _, value := range []string{"0.2.0", "go-0.2.0"} {
		Version = value
		if Wire() != "go-0.2.0" {
			t.Fatalf("wire=%s", Wire())
		}
	}
	Version = strings.Repeat("a", MaxLength-2)
	if Validate() == nil {
		t.Fatal("wire prefix exceeded server limit")
	}
}
