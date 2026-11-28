//go:build darwin

package main

import (
	"bufio"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"
)

type macUpdateFixture struct {
	Root          string
	Current       string
	Candidate     string
	Marker        string
	Config        string
	DataDir       string
	Installer     string
	CurrentInfo   macBundleInfo
	CandidateInfo macBundleInfo
	SigningKey    ed25519.PrivateKey
}

func createMacTestBundle(t *testing.T, path, binary, id, version string, build int64, minimum string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(path, "Contents", "MacOS"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := copyAtomic(binary, filepath.Join(path, "Contents", "MacOS", "Fixture"), 0755); err != nil {
		t.Fatal(err)
	}
	plist := map[string]any{"CFBundleIdentifier": id, "CFBundleExecutable": "Fixture", "CFBundleName": "ChordV Update Fixture", "CFBundleVersion": version, "CFBundleShortVersionString": version, "CFBundlePackageType": "APPL", "LSMinimumSystemVersion": minimum,
		"ChordVBuildInfo": map[string]any{"version": version, "build": build, "mode": "local", "platform": "macos", "architecture": architectureName()}}
	data, err := marshalPlist(plist)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(path, "Contents", "Info.plist"), data, 0644); err != nil {
		t.Fatal(err)
	}
	if _, err = runMacUpdateCommand(context.Background(), 30*time.Second, "/usr/bin/codesign", "--force", "--sign", "-", path); err != nil {
		t.Fatal(err)
	}
}

func macFixture(t *testing.T, minimum string) macUpdateFixture {
	return macFixtureHealth(t, minimum, "healthy")
}

