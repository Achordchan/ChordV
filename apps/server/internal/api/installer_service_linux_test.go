//go:build linux

package api

import (
	"os/exec"
	"strings"
	"testing"
)

// Exercise the embedded installer's decision with real /proc identities. Only
// the systemd responses and the separate read-only health probe are simulated.
func TestInstallerRequiresRunningReleaseDuringHealthProbe(t *testing.T) {
	raw, err := agentInstallTemplate.ReadFile("assets/install-go-agent.sh")
	if err != nil {
		t.Fatal(err)
	}
	_, tail, ok := strings.Cut(string(raw), "\nsystemctl start \"$SERVICE\" 9>&-\n")
	if !ok {
		t.Fatal("health phase missing")
	}
	block, _, ok := strings.Cut(tail, "\nCOMMITTED=1")
	if !ok {
		t.Fatal("commit boundary missing")
	}
	const setup = `set -eu
RELEASE=$(mktemp -d); STAGE=$RELEASE; INSTALL_DIR=$RELEASE; SERVICE=chordv-node-agent.service
API_BASE='' STATE_DIR='' DISCOVERED_API='' DISCOVERED_TAG='' WAIT_FOR_INBOUND=false
cp /bin/sleep "$RELEASE/chordv-agent"; "$RELEASE/chordv-agent" 60 & first=$!; "$RELEASE/chordv-agent" 60 & second=$!
trap 'kill "$first" "$second" 2>/dev/null || :; wait || :; rm -rf "$RELEASE"' EXIT
service_pid=$first
systemctl(){ case "$1" in is-active) [[ $scenario != inactive ]];; show) echo "$service_pid";; *) exit 80;; esac; }
runuser(){ if [[ $scenario == churn ]];then if [[ $service_pid == "$first" ]];then service_pid=$second;else service_pid=$first;fi;fi; [[ $scenario != probe-failure ]]; }
sleep(){ :; }; fail(){ exit 43; }
if [[ $scenario == foreign ]];then service_pid=$$;fi
if [[ $scenario == missing-pid ]];then service_pid=0;fi
`
	for _, mode := range []string{"healthy", "inactive", "foreign", "missing-pid", "churn", "probe-failure"} {
		t.Run(mode, func(t *testing.T) {
			cmd := exec.Command("bash", "-c", setup+block, "qa")
			cmd.Env = []string{"PATH=/usr/bin:/bin", "scenario=" + mode}
			out, err := cmd.CombinedOutput()
			if mode == "healthy" {
				if err != nil {
					t.Fatalf("expected success: %v: %s", err, out)
				}
			} else if cmd.ProcessState.ExitCode() != 43 {
				t.Fatalf("expected installer refusal, got %v: %s", err, out)
			}
		})
	}
}
