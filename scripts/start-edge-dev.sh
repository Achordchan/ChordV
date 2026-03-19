#!/usr/bin/env bash
set -euo pipefail

for port in 3011 8443 11085; do
  pids="$(lsof -ti tcp:${port} 2>/dev/null || true)"
  if [[ -n "${pids}" ]]; then
    echo "[edge-dev] 清理占用端口 ${port} 的进程: ${pids}"
    kill -9 ${pids} >/dev/null 2>&1 || true
  fi
done

pnpm --filter @chordv/edge-gateway dev
