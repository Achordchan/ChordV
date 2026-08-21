#!/usr/bin/env bash

set -Eeuo pipefail

fail() {
  printf '启动失败：%s\n' "$1" >&2
  exit 1
}

if [ "$#" -gt 1 ]; then
  fail "只接受一个可选的 API 端口参数，例如 ./start.sh 3100"
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
select_compatible_node

api_port=${1:-${CHORDV_API_PORT:-3000}}
case "$api_port" in
  ''|*[!0-9]*) fail "API 端口必须是 1..65535 的整数" ;;
esac
if [ "$api_port" -lt 1 ] || [ "$api_port" -gt 65535 ]; then
  fail "API 端口必须是 1..65535 的整数"
fi

desktop_port=5173
admin_port=5174
if [ "$api_port" -eq "$desktop_port" ] || [ "$api_port" -eq "$admin_port" ]; then
  fail "API 端口不能与桌面客户端端口 $desktop_port 或运营后台端口 $admin_port 相同"
fi

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

check_port_available "127.0.0.1" "$api_port" "API"
check_port_available "localhost" "$desktop_port" "桌面客户端"
check_port_available "127.0.0.1" "$admin_port" "运营后台"

export NODE_ENV=${NODE_ENV:-development}
export CHORDV_API_PORT=$api_port
export CHORDV_API_HOST=${CHORDV_API_HOST:-127.0.0.1}
export CHORDV_API_BASE_URL="http://127.0.0.1:$api_port"
export VITE_API_BASE_URL=$CHORDV_API_BASE_URL

ensure_pnpm_and_dependencies
install_local_runtime_cleanup
prepare_local_database

printf 'API 地址：http://127.0.0.1:%s/api\n' "$api_port"
printf '运营后台：http://127.0.0.1:%s\n' "$admin_port"
printf '正在启动 Tauri 桌面客户端（开发页面端口：%s）。\n' "$desktop_port"
printf '日志将直接显示在当前终端；按 Ctrl+C 同时停止运营后台、桌面客户端、API 和项目本地 PostgreSQL。\n'

if [ "${CHORDV_LOCAL_AGENT_ENABLED:-false}" = "true" ]; then
  printf '已启用隔离的本地 Node Agent / Xray 测试链路。\n'
  corepack pnpm dev:local:agent
else
  corepack pnpm dev:local
fi
