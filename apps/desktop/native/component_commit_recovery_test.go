package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
)

type componentRecoveryFixture struct {
	Config appConfig
	Source string
	Record installedComponent
	Grant  releaseAssetGrant
}

func recoveryFixture(t *testing.T) (*DesktopService, componentRecoveryFixture, []byte, []byte) {
	t.Helper()
	s, item, _, old, next := componentCommitFixture(t)
	url := "https://github.com/round19/component-commit/releases/download/v9.1.0/geoip.dat"
	grant, err := s.authorizedDownload(url, *item.ChecksumSHA256, *item.FileSizeBytes)
	if err != nil {
		t.Fatal(err)
	}
	source := filepath.Join(s.cfg.DataDir, "downloads", grant.SHA256+".download")
	if err = os.WriteFile(source, next, 0600); err != nil {
		t.Fatal(err)
	}
	record := installedComponent{Kind: "geoip", VersionLabel: pointer("new"), ArtifactSHA256: grant.SHA256, InstalledSHA256: testHash(next), InstalledSize: int64(len(next))}
	return s, componentRecoveryFixture{Config: s.cfg, Source: source, Record: record, Grant: grant}, old, next
}
func componentChild(t *testing.T, f componentRecoveryFixture, role string) error {
	t.Helper()
	file := filepath.Join(f.Config.DataDir, "component-test-input.json")
	if err := atomicJSON(file, f); err != nil {
		t.Fatal(err)
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	command := exec.Command(executable, "-test.run=^TestComponentCommitPrivateChild$")
	command.Env = append(systemProcessEnvironment(), "CHORDV_COMPONENT_COMMIT_TEST_INPUT="+file, "CHORDV_COMPONENT_COMMIT_TEST_ROLE="+role)
	output, err := command.CombinedOutput()
	if err != nil {
		t.Logf("child %s: %s", role, output)
	}
	return err
}
func TestComponentCommitPrivateChild(t *testing.T) {
	path := os.Getenv("CHORDV_COMPONENT_COMMIT_TEST_INPUT")
	if path == "" {
		t.Skip("private process fixture entry")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var f componentRecoveryFixture
	if err = json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	s := newDesktopService(f.Config)
	defer s.cancel()
	role := os.Getenv("CHORDV_COMPONENT_COMMIT_TEST_ROLE")
	if role == "recover" {
		if err = s.startup(); err != nil {
			t.Fatal(err)
		}
		return
	}
	tx, err := s.prepareComponentInstall(context.Background(), f.Source, f.Record, f.Grant)
	if err != nil {
		t.Fatal(err)
	}
	if role == "after-component" || role == "after-pair" {
		if err = tx.root.Rename(filepath.Join(tx.work, "next-component"), tx.target); err != nil {
			t.Fatal(err)
		}
	}
	if role == "after-pair" || role == "metadata-only" {
		if err = tx.root.Rename(filepath.Join(tx.work, "next-record"), tx.metadata); err != nil {
			t.Fatal(err)
		}
	}
	if err = syncComponentDirectory(tx.root, "."); err != nil {
		t.Fatal(err)
	}
	// A genuine child exits without closing the transaction or running deferred cleanup.
	os.Exit(23)
}
func TestComponentPairRecoversAcrossActualProcessExit(t *testing.T) {
	for _, phase := range []string{"prepared", "after-component", "after-pair", "metadata-only"} {
		for _, existing := range []bool{false, true} {
			t.Run(fmt.Sprint(phase, "/existing=", existing), func(t *testing.T) {
				s, f, old, next := recoveryFixture(t)
				target, _ := s.componentPath("geoip")
				metadata := filepath.Join(s.binDir(), "geoip.json")
				originalRecord, _ := os.ReadFile(metadata)
				originalFileInfo, _ := os.Stat(target)
				originalRecordInfo, _ := os.Stat(metadata)
				if !existing {
					if err := os.Remove(target); err != nil {
						t.Fatal(err)
					}
					if err := os.Remove(metadata); err != nil {
						t.Fatal(err)
					}
				}
				err := componentChild(t, f, phase)
				var exit *exec.ExitError
				if !errors.As(err, &exit) || exit.ExitCode() != 23 {
					t.Fatal("writer must abruptly exit at the selected real disk boundary", err)
				}
				if _, err = s.componentMetadata("geoip"); err == nil {
					t.Fatal("pending pair must not be accepted as verified")
				}
				if err = componentChild(t, f, "recover"); err != nil {
					t.Fatal("fresh-process recovery failed", err)
				}
				if _, err = os.Stat(filepath.Join(s.binDir(), componentWorkName("geoip"))); !os.IsNotExist(err) {
					t.Fatal("recovery work remains", err)
				}
				actual, err := os.ReadFile(target)
				if phase == "after-pair" {
					if err != nil || string(actual) != string(next) {
						t.Fatal("complete pair was rolled back", err)
					}
					if value, e := s.checkComponent(componentItem{Component: "geoip", ChecksumSHA256: &f.Grant.SHA256}); e != nil || value.(map[string]any)["ready"] != true {
						t.Fatal("complete pair not ready", value, e)
					}
				} else if existing {
					if err != nil || string(actual) != string(old) {
						t.Fatal("old component not restored", err)
					}
					record, _ := os.ReadFile(metadata)
					if string(record) != string(originalRecord) {
						t.Fatal("old metadata bytes changed")
					}
					restoredFileInfo, _ := os.Stat(target)
					restoredRecordInfo, _ := os.Stat(metadata)
					if !os.SameFile(originalFileInfo, restoredFileInfo) || !os.SameFile(originalRecordInfo, restoredRecordInfo) {
						t.Fatal("rollback did not preserve original file identity")
					}

				} else {
					if !os.IsNotExist(err) {
						t.Fatal("initial incomplete install left a target", err)
					}
					if _, err = os.Stat(metadata); !os.IsNotExist(err) {
						t.Fatal("initial incomplete install left metadata", err)
					}
				}
			})
		}
	}
}
func TestComponentPairMetadataCommitFailureRestoresOriginalBytes(t *testing.T) {
	s, f, old, _ := recoveryFixture(t)
	record, _ := os.ReadFile(filepath.Join(s.binDir(), "geoip.json"))
	tx, err := s.prepareComponentInstall(context.Background(), f.Source, f.Record, f.Grant)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.root.Close()
	injected := errors.New("test metadata rename failure")
	err = tx.apply(context.Background(), func(from, to string) error {
		if to == tx.metadata {
			return injected
		}
		return tx.root.Rename(from, to)
	})
	if !errors.Is(err, injected) {
		t.Fatal("failure boundary not reached", err)
	}
	if err = s.recoverComponentInstall("geoip"); err != nil {
		t.Fatal(err)
	}
	target, _ := s.componentPath("geoip")
	actual, _ := os.ReadFile(target)
	after, _ := os.ReadFile(filepath.Join(s.binDir(), "geoip.json"))
	if string(actual) != string(old) || string(after) != string(record) {
		t.Fatal("recovery failed to preserve both original byte sequences")
	}
}
func TestComponentPairCancellationAfterTargetRenameFinishesPair(t *testing.T) {
	s, f, _, next := recoveryFixture(t)
	tx, err := s.prepareComponentInstall(context.Background(), f.Source, f.Record, f.Grant)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.root.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	err = tx.apply(ctx, func(from, to string) error {
		err := tx.root.Rename(from, to)
		if to == tx.target {
			cancel()
		}
		return err
	})
	if err != nil {
		t.Fatal("post-boundary cancellation must not strand the pair", err)
	}
	if err = s.recoverComponentInstall("geoip"); err != nil {
		t.Fatal(err)
	}
	target, _ := s.componentPath("geoip")
	actual, _ := os.ReadFile(target)
	record, err := s.componentMetadata("geoip")
	if err != nil || string(actual) != string(next) || record.InstalledSHA256 != testHash(next) {
		t.Fatal("post-boundary commit is inconsistent", err)
	}
}
func TestComponentPairRecoveryPreservesForeignOrInvalidEvidence(t *testing.T) {
	for _, scenario := range []string{"foreign-target", "foreign-metadata", "backup-tampered", "bad-signature", "unknown-json-field", "symbolic-work", "unknown-work-file"} {
		t.Run(scenario, func(t *testing.T) {
			s, f, _, _ := recoveryFixture(t)
			if err := componentChild(t, f, "after-component"); err == nil {
				t.Fatal("writer did not abruptly exit")
			}
			work := filepath.Join(s.binDir(), componentWorkName("geoip"))
			target, _ := s.componentPath("geoip")
			metadata := filepath.Join(s.binDir(), "geoip.json")
			statePath := filepath.Join(work, "state.json")
			switch scenario {
			case "foreign-target":
				if err := os.WriteFile(target, []byte("foreign component"), 0700); err != nil {
					t.Fatal(err)
				}
			case "foreign-metadata":
				if err := os.WriteFile(metadata, []byte("foreign metadata"), 0600); err != nil {
					t.Fatal(err)
				}
			case "backup-tampered":
				if err := os.WriteFile(filepath.Join(work, "before-component"), []byte("changed backup"), 0700); err != nil {
					t.Fatal(err)
				}
			case "bad-signature":
				var state componentCommitState
				raw, _ := os.ReadFile(statePath)
				json.Unmarshal(raw, &state)
				state.Grant.Signature = "invalid"
				if err := atomicJSON(statePath, state); err != nil {
					t.Fatal(err)
				}
			case "unknown-json-field":
				var state map[string]any
				raw, _ := os.ReadFile(statePath)
				json.Unmarshal(raw, &state)
				state["UnexpectedPath"] = "outside"
				if err := atomicJSON(statePath, state); err != nil {
					t.Fatal(err)
				}
			case "symbolic-work":
				if runtime.GOOS == "windows" {
					t.Skip("this symlink evidence requires a symlink-capable test user")
				}
				moved := work + "-moved"
				if err := os.Rename(work, moved); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(moved, work); err != nil {
					t.Fatal(err)
				}
			case "unknown-work-file":
				if err := os.WriteFile(filepath.Join(work, "user-kept.txt"), []byte("preserve"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			beforeTarget, _ := os.ReadFile(target)
			beforeMetadata, _ := os.ReadFile(metadata)
			if err := s.recoverComponentInstall("geoip"); err == nil {
				t.Fatal("unexpected evidence was accepted")
			}
			afterTarget, _ := os.ReadFile(target)
			afterMetadata, _ := os.ReadFile(metadata)
			if string(beforeTarget) != string(afterTarget) || string(beforeMetadata) != string(afterMetadata) {
				t.Fatal("refused recovery changed visible component files")
			}
			if _, err := os.Lstat(work); err != nil {
				t.Fatal("refused recovery removed evidence", err)
			}
			if scenario == "unknown-work-file" {
				if data, err := os.ReadFile(filepath.Join(work, "user-kept.txt")); err != nil || string(data) != "preserve" {
					t.Fatal("unknown work data was removed", err)
				}
			}
		})
	}
}
