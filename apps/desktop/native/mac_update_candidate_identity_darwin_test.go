//go:build darwin

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestMacUpdateKeepsImageCandidateIdentityThroughHandoff(t *testing.T) {
	for _, action := range []string{"arm", "after-armed", "cancel"} {
		t.Run(action, func(t *testing.T) {
			ctx := context.Background()
			f := macFixture(t, "13.0")
			h := startMacHolder(t, f)
			h.ready(t)
			updater := filepath.Join(f.DataDir, "updater")
			journal := filepath.Join(updater, "mac-update-journal.json")
			phase := "prepared"
			if action == "after-armed" {
				_, _ = fmt.Fprintln(h.pipe, "ARM")
				if got := h.line(t); got != "ARMED" {
					t.Fatal(got)
				}
				_, _ = fmt.Fprintln(h.pipe, "PIPE_EOF")
				if got := h.line(t); got != "PIPE_CLOSED" {
					t.Fatal(got)
				}
				phase = "waiting_parent_exit"
			}
			macWait(t, updater, 10*time.Second, func() bool {
				data, _ := os.ReadFile(journal)
				return strings.Contains(string(data), `"phase": "`+phase+`"`)
			})
			journalBefore, err := os.ReadFile(journal)
			if err != nil {
				t.Fatal(err)
			}
			workBefore, err := macNode(h.work)
			if err != nil {
				t.Fatal(err)
			}
			staged := filepath.Join(h.work, "next.app")
			before, err := readMacBundle(ctx, staged, true)
			if err != nil || !macBundleSealMatches(before, f.CandidateInfo) {
				t.Fatal("initial seal does not match the fixture in the image", err)
			}
			if action == "arm" {
				// Keep the exact sealed bytes but not the directory that was prepared.
				original := filepath.Join(f.Root, "prepared-copy.app")
				if err := os.Rename(staged, original); err != nil {
					t.Fatal(err)
				}
				if _, err := runMacUpdateCommand(ctx, 30*time.Second, "/usr/bin/ditto", original, staged); err != nil {
					t.Fatal(err)
				}
			} else {
				// Keep the directory and executable. Only change a harmless sealed resource.
				resources := filepath.Join(staged, "Contents", "Resources")
				if err := os.MkdirAll(resources, 0700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(resources, "identity-test.txt"), []byte("isolated resource change"), 0600); err != nil {
					t.Fatal(err)
				}
				if _, err := runMacUpdateCommand(ctx, 30*time.Second, "/usr/bin/codesign", "--force", "--sign", "-", staged); err != nil {
					t.Fatal(err)
				}
			}
			after, err := readMacBundle(ctx, staged, true)
			if err != nil || before.Build != after.Build ||
				(macBundleSealMatches(after, before) != (action == "arm")) || (after.Node != before.Node) != (action == "arm") {
				t.Fatal("fixture must differ only in the intended identity dimension", err)
			}
			if node, err := macNode(h.work); err != nil || node != workBefore {
				t.Fatal("fixture changed workspace, masking candidate validation", err)
			}
			switch action {
			case "arm":
				_, _ = fmt.Fprintln(h.pipe, "COMMIT_REJECT")
				if got := h.line(t); !strings.HasPrefix(got, "REJECTED:") {
					t.Fatal(got)
				}
			case "after-armed":
				_, _ = fmt.Fprintln(h.pipe, "EXIT")
				if err := <-h.done; err != nil {
					t.Fatal(err)
				}
			case "cancel":
				_, _ = fmt.Fprintln(h.pipe, "ABORT")
			}
			var report struct {
				OK      bool
				Summary string
			}
			macWait(t, updater, 45*time.Second, func() bool {
				raw, _ := os.ReadFile(filepath.Join(updater, "install-report.json"))
				return json.Unmarshal(raw, &report) == nil
			})
			if report.OK || !strings.Contains(report.Summary, errMacUpdateCandidateIdentity.Error()) {
				t.Fatal("wrong refusal reason", report)
			}
			if installed, err := readMacBundle(ctx, f.Current, true); err != nil || installed != f.CurrentInfo {
				t.Fatal("original application changed", err)
			}
			if kept, err := readMacBundle(ctx, staged, true); err != nil || kept != after {
				t.Fatal("conflicting application was removed or changed", err)
			}
			if raw, err := os.ReadFile(journal); err != nil || string(raw) != string(journalBefore) {
				t.Fatal("refusal did not preserve its journal", err)
			}
			for _, path := range []string{f.Marker + ".pid", filepath.Join(h.work, "transaction.json")} {
				if _, err := os.Stat(path); !os.IsNotExist(err) {
					t.Fatal("conflicting candidate progressed to execution", path, err)
				}
			}
		})
	}
}
