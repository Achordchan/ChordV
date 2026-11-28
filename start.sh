#!/usr/bin/env bash
set -Eeuo pipefail
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$script_dir/scripts/mygo-local.mjs" "$@"
