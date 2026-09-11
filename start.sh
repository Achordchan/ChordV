#!/usr/bin/env bash

set -Eeuo pipefail

fail() {
  printf '启动失败：%s\n' "$1" >&2
  exit 1
}

if [ "$#" -gt 1 ]; then
  fail "只接受一个可选的后台页面端口，例如 bash ./start.sh 5174"
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$script_dir"

load_env_file() {
  env_file=$1
  [ -f "$env_file" ] || return 0

  line_number=0
  while IFS= read -r line || [ -n "$line" ]; do
    line_number=$((line_number + 1))
    line=${line%$'\r'}

    case "$line" in
      ''|'#'*) continue ;;
      export\ *) line=${line#export } ;;
    esac

    case "$line" in
      *=*) ;;
      *) fail "$env_file 第 $line_number 行不是有效的 KEY=VALUE" ;;
    esac

    key=${line%%=*}
    value=${line#*=}
    if [[ ! "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
      fail "$env_file 第 $line_number 行的变量名无效：$key"
    fi

    if printenv "$key" >/dev/null 2>&1; then
      continue
    fi

    if [ "${#value}" -ge 2 ]; then
      first_char=${value:0:1}
      last_char=${value: -1}
      if { [ "$first_char" = '"' ] && [ "$last_char" = '"' ]; } ||
         { [ "$first_char" = "'" ] && [ "$last_char" = "'" ]; }; then
        value=${value:1:${#value}-2}
      fi
    fi

    export "$key=$value"
  done < "$env_file"
}

load_env_file ".env"

# shellcheck source=scripts/local-runtime-bootstrap.sh
source "$script_dir/scripts/local-runtime-bootstrap.sh"
select_node_runtime

admin_port=${1:-${CHORDV_ADMIN_PORT:-5174}}
api_port=${CHORDV_API_PORT:-3000}
for port in "$admin_port" "$api_port"; do
  case "$port" in
    ''|*[!0-9]*) fail "端口必须是 1..65535 的整数" ;;
  esac
  if [ "$port" -lt 1 ] || [ "$port" -gt 65535 ]; then
    fail "端口必须是 1..65535 的整数"
  fi
done
[ "$api_port" -ne "$admin_port" ] || fail "内部 API 端口与后台页面端口不能相同；浏览器只需访问后台页面端口"

check_port_available() {
  host=$1
  port=$2
  label=$3

  if ! node - "$host" "$port" <<'NODE'
const net = require("node:net");
const host = process.argv[2];
const port = Number(process.argv[3]);
const server = net.createServer();
server.unref();
server.once("error", () => process.exit(1));
server.listen({ host, port, exclusive: true }, () => server.close(() => process.exit(0)));
NODE
  then
    fail "$label 端口 $port 已被占用；脚本不会关闭占用进程"
  fi
}

check_port_available "127.0.0.1" "$api_port" "内部 API"
check_port_available "127.0.0.1" "$admin_port" "后台页面"

export NODE_ENV=development
export CHORDV_API_PORT=$api_port
export CHORDV_API_HOST=127.0.0.1
export CHORDV_ADMIN_PORT=$admin_port
export CHORDV_API_BASE_URL="http://127.0.0.1:$api_port"
export CHORDV_DEV_API_TARGET="$CHORDV_API_BASE_URL"
export CHORDV_ADMIN_BASE_URL="http://127.0.0.1:$admin_port"
export CHORDV_ALLOW_LOCAL_DEV_ORIGINS=true
export VITE_API_BASE_URL=""

ensure_pnpm_and_dependencies
install_local_runtime_cleanup
ensure_prisma_client
# Both the API and development seed import this package's compiled exports.
# Prepare it once here; the API watcher below does not rebuild it a second time.
printf '正在准备后台共享模块。\n'
corepack pnpm --filter @chordv/shared build || fail "后台共享模块准备失败"
prepare_local_database

printf '正在启动后台页面和 API，等待服务就绪…\n'
printf '按 Ctrl+C 停止本次启动的后台服务。\n'
node "$script_dir/scripts/local-backend-dev.mjs"
