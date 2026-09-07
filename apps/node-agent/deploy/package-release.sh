#!/usr/bin/env bash
set -euo pipefail

# Package a built agent release directory (from build-release.sh) into the
# architecture-tagged tarball served by /api/agent-download/:arch. Run AFTER
# build-release.sh, on a machine of the TARGET architecture (better-sqlite3
# native modules are arch-specific):
#
#   x86_64 VPS:  ./package-release.sh /opt/chordv-node-agent.release linux-x64
#   arm64 VPS:   ./package-release.sh /opt/chordv-node-agent.release linux-arm64
#
# Drop the resulting tarball into the api container's agent-dist directory
# (./api-agent-dist in the 1Panel compose, or CHORDV_AGENT_DIST_DIR).

fail() {
  printf '打包失败：%s\n' "$1" >&2
  exit 1
}

source_dir=${1:?用法：package-release.sh <构建产物目录> <linux-x64|linux-arm64> [输出目录]}
arch=${2:?用法：package-release.sh <构建产物目录> <linux-x64|linux-arm64> [输出目录]}
out_dir=${3:-$(pwd)}

case "$arch" in
  linux-x64) [[ "$(uname -m)" == "x86_64" ]] || fail "当前架构 $(uname -m) 与目标 $arch 不符（原生模块与架构绑定，请在目标架构机器上构建）" ;;
  linux-arm64) [[ "$(uname -m)" == "aarch64" || "$(uname -m)" == "arm64" ]] || fail "当前架构 $(uname -m) 与目标 $arch 不符（原生模块与架构绑定，请在目标架构机器上构建）" ;;
  *) fail "不支持的架构标识：$arch" ;;
esac

[[ -f "$source_dir/dist/src/main.js" ]] || fail "构建产物缺少 dist/src/main.js：请先运行 build-release.sh"

mkdir -p -- "$out_dir"
tarball="$out_dir/chordv-agent-$arch.tar.gz"

# -C "$source_dir" . ：tarball 顶层即 dist/ node_modules/ deploy/，
# 与 install 脚本的 tar -xz -C /opt/chordv-node-agent 相对应。
tar -czf "$tarball" -C "$source_dir" .

printf '安装包已生成：%s（%s）\n' "$tarball" "$(du -h "$tarball" | cut -f1)"