func macFixtureHealth(t *testing.T, minimum, mode string) macUpdateFixture {
	t.Helper()
	temp, err := os.MkdirTemp("", strings.ReplaceAll(t.Name(), "/", "_")+"-")
	if err != nil {
		t.Fatal(err)
	}
	root, err := macCanonical(temp)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		out, err := runMacUpdateCommand(context.Background(), 30*time.Second, "/usr/bin/hdiutil", "info", "-plist")
		if err != nil || strings.Contains(string(out), root) {
			t.Errorf("fixture retains attached image or unverified inventory; evidence kept at %s: %v", root, err)
			return
		}
		if t.Failed() {
			t.Logf("failed fixture evidence retained at %s", root)
			return
		}
		if err := os.RemoveAll(root); err != nil {
			t.Error(err)
		}
	})
	f := macUpdateFixture{Root: root, Current: filepath.Join(root, "Installed.app"), Candidate: filepath.Join(root, "image", "Candidate.app"), Marker: filepath.Join(root, "candidate-started"), DataDir: filepath.Join(root, "data")}
	id := "app.chordv.mygo.local.test." + macPlanDigest([]byte(root))[:12]
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	createMacTestBundle(t, f.Current, self, id, "1.0.0", 1, "13.0")
	source := filepath.Join(root, "fixture.go")
	program := fmt.Sprintf(`package main
import("fmt";"os";"os/signal";"syscall";"time";"github.com/egoist/mygo")
func main(){
 _=os.WriteFile(%q,[]byte(fmt.Sprint(os.Getpid())),0600)
 h,err:=dialMacUpdateHealth(func(int,string)error{return nil});if err!=nil{fmt.Fprintln(os.Stderr,err);os.Exit(2)};defer h.Close()
 mygo.App.WhenReady(func(){go func(){
  if %q=="native-error"{h.NativeReady(fmt.Errorf("isolated native startup failed"))}else{h.NativeReady(nil)}
  _=h.AppReady();result:=<-h.Done()
  if result==nil{_=os.WriteFile(%q,[]byte(fmt.Sprint(os.Getpid())),0600)}
  stop:=make(chan os.Signal,1);signal.Notify(stop,syscall.SIGTERM,syscall.SIGINT);defer signal.Stop(stop)
  select{case<-stop:case<-time.After(45*time.Second):};mygo.App.Quit()
 }()});if err:=mygo.App.Run();err!=nil{os.Exit(2)}
}
`, f.Marker+".pid", mode, f.Marker)
	if err = os.WriteFile(source, []byte(program), 0600); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		data, err := os.ReadFile(f.Marker + ".pid")
		if os.IsNotExist(err) {
			return
		}
		pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
		if err != nil || pid <= 1 {
			t.Error("invalid owned candidate marker", err)
			return
		}
		path, err := macHealthProcessPath(pid)
		if err != nil {
			return
		}
		if path != filepath.Join(f.Current, "Contents", "MacOS", "Fixture") {
			return
		}
		owned, err := ownMacUpdateProcess(pid, path)
		if err != nil {
			t.Error("cannot identify owned candidate", err)
			return
		}
		defer owned.Close()
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := owned.StopAndWait(ctx); err != nil {
			t.Error("cannot stop owned candidate", err)
		}
	})
	binary := filepath.Join(root, "candidate-binary")
	files := []string{source}
	for _, name := range []string{"mac_update_health_client_darwin.go", "mac_update_health_peer_darwin.go"} {
		path := filepath.Join(root, name)
		if err := copyAtomic(name, path, 0600); err != nil {
			t.Fatal(err)
		}
		files = append(files, path)
	}
	cmd := exec.Command("go", append([]string{"build", "-o", binary}, files...)...)
	cmd.Env = append(systemProcessEnvironment(), "GOPROXY=off", "CGO_ENABLED=0", "GOARCH="+runtime.GOARCH)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build genuine local app fixture: %v %s", err, out)
	}
	createMacTestBundle(t, f.Candidate, binary, id, "2.0.0", 2, minimum)
	if err = os.MkdirAll(filepath.Join(f.DataDir, "updater"), 0700); err != nil {
		t.Fatal(err)
	}
	f.Installer = filepath.Join(f.DataDir, "updater", "update.dmg")
	if _, err = runMacUpdateCommand(context.Background(), 90*time.Second, "/usr/bin/hdiutil", "create", "-ov", "-format", "UDZO", "-volname", "ChordV Update Fixture", "-srcfolder", filepath.Dir(f.Candidate), f.Installer); err != nil {
		t.Fatal(err)
	}
	pub, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	f.SigningKey = key
	hash, err := fileSHA256(f.Installer)
	if err != nil {
		t.Fatal(err)
	}
	stat, err := os.Stat(f.Installer)
	if err != nil {
		t.Fatal(err)
	}
	manifest := releaseManifest{SchemaVersion: 1, Tag: "v2.0.0", Version: "2.0.0", Channel: "stable", Build: 2, Installers: []releaseAsset{{Platform: "macos", Architecture: architectureName(), FileName: "update.dmg", SHA256: hash, SizeBytes: stat.Size()}}}
	body, _ := json.Marshal(manifest)
	signature := base64.StdEncoding.EncodeToString(ed25519.Sign(key, body))
	repository := "test/desktop"
	s := newDesktopService(appConfig{DataDir: f.DataDir, ReleaseRepository: repository, ReleasePublicKey: base64.StdEncoding.EncodeToString(pub)})
	defer s.cancel()
	input, _ := json.Marshal(map[string]string{"manifest": string(body), "signature": signature, "tag": manifest.Tag})
	if _, err = s.authorizeReleaseManifest(context.Background(), input); err != nil {
		t.Fatal(err)
	}
	grant, err := s.authorizedDownload("https://github.com/"+repository+"/releases/download/v2.0.0/update.dmg", hash, stat.Size())
	if err != nil {
		t.Fatal(err)
	}
	pending := pendingInstaller{Path: f.Installer, SHA256: hash, Size: stat.Size(), Version: "2.0.0", Grant: grant}
	if err = atomicJSON(filepath.Join(f.DataDir, "updater", "pending.json"), pending); err != nil {
		t.Fatal(err)
	}
	f.Config = filepath.Join(root, "fixture-config.json")
	if err = atomicJSON(f.Config, macFixtureConfig{f.DataDir, repository, s.cfg.ReleasePublicKey, f.Installer}); err != nil {
		t.Fatal(err)
	}
	f.CurrentInfo, err = readMacBundle(context.Background(), f.Current, true)
	if err != nil {
		t.Fatal(err)
	}
	f.CandidateInfo, err = readMacBundle(context.Background(), f.Candidate, true)
	if err != nil {
		t.Fatal(err)
	}
	return f
}

