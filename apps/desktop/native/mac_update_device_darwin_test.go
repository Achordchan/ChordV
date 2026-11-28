//go:build darwin

package main

import (
	"os"
	"strconv"
	"strings"
	"testing"

	"golang.org/x/sys/unix"
)

func TestMacUpdateDeviceIDReadsLiveRegistryIdentity(t *testing.T) {
	if _, err := os.Lstat("/dev/disk0"); os.IsNotExist(err) {
		t.Skip("requires a local macOS media service")
	}
	first, err := macUpdateDeviceID("/dev/disk0")
	if err != nil || first == 0 {
		t.Fatalf("live registry identity must be nonzero: %d %v", first, err)
	}
	second, err := macUpdateDeviceID("/dev/disk0")
	if err != nil || second != first {
		t.Fatalf("unchanged live media identity drifted: %d -> %d %v", first, second, err)
	}
	t.Logf("read-only /dev/disk0 IORegistryEntryID=%d", first)
}

func TestMacUpdateDeviceIDRejectsNonCanonicalPaths(t *testing.T) {
	for i, path := range []string{
		"", "disk0", "/dev/disk", "/dev/disk-1", "/dev/disk01", "/dev/rdisk0",
		"/dev/disk0s", "/dev/disk0s-1", "/dev/disk0s01", "/dev/disk0s1/",
		"/dev/disk0/../disk0", "/dev//disk0", "/dev/disk0\x00", "/dev/disk0\n",
		" /dev/disk0", "/dev/disk0 ", "/dev/disk0;echo", "/dev/disk" + strings.Repeat("1", 128),
	} {
		t.Run(strconv.Itoa(i), func(t *testing.T) {
			id, err := macUpdateDeviceID(path)
			if id != 0 || err == nil || !strings.Contains(err.Error(), "路径无效") {
				t.Fatalf("invalid device path %q produced %d %v", path, id, err)
			}
		})
	}
}

func TestMacUpdateDeviceIDRejectsMissingMedia(t *testing.T) {
	path := "/dev/disk999999999s1s2"
	if _, err := os.Lstat(path); !os.IsNotExist(err) {
		t.Fatal("missing-media negative control is not absent", err)
	}
	id, err := macUpdateDeviceID(path)
	if id != 0 || err == nil || !strings.Contains(err.Error(), "注册实体不存在") {
		t.Fatalf("absent valid device must fail closed: %d %v", id, err)
	}
}

func TestMacUpdateDeviceReferenceLifetime(t *testing.T) {
	for _, control := range []struct {
		name        string
		matching    uintptr
		service     uint32
		id          uint64
		idCode      int32
		releaseCode int32
		wantError   bool
		wantGet     int
		wantRead    int
		wantRelease int
	}{
		{name: "matching-failure", wantError: true},
		{name: "lookup-failure", matching: 23, wantError: true, wantGet: 1},
		{name: "read-failure", matching: 23, service: 17, id: 7, idCode: -1, wantError: true, wantGet: 1, wantRead: 1, wantRelease: 1},
		{name: "zero-id", matching: 23, service: 17, wantError: true, wantGet: 1, wantRead: 1, wantRelease: 1},
		{name: "release-failure", matching: 23, service: 17, id: 7, releaseCode: -1, wantError: true, wantGet: 1, wantRead: 1, wantRelease: 1},
		{name: "read-and-release-failure", matching: 23, service: 17, idCode: -1, releaseCode: -1, wantError: true, wantGet: 1, wantRead: 1, wantRelease: 1},
		{name: "success", matching: 23, service: 17, id: 7, wantGet: 1, wantRead: 1, wantRelease: 1},
	} {
		t.Run(control.name, func(t *testing.T) {
			var matches, gets, reads, releases int
			api := macUpdateDeviceAPI{
				bsdNameMatching: func(port, options uint32, name string) uintptr {
					matches++
					if port != 0 || options != 0 || name != "disk17s1" {
						t.Fatal("unexpected BSD lookup arguments", port, options, name)
					}
					return control.matching
				},
				getMatchingService: func(port uint32, matching uintptr) uint32 {
					gets++
					if port != 0 || matching != control.matching {
						t.Fatal("wrong matching dictionary or port", port, matching)
					}
					return control.service
				},
				getRegistryID: func(service uint32, id *uint64) int32 {
					reads++
					if service != control.service {
						t.Fatal("read wrong service", service)
					}
					*id = control.id
					return control.idCode
				},
				release: func(service uint32) int32 {
					releases++
					if service != control.service {
						t.Fatal("released wrong service", service)
					}
					return control.releaseCode
				},
			}
			id, err := api.lookup("/dev/disk17s1")
			if (err != nil) != control.wantError || control.wantError && id != 0 || !control.wantError && id != control.id {
				t.Fatal("registry lookup did not fail closed", id, err)
			}
			if matches != 1 || gets != control.wantGet || reads != control.wantRead || releases != control.wantRelease {
				t.Fatal("wrong service ownership lifetime", matches, gets, reads, releases)
			}
		})
	}
}

func TestMacUpdateDeviceIdentityConcurrentLookup(t *testing.T) {
	if _, err := os.Lstat("/dev/disk0"); os.IsNotExist(err) {
		t.Skip("requires a local macOS media service")
	}
	for i := range 12 {
		t.Run(strconv.Itoa(i), func(t *testing.T) {
			t.Parallel()
			for range 5 {
				if id, err := macUpdateDeviceID("/dev/disk0"); err != nil || id == 0 {
					t.Fatal("parallel registry lookup failed", id, err)
				}
			}
		})
	}
}

func TestMacUpdateBootSessionReadsLiveKernelUUID(t *testing.T) {
	want, err := unix.Sysctl("kern.bootsessionuuid")
	if err != nil {
		t.Fatal(err)
	}
	first, err := macUpdateBootSession()
	if err != nil || first != strings.ToUpper(want) || len(first) != 36 {
		t.Fatal("live boot session UUID differs from kernel", first, want, err)
	}
	second, err := macUpdateBootSession()
	if err != nil || second != first {
		t.Fatal("unchanged boot session drifted", first, second, err)
	}
}
