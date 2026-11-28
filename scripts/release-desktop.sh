#!/usr/bin/env bash
set -euo pipefail

printf '%s\n' '此旧发版入口已退役。请在 GitHub Actions 中选择 Release MyGo Desktop（.github/workflows/release-desktop.yml），通过 workflow_dispatch 手动发版。' >&2
exit 1
