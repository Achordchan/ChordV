//go:build darwin

package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

// Foreign-thread Objective-C callbacks need Go initialization to have completed.
func TestMain(m *testing.M) {
	if len(os.Args) == 3 && (os.Args[1] == "--mac-startup-rollback-parent-test" || os.Args[1] == "--mac-startup-rollback-worker-test") {
		if err := runStartupRollbackTestCommand(); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(2)
		}
		os.Exit(0)
	}
	if len(os.Args) == 3 && os.Args[1] == "--mac-recovery-snapshot-test" {
		if err := runMacRecoverySnapshotTest(os.Args[2]); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(2)
		}
		os.Exit(0)
	}
	if len(os.Args) == 1 && filepath.Base(os.Args[0]) == "Fixture" {
		gate, err := beginMacDesktopLaunch(nil)
		if err != nil || gate == nil {
			fmt.Fprintln(os.Stderr, "restored application could not acquire its normal startup gate", err)
			os.Exit(2)
		}
		root := filepath.Dir(filepath.Dir(filepath.Dir(filepath.Dir(os.Args[0]))))
		if err = finishRestartedOriginalStartupTest(root, os.Args[0]); err != nil {
			_ = os.WriteFile(filepath.Join(root, "original-restart-error"), []byte(err.Error()), 0600)
			fmt.Fprintln(os.Stderr, err)
			os.Exit(2)
		}
		_ = os.WriteFile(filepath.Join(root, "original-restarted"), []byte("restarted"), 0600)
		_ = gate.Close()
		os.Exit(0)
	}
	if len(os.Args) == 3 && os.Args[1] == "--chordv-mac-update-helper" {
		var open macRecoveryArmingProvider
		if p, _, err := readMacPlan(os.Args[2]); err == nil {
			// Publish a competing entry only after this real helper has been started.
			// Link is exclusive and preserves inode identity for the parent assertion.
			updater := filepath.Join(p.DataDir, "updater")
			if err := os.Link(filepath.Join(updater, "test-late-journal"), filepath.Join(updater, "mac-update-journal.json")); err != nil && !os.IsNotExist(err) {
				fmt.Fprintln(os.Stderr, err)
				os.Exit(2)
			}
			if _, err = installMacSchema2HTTPFixture(macFixtureConfig{DataDir: p.DataDir, Repository: p.Repository, PublicKey: p.PublicKey, Installer: p.Installer.Path}); err != nil {
				fmt.Fprintln(os.Stderr, err)
				os.Exit(2)
			}
			if mode, err := os.ReadFile(filepath.Join(updater, "test-protected-recovery-mode")); err == nil {
				open = func(ctx context.Context, validated *macUpdatePlan) (macRecoveryArmingAuthority, error) {
					if validated.Current != p.Current || validated.DataDir != p.DataDir || validated.Work != p.Work || validated.preparedCandidate.CDHash == "" {
						return nil, errors.New("test provider did not receive the authenticated prepared plan")
					}
					arm := &macRecoveryArmTestStore{mode: string(mode), updater: updater}
					switch string(mode) {
					case "provider-unavailable":
						return nil, errors.New("test protected store unavailable")
					case "slot-authority-complete", "slot-authority-lost-checkpoint":
						store, err := newMacRecoverySlotAuthority(macRecoverySlotLiveTestBackend(updater, string(mode)), validated.Current.Path, validated.DataDir)
						if err != nil {
							return nil, err
						}
						return store, store.requireEmptyForUpdate(ctx)
					case "cleanup-complete", "cleanup-checkpoint-error", "cleanup-retire-error":
						return &macRecoveryCleanupTestStore{macRecoveryArmTestStore: arm}, nil
					default:
						return arm, nil
					}
				}
			}
			if _, err = os.Stat(filepath.Join(p.DataDir, "updater", "prepare-gate-request")); err == nil {
				original := prepareMacUpdateBundle
				prepareMacUpdateBundle = func(ctx context.Context, p *macUpdatePlan) error {
					if err := original(ctx, p); err != nil {
						return err
					}
					if err := atomicFile(filepath.Join(p.DataDir, "updater", "prepare-gate-ready"), []byte("ready"), 0600); err != nil {
						return err
					}
					<-ctx.Done()
					return ctx.Err()
				}
			}
		}
		if err := runMacUpdateHelperWithRecovery(os.Args[2], open); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(2)
		}
		os.Exit(0)
	}
	if len(os.Args) == 3 && os.Args[1] == "--mac-update-test-holder" {
		if err := runMacUpdateTestHolder(os.Args[2]); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(2)
		}
		os.Exit(0)
	}
	os.Exit(m.Run())
}

