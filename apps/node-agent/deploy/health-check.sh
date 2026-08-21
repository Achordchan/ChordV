#!/usr/bin/env bash
set -euo pipefail

cd /opt/chordv-node-agent
set -a
source /etc/chordv/node-agent.env
set +a
exec /usr/bin/node dist/src/main.js --health
