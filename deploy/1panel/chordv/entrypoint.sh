#!/usr/bin/env bash
# ChordV backend supervisor entrypoint.
#
# Plays the role systemd plays for sub2api: the Node app never restarts itself in
# place. To update, the app stages a new release directory, writes a `pending.json`
# marker, and exits. This supervisor loop then:
#   1. promotes the pending version (atomically flips the `current` symlink),
#   2. launches the app and health-gates it,
#   3. on health failure, auto-rolls-back to the last known-good version,
#   4. records the outcome in `operation-result.json`, which the app consumes on
#      its next boot to close out the audit record.
#
# A successful promotion writes NO result marker: the app that comes back up and
# serves traffic IS the proof of success, and confirms its own operation record
# on boot (see SystemUpdateService.reconcileOperationsOnBoot). The supervisor
# only needs to speak up for the failure/rollback path, which the failed app
# cannot record for itself.
#
# Docker's `restart: unless-stopped` is a secondary safety net: it only matters
# if this supervisor process itself dies. Normal self-updates never exit the
# container — this loop relaunches the app in place.
set -u

RELEASES_DIR="${CHORDV_SYSTEM_RELEASES_DIR:-/app/releases}"
STATE_DIR="${CHORDV_SYSTEM_STATE_DIR:-/app/state}"
CURRENT_LINK="${CHORDV_SYSTEM_CURRENT_LINK:-/app/current}"
SEED_DIR="${CHORDV_SYSTEM_SEED_DIR:-/app/seed}"
APP_ENTRY="${CHORDV_SYSTEM_APP_ENTRY:-apps/api/dist/apps/api/src/main.js}"
MIGRATE_SCRIPT="${CHORDV_SYSTEM_MIGRATE_SCRIPT:-scripts/prisma-migrate-with-baseline.mjs}"
RUN_MIGRATE="${CHORDV_SUPERVISOR_MIGRATE:-true}"
API_PORT="${CHORDV_API_PORT:-3000}"
HEALTH_PATH="${CHORDV_SYSTEM_HEALTH_PATH:-/api/health}"
HEALTH_TIMEOUT="${CHORDV_SYSTEM_UPDATE_HEALTH_TIMEOUT_SECONDS:-90}"
NODE_BIN="${CHORDV_SYSTEM_NODE_BIN:-node}"

PENDING_FILE="$STATE_DIR/pending.json"
RESULT_FILE="$STATE_DIR/operation-result.json"
DESIRED_FILE="$STATE_DIR/desired-version"
LAST_GOOD_FILE="$STATE_DIR/last-good-version"