type macFixtureConfig struct {
	DataDir    string
	Repository string
	PublicKey  string
	Installer  string
}

func runMacUpdateTestHolder(path string) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	var cfg macFixtureConfig
	if err = json.Unmarshal(data, &cfg); err != nil {
		return err
	}
	if _, err = installMacSchema2HTTPFixture(cfg); err != nil {
		return err
	}
	s := newDesktopService(appConfig{DataDir: cfg.DataDir, ReleaseRepository: cfg.Repository, ReleasePublicKey: cfg.PublicKey, APIBase: "http://127.0.0.1:1"})
	defer s.cancel()
	fmt.Fprintln(os.Stdout, "STARTING")
	prepared := make(chan error, 1)
	go func() { _, err := s.prepareMacUpdate(context.Background(), cfg.Installer); prepared <- err }()
	commands := make(chan string, 8)
	go func() {
		scanner := bufio.NewScanner(os.Stdin)
		for scanner.Scan() {
			commands <- scanner.Text()
		}
		commands <- "EXIT"
		close(commands)
	}()
	cancelled := false
	for {
		select {
		case err := <-prepared:
			prepared = nil
			if err != nil {
				if cancelled {
					continue
				}
				return err
			}
			if cancelled {
				continue
			}
			s.macUpdateMu.Lock()
			h := s.macUpdate
			if h == nil {
				s.macUpdateMu.Unlock()
				return fmt.Errorf("missing prepared handoff")
			}
			info := map[string]any{"work": h.dir, "helperPid": h.command.Process.Pid, "parentPid": os.Getpid()}
			s.macUpdateMu.Unlock()
			data, _ = json.Marshal(info)
			fmt.Fprintln(os.Stdout, string(data))
		case command := <-commands:
			switch command {
			case "ARM":
				if _, err = s.commitMacUpdate(context.Background()); err != nil {
					return err
				}
				fmt.Fprintln(os.Stdout, "ARMED")
			case "ARM_RAW":
				if _, err = fmt.Fprintln(s.macUpdate.pipe, "ARM"); err != nil {
					return err
				}
				fmt.Fprintln(os.Stdout, "RAW_ARM_SENT")
			case "ABORT":
				cancelled = true
				if err = s.abortMacUpdate(); err != nil {
					return err
				}
				fmt.Fprintln(os.Stdout, "ABORTED")
			case "PIPE_EOF":
				_ = s.macUpdate.pipe.Close()
				fmt.Fprintln(os.Stdout, "PIPE_CLOSED")
			case "RELOAD_PENDING":
				data, err := os.ReadFile(filepath.Join(s.cfg.DataDir, "updater", "pending.json"))
				if err != nil {
					return err
				}
				var pending pendingInstaller
				if err = json.Unmarshal(data, &pending); err != nil {
					return err
				}
				s.pendingMu.Lock()
				s.pending = &pending
				s.pendingMu.Unlock()
				fmt.Fprintln(os.Stdout, "RELOADED")
			case "COMMIT_REJECT":
				_, err := s.commitMacUpdate(context.Background())
				if err == nil {
					return fmt.Errorf("changed pending unexpectedly armed")
				}
				fmt.Fprintln(os.Stdout, "REJECTED:"+err.Error())
			case "ABORT_REJECT":
				if err := s.abortMacUpdate(); err == nil {
					return fmt.Errorf("acknowledged handoff was cancelled")
				}
				fmt.Fprintln(os.Stdout, "CANCEL_REJECTED")
			case "TEST_CLEANUP":
				cancelled = true
				s.macUpdateMu.Lock()
				if s.macUpdate != nil {
					_ = s.macUpdate.abort()
					s.macUpdate = nil
				}
				s.macUpdateMu.Unlock()
				fmt.Fprintln(os.Stdout, "CLEANED")
			case "ARM_REPORT_FAIL":
				report := filepath.Join(s.cfg.DataDir, "updater", "install-report.json")
				if err := os.Mkdir(report, 0700); err != nil {
					return err
				}
				pending, err := s.validatedInstaller(cfg.Installer)
				if err != nil {
					return err
				}
				_, err = s.handoffInstaller(context.Background(), pending, installerHandoffOps{
					start: func(string) error { _, err := s.commitMacUpdate(context.Background()); return err },
					quit:  func() { fmt.Fprintln(os.Stdout, "QUIT_REQUESTED") }, writeReport: atomicJSON})
				if err != nil {
					return err
				}
				if err = os.Remove(report); err != nil {
					return err
				}
				fmt.Fprintln(os.Stdout, "COMMITTED")
			case "EXIT":
				return nil
			}
		}
	}
}
