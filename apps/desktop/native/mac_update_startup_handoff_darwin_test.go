//go:build darwin

package main

import (
	"bufio"
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/egoist/mygo"
)

type startupRollbackTestConfig struct {
	App    appConfig
	Arm    macRecoveryPendingArm
	Public ed25519.PublicKey
	Digest string
	Mode   string
}

func runStartupRollbackTestCommand() error {
	var cfg startupRollbackTestConfig
	raw, err := os.ReadFile(os.Args[2])
	if err == nil {
		err = json.Unmarshal(raw, &cfg)
	}
	if err == nil {
		ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
		if os.Args[1] == "--mac-startup-rollback-parent-test" {
			err = runStartupRollbackTestParent(ctx, cfg)
		} else {
			err = runStartupRollbackTestWorker(ctx, cfg)
		}
		cancel()
	}
	return err
}

func runStartupRollbackTestParent(ctx context.Context, cfg startupRollbackTestConfig) error {
	self, err := macHealthProcessPath(os.Getpid())
	if err != nil {
		return err
	}
	anchor, err := deriveRecoveryAnchor(ctx, cfg.App, self)
	if err != nil {
		return err
	}
	store, err := startupRollbackTestSlot(ctx, anchor, cfg)
	if err != nil {
		return err
	}
	state, err := runMacStartupRecovery(ctx, anchor, store)
	var request *macStartupRollbackRequest
	if state != "needs_exit_handoff" || !errors.As(err, &request) {
		return fmt.Errorf("did not request the startup handoff: %s %v", state, err)
	}
	files := []*os.File{os.NewFile(3, "authority-requests"), os.NewFile(4, "authority-replies"), os.NewFile(5, "worker-result")}
	err = startMacStartupRollback(ctx, anchor, request.intent, store, func(path string) *exec.Cmd {
		cmd := exec.Command(path, "--mac-startup-rollback-worker-test", os.Args[2])
		cmd.Env, cmd.Stderr, cmd.ExtraFiles = systemProcessEnvironment(), os.Stderr, files
		return cmd
	})
	for _, file := range files {
		file.Close()
	}
	if err != nil {
		fmt.Fprintln(os.Stdout, "PARENT_REJECTED", err)
	} else {
		fmt.Fprintln(os.Stdout, "PARENT_ARMED")
	}
	// Keep this real B alive until the fixture explicitly authorizes its exit,
	// whether the production launcher armed a worker or rejected it.
	line, err := bufio.NewReader(os.Stdin).ReadString('\n')
	if err != nil || line != "EXIT\n" {
		return errors.Join(err, errors.New("test parent missing EXIT"))
	}
	return nil
}

func startupRollbackTestSlot(ctx context.Context, anchor macRecoveryAnchor, cfg startupRollbackTestConfig) (*macRecoverySlotAuthority, error) {
	store, err := newMacRecoverySlotAuthority(&macRecoverySlotTestBackend{items: make(map[string][]byte)}, anchor.bundle.Path, cfg.App.DataDir)
	if err != nil {
		return nil, err
	}
	if err = store.reserve(ctx, cfg.Arm); err != nil {
		return nil, err
	}
	return store, store.bind(ctx, cfg.Arm, cfg.Digest)
}

// Run the real cleanup entry from the original process opened by macOS.
// The test slot replaces the system Keychain; no fixture file grants access
// in a production binary.
func finishRestartedOriginalStartupTest(root, self string) error {
	raw, err := os.ReadFile(filepath.Join(root, "startup-handoff-fixture.json"))
	if errors.Is(err, os.ErrNotExist) {
		return nil // Other original-version fixtures only witness the launch.
	}
	var cfg startupRollbackTestConfig
	if err = errors.Join(err, json.Unmarshal(raw, &cfg)); err != nil {
		return err
	}
	if os.Getenv("CHORDV_MYGO_DATA_DIR") != cfg.App.DataDir {
		return errors.New("restored application did not receive the authorized DataDir")
	}
	// LaunchServices waits for the native app to finish launching. Run the
	// normal event loop while asynchronous recovery waits for the helper.
	result := make(chan error, 1)
	mygo.App.SetActivationPolicy(mygo.ActivationPolicyProhibited)
	mygo.App.WhenReady(func() {
		go func() {
			result <- finishStartupRollbackTestCleanup(cfg, self)
			mygo.App.Quit()
		}()
	})
	if err := mygo.App.Run(); err != nil {
		return err
	}
	select {
	case err := <-result:
		return err
	default:
		return errors.New("restarted fixture exited before recovery completed")
	}
}