log() { printf '%s [supervisor] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }

read_file_trim() { [ -f "$1" ] && tr -d ' \t\r\n' < "$1" || true; }

json_get() {
  # json_get <file> <key> — minimal string/scalar extractor, no jq dependency.
  [ -f "$1" ] || return 0
  sed -n "s/.*\"$2\"[[:space:]]*:[[:space:]]*\"\{0,1\}\([^\",}]*\)\"\{0,1\}.*/\1/p" "$1" | head -n1
}

atomic_promote() {
  # Flip CURRENT_LINK to releases/<version> atomically and persist desired-version.
  local version="$1"
  ln -sfn "$RELEASES_DIR/$version" "$CURRENT_LINK"
  printf '%s' "$version" > "$DESIRED_FILE"
}

write_result() {
  # write_result <operationId> <status:success|failed|rolledback> <version> <reason>
  mkdir -p "$STATE_DIR"
  cat > "$RESULT_FILE" <<EOF
{"operationId":"$1","status":"$2","version":"$3","reason":"$4"}
EOF
}

resolve_start_version() {
  local desired current
  desired="$(read_file_trim "$DESIRED_FILE")"
  if [ -n "$desired" ] && [ -d "$RELEASES_DIR/$desired" ]; then
    printf '%s' "$desired"; return 0
  fi
  if [ -L "$CURRENT_LINK" ]; then
    current="$(basename "$(readlink "$CURRENT_LINK")")"
    if [ -n "$current" ] && [ -d "$RELEASES_DIR/$current" ]; then
      printf '%s' "$current"; return 0
    fi
  fi
  # Nothing usable — bootstrap from the image-baked seed release.
  local seed_version
  seed_version="$(read_file_trim "$SEED_DIR/SYSTEM_VERSION")"
  if [ -z "$seed_version" ]; then
    log "FATAL: no desired version, no current symlink, and no seed at $SEED_DIR"; exit 1
  fi
  if [ ! -d "$RELEASES_DIR/$seed_version" ]; then
    log "bootstrapping releases/$seed_version from seed"
    mkdir -p "$RELEASES_DIR"
    cp -a "$SEED_DIR" "$RELEASES_DIR/$seed_version"
  fi
  printf '%s' "$seed_version"
}

wait_healthy() {
  # wait_healthy <pid> — 0 if the app answers health before timeout while alive.
  # X-Forwarded-Proto: https satisfies the production HTTPS-only guard for this
  # in-container probe, mirroring what the openresty terminator sends upstream.
  local pid="$1" waited=0 url="http://127.0.0.1:${API_PORT}${HEALTH_PATH}"
  while [ "$waited" -lt "$HEALTH_TIMEOUT" ]; do
    if ! kill -0 "$pid" 2>/dev/null; then
      log "app pid $pid exited during health gate"; return 1
    fi
    if curl -fsS -o /dev/null --max-time 3 -H "X-Forwarded-Proto: https" "$url" 2>/dev/null; then
      return 0
    fi
    sleep 1; waited=$((waited + 1))
  done
  log "health gate timed out after ${HEALTH_TIMEOUT}s"; return 1
}

run_migrate() {
  local release="$1"
  [ "$RUN_MIGRATE" = "true" ] || return 0
  [ -f "$release/$MIGRATE_SCRIPT" ] || { log "no migrate script in $release, skipping"; return 0; }
  log "running migrations for $(basename "$release")"
  ( cd "$release" && "$NODE_BIN" "$MIGRATE_SCRIPT" )
}

discard_failed_release() {
  # Delete a freshly-DOWNLOADED release that failed to come up, so it is never
  # offered as a rollback target (listRollbackVersions scans the releases dir).
  # Only for 'update' promotions — never delete a user-chosen historical version.
  local version="$1" kind="$2"
  if [ "$kind" = "update" ] && [ -n "$version" ] && [ -d "$RELEASES_DIR/$version" ]; then
    log "discarding failed release $version"
    rm -rf "${RELEASES_DIR:?}/${version:?}"
  fi
}

APP_PID=""
forward_signal() {
  [ -n "$APP_PID" ] && kill -TERM "$APP_PID" 2>/dev/null
}
trap 'forward_signal; exit 143' TERM INT

mkdir -p "$STATE_DIR" "$RELEASES_DIR"

GEN_VERSION="$(resolve_start_version)"
GEN_OP=""; GEN_KIND=""; GEN_PROMOTION=0

while true; do
  atomic_promote "$GEN_VERSION"
  RELEASE_DIR="$RELEASES_DIR/$GEN_VERSION"
  if [ ! -f "$RELEASE_DIR/$APP_ENTRY" ]; then
    log "FATAL: entry $APP_ENTRY missing in $RELEASE_DIR"; exit 1
  fi

  if ! run_migrate "$RELEASE_DIR"; then
    log "migration failed for $GEN_VERSION"
    if [ "$GEN_PROMOTION" = "1" ]; then
      LG="$(read_file_trim "$LAST_GOOD_FILE")"
      if [ -n "$LG" ] && [ "$LG" != "$GEN_VERSION" ] && [ -d "$RELEASES_DIR/$LG" ]; then
        [ -n "$GEN_OP" ] && write_result "$GEN_OP" "rolledback" "$LG" "迁移失败，已回滚代码（数据库结构未回退）"
        discard_failed_release "$GEN_VERSION" "$GEN_KIND"
        GEN_VERSION="$LG"; GEN_OP=""; GEN_KIND=""; GEN_PROMOTION=0; continue
      fi
    fi
    [ -n "$GEN_OP" ] && write_result "$GEN_OP" "failed" "$GEN_VERSION" "数据库迁移失败"
    sleep 3; GEN_OP=""; GEN_PROMOTION=0; continue
  fi

  export CHORDV_SYSTEM_VERSION="$GEN_VERSION"
  log "launching $GEN_VERSION"
  ( cd "$RELEASE_DIR" && exec "$NODE_BIN" "$APP_ENTRY" ) &
  APP_PID=$!

  if wait_healthy "$APP_PID"; then
    printf '%s' "$GEN_VERSION" > "$LAST_GOOD_FILE"
    # Success writes no result marker: the app confirms its own promotion on boot.
    log "$GEN_VERSION healthy (last-good)"
    GEN_OP=""; GEN_KIND=""; GEN_PROMOTION=0
    wait "$APP_PID"; EXIT_CODE=$?
    APP_PID=""
    log "app for $GEN_VERSION exited (code $EXIT_CODE)"

    if [ -f "$PENDING_FILE" ]; then
      PV="$(json_get "$PENDING_FILE" version)"
      POP="$(json_get "$PENDING_FILE" operationId)"
      PKIND="$(json_get "$PENDING_FILE" kind)"
      rm -f "$PENDING_FILE"
      if [ -n "$PV" ] && [ -d "$RELEASES_DIR/$PV" ]; then
        log "pending $PKIND -> $PV (op $POP)"
        GEN_VERSION="$PV"; GEN_OP="$POP"; GEN_KIND="$PKIND"; GEN_PROMOTION=1
      else
        log "pending marker names unusable version '$PV'; restarting $GEN_VERSION"
        [ -n "$POP" ] && write_result "$POP" "failed" "$GEN_VERSION" "目标版本目录缺失"
      fi
    else
      log "no pending marker; restarting $GEN_VERSION"
    fi
    continue
  fi

  # Health gate failed for a freshly promoted version → auto-rollback.
  log "$GEN_VERSION failed health gate"
  kill -TERM "$APP_PID" 2>/dev/null; wait "$APP_PID" 2>/dev/null; APP_PID=""
  if [ "$GEN_PROMOTION" = "1" ]; then
    LG="$(read_file_trim "$LAST_GOOD_FILE")"
    if [ -n "$LG" ] && [ "$LG" != "$GEN_VERSION" ] && [ -d "$RELEASES_DIR/$LG" ]; then
      log "auto-rolling back $GEN_VERSION -> $LG (op $GEN_OP)"
      [ -n "$GEN_OP" ] && write_result "$GEN_OP" "rolledback" "$LG" "新版本健康检查未通过，已自动回滚"
      discard_failed_release "$GEN_VERSION" "$GEN_KIND"
      GEN_VERSION="$LG"; GEN_OP=""; GEN_KIND=""; GEN_PROMOTION=0; continue
    fi
    [ -n "$GEN_OP" ] && write_result "$GEN_OP" "failed" "$GEN_VERSION" "新版本健康检查未通过且无可回滚版本"
  fi
  log "no known-good version to fall back to; retrying $GEN_VERSION in 3s"
  sleep 3; GEN_OP=""; GEN_PROMOTION=0
done
