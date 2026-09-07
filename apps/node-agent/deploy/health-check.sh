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

node_bin="${CHORDV_AGENT_NODE_BIN:-/usr/bin/node}"
db_path="${AGENT_DATABASE_PATH:-/var/lib/chordv-node-agent/agent.db}"

# The probe opens the service's sqlite database read-only. SQLite still needs
# the WAL sidecars and CREATES them when they are missing, and the service can
# remove them between any check and that open (a stop or restart racing this
# script) — so a root-run probe could leave root-owned -wal/-shm files that the
# unprivileged agent then cannot use. Run the probe as the database's owner
# instead: anything the race creates belongs to the service either way. The
# agent refuses a mismatched uid on its own, so a missing runuser must abort
# rather than silently probe as root.
db_owner=""
for candidate in "$db_path" "$(dirname "$db_path")"; do
  [[ -e "$candidate" ]] || continue
  db_owner=$(stat -c '%U' "$candidate" 2>/dev/null || stat -f '%Su' "$candidate" 2>/dev/null || true)
  [[ -n "$db_owner" && "$db_owner" != UNKNOWN ]] && break
  db_owner=""
done

if [[ "$(id -u)" -eq 0 && -n "$db_owner" && "$db_owner" != root ]]; then
  if ! command -v runuser >/dev/null 2>&1; then
    echo "健康检查中止：缺少 runuser，无法以状态库所属用户 $db_owner 的身份探测" >&2
    exit 1
  fi
  exec runuser -u "$db_owner" -- "$node_bin" dist/src/main.js --health
fi

exec "$node_bin" dist/src/main.js --health
