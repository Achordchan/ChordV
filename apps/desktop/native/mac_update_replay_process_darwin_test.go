//go:build darwin

package main

import (
	"bufio"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

type macReplayWorkerConfig struct {
	Cfg       appConfig
	Public    ed25519.PublicKey
	Worker    string
	TimeoutMS int
	BadARM    bool
}

type macReplayWorkerResult struct {
	State string
	Error string
}

type macReplayRemoteTestAuthority struct {
	public ed25519.PublicKey
	input  *json.Decoder
	output *json.Encoder
}

func (a *macReplayRemoteTestAuthority) active(ctx context.Context, target, dataDir string) (macRecoveryIntent, error) {
	if err := ctx.Err(); err != nil {
		return macRecoveryIntent{}, err
	}
	nonce := make([]byte, 32)
	if _, err := rand.Read(nonce); err != nil {
		return macRecoveryIntent{}, err
	}
	if err := a.output.Encode(nonce); err != nil {
		return macRecoveryIntent{}, err
	}
	var proof macReplayTestProof
	if err := a.input.Decode(&proof); err != nil {
		return macRecoveryIntent{}, err
	}
	return verifyMacReplayTestProof(a.public, nonce, proof, target, dataDir)
}

func init() {
	if len(os.Args) != 3 || os.Args[1] != "--mac-replay-parent-test" && os.Args[1] != "--mac-replay-worker-test" {
		return
	}
	raw, err := os.ReadFile(os.Args[2])
	var cfg macReplayWorkerConfig
	if err == nil {
		err = json.Unmarshal(raw, &cfg)
	}
	if err == nil && os.Args[1] == "--mac-replay-parent-test" {
		err = runMacReplayTestParent(cfg)
	} else if err == nil {
		err = runMacReplayTestWorker(cfg)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	os.Exit(0)
}

func runMacReplayTestParent(cfg macReplayWorkerConfig) error {
	worker := exec.Command(cfg.Worker, "--mac-replay-worker-test", os.Args[2])
	worker.Env = systemProcessEnvironment()
	worker.Stderr = os.Stderr
	for fd := 3; fd <= 5; fd++ {
		worker.ExtraFiles = append(worker.ExtraFiles, os.NewFile(uintptr(fd), "controller-private-pipe"))
	}
	input, err := worker.StdinPipe()
	if err != nil {
		return err
	}
	output, err := worker.StdoutPipe()
	if err != nil {
		return err
	}
	if err = worker.Start(); err != nil {
		return err
	}
	for _, file := range worker.ExtraFiles {
		file.Close()
	}
	line, err := bufio.NewReader(output).ReadString('\n')
	if err != nil {
		return err
	}
	if !strings.HasPrefix(line, "CHORDV_RECOVERY_READY ") {
		return fmt.Errorf("unexpected worker readiness: %q", line)
	}
	token := strings.TrimPrefix(line, "CHORDV_RECOVERY_READY ")
	if cfg.BadARM {
		token = "stale-generation\n"
	}
	if _, err = fmt.Fprint(input, "ARM "+token); err != nil {
		return err
	}
	fmt.Fprintln(os.Stdout, "PARENT_READY", worker.Process.Pid)
	reader := bufio.NewReader(os.Stdin)
	line, err = reader.ReadString('\n')
	if err != nil || line != "EOF\n" {
		return fmt.Errorf("test parent missing EOF instruction: %q %v", line, err)
	}
	input.Close()
	fmt.Fprintln(os.Stdout, "PARENT_EOF")
	line, err = reader.ReadString('\n')
	if err != nil || line != "EXIT\n" {
		return fmt.Errorf("test parent missing EXIT instruction: %q %v", line, err)
	}
	// Deliberately do not wait for worker: it must observe this parent's EXIT.
	return nil
}

func runMacReplayTestWorker(cfg macReplayWorkerConfig) error {
	requests, responses := os.NewFile(3, "authority-requests"), os.NewFile(4, "authority-responses")
	defer requests.Close()
	defer responses.Close()
	resultPipe := os.NewFile(5, "worker-result")
	defer resultPipe.Close()
	authority := &macReplayRemoteTestAuthority{public: cfg.Public, input: json.NewDecoder(responses), output: json.NewEncoder(requests)}
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(cfg.TimeoutMS)*time.Millisecond)
	defer cancel()
	parentPath, err := macHealthProcessPath(os.Getppid())
	if err != nil {
		return err
	}
	anchor, err := deriveRecoveryAnchor(ctx, cfg.Cfg, parentPath)
	if err != nil {
		return err
	}
	for _, fd := range []int{0, 1} {
		if err = unix.SetNonblock(fd, true); err != nil {
			return err
		}
	}
	handoff := &macRecoveryHandoff{input: os.NewFile(0, "parent-input"), output: os.NewFile(1, "parent-output")}
	state, replayErr := replayMacUpdateRecovery(ctx, anchor, authority, handoff)
	result := macReplayWorkerResult{State: state}
	if replayErr != nil {
		result.Error = replayErr.Error()
	}
	return json.NewEncoder(resultPipe).Encode(result)
}

type macReplayTestRun struct {
	parent *exec.Cmd
	input  io.WriteCloser
	output *bufio.Reader
	result chan macReplayWorkerResult
	worker int
}

func startMacReplayTestRun(t *testing.T, f *macRecoveryFixture, a *macReplayTestAuthority, timeout time.Duration, badARM bool) *macReplayTestRun {
	t.Helper()
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cfg := macReplayWorkerConfig{Cfg: f.cfg, Public: a.public, Worker: self, TimeoutMS: int(timeout.Milliseconds()), BadARM: badARM}
	config := filepath.Join(f.root, "private-replay-config.json")
	if err = atomicJSON(config, cfg); err != nil {
		t.Fatal(err)
	}
	requestRead, requestWrite, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	responseRead, responseWrite, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	resultRead, resultWrite, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	command := exec.Command(f.plan.Current.Executable, "--mac-replay-parent-test", config)
	command.Env = systemProcessEnvironment()
	command.Stderr = os.Stderr
	command.ExtraFiles = []*os.File{requestWrite, responseRead, resultWrite}
	input, err := command.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	output, err := command.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err = command.Start(); err != nil {
		t.Fatal(err)
	}
	for _, file := range command.ExtraFiles {
		file.Close()
	}
	run := &macReplayTestRun{parent: command, input: input, output: bufio.NewReader(output), result: make(chan macReplayWorkerResult, 1)}
	controllerDone, resultDone := make(chan struct{}), make(chan struct{})
	go func() {
		defer close(controllerDone)
		defer requestRead.Close()
		defer responseWrite.Close()
		decoder, encoder := json.NewDecoder(requestRead), json.NewEncoder(responseWrite)
		for {
			var nonce []byte
			if decoder.Decode(&nonce) != nil || encoder.Encode(a.proof(nonce)) != nil {
				return
			}
		}
	}()
	go func() {
		defer close(resultDone)
		defer resultRead.Close()
		var result macReplayWorkerResult
		if err := json.NewDecoder(resultRead).Decode(&result); err != nil {
			result.Error = err.Error()
		}
		run.result <- result
	}()
	t.Cleanup(func() {
		input.Close()
		if command.ProcessState == nil {
			_ = command.Process.Kill()
			_ = command.Wait()
		}
		select {
		case <-resultDone:
		case <-time.After(timeout + 2*time.Second):
			t.Error("isolated recovery worker did not close result pipe")
		}
		select {
		case <-controllerDone:
		case <-time.After(2 * time.Second):
			t.Error("isolated authority pipe did not close")
		}
	})
	line, err := run.output.ReadString('\n')
	fields := strings.Fields(line)
	if err != nil || len(fields) != 2 || fields[0] != "PARENT_READY" {
		t.Fatal("real B parent did not complete READY", line, err)
	}
	run.worker, err = strconv.Atoi(fields[1])
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("actual B parent pid=%d recovery worker=%d; controller private key never transferred", command.Process.Pid, run.worker)
	return run
}

func (r *macReplayTestRun) closePipe(t *testing.T) {
	t.Helper()
	if _, err := fmt.Fprintln(r.input, "EOF"); err != nil {
		t.Fatal(err)
	}
	if line, err := r.output.ReadString('\n'); err != nil || line != "PARENT_EOF\n" {
		t.Fatal("parent EOF not observed", line, err)
	}
}

func (r *macReplayTestRun) exitParent(t *testing.T) {
	t.Helper()
	if _, err := fmt.Fprintln(r.input, "EXIT"); err != nil {
		t.Fatal(err)
	}
	if err := r.parent.Wait(); err != nil {
		t.Fatal(err)
	}
}

func (r *macReplayTestRun) receive(t *testing.T) macReplayWorkerResult {
	t.Helper()
	select {
	case result := <-r.result:
		return result
	case <-time.After(10 * time.Second):
		t.Fatal("recovery result timed out")
		return macReplayWorkerResult{}
	}
}
