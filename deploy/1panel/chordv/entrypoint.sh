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
# In-progress promotion: persisted so a supervisor/host restart mid-promotion
# still knows this is a health-gated promotion (and can roll back), rather than
# treating the half-promoted release as a plain, trusted start.
PROMOTING_FILE="$STATE_DIR/promoting.json"
# A new release must stay up AND healthy for this long before it is trusted as
# last-good — otherwise a version that serves one probe then crashes on delayed
# init would be restarted forever instead of rolled back.
STABILIZE_SECONDS="${CHORDV_SYSTEM_UPDATE_STABILIZE_SECONDS:-10}"

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

write_promoting() {
  # write_promoting <version> <operationId> <kind>
  mkdir -p "$STATE_DIR"
  cat > "$PROMOTING_FILE" <<EOF
{"version":"$1","operationId":"$2","kind":"$3"}
EOF
}

clear_promoting() { rm -f "$PROMOTING_FILE"; }

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

confirm_stable() {
  # confirm_stable <pid> — after the first healthy probe, require the app to stay
  # alive AND healthy for STABILIZE_SECONDS so a version that crashes right after
  # opening the port is treated as a failed promotion, not marked last-good.
  local pid="$1" waited=0 url="http://127.0.0.1:${API_PORT}${HEALTH_PATH}"
  while [ "$waited" -lt "$STABILIZE_SECONDS" ]; do
    if ! kill -0 "$pid" 2>/dev/null; then
      log "app pid $pid exited during stabilization"; return 1
    fi
    if ! curl -fsS -o /dev/null --max-time 3 -H "X-Forwarded-Proto: https" "$url" 2>/dev/null; then
      log "app became unhealthy during stabilization"; return 1
    fi
    sleep 1; waited=$((waited + 1))
  done
  return 0
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

handle_failed_promotion() {
  # A promoted release failed to come up (migration / health gate / stabilization).
  # Roll back to last-good when we can; otherwise record failure and retry. Always
  # clears the promotion marker so a later restart does not resume a dead promotion.
  # Mutates the GEN_* globals for the next loop iteration. $1 is a reason string.
  local reason="$1" LG=""
  if [ "$GEN_PROMOTION" = "1" ]; then
    LG="$(read_file_trim "$LAST_GOOD_FILE")"
    if [ -n "$LG" ] && [ "$LG" != "$GEN_VERSION" ] && [ -d "$RELEASES_DIR/$LG" ]; then
      log "auto-rolling back $GEN_VERSION -> $LG (op ${GEN_OP:-none}): $reason"
      [ -n "$GEN_OP" ] && write_result "$GEN_OP" "rolledback" "$LG" "$reason"
      discard_failed_release "$GEN_VERSION" "$GEN_KIND"
      clear_promoting
      GEN_VERSION="$LG"; GEN_OP=""; GEN_KIND=""; GEN_PROMOTION=0
      return 0
    fi
    [ -n "$GEN_OP" ] && write_result "$GEN_OP" "failed" "$GEN_VERSION" "$reason（无可回滚版本）"
    clear_promoting
  fi
  log "no known-good version to fall back to; retrying $GEN_VERSION in 3s"
  sleep 3
  GEN_OP=""; GEN_KIND=""; GEN_PROMOTION=0
  return 0
}

APP_PID=""
forward_signal() {
  [ -n "$APP_PID" ] && kill -TERM "$APP_PID" 2>/dev/null
}
trap 'forward_signal; exit 143' TERM INT

mkdir -p "$STATE_DIR" "$RELEASES_DIR"

# Resume an interrupted promotion: if we restarted after desired-version was
# switched but before the health gate finished, treat it as a promotion again so
# it is health-gated and can still roll back (instead of retrying forever / being
# reconciled as a success it never earned).
if [ -f "$PROMOTING_FILE" ]; then
  RESUME_V="$(json_get "$PROMOTING_FILE" version)"
  RESUME_OP="$(json_get "$PROMOTING_FILE" operationId)"
  RESUME_KIND="$(json_get "$PROMOTING_FILE" kind)"
  if [ -n "$RESUME_V" ] && [ -d "$RELEASES_DIR/$RESUME_V" ]; then
    log "resuming interrupted promotion -> $RESUME_V (op $RESUME_OP)"
    GEN_VERSION="$RESUME_V"; GEN_OP="$RESUME_OP"; GEN_KIND="$RESUME_KIND"; GEN_PROMOTION=1
  else
    log "stale promoting marker (version '$RESUME_V' unusable); discarding"
    [ -n "$RESUME_OP" ] && write_result "$RESUME_OP" "failed" "$RESUME_V" "提升过程中断且目标版本缺失"
    clear_promoting
    GEN_VERSION="$(resolve_start_version)"; GEN_OP=""; GEN_KIND=""; GEN_PROMOTION=0
  fi
else
  GEN_VERSION="$(resolve_start_version)"; GEN_OP=""; GEN_KIND=""; GEN_PROMOTION=0
fi

while true; do
  atomic_promote "$GEN_VERSION"
  RELEASE_DIR="$RELEASES_DIR/$GEN_VERSION"
  if [ ! -f "$RELEASE_DIR/$APP_ENTRY" ]; then
    log "FATAL: entry $APP_ENTRY missing in $RELEASE_DIR"; exit 1
  fi

  if ! run_migrate "$RELEASE_DIR"; then
    log "migration failed for $GEN_VERSION"
    handle_failed_promotion "迁移失败，已回滚代码（数据库结构未回退）"
    continue
  fi

  export CHORDV_SYSTEM_VERSION="$GEN_VERSION"
  log "launching $GEN_VERSION"
  ( cd "$RELEASE_DIR" && exec "$NODE_BIN" "$APP_ENTRY" ) &
  APP_PID=$!

  if wait_healthy "$APP_PID" && confirm_stable "$APP_PID"; then
    printf '%s' "$GEN_VERSION" > "$LAST_GOOD_FILE"
    # Finalize the operation ONLY now — after health + stabilization. The app does
    # not self-confirm on boot (a version can open the port then fail during delayed
    # init); it consumes this marker to mark the op succeeded.
    [ -n "$GEN_OP" ] && write_result "$GEN_OP" "success" "$GEN_VERSION" ""
    clear_promoting
    log "$GEN_VERSION healthy + stable (last-good)"
    GEN_OP=""; GEN_KIND=""; GEN_PROMOTION=0
    wait "$APP_PID"; EXIT_CODE=$?
    APP_PID=""
    log "app for $GEN_VERSION exited (code $EXIT_CODE)"

    if [ -f "$PENDING_FILE" ]; then
      PV="$(json_get "$PENDING_FILE" version)"
      POP="$(json_get "$PENDING_FILE" operationId)"
      PKIND="$(json_get "$PENDING_FILE" kind)"
      if [ -n "$PV" ] && [ -d "$RELEASES_DIR/$PV" ]; then
        # Persist the promotion BEFORE the next iteration flips desired-version, so
        # a crash in the gap is resumed as a health-gated promotion, not a bare start.
        write_promoting "$PV" "$POP" "$PKIND"
        rm -f "$PENDING_FILE"
        log "pending $PKIND -> $PV (op $POP)"
        GEN_VERSION="$PV"; GEN_OP="$POP"; GEN_KIND="$PKIND"; GEN_PROMOTION=1
      else
        rm -f "$PENDING_FILE"
        log "pending marker names unusable version '$PV'; restarting $GEN_VERSION"
        [ -n "$POP" ] && write_result "$POP" "failed" "$GEN_VERSION" "目标版本目录缺失"
      fi
    else
      log "no pending marker; restarting $GEN_VERSION"
    fi
    continue
  fi

  # Failed to come up (never healthy, or crashed during stabilization) → roll back.
  log "$GEN_VERSION failed to become healthy+stable"
  kill -TERM "$APP_PID" 2>/dev/null; wait "$APP_PID" 2>/dev/null; APP_PID=""
  handle_failed_promotion "新版本健康检查未通过，已自动回滚"
done
