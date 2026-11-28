//go:build darwin

package main

import (
	"bufio"
	"context"
	"errors"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

func TestMacUpdateNativeFailureWaitsForAuthenticatedChallenge(t *testing.T) {
	health, err := startMacUpdateHealth(&macUpdatePlan{ID: "1234567890"}, macBundleInfo{})
	if err != nil {
		t.Fatal(err)
	}
	defer health.Close()
	for _, entry := range health.RestartEnvironment() {
		key, value, _ := strings.Cut(entry, "=")
		t.Setenv(key, value)
	}
	client, err := dialMacUpdateHealth(func(int, string) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	client.NativeReady(errors.New("deterministic startup failure before server accept"))
	select {
	case err := <-client.Done():
		t.Fatal("client closed before server could authenticate queued socket", err)
	default:
	}
	conn, err := health.listener.AcceptUnix()
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(2 * time.Second))
	pid, uid, err := macHealthPeer(conn)
	if err != nil || pid != os.Getpid() || uid != uint32(os.Getuid()) {
		t.Fatal("queued peer credentials unavailable", pid, uid, err)
	}
	reader := bufio.NewReaderSize(conn, 4096)
	hello, err := readMacHealthMessage(reader)
	if err != nil || hello.Kind != "hello" {
		t.Fatal("missing hello", hello, err)
	}
	if err = writeMacHealthMessage(conn, macHealthMessage{Kind: "challenge", ID: health.plan.ID, Challenge: health.challenge}); err != nil {
		t.Fatal(err)
	}
	failed, err := readMacHealthMessage(reader)
	if err != nil || failed.Kind != "failed" || failed.Challenge != health.challenge || failed.Error == "" {
		t.Fatal("native failure lost verified challenge", failed, err)
	}
	if err := <-client.Done(); err == nil {
		t.Fatal("failed startup acknowledged as healthy")
	}
}

func macHealthFixtureBinary(t *testing.T, root string) string {
	t.Helper()
	for _, name := range []string{"mac_update_health_client_darwin.go", "mac_update_health_peer_darwin.go"} {
		source, err := os.ReadFile(name)
		if err != nil {
			t.Fatal(err)
		}
		if err = os.WriteFile(filepath.Join(root, name), source, 0600); err != nil {
			t.Fatal(err)
		}
	}
	program := `package main
import("bufio";"errors";"fmt";"net";"os";"time";"github.com/egoist/mygo")
func main(){
 mode:=os.Getenv("CHORDV_HEALTH_PROOF_MODE")
 if mode=="wrong-ack"{
  conn,err:=net.Dial("unix",os.Getenv(macHealthSocketEnv));if err!=nil{panic(err)}
  id:=os.Getenv(macHealthIDEnv)
  _=writeMacHealthMessage(conn,macHealthMessage{Kind:"hello",ID:id})
  go func(){_,_=readMacHealthMessage(bufio.NewReaderSize(conn,4096));_=writeMacHealthMessage(conn,macHealthMessage{Kind:"ready",ID:id,Challenge:"invalid"})}()
 }else{
  if mode=="wrong-id"{_=os.Setenv(macHealthIDEnv,"wrong-session")}
  client,err:=dialMacUpdateHealth(func(int,string)error{return nil});if err!=nil{panic(err)}
  mygo.App.WhenReady(func(){
   if mode=="exit-early"{go func(){time.Sleep(200*time.Millisecond);mygo.App.Quit()}();return}
   if mode!="no-frontend"{_=client.AppReady()}
   if mode=="native-error"{client.NativeReady(errors.New("fixture native recovery failed"))}else if mode!="no-native"{client.NativeReady(nil)}
   go func(){if client!=nil{err:=<-client.Done();_=os.WriteFile(os.Getenv("CHORDV_HEALTH_PROOF_MARKER"),[]byte(fmt.Sprint(err)),0600)}}()
  })
 }
 mygo.App.WhenReady(func(){go func(){time.Sleep(30*time.Second);mygo.App.Quit()}()})
 if err:=mygo.App.Run();err!=nil{panic(err)}
}`
	source := filepath.Join(root, "candidate.go")
	if err := os.WriteFile(source, []byte(program), 0600); err != nil {
		t.Fatal(err)
	}
	binary := filepath.Join(root, "candidate")
	cmd := exec.Command("go", "build", "-o", binary, source, filepath.Join(root, "mac_update_health_client_darwin.go"), filepath.Join(root, "mac_update_health_peer_darwin.go"))
	cmd.Env = append(systemProcessEnvironment(), "CGO_ENABLED=0", "GOPROXY=off", "GOARCH="+runtime.GOARCH)
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build actual health client GUI: %v %s", err, output)
	}
	return binary
}

