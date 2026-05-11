#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE="${GIT_REMOTE:-origin}"

cd "${ROOT_DIR}"

read_json_field() {
  local file="$1"
  local field="$2"

  node -e '
    const fs = require("node:fs");
    const file = process.argv[1];
    const field = process.argv[2];
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    const value = field.split(".").reduce((current, key) => current?.[key], data);
    if (typeof value !== "string" || value.trim() === "") {
      console.error(`无法读取 ${file} 的 ${field}`);
      process.exit(1);
    }
    process.stdout.write(value.trim());
  ' "${file}" "${field}"
}

fail() {
  echo "发版检查失败：$*" >&2
  exit 1
}

version="$(read_json_field package.json version)"
desktop_version="$(read_json_field apps/desktop/package.json version)"
tauri_version="$(read_json_field apps/desktop/src-tauri/tauri.conf.json version)"
platform_macos_version="$(read_json_field apps/desktop/config/platform-versions.json macos)"
platform_windows_version="$(read_json_field apps/desktop/config/platform-versions.json windows)"
tag="v${version}"

if ! [[ "${version}" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z.-]+)?$ ]]; then
  fail "根 package.json 的版本号不是合法语义化版本：${version}"
fi

if [ "${desktop_version}" != "${version}" ]; then
  fail "apps/desktop/package.json 的版本 ${desktop_version} 与根版本 ${version} 不一致"
fi

if [ "${tauri_version}" != "${version}" ]; then
  fail "apps/desktop/src-tauri/tauri.conf.json 的版本 ${tauri_version} 与根版本 ${version} 不一致"
fi

if [ "${platform_macos_version}" != "${version}" ]; then
  fail "apps/desktop/config/platform-versions.json 的 macos 版本 ${platform_macos_version} 与根版本 ${version} 不一致"
fi

if [ "${platform_windows_version}" != "${version}" ]; then
  fail "apps/desktop/config/platform-versions.json 的 windows 版本 ${platform_windows_version} 与根版本 ${version} 不一致"
fi

if [ -n "$(git status --porcelain=v1 --untracked-files=all)" ]; then
  fail "工作树不干净，请先提交或清理当前改动"
fi

if git rev-parse -q --verify "refs/tags/${tag}" >/dev/null; then
  fail "本地已存在 tag：${tag}"
fi

if git ls-remote --exit-code --tags "${REMOTE}" "refs/tags/${tag}" >/dev/null 2>&1; then
  fail "远端 ${REMOTE} 已存在 tag：${tag}"
fi

if ! git ls-remote "${REMOTE}" >/dev/null 2>&1; then
  fail "无法访问远端 ${REMOTE}，请先确认 origin 可连接"
fi

echo "版本检查通过：${version}"
echo "准备创建 tag：${tag}"

git tag -a "${tag}" -m "ChordV ${tag}"
git push "${REMOTE}" "${tag}"

echo "已推送 tag：${tag}"
echo "GitHub Actions 会在 tag 触发后自动编译并发布桌面安装包。"
