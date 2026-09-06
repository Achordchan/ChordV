#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf '构建失败：%s\n' "$1" >&2
  exit 1
}

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/../../.." && pwd)
destination=${1:-/opt/chordv-node-agent.release}

case "$destination" in
  /*) ;;
  *) fail "发布目录必须是绝对路径" ;;
esac

destination=$(realpath -m "$destination")
case "$destination" in
  /|/opt|/usr|/var|/home|"$repo_root"|"$repo_root"/*)
    fail "发布目录不安全：$destination"
    ;;
esac
case "$(basename "$destination")" in
  chordv-node-agent*) ;;
  *) fail "发布目录名称必须以 chordv-node-agent 开头" ;;
esac

node_version=$(node --version 2>/dev/null || true)
[[ "$node_version" =~ ^v20\.19\. ]] || fail "Node.js 版本为 ${node_version:-未安装}，要求 20.19.x"

running_dir=/opt/chordv-node-agent
if systemctl is-active --quiet chordv-node-agent 2>/dev/null && [[ -d "$running_dir/node_modules" ]]; then
  shared_native=$(find "$running_dir/node_modules" -type f -name '*.node' -links +1 -print -quit)
  [[ -z "$shared_native" ]] || fail "运行中的 Agent 仍使用 pnpm 硬链接原生模块，请先迁移到独立副本后再构建"
fi

cd "$repo_root"
corepack pnpm install --frozen-lockfile --filter @chordv/node-agent...
corepack pnpm --filter @chordv/node-agent test
corepack pnpm --filter @chordv/node-agent check
corepack pnpm --filter @chordv/node-agent build

rm -rf -- "$destination"
corepack pnpm --config.package-import-method=copy --filter @chordv/node-agent deploy --prod "$destination"
cp -a apps/node-agent/dist "$destination/"
cp -a apps/node-agent/deploy "$destination/"

test -f "$destination/dist/src/main.js" || fail "发布产物缺少 dist/src/main.js"
shared_native=$(find "$destination/node_modules" -type f -name '*.node' -links +1 -print -quit)
[[ -z "$shared_native" ]] || fail "发布产物仍包含硬链接原生模块：$shared_native"

printf '发布产物已生成：%s\n' "$destination"
