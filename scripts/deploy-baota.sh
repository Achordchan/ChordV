#!/usr/bin/env bash
set -euo pipefail

DEPLOY_HOST="${DEPLOY_HOST:-}"
DEPLOY_USER="${DEPLOY_USER:-}"
DEPLOY_PATH="${DEPLOY_PATH:-}"
DEPLOY_ADMIN_PATH="${DEPLOY_ADMIN_PATH:-}"
DEPLOY_PROJECT="${DEPLOY_PROJECT:-chordv_api}"
DEPLOY_NODE_VERSION="${DEPLOY_NODE_VERSION:-v20.19.0}"
DEPLOY_DOMAIN="${DEPLOY_DOMAIN:-v.baymaxgroup.com}"
DEPLOY_PORT="${DEPLOY_PORT:-3001}"
DEPLOY_HEALTH_PATH="${DEPLOY_HEALTH_PATH:-/api/client/version}"
DEPLOY_XUI_TIMEOUT_MS="${DEPLOY_XUI_TIMEOUT_MS:-30000}"
DEPLOY_ALLOW_ROOT="${DEPLOY_ALLOW_ROOT:-false}"
DEPLOY_RUN_DB_PUSH="${DEPLOY_RUN_DB_PUSH:-false}"
SSH_OPTS="${SSH_OPTS:-}"

if [ -x /usr/local/bin/node ]; then
  export PATH="/usr/local/bin:${PATH}"
fi

STAGE_DIR="_deploy/baota"
API_STAGE="${STAGE_DIR}/api"
ADMIN_STAGE="${STAGE_DIR}/admin"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "缺少命令：$1"
    exit 1
  fi
}

require_env() {
  local name="$1"
  local value="${!name:-}"
  if [ -z "${value}" ]; then
    echo "Missing required deploy environment variable: ${name}"
    exit 1
  fi
}

