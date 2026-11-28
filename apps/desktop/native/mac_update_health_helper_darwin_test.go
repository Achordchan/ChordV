//go:build darwin

package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestMacUpdatePackagedCandidateRejectsForeignHealthPeer(t *testing.T) {
	ctx, candidate := macHealthPackagedCandidate(t)
	root := filepath.Dir(candidate.Path)
	health, err := startMacUpdateHealth(&macUpdatePlan{ID: "unrelated-operation"}, candidate)
	if err != nil {
		t.Fatal(err)
	}
	defer health.Close()
	wire := make(chan error, 1)
	go func() { wire <- expectMacHealthPeerEOF(health) }()
	assertMacHealthHelperRejected(t, ctx, candidate, filepath.Join(root, "data"), health.RestartEnvironment(), "")
	if err = <-wire; err != nil {
		t.Fatal(err)
	}
}

func TestMacUpdatePackagedCandidateRejectsDifferentSignedHelperAtExpectedPath(t *testing.T) {
	ctx, candidate := macHealthPackagedCandidate(t)
	root := filepath.Dir(candidate.Path)
	const operation = "mismatched-signed-helper"
	work := filepath.Join(root, ".chordv-mac-update-"+operation)
	if err := os.Mkdir(work, 0700); err != nil {
		t.Fatal(err)
	}
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	app := filepath.Join(work, macUpdateHelperBundleName)
	createMacTestBundle(t, app, self, "app.chordv.mygo.local.unrelated-helper-fixture", "1.0.0", 1, "13.0")
	helper, err := readMacBundle(ctx, app, true)
	if err != nil {
		t.Fatal(err)
	}
	listener := exec.CommandContext(ctx, helper.Executable, "-test.run=^TestMacUpdateHealthFixtureListener$")
	listener.Env = append(systemProcessEnvironment(), "CHORDV_HEALTH_FIXTURE_LISTENER="+operation)
	stdout, err := listener.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err = listener.Start(); err != nil {
		t.Fatal(err)
	}
	joined := false
	defer func() {
		if !joined {
			_ = listener.Process.Kill()
			_ = listener.Wait()
		}
	}()
	reader := bufio.NewReader(stdout)
	socket, err := reader.ReadString('\n')
	if err != nil || !strings.HasPrefix(socket, "/private/tmp/cvh-") {
		t.Fatal("signed fixture could not start private listener", socket, err)
	}
	assertMacHealthHelperRejected(t, ctx, candidate, filepath.Join(root, "data"), []string{
		macHealthSocketEnv + "=" + strings.TrimSpace(socket), macHealthIDEnv + "=" + operation,
		fmt.Sprintf("%s=%d", macHealthServerPIDEnv, listener.Process.Pid),
	}, "更新应用bundleID不一致")
	log, err := io.ReadAll(reader)
	if waitErr := listener.Wait(); err != nil || waitErr != nil {
		joined = true
		t.Fatalf("signed mismatched-helper socket was not rejected before hello: %v %v %s", err, waitErr, log)
	}
	joined = true
}

func TestMacUpdateHealthFixtureListener(t *testing.T) {
	id := os.Getenv("CHORDV_HEALTH_FIXTURE_LISTENER")
	if id == "" {
		return
	}
	health, err := startMacUpdateHealth(&macUpdatePlan{ID: id}, macBundleInfo{})
	if err != nil {
		t.Fatal(err)
	}
	defer health.Close()
	fmt.Println(health.socket)
	if err = expectMacHealthPeerEOF(health); err != nil {
		t.Fatal(err)
	}
}

func macHealthPackagedCandidate(t *testing.T) (context.Context, macBundleInfo) {
	t.Helper()
	app := os.Getenv("CHORDV_TEST_FULL_GUI_APP")
	if app == "" {
		t.Skip("requires the isolated build's actual signed app bundle")
	}
	root, err := macCanonical(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	t.Cleanup(cancel)
	copy := filepath.Join(root, "Candidate.app")
	if _, err = runMacUpdateCommand(ctx, 10*time.Second, "/usr/bin/ditto", app, copy); err != nil {
		t.Fatal(err)
	}
	candidate, err := readMacBundle(ctx, copy, true)
	if err != nil || candidate.Build.Mode != "local" {
		t.Fatal("requires a private local build", err)
	}
	return ctx, candidate
}

func expectMacHealthPeerEOF(health *macUpdateHealthSupervisor) error {
	if err := health.listener.SetDeadline(time.Now().Add(8 * time.Second)); err != nil {
		return err
	}
	conn, err := health.listener.AcceptUnix()
	if err != nil {
		return err
	}
	defer conn.Close()
	if err = conn.SetReadDeadline(time.Now().Add(8 * time.Second)); err != nil {
		return err
	}
	message, err := readMacHealthMessage(bufio.NewReaderSize(conn, 4096))
	if message.Kind != "" || !errors.Is(err, io.EOF) {
		return fmt.Errorf("candidate sent data to an unrelated same-UID process before authenticating it: %+v, %v", message, err)
	}
	return nil
}

func assertMacHealthHelperRejected(t *testing.T, ctx context.Context, candidate macBundleInfo, dataDir string, environment []string, reason string) {
	t.Helper()
	child := exec.CommandContext(ctx, candidate.Executable)
	child.Env = append(systemProcessEnvironment(), "CHORDV_MYGO_DATA_DIR="+dataDir, "CHORDV_API_BASE_URL=http://127.0.0.1:1")
	child.Env = append(child.Env, environment...)
	output, runErr := child.CombinedOutput()
	if runErr == nil || !strings.Contains(string(output), errMacUnexpectedHealthHelper.Error()) || !strings.Contains(string(output), reason) {
		t.Fatalf("candidate did not report the unrelated peer: %v, %s", runErr, output)
	}
	if _, err := os.Lstat(dataDir); !os.IsNotExist(err) {
		t.Fatal("unrelated peer caused desktop data initialization", err)
	}
}
