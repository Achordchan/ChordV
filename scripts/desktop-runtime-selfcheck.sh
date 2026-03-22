#!/usr/bin/env bash
set -euo pipefail

APP_DATA_DIR="${HOME}/Library/Application Support/app.chordv.desktop"
RUNTIME_DIR="${APP_DATA_DIR}/runtime"
PID_FILE="${RUNTIME_DIR}/xray.pid"
SESSION_FILE="${APP_DATA_DIR}/session.json"
LOG_FILE="/tmp/chordv-desktop-runtime-selfcheck.log"

mkdir -p "${RUNTIME_DIR}"
rm -f "${LOG_FILE}"

sleep 600 &
DUMMY_PID=$!
echo "${DUMMY_PID}" > "${PID_FILE}"
rm -f "${SESSION_FILE}"

pkill -f 'target/debug/chordv-desktop' >/dev/null 2>&1 || true

(
  cd "/Users/achordchan/Downloads/不同步的桌面/项目/ChordV/apps/desktop"
  pnpm tauri dev > "${LOG_FILE}" 2>&1
) &
DEV_PID=$!

cleanup() {
  kill "${DEV_PID}" >/dev/null 2>&1 || true
  pkill -f 'target/debug/chordv-desktop' >/dev/null 2>&1 || true
  kill "${DUMMY_PID}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

KILLED_AT=""
for second in $(seq 1 30); do
  if ! ps -p "${DUMMY_PID}" >/dev/null 2>&1; then
    KILLED_AT="${second}"
    break
  fi
  sleep 1
done

if [[ -z "${KILLED_AT}" ]]; then
  echo "自检失败：30 秒内未清理残留运行态"
  tail -n 40 "${LOG_FILE}" || true
  exit 1
fi

echo "自检通过：第 ${KILLED_AT} 秒清理了残留运行态"
tail -n 20 "${LOG_FILE}" || true