assert_safe_deploy_path() {
  local name="$1"
  local value="$2"
  case "${value}" in
    ""|"/"|"/www"|"/www/"|"/www/wwwroot"|"/www/wwwroot/")
      echo "Refusing dangerous ${name}: ${value}"
      exit 1
      ;;
    /*)
      ;;
    *)
      echo "${name} must be an absolute path: ${value}"
      exit 1
      ;;
  esac
}

require_env DEPLOY_HOST
require_env DEPLOY_USER
require_env DEPLOY_PATH
require_env DEPLOY_ADMIN_PATH

if [ "${DEPLOY_USER}" = "root" ] && [ "${DEPLOY_ALLOW_ROOT}" != "true" ]; then
  echo "Refusing root deploy user unless DEPLOY_ALLOW_ROOT=true is set explicitly."
  exit 1
fi

assert_safe_deploy_path DEPLOY_PATH "${DEPLOY_PATH}"
assert_safe_deploy_path DEPLOY_ADMIN_PATH "${DEPLOY_ADMIN_PATH}"

REMOTE="${DEPLOY_USER}@${DEPLOY_HOST}"
DEPLOY_STAGE_PATH="${DEPLOY_PATH}.stage-$(date +%Y%m%d%H%M%S)"

require_command pnpm
require_command rsync
require_command ssh

echo "构建后端与后台..."
pnpm --filter @chordv/shared build
pnpm --filter @chordv/api db:generate
pnpm --filter @chordv/api build
pnpm --filter @chordv/admin build

rm -rf "${STAGE_DIR}"
mkdir -p "${API_STAGE}/apps/api" "${API_STAGE}/packages/shared" "${ADMIN_STAGE}"

rsync -a \
  package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json turbo.json \
  "${API_STAGE}/"

rsync -a \
  --exclude "node_modules/" \
  --exclude ".env" \
  --exclude ".env.*" \
  --exclude ".DS_Store" \
  --exclude "._*" \
  --exclude "prisma/dev.db" \
  apps/api/ "${API_STAGE}/apps/api/"

rsync -a \
  --exclude "node_modules/" \
  --exclude ".DS_Store" \
  --exclude "._*" \
  packages/shared/ "${API_STAGE}/packages/shared/"

rsync -a --delete apps/admin/dist/ "${ADMIN_STAGE}/"

echo "Preparing remote API stage: ${DEPLOY_STAGE_PATH}"
ssh ${SSH_OPTS} "${REMOTE}" \
  DEPLOY_PATH="${DEPLOY_PATH}" \
  DEPLOY_STAGE_PATH="${DEPLOY_STAGE_PATH}" \
  'bash -s' <<'REMOTE_STAGE_PREP'
set -euo pipefail

rm -rf "${DEPLOY_STAGE_PATH}"
mkdir -p "${DEPLOY_STAGE_PATH}"
for env_file in ".env" ".env.local" "apps/api/.env" "apps/api/.env.local"; do
  if [ -f "${DEPLOY_PATH}/${env_file}" ]; then
    mkdir -p "$(dirname "${DEPLOY_STAGE_PATH}/${env_file}")"
    cp "${DEPLOY_PATH}/${env_file}" "${DEPLOY_STAGE_PATH}/${env_file}"
  fi
done
REMOTE_STAGE_PREP

echo "Syncing API stage to remote preflight directory..."
rsync -az --delete \
  --omit-dir-times \
  --no-perms \
  --no-owner \
  --no-group \
  -e "ssh ${SSH_OPTS}" \
  --exclude ".env" \
  --exclude ".env.*" \
  --exclude ".well-known/" \
  --exclude "node_modules/" \
  --exclude "data/" \
  --exclude "storage/" \
  --exclude "uploads/" \
  --exclude "logs/" \
  --exclude "*.log" \
  --exclude "*.db" \
  "${API_STAGE}/" "${REMOTE}:${DEPLOY_STAGE_PATH}/"

ssh ${SSH_OPTS} "${REMOTE}" \
  DEPLOY_PATH="${DEPLOY_PATH}" \
  DEPLOY_STAGE_PATH="${DEPLOY_STAGE_PATH}" \
  DEPLOY_NODE_VERSION="${DEPLOY_NODE_VERSION}" \
  DEPLOY_RUN_DB_PUSH="${DEPLOY_RUN_DB_PUSH}" \
  'bash -s' <<'REMOTE_STAGE_SCHEMA'
set -euo pipefail

NODE_BIN="/www/server/nodejs/${DEPLOY_NODE_VERSION}/bin/node"
COREPACK_CLI="/www/server/nodejs/${DEPLOY_NODE_VERSION}/bin/corepack"
PNPM_VERSION="9.15.3"
NODE_DIR="$(dirname "${NODE_BIN}")"
export PATH="${NODE_DIR}:${PATH}"

cd "${DEPLOY_STAGE_PATH}"

if [ ! -x "${NODE_BIN}" ]; then
  echo "Baota Node not found: ${NODE_BIN}"
  exit 1
fi

if [ ! -f "${COREPACK_CLI}" ]; then
  echo "Baota corepack not found: ${COREPACK_CLI}"
  exit 1
fi

COREPACK_ENABLE_DOWNLOAD_PROMPT=0 "${NODE_BIN}" "${COREPACK_CLI}" "pnpm@${PNPM_VERSION}" install --frozen-lockfile
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 "${NODE_BIN}" "${COREPACK_CLI}" "pnpm@${PNPM_VERSION}" --filter @chordv/api db:generate

LIVE_SCHEMA="${DEPLOY_PATH}/apps/api/prisma/schema.prisma"
STAGE_SCHEMA="${DEPLOY_STAGE_PATH}/apps/api/prisma/schema.prisma"
if [ -f "${LIVE_SCHEMA}" ] && [ -f "${STAGE_SCHEMA}" ] && ! cmp -s "${LIVE_SCHEMA}" "${STAGE_SCHEMA}"; then
  if [ "${DEPLOY_RUN_DB_PUSH}" != "true" ]; then
    echo "Prisma schema changed, but DEPLOY_RUN_DB_PUSH is not true. Refusing to sync incompatible API code before an explicit database update."
    exit 1
  fi
  echo "Prisma schema changed and DEPLOY_RUN_DB_PUSH=true; database push will run after live code sync and before restart."
fi
REMOTE_STAGE_SCHEMA

echo "同步 API 到宝塔项目：${DEPLOY_PROJECT}"
rsync -az --delete \
  --omit-dir-times \
  --no-perms \
  --no-owner \
  --no-group \
  -e "ssh ${SSH_OPTS}" \
  --exclude ".env" \
  --exclude ".env.*" \
  --exclude ".well-known/" \
  --exclude "node_modules/" \
  --exclude "start.sh" \
  --exclude "data/" \
  --exclude "storage/" \
  --exclude "uploads/" \
  --exclude "logs/" \
  --exclude "*.log" \
  --exclude "*.db" \
  "${API_STAGE}/" "${REMOTE}:${DEPLOY_PATH}/"

echo "同步后台静态文件..."
rsync -az --delete \
  --omit-dir-times \
  --no-perms \
  --no-owner \
  --no-group \
  -e "ssh ${SSH_OPTS}" \
  --exclude ".well-known/" \
  "${ADMIN_STAGE}/" "${REMOTE}:${DEPLOY_ADMIN_PATH}/"

ssh ${SSH_OPTS} "${REMOTE}" \
  DEPLOY_PATH="${DEPLOY_PATH}" \
  DEPLOY_ADMIN_PATH="${DEPLOY_ADMIN_PATH}" \
  DEPLOY_STAGE_PATH="${DEPLOY_STAGE_PATH}" \
  DEPLOY_PROJECT="${DEPLOY_PROJECT}" \
  DEPLOY_NODE_VERSION="${DEPLOY_NODE_VERSION}" \
  DEPLOY_DOMAIN="${DEPLOY_DOMAIN}" \
DEPLOY_HOST="${DEPLOY_HOST}" \
DEPLOY_PORT="${DEPLOY_PORT}" \
DEPLOY_XUI_TIMEOUT_MS="${DEPLOY_XUI_TIMEOUT_MS}" \
DEPLOY_HEALTH_PATH="${DEPLOY_HEALTH_PATH}" \
DEPLOY_RUN_DB_PUSH="${DEPLOY_RUN_DB_PUSH}" \
  'bash -s' <<'REMOTE_SCRIPT'
set -euo pipefail

NODE_BIN="/www/server/nodejs/${DEPLOY_NODE_VERSION}/bin/node"
COREPACK_CLI="/www/server/nodejs/${DEPLOY_NODE_VERSION}/bin/corepack"
PANEL_PY="/www/server/panel/pyenv/bin/python"
PNPM_VERSION="9.15.3"
NODE_DIR="$(dirname "${NODE_BIN}")"
export PATH="${NODE_DIR}:${PATH}"

cd "${DEPLOY_PATH}"

if [ ! -f "start.sh" ]; then
  echo "服务器 start.sh 不存在，停止部署。"
  exit 1
fi

normalize_start_script() {
python3 - <<'PY'
from pathlib import Path
import os

path = Path("start.sh")
text = path.read_text(encoding="utf-8")
lines = text.splitlines()

def upsert_export(name, value, insert_after_prefix=None):
  target = f"export {name}={value}"
  found = False
  next_lines = []
  for index, line in enumerate(lines):
    if line.startswith(f"export {name}="):
      if not found:
        next_lines.append(target)
        found = True
      continue
    next_lines.append(line)
  if found:
    lines[:] = next_lines
    return
  insert_at = None
  if insert_after_prefix:
    for index, line in enumerate(lines):
      if line.startswith(insert_after_prefix):
        insert_at = index + 1
        break
  if insert_at is None:
    lines.append(target)
  else:
    lines.insert(insert_at, target)

upsert_export("NODE_ENV", "production")
upsert_export("CHORDV_API_PORT", os.environ["DEPLOY_PORT"])
upsert_export("CHORDV_API_BASE_URL", f"http://localhost:{os.environ['DEPLOY_PORT']}")
upsert_export(
  "CHORDV_XUI_TIMEOUT_MS",
  os.environ["DEPLOY_XUI_TIMEOUT_MS"],
  "export CHORDV_PANEL_DEFAULT_TIMEOUT_MS="
)
path.write_text("\n".join(lines) + "\n", encoding="utf-8")
PY
}

normalize_start_script

if [ ! -x "${NODE_BIN}" ]; then
  echo "宝塔 Node 不存在：${NODE_BIN}"
  exit 1
fi

if [ ! -f "${COREPACK_CLI}" ]; then
  echo "宝塔 corepack 不存在：${COREPACK_CLI}"
  exit 1
fi

COREPACK_ENABLE_DOWNLOAD_PROMPT=0 "${NODE_BIN}" "${COREPACK_CLI}" "pnpm@${PNPM_VERSION}" install --frozen-lockfile
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 "${NODE_BIN}" "${COREPACK_CLI}" "pnpm@${PNPM_VERSION}" --filter @chordv/api db:generate
if [ "${DEPLOY_RUN_DB_PUSH}" = "true" ]; then
  echo "Running explicit production prisma db push after live code sync and before restart."
  COREPACK_ENABLE_DOWNLOAD_PROMPT=0 "${NODE_BIN}" "${COREPACK_CLI}" "pnpm@${PNPM_VERSION}" --filter @chordv/api db:push
else
  echo "Skipping prisma db push. Set DEPLOY_RUN_DB_PUSH=true only for an explicitly approved schema update."
fi

find "${DEPLOY_PATH}" "${DEPLOY_ADMIN_PATH}" \( -name ".DS_Store" -o -name "._*" \) -type f -print0 | xargs -0 -r rm -f

"${PANEL_PY}" - <<'PY'
import json
import os
import sys

sys.path.insert(0, "/www/server/panel/class")
import public
from projectModel.nodejsModel import main

project = public.dict_obj()
project.project_name = os.environ["DEPLOY_PROJECT"]
model = main()
print(json.dumps(model.stop_project(project), ensure_ascii=False))
PY

python3 - <<'PY'
import os
import signal
import time

deploy_path = os.path.realpath(os.environ["DEPLOY_PATH"])
target = b"apps/api/dist/apps/api/src/main.js"
matched = []

for pid_name in os.listdir("/proc"):
  if not pid_name.isdigit():
    continue
  pid = int(pid_name)
  try:
    with open(f"/proc/{pid}/cmdline", "rb") as handle:
      cmdline = handle.read()
    cwd = os.path.realpath(os.readlink(f"/proc/{pid}/cwd"))
  except OSError:
    continue
  if cwd == deploy_path and target in cmdline:
    matched.append(pid)

for pid in matched:
  try:
    os.kill(pid, signal.SIGTERM)
  except ProcessLookupError:
    pass

deadline = time.time() + 5
while matched and time.time() < deadline:
  alive = []
  for pid in matched:
    try:
      os.kill(pid, 0)
      alive.append(pid)
    except ProcessLookupError:
      pass
  matched = alive
  if matched:
    time.sleep(0.2)

for pid in matched:
  try:
    os.kill(pid, signal.SIGKILL)
  except ProcessLookupError:
    pass
PY

"${PANEL_PY}" - <<'PY'
import json
import os
import sys

sys.path.insert(0, "/www/server/panel/class")
import public
from projectModel.nodejsModel import main

project = public.dict_obj()
project.project_name = os.environ["DEPLOY_PROJECT"]
model = main()
print(json.dumps(model.start_project(project), ensure_ascii=False))
PY

normalize_start_script

for _ in $(seq 1 30); do
  if curl -fsS -H "X-Forwarded-Proto: https" "http://127.0.0.1:${DEPLOY_PORT}${DEPLOY_HEALTH_PATH}" >/dev/null; then
    break
  fi
  sleep 1
done

curl -fsS -H "X-Forwarded-Proto: https" "http://127.0.0.1:${DEPLOY_PORT}${DEPLOY_HEALTH_PATH}" >/dev/null
curl -k -fsS --resolve "${DEPLOY_DOMAIN}:443:${DEPLOY_HOST}" "https://${DEPLOY_DOMAIN}${DEPLOY_HEALTH_PATH}" >/dev/null
rm -rf "${DEPLOY_STAGE_PATH}"
REMOTE_SCRIPT

echo "部署完成。"