type macHolderProcess struct {
	command        *exec.Cmd
	pipe           *os.File
	lines          chan string
	done           chan error
	work           string
	helperPID      int
	helperIdentity string
	helperBundle   macFilesystemIdentity
}

func startMacHolder(t *testing.T, f macUpdateFixture) *macHolderProcess {
	t.Helper()
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(f.CurrentInfo.Executable, "--mac-update-test-holder", f.Config)
	cmd.Stdin = reader
	cmd.Env = systemProcessEnvironment()
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	log, err := os.Create(filepath.Join(f.Root, "holder.log"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { log.Close() })
	cmd.Stderr = log
	if err = cmd.Start(); err != nil {
		t.Fatal(err)
	}
	reader.Close()
	h := &macHolderProcess{command: cmd, pipe: writer, lines: make(chan string, 8), done: make(chan error, 1)}
	go func() { h.done <- cmd.Wait(); close(h.done) }()
	go func() {
		scanner := bufio.NewScanner(stdout)
		for scanner.Scan() {
			h.lines <- scanner.Text()
		}
		close(h.lines)
	}()
	t.Cleanup(func() {
		if t.Failed() {
			for _, path := range []string{filepath.Join(f.Root, "holder.log"), filepath.Join(h.work, "helper.log"), filepath.Join(f.DataDir, "updater", "install-report.json"), filepath.Join(f.DataDir, "updater", "mac-update-journal.json")} {
				if data, err := os.ReadFile(path); err == nil {
					t.Logf("failure diagnostics %s: %.16384s", filepath.Base(path), data)
				}
			}
		}
		_, _ = fmt.Fprintln(h.pipe, "TEST_CLEANUP")
		h.pipe.Close()
		select {
		case <-h.done:
		case <-time.After(10 * time.Second):
			_ = h.command.Process.Kill()
			<-h.done
		}
		if h.work != "" && stopMacTestHelper(t, h) {
			if err := h.cleanupFixtureWork(f); err != nil {
				t.Errorf("owned update cleanup failed; work=%s: %v", h.work, err)
				if data, readErr := os.ReadFile(filepath.Join(h.work, macMountRecordName)); readErr == nil {
					t.Logf("retained ownership record: %s", data)
				}
			}
		}
	})
	if got := h.line(t); got != "STARTING" {
		t.Fatalf("holder did not start: %s", got)
	}
	return h
}

func (h *macHolderProcess) line(t *testing.T) string {
	t.Helper()
	select {
	case line := <-h.lines:
		if line == "" {
			t.Fatal("holder exited before response")
		}
		return line
	case <-time.After(3 * time.Minute):
		t.Fatal("holder response timeout")
	}
	return ""
}

func (h *macHolderProcess) ready(t *testing.T) {
	t.Helper()
	var ready struct {
		Work      string `json:"work"`
		HelperPID int    `json:"helperPid"`
	}
	if err := json.Unmarshal([]byte(h.line(t)), &ready); err != nil {
		t.Fatal(err)
	}
	h.work = ready.Work
	h.helperPID = ready.HelperPID
	h.helperIdentity, _ = processIdentity(context.Background(), ready.HelperPID)
	bundle, _, err := readMacFilesystemNode(filepath.Join(h.work, macUpdateHelperBundleName))
	if err != nil {
		t.Fatal(err)
	}
	h.helperBundle = bundle
}

func (h *macHolderProcess) cleanupFixtureWork(f macUpdateFixture) error {
	if filepath.Dir(h.work) != f.Root {
		return fmt.Errorf("refuse fixture cleanup outside %s", f.Root)
	}
	directories, err := readMacSwapDirectories(f.Current, h.work)
	if os.IsNotExist(err) {
		return assertMacWorkImageAbsent(h.work)
	}
	if err != nil {
		return err
	}
	// Tests can rebind the enclosing fixture directory or leave a deliberately
	// invalid app installed. Only the helper seen at READY may be cleaned here.
	scope := macCleanupScope{target: f.Current, parent: directories.ParentStable, workspace: directories.WorkStable}
	if h.helperBundle.FileID != 0 {
		scope.helper = &h.helperBundle
	}
	return cleanupMacUpdateWorkWithScope(h.work, &scope)
}