func finishStartupRollbackTestCleanup(cfg startupRollbackTestConfig, self string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	anchor, err := deriveRecoveryAnchor(ctx, cfg.App, self)
	if err != nil {
		return err
	}
	store, err := startupRollbackTestSlot(ctx, anchor, cfg)
	if err != nil {
		return err
	}
	if state, err := runMacStartupRecovery(ctx, anchor, store); err != nil || state != "kept_original" {
		return fmt.Errorf("reopened original did not complete startup recovery: %s: %v", state, err)
	}
	return store.requireEmptyForUpdate(ctx)
}

func runStartupRollbackTestWorker(ctx context.Context, cfg startupRollbackTestConfig) error {
	requests, responses, result := os.NewFile(3, "authority-requests"), os.NewFile(4, "authority-replies"), os.NewFile(5, "worker-result")
	defer requests.Close()
	defer responses.Close()
	defer result.Close()
	if cfg.Mode != "valid" {
		// A fixture with the right signed image but a bad control message is
		// still not entitled to make the candidate exit.
		intent := cfg.Arm.Intent
		intent.TransactionSHA256, intent.Capability = cfg.Digest, "rollback_original"
		if cfg.Mode == "wrong-intent-ready" {
			intent.PlanSHA256 = macPlanDigest([]byte("not the armed plan"))
		}
		scope, err := macRecoveryHandoffScope(intent)
		if err != nil {
			return err
		}
		token := scope + strings.Repeat("11", 32)
		fmt.Fprintln(os.Stdout, "CHORDV_RECOVERY_READY "+token)
		_, _ = io.Copy(io.Discard, os.Stdin)
		fmt.Fprintln(os.Stdout, "WRONG_ACK "+token)
		<-ctx.Done()
		return nil
	}
	state, err := executeMacRecoveryWorker(ctx, cfg.App, func(macRecoveryAnchor, macBundleInfo) (macRecoveryAuthority, error) {
		return &macReplayRemoteTestAuthority{public: cfg.Public, input: json.NewDecoder(responses), output: json.NewEncoder(requests)}, nil
	})
	report := macReplayWorkerResult{State: state}
	if err != nil {
		report.Error = err.Error()
	}
	return json.NewEncoder(result).Encode(report)
}

