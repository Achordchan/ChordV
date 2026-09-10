#!/usr/bin/env bash
# Full local protocol test with real official 3x-ui and Go binaries. Docker
# supplies the isolated filesystem; this fixture supplies systemd scheduling.
set -euo pipefail
mkdir -p /scenario /run/systemd/system /run/lock /usr/local
cd /usr/local
tar -xzf /payload/x-ui.tar.gz
chmod +x /usr/local/x-ui/x-ui /usr/local/x-ui/bin/xray-linux-arm64
/usr/local/x-ui/x-ui setting -username go-e2e -password 'test-only-isolated-strong-password' -port 54321 -webBasePath / -listenIP 127.0.0.1 >/scenario/panel-init.log 2>&1
cd /usr/local/x-ui
./x-ui run >/scenario/panel.log 2>&1 &
echo $! >/scenario/panel.pid
cat >/usr/local/bin/systemctl <<'SYSTEMCTL'
#!/usr/bin/env bash
case "$1" in
  show)
    case "$3" in
      MainPID) cat /scenario/panel.pid ;;
      FragmentPath) [[ ! -f /etc/systemd/system/chordv-node-agent.service ]] || echo /etc/systemd/system/chordv-node-agent.service ;;
    esac ;;
  is-active) [[ -f /scenario/agent.pid ]] && kill -0 "$(cat /scenario/agent.pid)" 2>/dev/null ;;
  start)
    set -a
    . /etc/chordv/node-agent.env
    set +a
    runuser -u chordv-agent -- /opt/chordv-node-agent/current/chordv-agent >>/scenario/agent.log 2>&1 &
    echo $! >/scenario/agent.pid ;;
  stop)
    if [[ -f /scenario/agent.pid ]]; then
      kill -TERM "$(cat /scenario/agent.pid)" 2>/dev/null || true
      for n in {1..20}; do kill -0 "$(cat /scenario/agent.pid)" 2>/dev/null || break; sleep 0.1; done
      rm -f /scenario/agent.pid
    fi ;;
  enable|daemon-reload) : ;;
  *) exit 1 ;;
esac
SYSTEMCTL
chmod +x /usr/local/bin/systemctl
exec node /fixture/go-onboarding-live.cjs
