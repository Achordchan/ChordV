#!/usr/bin/env bash
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "安装失败：请使用 root 运行。" >&2
  exit 1
fi

node_version="$(node --version 2>/dev/null || true)"
if [[ ! "$node_version" =~ ^v20\.19\. ]]; then
  echo "安装失败：Node.js 版本为 ${node_version:-未安装}，要求 20.19.x。" >&2
  exit 1
fi

if ! id chordv-agent >/dev/null 2>&1; then
  useradd --system --home /var/lib/chordv-node-agent --shell /usr/sbin/nologin chordv-agent
fi
install -d -m 0750 -o chordv-agent -g chordv-agent /var/lib/chordv-node-agent
install -m 0644 ./deploy/chordv-node-agent.service /etc/systemd/system/chordv-node-agent.service
systemctl daemon-reload
systemctl enable chordv-node-agent.service

echo "systemd 服务已安装。请确认 /etc/chordv/node-agent.env 后手动启动："
echo "  systemctl start chordv-node-agent"