func TestMacStartupRollbackUsesRealSignedWorkerAndParentExit(t *testing.T) {
	for _, mode := range []string{"valid", "wrong-intent-ready", "wrong-armed-ack"} {
		t.Run(mode, func(t *testing.T) {
			f := newMacRecoveryFixtureWithHelper(t, false, true)
			controller := newMacReplayTestAuthority(t, f)
			intent := controller.intent
			arm := macRecoveryPendingArm{Intent: intent, HelperPID: f.transaction.HelperPID, HelperIdentity: f.transaction.HelperIdentity, HelperExecutable: f.transaction.HelperExecutable}
			arm.Intent.Capability, arm.Intent.TransactionSHA256 = "", ""
			if err := f.plan.swap(intent.Current.Node, intent.Candidate.Node); err != nil {
				t.Fatal(err)
			}
			cfgPath := filepath.Join(f.root, "startup-handoff-fixture.json")
			if err := atomicJSON(cfgPath, startupRollbackTestConfig{App: f.cfg, Arm: arm, Public: controller.public, Digest: intent.TransactionSHA256, Mode: mode}); err != nil {
				t.Fatal(err)
			}
			pipe := func() (*os.File, *os.File) {
				t.Helper()
				r, w, err := os.Pipe()
				if err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { r.Close(); w.Close() })
				return r, w
			}
			requests, toRequests := pipe()
			fromResponses, responses := pipe()
			results, toResults := pipe()
			go func() {
				decoder, encoder := json.NewDecoder(requests), json.NewEncoder(responses)
				for {
					var nonce []byte
					if decoder.Decode(&nonce) != nil || encoder.Encode(controller.proof(nonce)) != nil {
						return
					}
				}
			}()
			cmd := exec.Command(intent.Current.Executable, "--mac-startup-rollback-parent-test", cfgPath)
			cmd.Env, cmd.Stderr = systemProcessEnvironment(), os.Stderr
			cmd.ExtraFiles = []*os.File{toRequests, fromResponses, toResults}
			input, err := cmd.StdinPipe()
			if err != nil {
				t.Fatal(err)
			}
			output, err := cmd.StdoutPipe()
			if err != nil {
				t.Fatal(err)
			}
			if err = cmd.Start(); err != nil {
				t.Fatal(err)
			}
			for _, file := range cmd.ExtraFiles {
				file.Close()
			}
			t.Cleanup(func() { _ = input.Close(); _ = cmd.Process.Kill(); _ = cmd.Wait() })
			line := make(chan string, 1)
			go func() { received, _ := bufio.NewReader(output).ReadString('\n'); line <- strings.TrimSpace(received) }()
			select {
			case message := <-line:
				if mode == "valid" && message != "PARENT_ARMED" {
					t.Fatal("real signed helper did not give a verified ACK", message)
				}
				if mode != "valid" {
					want := "未确认已等待本次进程退出"
					if mode == "wrong-intent-ready" {
						want = "未绑定本次完整回滚授权"
					}
					if !strings.HasPrefix(message, "PARENT_REJECTED ") || !strings.Contains(message, want) {
						t.Fatal("invalid handshake was not rejected for the expected reason", message)
					}
				}
			case <-time.After(32 * time.Second):
				t.Fatal("startup handoff timeout")
			}
			target, err := macNode(intent.Target)
			if err != nil || target != intent.Candidate.Node {
				t.Fatal("ARM or refusal changed B before real parent exit", target, err)
			}
			if live, err := macHealthProcessPath(cmd.Process.Pid); err != nil || live != intent.Current.Executable {
				t.Fatal("the parent was not still the installed executable", err)
			}
			if _, err = fmt.Fprintln(input, "EXIT"); err != nil {
				t.Fatal(err)
			}
			if err = cmd.Wait(); err != nil {
				t.Fatal(err)
			}
			if mode != "valid" {
				if target, err = macNode(intent.Target); err != nil || target != intent.Candidate.Node {
					t.Fatal("a rejected worker was left able to swap", err)
				}
				if err = results.SetReadDeadline(time.Now().Add(2 * time.Second)); err != nil {
					t.Fatal(err)
				}
				if _, err := results.Read(make([]byte, 1)); err != io.EOF {
					t.Fatal("rejected worker was not reaped and still owns its result pipe", err)
				}
				if _, err := os.Lstat(filepath.Join(f.root, "original-restarted")); !os.IsNotExist(err) {
					t.Fatal("rejected worker reopened an application", err)
				}
				return
			}
			if err = results.SetReadDeadline(time.Now().Add(25 * time.Second)); err != nil {
				t.Fatal(err)
			}
			var report macReplayWorkerResult
			if err = json.NewDecoder(results).Decode(&report); err != nil || report.Error != "" || report.State != "rolled_back_retained" {
				t.Fatal("real signed recovery worker did not perform the verified swap", report, err)
			}
			if target, err = macNode(intent.Target); err != nil || target != intent.Current.Node {
				t.Fatal("the authorized original was not restored", err)
			}
			var outcome struct {
				OK      bool   `json:"ok"`
				Summary string `json:"summary"`
			}
			raw, err := os.ReadFile(filepath.Join(intent.DataDir, "updater", "install-report.json"))
			if err != nil || json.Unmarshal(raw, &outcome) != nil || outcome.OK || outcome.Summary != "原版本已恢复，已请求重新打开。" {
				t.Fatal("the restored application did not receive a truthful update report", outcome, err)
			}
			macWait(t, f.root, 18*time.Second, func() bool {
				if failure, err := os.ReadFile(filepath.Join(f.root, "original-restart-error")); err == nil {
					t.Fatal(string(failure))
				}
				raw, err := os.ReadFile(filepath.Join(f.root, "original-restarted"))
				return err == nil && string(raw) == "restarted"
			})
			for _, path := range []string{intent.Work, filepath.Join(intent.DataDir, "updater", "mac-update-journal.json")} {
				if _, err = os.Lstat(path); !os.IsNotExist(err) {
					t.Fatal("the reopened original did not retire its recovery materials", path, err)
				}
			}
		})
	}
}