func TestMacUpdateHealthActualGUIProtocol(t *testing.T) {
	root, err := macCanonical(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	binary := macHealthFixtureBinary(t, root)
	for _, mode := range []string{"healthy", "no-frontend", "no-native", "native-error", "wrong-ack", "wrong-id", "exit-early"} {
		t.Run(mode, func(t *testing.T) {
			caseRoot := filepath.Join(root, mode)
			if err := os.Mkdir(caseRoot, 0700); err != nil {
				t.Fatal(err)
			}
			app := filepath.Join(caseRoot, "Candidate.app")
			createMacTestBundle(t, app, binary, "app.chordv.mygo.local.healthproof."+strings.ReplaceAll(mode, "-", ""), "2.0.0", 2, "13.0")
			info, err := readMacBundle(context.Background(), app, true)
			if err != nil {
				t.Fatal(err)
			}
			// Use the same short decimal ID format as prepareMacUpdate's MkdirTemp work.
			work, err := os.MkdirTemp(caseRoot, ".chordv-mac-update-")
			if err != nil {
				t.Fatal(err)
			}
			id := strings.TrimPrefix(filepath.Base(work), ".chordv-mac-update-")
			plan := &macUpdatePlan{ID: id, Current: info}
			health, err := startMacUpdateHealth(plan, info)
			if err != nil {
				t.Fatal(err)
			}
			defer health.Close()
			foreign, err := net.DialUnix("unix", nil, &net.UnixAddr{Name: health.socket, Net: "unix"})
			if err != nil {
				t.Fatal(err)
			}
			defer foreign.Close()
			env := append(health.RestartEnvironment(), "CHORDV_HEALTH_PROOF_MODE="+mode, "CHORDV_HEALTH_PROOF_MARKER="+filepath.Join(caseRoot, "client-result"))
			launchCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			owned, err := launchMacUpdateApplication(launchCtx, info, env)
			cancel()
			if err != nil {
				t.Fatal(err)
			}
			defer owned.Close()
			defer func() {
				ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
				defer cancel()
				if err := owned.StopAndWait(ctx); err != nil {
					t.Error("owned cleanup:", err)
				}
			}()
			if mode == "healthy" {
				actual, hashErr := macHealthProcessCDHash(owned.PID)
				if hashErr != nil || actual != info.CDHash {
					t.Fatalf("running candidate kernel CDHash mismatch: %s expected %s err %v", actual, info.CDHash, hashErr)
				}
				if hashErr = verifyMacHealthProcessCDHash(owned.PID, strings.Repeat("0", 40)); hashErr == nil {
					t.Fatal("running candidate accepted another signed image hash")
				}
				t.Logf("nonself kernel CDHash %s equals signed candidate", actual)
			}
			waitCtx, stop := context.WithTimeout(context.Background(), 2*time.Second)
			err = health.Wait(waitCtx, owned, nil)
			stop()
			if mode == "healthy" && err != nil {
				t.Fatal("real GUI dual-ready ACK failed:", err)
			}
			if mode != "healthy" && err == nil {
				t.Fatal("unhealthy candidate accepted:", mode)
			}
			if err == nil {
				t.Logf("verified real GUI PID=%d kernel path=%s session=%s", owned.PID, owned.executable, id)
			} else {
				t.Logf("rejected %s: %v", mode, err)
			}
		})
	}
	t.Run("os-rejection", func(t *testing.T) {
		app := filepath.Join(root, "Rejected.app")
		createMacTestBundle(t, app, binary, "app.chordv.mygo.local.healthproof.rejected", "2.0.0", 2, "99.0")
		info, err := readMacBundle(context.Background(), app, true)
		if err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		owned, err := launchMacUpdateApplication(ctx, info, nil)
		if owned != nil {
			defer owned.Close()
			t.Fatal("OS rejected app returned live ownership")
		}
		if err == nil || !macUpdateLaunchRollbackSafe(err) {
			t.Fatalf("expected explicit safe OS rejection: %v", err)
		}
	})
}

func TestMacUpdateLaunchCancellationIsClassified(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := launchMacUpdateApplication(ctx, macBundleInfo{}, nil); err == nil || !macUpdateLaunchRollbackSafe(err) {
		t.Fatal("prelaunch cancellation not classified", err)
	}
	if macUpdateLaunchRollbackSafe(errors.New("unknown launcher outcome")) {
		t.Fatal("unknown launch authorized rollback")
	}
}

func TestMacUpdateOwnedProcessRefusesChangedIdentity(t *testing.T) {
	command := exec.Command("/bin/sleep", "20")
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	defer command.Wait()
	executable, err := macHealthProcessPath(command.Process.Pid)
	if err != nil {
		command.Process.Kill()
		t.Fatal(err)
	}
	owned, err := ownMacUpdateProcess(command.Process.Pid, executable)
	if err != nil {
		command.Process.Kill()
		t.Fatal(err)
	}
	defer owned.Close()
	owned.executable = "/not-the-owned-application"
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	err = owned.StopAndWait(ctx)
	cancel()
	if err == nil {
		t.Fatal("changed process identity authorized termination")
	}
	if err = command.Process.Signal(os.Signal(unix.Signal(0))); err != nil {
		t.Fatal("identity mismatch terminated a process:", err)
	}
	owned.executable = executable
	ctx, cancel = context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err = owned.StopAndWait(ctx); err != nil {
		command.Process.Kill()
		t.Fatal(err)
	}
}

func TestMacUpdateHealthWireRejectsExtraData(t *testing.T) {
	for _, wire := range []string{"{\"kind\":\"ready\",\"id\":\"123\",\"pid\":1}\n", "{\"kind\":\"ready\"} {}\n", strings.Repeat("x", 4096) + "\n"} {
		if _, err := readMacHealthMessage(bufio.NewReaderSize(strings.NewReader(wire), 4096)); err == nil {
			t.Fatal("accepted untrusted wire content")
		}
	}
}

func TestMacUpdateRunningSignatureQueryFailsClosed(t *testing.T) {
	if err := verifyMacHealthProcessCDHash(-1, strings.Repeat("0", 40)); err == nil {
		t.Fatal("missing running process accepted")
	}
}
