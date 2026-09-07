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

# 先写同目录临时文件再原子 rename：输出目录可能就是 agent-dist 分发目录，
# 而 AgentDownloadController 可能正在流式读取同名文件——原地覆盖会截断它
# 已打开的文件（fd 不保护原地写入），并让失败的打包留下不完整的公开产物。
# 同目录保证 rename 在同一文件系统内；正在下载的旧文件由其 fd 继续读完。
tmp_tarball=$(mktemp -- "$tarball.tmp.XXXXXX") || fail "无法在输出目录创建临时文件：$out_dir"
trap 'rm -f -- "$tmp_tarball"' EXIT

# -C "$source_dir" . ：tarball 顶层即 dist/ node_modules/ deploy/，
# 与 install 脚本的 tar -xz -C /opt/chordv-node-agent 相对应。
tar -czf "$tmp_tarball" -C "$source_dir" .
# 校验自己刚写出的归档，损坏的产物不得发布。
tar -tzf "$tmp_tarball" >/dev/null || fail "生成的安装包无法读取，未发布"
chmod 0644 "$tmp_tarball"
mv -f -- "$tmp_tarball" "$tarball"
trap - EXIT

printf '安装包已生成：%s（%s）\n' "$tarball" "$(du -h "$tarball" | cut -f1)"
