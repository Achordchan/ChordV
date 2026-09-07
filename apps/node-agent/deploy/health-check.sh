#!/usr/bin/env bash
set -euo pipefail

runtime_dir=/opt/chordv-node-agent
if [[ -L "$runtime_dir/current" ]]; then runtime_dir="$runtime_dir/current"; fi
cd "$runtime_dir"
set -a
source /etc/chordv/node-agent.env
set +a
exec "${CHORDV_AGENT_NODE_BIN:-/usr/bin/node}" dist/src/main.js --health
