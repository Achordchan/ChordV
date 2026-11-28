//go:build darwin

package main

import "testing"

func TestMacUpdateWholeDeviceSelectionDoesNotDependOnEntityOrder(t *testing.T) {
	for _, tt := range []struct {
		name     string
		entities []macAttachedEntity
		want     string
	}{
		{"partition-first", []macAttachedEntity{{Device: "/dev/disk11s1"}, {Device: "/dev/disk11", Hint: "GUID_partition_scheme"}}, "/dev/disk11"},
		{"apfs-synthetic-first", []macAttachedEntity{{Device: "/dev/disk14", Hint: "EF57347C-0000-11AA-AA11-00306543ECAC"}, {Device: "/dev/disk11s1"}, {Device: "/dev/disk11", Hint: "GUID_partition_scheme"}, {Device: "/dev/disk14s1"}}, "/dev/disk11"},
		{"whole-volume", []macAttachedEntity{{Device: "/dev/disk11", Hint: "Apple_HFS"}}, "/dev/disk11"},
		{"empty", nil, ""},
		{"partition-only", []macAttachedEntity{{Device: "/dev/disk11s1"}}, ""},
		{"ambiguous-whole", []macAttachedEntity{{Device: "/dev/disk11"}, {Device: "/dev/disk14"}}, ""},
		{"multiple-schemes", []macAttachedEntity{{Device: "/dev/disk11", Hint: "GUID_partition_scheme"}, {Device: "/dev/disk14", Hint: "Apple_partition_scheme"}}, ""},
		{"non-device", []macAttachedEntity{{Device: "/tmp/disk11", Hint: "GUID_partition_scheme"}}, ""},
	} {
		t.Run(tt.name, func(t *testing.T) {
			got, err := macWholeImageDevice(tt.entities)
			if got != tt.want || (err != nil) != (tt.want == "") {
				t.Fatal(got, err)
			}
		})
	}
}
