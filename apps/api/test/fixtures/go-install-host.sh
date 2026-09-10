#!/usr/bin/env bash
# Disposable, offline Linux fixture for installer filesystem and recovery paths.
# systemctl is replaced here because a Docker process is not a systemd boot.
set -euo pipefail
mkdir -p /scenario /run/systemd/system /usr/local/x-ui/bin /run/lock
printf 'existing panel config\n' > /usr/local/x-ui/bin/config.json
printf 'existing panel executable\n' > /usr/local/x-ui/x-ui
sha256sum /usr/local/x-ui/bin/config.json /usr/local/x-ui/x-ui > /scenario/panel.before
cat > /usr/local/bin/curl <<'CURL'
#!/bin/bash
[[ ! -f /scenario/network-fails ]] || exit 7
while [[ $# -gt 0 ]]; do
  if [[ $1 == -o ]]; then cp /payload/agent "$2"; exit; fi
  shift
done
exit 1
CURL
cat > /usr/local/bin/systemctl <<'SYSTEMCTL'
#!/bin/bash
case "$1" in
  show)
    case "$3" in
      FragmentPath) [[ ! -f /etc/systemd/system/chordv-node-agent.service ]] || echo /etc/systemd/system/chordv-node-agent.service ;;
      MainPID) echo 1234 ;;
    esac ;;
  is-active) test -f /scenario/active ;;
  start)
    [[ ! -f /scenario/start-fails ]] || exit 1
    touch /scenario/active
    runuser -u chordv-agent -- bash -c 'printf "identity-sentinel" > /var/lib/chordv-node-agent/credentials.json; printf "unsettled-metering" > /var/lib/chordv-node-agent/agent.db' ;;
  stop) rm -f /scenario/active ;;
  enable|daemon-reload) : ;;
  *) exit 1 ;;
esac
SYSTEMCTL
chmod +x /usr/local/bin/curl /usr/local/bin/systemctl
expect_failure() { if bash "$1" >/scenario/output 2>&1; then cat /scenario/output; exit 1; fi; }
# A local unprivileged account can pre-create a symlink in a permissive shared
# lock directory. The protected target must not be opened/truncated by root.
chmod 0777 /run/lock
printf 'protected-root-file\n' > /scenario/protected-root-file
chmod 0600 /scenario/protected-root-file
runuser -u nobody -- ln -s /scenario/protected-root-file /run/lock/chordv-go-install.lock
expect_failure /payload/expired.sh
[[ $(cat /scenario/protected-root-file) == 'protected-root-file' ]] || { echo 'protected file was truncated by installer lock' >&2; exit 1; }
# Also refuse a planted symlink at the new private lock filename.
ln -s /scenario/protected-root-file /run/chordv-agent-installer/install.lock.attack
mv -fT /run/chordv-agent-installer/install.lock.attack /run/chordv-agent-installer/install.lock
expect_failure /payload/install.sh
[[ $(cat /scenario/protected-root-file) == 'protected-root-file' ]] || { echo 'private lock symlink changed protected file' >&2; exit 1; }
rm /run/chordv-agent-installer/install.lock
[[ $(stat -c %a /run/chordv-agent-installer) == 700 ]]
[[ ! -e /opt/chordv-node-agent ]]
expect_failure /payload/corrupt.sh
[[ ! -e /opt/chordv-node-agent ]]
touch /scenario/network-fails
expect_failure /payload/install.sh
rm /scenario/network-fails
[[ ! -e /opt/chordv-node-agent ]]
touch /scenario/preflight-fails
expect_failure /payload/install.sh
rm /scenario/preflight-fails
[[ ! -e /opt/chordv-node-agent ]]
# Existing identity must be refused before download/preflight or filesystem edits.
mkdir -p /etc/chordv
printf 'old credential\n' > /etc/chordv/node-agent.env
expect_failure /payload/install.sh
[[ $(cat /etc/chordv/node-agent.env) == 'old credential' ]]
rm /etc/chordv/node-agent.env
# Resume a first installation killed after creating a release directory/link.
digest=$(sha256sum /payload/agent | cut -d' ' -f1)
printf 'test-node\n%s\n' "$(printf chordv_register_test | sha256sum | cut -d' ' -f1)" > /etc/chordv/go-install.identity
partial="/opt/chordv-node-agent/releases/0.0.11-$digest"
mkdir -p "$partial"
printf 'interrupted copy' > "$partial/chordv-agent.new"
ln -s "$partial" /opt/chordv-node-agent/.current-next
bash /payload/install.sh
[[ $(stat -c %a /etc/chordv/node-agent.env) == 640 ]]
[[ $(stat -c %U /etc/chordv/node-agent.env) == root ]]
[[ $(stat -c %U /var/lib/chordv-node-agent/credentials.json) == chordv-agent ]]
sha256sum /var/lib/chordv-node-agent/credentials.json /var/lib/chordv-node-agent/agent.db > /scenario/state.before
bash /payload/expired.sh
sha256sum -c /scenario/state.before
expect_failure /payload/other.sh
sha256sum -c /scenario/state.before
# Failure during promotion restores the prior unit/env/link while preserving
# the identity and durable queue. A following run uses the same identity.
sha256sum /etc/chordv/node-agent.env /etc/systemd/system/chordv-node-agent.service > /scenario/service.before
touch /scenario/start-fails
ln -s "$partial" /opt/chordv-node-agent/.rollback-next
expect_failure /payload/install.sh
rm /scenario/start-fails
sha256sum -c /scenario/service.before
sha256sum -c /scenario/state.before
bash /payload/install.sh
sha256sum -c /scenario/panel.before
[[ ! -e /etc/systemd/system/chordv-xray.service ]]
printf '%s\n' 'Installer host regression passed: checksum/network/preflight failures, existing identity refusal, repeat, recovery, panel preservation.'
