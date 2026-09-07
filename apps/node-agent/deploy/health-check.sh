#!/usr/bin/env bash
set -euo pipefail

env_file=/etc/chordv/node-agent.env
runtime_dir=/opt/chordv-node-agent
if [[ -L "$runtime_dir/current" ]]; then runtime_dir="$runtime_dir/current"; fi
cd "$runtime_dir"

# This file is sourced as shell code and this check is normally run as root, so
# only a root-owned regular file may be loaded. The installer keeps it
# root:chordv-agent 0640; a service-writable env file would let a compromised
# agent execute arbitrary commands as the operator running the health check.
if [[ -L "$env_file" || ! -f "$env_file" ]]; then
  echo "健康检查中止：$env_file 不是普通文件" >&2
  exit 1
fi
owner=$(stat -c '%u' "$env_file" 2>/dev/null || stat -f '%u' "$env_file")
writable=$(stat -c '%a' "$env_file" 2>/dev/null || stat -f '%Lp' "$env_file")
if [[ "$owner" != 0 || $((8#$writable & 8#022)) -ne 0 ]]; then
  echo "健康检查中止：$env_file 必须由 root 所有且不可被组/其他用户写入（当前 owner=$owner mode=$writable）" >&2
  exit 1
fi

set -a
source "$env_file"
set +a
exec "${CHORDV_AGENT_NODE_BIN:-/usr/bin/node}" dist/src/main.js --health
