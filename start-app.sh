#!/usr/bin/env bash
# Build and run only the native desktop preview; never manage backend processes.
set -Eeuo pipefail

fail() { printf '客户端启动失败：%s\n' "$1" >&2; exit 1; }
usage() {
  cat <<'HELP'
用法：bash ./start-app.sh [--check | --build-only]
  默认           构建当前目录中的客户端，并在前台启动原生预览窗口
  --check        只检查本机工具链和项目依赖
  --build-only   只构建本机调试程序，不启动窗口
  --help         显示帮助
macOS 使用终端；Windows 使用 Git Bash 和 Windows 原生 Node/Rust MSVC。
后台仍通过 start.sh 单独运行。关闭客户端请退出托盘菜单或按 Ctrl+C。
需要联调本地后台时，显式设置 VITE_API_BASE_URL=http://127.0.0.1:3000。
HELP
}
[ "$#" -le 1 ] || fail '参数过多，请使用 --help 查看用法。'
mode=${1:-run}
case "$mode" in
  --help|-h) usage; exit 0 ;;
  run|--check|--build-only) ;;
  *) fail "不支持的参数：$mode" ;;
esac

app_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
desktop_root="$app_root/apps/desktop"
cd "$app_root"
case "$(uname -s)" in
  Darwin) platform=macos ;;
  MINGW*|MSYS*) platform=windows ;;
  *) fail '仅支持 macOS 和 Windows Git Bash；WSL 不能构建 Windows 原生预览。' ;;
esac
command -v node >/dev/null 2>&1 || fail '缺少 Node.js，请先安装 Node.js 和项目依赖。'
node_platform=$(node -p 'process.platform')
if [ "$platform" = windows ]; then
  [ "$node_platform" = win32 ] || fail '请在 Git Bash 中使用 Windows 原生 Node.js。'
else
  [ "$node_platform" = darwin ] || fail '请使用 macOS 原生 Node.js。'
fi
# Respect the active toolchain; only add rustup's standard location if necessary.
if ! command -v cargo >/dev/null 2>&1 && [ -d "${CARGO_HOME:-$HOME/.cargo}/bin" ]; then
  export PATH="${CARGO_HOME:-$HOME/.cargo}/bin:$PATH"
fi
command -v cargo >/dev/null 2>&1 || fail '缺少 Rust/Cargo。请安装 rustup；macOS 还需 Xcode Command Line Tools，Windows 还需 Visual Studio C++ Build Tools 和 WebView2。'
command -v rustc >/dev/null 2>&1 || fail '缺少 rustc，请使用 rustup 安装本机 stable 工具链。'
rust_host=$(rustc -vV | sed -n 's/^host: //p' | tr -d '\r')
case "$platform:$rust_host" in
  macos:*-apple-darwin|windows:*-pc-windows-msvc) ;;
  *) fail "Rust 工具链与本机不匹配：${rust_host}；Windows 必须使用 MSVC。" ;;
esac
if [ "$platform" = macos ]; then
  xcode-select -p >/dev/null 2>&1 || fail '缺少 Xcode Command Line Tools，请执行 xcode-select --install。'
fi
if command -v pnpm >/dev/null 2>&1; then
  package_runner=(pnpm)
elif command -v corepack >/dev/null 2>&1; then
  package_runner=(corepack pnpm)
else
  fail '缺少 pnpm/Corepack，请按 README 安装项目要求的 pnpm。'
fi
[ -f "$desktop_root/node_modules/@tauri-apps/cli/tauri.js" ] || fail '缺少桌面依赖，请在项目根目录执行 pnpm install --frozen-lockfile。'
[ -d "$desktop_root/node_modules/typescript" ] && [ -d "$desktop_root/node_modules/vite" ] || fail '桌面前端依赖不完整，请执行 pnpm install --frozen-lockfile。'
version=$(node - "$desktop_root/config/platform-versions.json" "$platform" <<'NODE'
const fs = require('node:fs');
const value = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))[process.argv[3]];
if (typeof value !== 'string' || !value) throw new Error('缺少本平台客户端版本');
process.stdout.write(value);
NODE
)
printf '客户端源码：%s\n平台：%s（%s） · 版本：%s\n' "$desktop_root" "$platform" "$rust_host" "$version"
if [ "$mode" = --check ]; then
  printf '基础工具链检查通过；原生 SDK 和链接器完整性将在构建时验证。\n'
  exit 0
fi

# One foreground session per checkout prevents rebuilding a running Windows exe.
preview_root="$app_root/.data/local-app"
mkdir -p "$preview_root"
lock_dir="$preview_root/session.lock"
mkdir "$lock_dir" 2>/dev/null || fail "已有客户端构建/预览会话。请先退出；若上次终端被强制结束，确认无预览进程后再删除 ${lock_dir}。"
cleanup() { rmdir "$lock_dir" 2>/dev/null || true; }
trap cleanup EXIT
app_pid=''
stop_app() {
  # Only the direct native preview belongs to this launcher. Never kill by name
  # or port: backend services may be running in a different terminal.
  if [ -n "$app_pid" ]; then
    kill -TERM "$app_pid" 2>/dev/null || true
    wait "$app_pid" 2>/dev/null || true
  fi
  exit "$1"
}
trap 'stop_app 130' INT
trap 'stop_app 143' TERM HUP
export CARGO_TARGET_DIR="$preview_root/target"
export VITE_APP_VERSION="$version"
# Only this isolated native preview includes local download simulation controls.
export VITE_CHORDV_LOCAL_PREVIEW=1
# Native requests use a separate variable; a frontend-only override must not
# silently leave the running preview connected to production.
if [ "${CHORDV_API_BASE_URL+x}" != x ] && [ -n "${VITE_API_BASE_URL:-}" ]; then
  export CHORDV_API_BASE_URL="$VITE_API_BASE_URL"
fi

# Frontend compilation reuses the existing package script. The native build
# override skips only its duplicate beforeBuildCommand and release packaging.
printf '正在构建客户端前端…\n'
"${package_runner[@]}" --dir "$desktop_root" run build
config=$(node - "$version" <<'NODE'
process.stdout.write(JSON.stringify({
  version: process.argv[2],
  mainBinaryName: 'ChordV-Preview',
  identifier: 'app.chordv.desktop.preview',
  build: { beforeBuildCommand: '' }
}));
NODE
)
printf '正在构建本机原生预览（首次 Rust 编译耗时较长，后续复用缓存）…\n'
(cd "$desktop_root" && node ./node_modules/@tauri-apps/cli/tauri.js build --debug --no-bundle --target "$rust_host" --config "$config")
executable="$CARGO_TARGET_DIR/$rust_host/debug/ChordV-Preview"
[ "$platform" != windows ] || executable="$executable.exe"
[ -f "$executable" ] || fail "构建结束但未找到预览程序：$executable"
printf '预览程序：%s\n' "$executable"
[ "$mode" != --build-only ] || exit 0
printf '正在启动客户端；日志显示在本终端。退出托盘菜单或按 Ctrl+C 结束。\n'
"$executable" &
app_pid=$!
wait "$app_pid"
