#!/usr/bin/env bash
set -euo pipefail

DEPLOY_HOST="${DEPLOY_HOST:-111.228.1.199}"
DEPLOY_USER="${DEPLOY_USER:-root}"
DEPLOY_PATH="${DEPLOY_PATH:-/www/wwwroot/v.baymaxgroup.com}"
DEPLOY_ADMIN_PATH="${DEPLOY_ADMIN_PATH:-/www/v.baymaxgroup.com}"
DEPLOY_PROJECT="${DEPLOY_PROJECT:-chordv_api}"
DEPLOY_NODE_VERSION="${DEPLOY_NODE_VERSION:-v20.19.0}"
DEPLOY_DOMAIN="${DEPLOY_DOMAIN:-v.baymaxgroup.com}"
DEPLOY_PORT="${DEPLOY_PORT:-3001}"
DEPLOY_HEALTH_PATH="${DEPLOY_HEALTH_PATH:-/api/client/version}"
SSH_OPTS="${SSH_OPTS:-}"

if [ -x /usr/local/bin/node ]; then
  export PATH="/usr/local/bin:${PATH}"
fi

REMOTE="${DEPLOY_USER}@${DEPLOY_HOST}"
STAGE_DIR="_deploy/baota"
API_STAGE="${STAGE_DIR}/api"
ADMIN_STAGE="${STAGE_DIR}/admin"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "缺少命令：$1"
    exit 1
  fi
}

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
  DEPLOY_PROJECT="${DEPLOY_PROJECT}" \
  DEPLOY_NODE_VERSION="${DEPLOY_NODE_VERSION}" \
  DEPLOY_DOMAIN="${DEPLOY_DOMAIN}" \
  DEPLOY_HOST="${DEPLOY_HOST}" \
  DEPLOY_PORT="${DEPLOY_PORT}" \
  DEPLOY_HEALTH_PATH="${DEPLOY_HEALTH_PATH}" \
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
print(json.dumps(model.start_project(project), ensure_ascii=False))
PY

for _ in $(seq 1 30); do
  if curl -fsS -H "X-Forwarded-Proto: https" "http://127.0.0.1:${DEPLOY_PORT}${DEPLOY_HEALTH_PATH}" >/dev/null; then
    break
  fi
  sleep 1
done

curl -fsS -H "X-Forwarded-Proto: https" "http://127.0.0.1:${DEPLOY_PORT}${DEPLOY_HEALTH_PATH}" >/dev/null
curl -k -fsS --resolve "${DEPLOY_DOMAIN}:443:${DEPLOY_HOST}" "https://${DEPLOY_DOMAIN}${DEPLOY_HEALTH_PATH}" >/dev/null
REMOTE_SCRIPT

echo "部署完成。"
