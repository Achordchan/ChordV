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
# api + admin ship as one release unit; validate the admin bundle too so a release
# missing it is rejected/rolled back rather than silently serving a stale UI from a
# different release (set empty to skip, e.g. API-only deployments or stub tests).
ADMIN_ENTRY="${CHORDV_SYSTEM_ADMIN_ENTRY:-apps/admin/dist/index.html}"
MIGRATE_SCRIPT="${CHORDV_SYSTEM_MIGRATE_SCRIPT:-scripts/prisma-migrate-with-baseline.mjs}"
RUN_MIGRATE="${CHORDV_SUPERVISOR_MIGRATE:-true}"
# Upper bound for a supervisor-run migration (seconds) so a hung migrate can't
# wedge the container after the old process has exited. Covers a large migrate.
MIGRATE_TIMEOUT="${CHORDV_SYSTEM_MIGRATE_TIMEOUT:-900}"
# Pre-migration DB snapshot (recovery point) — owned by the SUPERVISOR, not the app,
# so it is taken with the old process already stopped (a consistent point-in-time) and
# can never be orphaned by an app SIGKILL. Only taken when the staged update actually
# migrates (promoting.json migrationApplied=true). pg_dump ships in the runtime image.
SNAPSHOT_ENABLED="${CHORDV_SYSTEM_UPDATE_SNAPSHOT:-true}"
BACKUP_DIR="${CHORDV_SYSTEM_UPDATE_BACKUP_DIR:-$STATE_DIR/backups}"
SNAPSHOT_KEEP="${CHORDV_SYSTEM_UPDATE_SNAPSHOT_KEEP:-5}"
SNAPSHOT_TIMEOUT="${CHORDV_SYSTEM_UPDATE_SNAPSHOT_TIMEOUT:-600}"
API_PORT="${CHORDV_API_PORT:-3000}"
# Gate promotions on READINESS (exercises the DB), not bare liveness: a version
# that opens its port but has a broken Prisma runtime/schema must fail the gate
# and roll back, not become last-good.
HEALTH_PATH="${CHORDV_SYSTEM_HEALTH_PATH:-/api/health/ready}"
HEALTH_TIMEOUT="${CHORDV_SYSTEM_UPDATE_HEALTH_TIMEOUT_SECONDS:-90}"
NODE_BIN="${CHORDV_SYSTEM_NODE_BIN:-node}"

PENDING_FILE="$STATE_DIR/pending.json"
# Each operation's outcome is written to its OWN file (operation-result.<op>.json),
# never a single shared operation-result.json: a second operation must not clobber a
# first one the app has not consumed yet (e.g. the app booted while PostgreSQL was
# briefly unavailable, so the first result is still waiting). The app scans + drains
# every operation-result*.json on boot and on each status poll.
RESULT_PREFIX="$STATE_DIR/operation-result"
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
  # Flip CURRENT_LINK to releases/<version> and DURABLY persist desired-version.
  # Returns non-zero if EITHER the symlink flip or the desired-version write fails
  # (read-only / full state volume, I/O error). Callers MUST NOT launch/approve a
  # version whose promotion state could not be recorded: otherwise the admin
  # container (which follows the same symlink) could keep serving the old bundle
  # while the API is approved as new, or a later restart could relaunch an
  # inconsistent target. `ln -sfn` replaces the existing link in place (‑n so it does
  # not dereference the old symlink-to-dir); desired-version is written tmp+mv+sync so
  # a crash mid-write can't leave it empty/half-written (which boots to the seed).
  local version="$1"
  if ! ln -sfn "$RELEASES_DIR/$version" "$CURRENT_LINK"; then
    log "ERROR: cannot flip current symlink to $version (state volume read-only/full?)"
    return 1
  fi
  local dtmp="$DESIRED_FILE.tmp.$$"
  if ! printf '%s' "$version" > "$dtmp" || ! mv -f "$dtmp" "$DESIRED_FILE"; then
    rm -f "$dtmp" 2>/dev/null
    log "ERROR: cannot persist desired-version for $version (state volume read-only/full?)"
    return 1
  fi
  sync 2>/dev/null || true
  return 0
}

write_result() {
  # write_result <operationId> <status:success|failed|rolledback> <version> <reason> [migrationApplied]
  # Atomic write (tmp + mv + sync) to a PER-OPERATION file: the app polls concurrently,
  # so a partial `cat >` could be read as truncated JSON; and a distinct filename per
  # operation means a later operation's result never overwrites an earlier unconsumed
  # one (the app drains every operation-result*.json). Overwriting the SAME op's file
  # (e.g. a resumed promotion re-finalizing) is fine. All write_result callers pass a
  # non-empty operationId. Returns non-zero if the outcome could not be durably persisted.
  mkdir -p "$STATE_DIR" || return 1
  local op="$1" migrated="${5:-false}"
  [ -n "$op" ] || return 1
  local out="$RESULT_PREFIX.$op.json" tmp
  tmp="$RESULT_PREFIX.$op.json.tmp.$$"
  if ! printf '{"operationId":"%s","status":"%s","version":"%s","reason":"%s","migrationApplied":%s}\n' \
      "$op" "$2" "$3" "$4" "$migrated" > "$tmp"; then
    rm -f "$tmp" 2>/dev/null; return 1
  fi
  [ -s "$tmp" ] || { rm -f "$tmp" 2>/dev/null; return 1; }
  mv -f "$tmp" "$out" || { rm -f "$tmp" 2>/dev/null; return 1; }
  sync 2>/dev/null || true
  return 0
}

write_promoting() {
  # write_promoting <version> <operationId> <kind> [migrationApplied] [rollbackFrom]
  # Returns non-zero if the marker could not be durably written (e.g. full state
  # volume). Callers MUST NOT delete pending.json or promote unless this succeeds, or
  # a mid-gate restart would treat the target as an ordinary trusted start and skip
  # the automatic rollback. migrationApplied is carried so a later rollback can report
  # whether the schema was migrated. kind=rollback + rollbackFrom mark a health-gated
  # rollback LANDING (last-good re-promoted), so the terminal 'rolledback' result is
  # written only after last-good itself stabilizes — and survives a mid-gate restart.
  mkdir -p "$STATE_DIR" || return 1
  local migrated="${4:-false}"
  local rollback_from="${5:-}"
  local tmp="$PROMOTING_FILE.tmp.$$"
  if ! printf '{"version":"%s","operationId":"%s","kind":"%s","migrationApplied":%s,"rollbackFrom":"%s"}\n' \
      "$1" "$2" "$3" "$migrated" "$rollback_from" > "$tmp"; then
    rm -f "$tmp" 2>/dev/null; return 1
  fi
  [ -s "$tmp" ] || { rm -f "$tmp" 2>/dev/null; return 1; }
  mv -f "$tmp" "$PROMOTING_FILE" || { rm -f "$tmp" 2>/dev/null; return 1; }
  sync 2>/dev/null || true
  return 0
}

clear_promoting() { rm -f "$PROMOTING_FILE"; }

resolve_start_version() {
  local desired current lastgood
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
  # Prefer the last known-good version over the image seed: if desired/current point
  # at a version whose dir is gone (e.g. a discarded failed update), fall back to the
  # release that last passed health, not all the way back to the baked seed.
  lastgood="$(read_file_trim "$LAST_GOOD_FILE")"
  if [ -n "$lastgood" ] && [ -d "$RELEASES_DIR/$lastgood" ]; then
    log "desired/current unusable; falling back to last-good $lastgood"
    printf '%s' "$lastgood"; return 0
  fi
  # Nothing usable — bootstrap from the image-baked seed release.
  local seed_version
  seed_version="$(read_file_trim "$SEED_DIR/SYSTEM_VERSION")"
  if [ -z "$seed_version" ]; then
    log "FATAL: no desired version, no current symlink, and no seed at $SEED_DIR"; exit 1
  fi
  # Consider the seed already bootstrapped only if the entry actually exists — a
  # previous interrupted/disk-full cp can leave a partial dir that would otherwise
  # be launched (and crash-loop) forever.
  if [ ! -f "$RELEASES_DIR/$seed_version/$APP_ENTRY" ]; then
    log "bootstrapping releases/$seed_version from seed"
    mkdir -p "$RELEASES_DIR"
    # Copy into a temp dir, validate, then rename atomically so a crash mid-copy
    # never leaves a half-populated release/<version> in place.
    local stage="$RELEASES_DIR/.seed-stage.$$"
    rm -rf "$stage"
    if ! cp -a "$SEED_DIR" "$stage"; then
      rm -rf "$stage"; log "FATAL: seed copy failed"; exit 1
    fi
    if [ ! -f "$stage/$APP_ENTRY" ]; then
      rm -rf "$stage"; log "FATAL: seed is missing $APP_ENTRY"; exit 1
    fi
    rm -rf "$RELEASES_DIR/$seed_version"
    mv -f "$stage" "$RELEASES_DIR/$seed_version"
    sync 2>/dev/null || true
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

write_last_good() {
  # Durably record the last known-good version (tmp+mv+sync). Returns non-zero if it
  # could not be committed: the caller must NOT finalize a promotion without it, or a
  # later failed update would have no valid rollback target and could strand the
  # service on a broken release.
  local version="$1" tmp="$LAST_GOOD_FILE.tmp.$$"
  if ! printf '%s' "$version" > "$tmp" || ! mv -f "$tmp" "$LAST_GOOD_FILE"; then
    rm -f "$tmp" 2>/dev/null
    return 1
  fi
  sync 2>/dev/null || true
  return 0
}

prune_snapshots() {
  # Keep only the newest SNAPSHOT_KEEP pre-migrate snapshots so they can't fill the
  # state volume and then break future snapshots / markers / audit writes.
  local n=0 f
  ls -1t "$BACKUP_DIR"/pre-migrate-*.sql.gz 2>/dev/null | while IFS= read -r f; do
    n=$((n + 1))
    [ "$n" -gt "$SNAPSHOT_KEEP" ] && rm -f "$f" 2>/dev/null
  done
  return 0
}

run_snapshot() {
  # run_snapshot <version> <operationId> — pre-migration DB snapshot. Returns non-zero
  # if a snapshot was required but could not be durably created; the caller then rolls
  # back instead of migrating (never migrate without a trustworthy recovery point).
  local version="$1" op="$2"
  [ "$SNAPSHOT_ENABLED" = "true" ] || return 0
  if [ -z "${DATABASE_URL:-}" ]; then
    log "ERROR: DATABASE_URL not set; cannot snapshot before migrate"
    return 1
  fi
  mkdir -p "$BACKUP_DIR" || { log "ERROR: cannot create backup dir $BACKUP_DIR"; return 1; }
  # Reuse a snapshot ONLY when it belongs to THIS SAME operation (keyed by opId), i.e.
  # we are resuming the very same promotion after a crash/re-gate. A later retry of the
  # same VERSION is a different operation (new opId) and MUST take a fresh snapshot, or
  # a restore would silently discard all writes that happened since the first attempt.
  # Only a fully-finalized snapshot (final name) counts as reusable — a crash mid-dump
  # leaves a distinct .partial file (below) that never matches this glob, so the resume
  # takes a fresh dump instead of trusting a truncated one.
  local base="pre-migrate-${version}-${op}"
  if ls "$BACKUP_DIR/$base"-*.sql.gz >/dev/null 2>&1; then
    log "pre-migrate snapshot for op ${op} already exists; reusing it"
    return 0
  fi
  local stamp target tmp
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  target="$BACKUP_DIR/${base}-${stamp}.sql.gz"
  # Dump to a .partial temp name first; it is NOT reusable (doesn't match the glob) and
  # is only renamed to the final name after gzip integrity is verified and flushed —
  # so a truncated dump from a crash can never be mistaken for a valid recovery point.
  tmp="$BACKUP_DIR/.${base}-${stamp}.sql.gz.partial.$$"
  log "snapshotting database before migrate -> $(basename "$target") (timeout ${SNAPSHOT_TIMEOUT}s)"
  # pipefail so a pg_dump failure fails the pipe even though gzip succeeds; timeout so a
  # hung dump can't wedge the container after the old process has already exited.
  if ! ( set -o pipefail; timeout -k 30 "$SNAPSHOT_TIMEOUT" pg_dump "$DATABASE_URL" | gzip > "$tmp" ); then
    log "ERROR: database snapshot failed"
    rm -f "$tmp" 2>/dev/null
    return 1
  fi
  [ -s "$tmp" ] || { log "ERROR: database snapshot is empty"; rm -f "$tmp" 2>/dev/null; return 1; }
  # Verify the gzip archive is COMPLETE before trusting/renaming it.
  if ! gzip -t "$tmp" 2>/dev/null; then
    log "ERROR: snapshot archive is corrupt/incomplete"; rm -f "$tmp" 2>/dev/null; return 1
  fi
  sync 2>/dev/null || true # flush contents before publishing the reusable name
  if ! mv -f "$tmp" "$target"; then
    log "ERROR: cannot finalize snapshot"; rm -f "$tmp" 2>/dev/null; return 1
  fi
  sync 2>/dev/null || true # flush the directory entry (the rename)
  prune_snapshots
  return 0
}

run_migrate() {
  local release="$1"
  [ "$RUN_MIGRATE" = "true" ] || return 0
  [ -f "$release/$MIGRATE_SCRIPT" ] || { log "no migrate script in $release, skipping"; return 0; }
  log "running migrations for $(basename "$release") (timeout ${MIGRATE_TIMEOUT}s)"
  # Bound the migration: a hang on the DB connection / advisory lock would otherwise
  # block forever after the old process has exited, never reaching the readiness gate
  # or rollback. `timeout -k` also SIGKILLs if it ignores SIGTERM. Non-zero (incl.
  # 124 on timeout) is routed through handle_failed_promotion by the caller.
  ( cd "$release" && timeout -k 30 "$MIGRATE_TIMEOUT" "$NODE_BIN" "$MIGRATE_SCRIPT" )
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
  # Roll back to last-good when we can; otherwise record failure and retry.
  # Mutates the GEN_* globals for the next loop iteration. $1 is a reason string.
  #
  # write_result is atomic (tmp+mv) so a concurrent poll never reads a truncated
  # outcome. In the rollback branch we must move off the broken version (clear the
  # promoting guard so new ops are not blocked and a restart does not re-promote a
  # discarded version); if the atomic result write nonetheless fails (e.g. full
  # volume), the app's boot reconcile stale-sweep still marks the orphaned op
  # terminal, so it is never left running forever.
  local reason="$1" mig_override="${2:-}" LG="" MIG
  # Whether the failed promotion may have CHANGED the schema — carried so the app can
  # warn "code rolled back but schema not". Callers that fail BEFORE migration runs
  # (incomplete release, snapshot failure, promote-state failure) pass an explicit
  # "false" so the audit/UI does not wrongly claim the schema changed. Otherwise
  # (health-gate failure after migrate, migration failure itself) fall back to the
  # promoting marker's migrationApplied.
  if [ -n "$mig_override" ]; then
    MIG="$mig_override"
  else
    MIG="$(json_get "$PROMOTING_FILE" migrationApplied)"; [ "$MIG" = "true" ] || MIG="false"
  fi
  if [ "$GEN_PROMOTION" = "1" ]; then
    LG="$(read_file_trim "$LAST_GOOD_FILE")"
    if [ -n "$LG" ] && [ "$LG" != "$GEN_VERSION" ] && [ -d "$RELEASES_DIR/$LG" ]; then
      log "auto-rolling back $GEN_VERSION -> $LG (op ${GEN_OP:-none}): $reason"
      # Do NOT write the terminal 'rolledback' result here: last-good has not been
      # launched/health-checked yet, and if it fails to come up (e.g. against the
      # already-migrated DB) reporting a successful rollback would be a lie. Instead,
      # re-promote last-good as a health-gated promotion carrying the SAME operation,
      # marked kind=rollback (+ rollbackFrom/reason). The success path finalizes it as
      # 'rolledback' ONLY after last-good passes readiness + stabilization; if last-good
      # also fails, the no-fallback branch records it as 'failed'. Persist the promoting
      # marker (carrying the FAILED version's migrationApplied) BEFORE flipping the
      # symlink so a crash in the gap resumes the rollback landing, not the broken one.
      GEN_ROLLBACK_FROM="$GEN_VERSION"; GEN_ROLLBACK_REASON="$reason"
      # Persist the rollback marker FIRST and DO NOT switch or discard anything unless
      # it is durable. If the state volume is full/read-only, flipping the symlink and
      # deleting the failed release while the on-disk marker still points at that (now
      # gone) version would make a restart unable to resume the health-gated rollback —
      # it would record a wrong "failed" audit and could desync admin/API versions.
      # Keep everything as-is (GEN_* unchanged → the loop retries the failed version,
      # rolls back again) until the marker can be written.
      if ! write_promoting "$LG" "$GEN_OP" "rollback" "$MIG" "$GEN_VERSION"; then
        log "ERROR: cannot persist rollback marker (state volume full/read-only?); not switching/discarding, retrying in 3s"
        sleep 3
        return 0
      fi
      # Marker durable: now safe to flip to last-good and discard the failed release.
      # If the symlink/desired write fails here, the durable marker still names LG, so a
      # restart resumes the rollback to LG correctly.
      atomic_promote "$LG" || log "WARN: could not persist promotion to $LG; retrying in loop"
      discard_failed_release "$GEN_VERSION" "$GEN_KIND"
      GEN_VERSION="$LG"; GEN_KIND="rollback"; GEN_PROMOTION=1
      return 0
    fi
    # No fallback: keep retrying the SAME version. Only clear the promoting guard
    # once the failure is durably recorded, so the outcome is not lost.
    #
    # Record the ORIGINALLY ATTEMPTED version, not the version we happen to be sitting
    # on. If this is a rollback LANDING that ALSO failed, GEN_VERSION is now last-good
    # but the operation's real target was the candidate that started the failure
    # (GEN_ROLLBACK_FROM) — writing last-good here would collapse the audit's toVersion
    # and lose which candidate actually failed.
    local attempted="${GEN_ROLLBACK_FROM:-$(json_get "$PROMOTING_FILE" rollbackFrom)}"
    attempted="${attempted:-$GEN_VERSION}"
    if [ -n "$GEN_OP" ]; then
      if write_result "$GEN_OP" "failed" "$attempted" "${reason}（无可回滚版本）" "$MIG"; then
        clear_promoting
      else
        log "WARN: could not persist failure result; keeping promoting marker for retry"
      fi
    else
      clear_promoting
    fi
  fi
  log "no known-good version to fall back to; retrying $GEN_VERSION in 3s"
  sleep 3
  GEN_OP=""; GEN_KIND=""; GEN_PROMOTION=0; GEN_ROLLBACK_FROM=""; GEN_ROLLBACK_REASON=""
  return 0
}

APP_PID=""
forward_signal() {
  # On docker stop/recreate, forward SIGTERM to the app AND wait for it to exit before
  # we (PID 1) leave — otherwise the container teardown that follows PID 1's exit can
  # SIGKILL Node mid-shutdown, defeating enableShutdownHooks (graceful DB disconnect,
  # in-flight request drain). Docker's own SIGKILL grace period backstops a hung app,
  # so no hard timeout is needed here.
  if [ -n "$APP_PID" ]; then
    kill -TERM "$APP_PID" 2>/dev/null
    wait "$APP_PID" 2>/dev/null
  fi
  exit 143
}
trap forward_signal TERM INT

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
elif [ -f "$PENDING_FILE" ]; then
  # The app staged an update (wrote pending.json) but the host/supervisor restarted
  # before we processed its exit. Convert the pending marker into a promotion now
  # so the target is health-gated + rollback-capable — otherwise the old version
  # would just start, and the stale pending marker could later promote a supposedly
  # failed update on an unrelated exit.
  PV="$(json_get "$PENDING_FILE" version)"
  POP="$(json_get "$PENDING_FILE" operationId)"
  PKIND="$(json_get "$PENDING_FILE" kind)"
  PMIG="$(json_get "$PENDING_FILE" migrationApplied)"; [ "$PMIG" = "true" ] || PMIG="false"
  if [ -n "$PV" ] && [ -d "$RELEASES_DIR/$PV" ] && write_promoting "$PV" "$POP" "$PKIND" "$PMIG"; then
    rm -f "$PENDING_FILE"
    log "resuming staged $PKIND from pending marker -> $PV (op $POP)"
    GEN_VERSION="$PV"; GEN_OP="$POP"; GEN_KIND="$PKIND"; GEN_PROMOTION=1
  else
    log "unusable/undurable pending marker (version '$PV'); discarding"
    rm -f "$PENDING_FILE"
    [ -n "$POP" ] && write_result "$POP" "failed" "$PV" "暂存的更新在重启期间中断，未能提升"
    GEN_VERSION="$(resolve_start_version)"; GEN_OP=""; GEN_KIND=""; GEN_PROMOTION=0
  fi
else
  GEN_VERSION="$(resolve_start_version)"; GEN_OP=""; GEN_KIND=""; GEN_PROMOTION=0
fi
# Context for a rollback LANDING carried across loop iterations (set by
# handle_failed_promotion, consumed by the success path). On a mid-gate restart these
# are empty and both terminal paths recover rollbackFrom from the promoting marker.
GEN_ROLLBACK_FROM=""; GEN_ROLLBACK_REASON=""

while true; do
  if ! atomic_promote "$GEN_VERSION"; then
    if [ "$GEN_PROMOTION" = "1" ]; then
      # Cannot record the promotion state (read-only/full state volume): do NOT launch
      # and approve a version whose symlink/desired-version could not be committed —
      # roll back to a version whose state is already consistent.
      log "cannot persist promotion state for $GEN_VERSION; rolling back"
      handle_failed_promotion "无法持久化提升状态（状态卷可能只读或已满），已自动回滚" "false"
      continue
    fi
    # Non-promotion (ordinary restart): the existing symlink most likely already
    # points at this version, so keep serving rather than take the service down.
    log "WARN: cannot persist promotion state for $GEN_VERSION; continuing with existing symlink"
  fi
  RELEASE_DIR="$RELEASES_DIR/$GEN_VERSION"
  # Validate the release is complete BEFORE launching/health-gating: the api entry,
  # and (for the api+admin release unit) the admin bundle. A missing piece on a
  # promoted release rolls back; on the initial/seed version it is fatal (nothing to
  # fall back to).
  MISSING=""
  [ -f "$RELEASE_DIR/$APP_ENTRY" ] || MISSING="$APP_ENTRY"
  if [ -z "$MISSING" ] && [ -n "$ADMIN_ENTRY" ] && [ ! -f "$RELEASE_DIR/$ADMIN_ENTRY" ]; then
    MISSING="$ADMIN_ENTRY"
  fi
  if [ -n "$MISSING" ]; then
    if [ "$GEN_PROMOTION" = "1" ]; then
      # A corrupt/incomplete promoted release: roll back instead of exiting, which
      # (with desired/promoting already persisted) would restart into the same
      # broken version forever.
      log "release $GEN_VERSION missing $MISSING; rolling back"
      handle_failed_promotion "新版本不完整（缺少 ${MISSING}），已自动回滚" "false"
      continue
    fi
    log "FATAL: release $GEN_VERSION missing $MISSING (no promotion to roll back)"; exit 1
  fi

  # Pre-migration snapshot: only for a forward promotion that will migrate. A rollback
  # LANDING (kind=rollback) goes to an OLDER release whose migrations are already
  # applied, so `migrate deploy` is a no-op there — snapshotting again would only delay
  # recovery. migrationApplied is read from the promoting marker the app staged.
  PROMO_MIG="$(json_get "$PROMOTING_FILE" migrationApplied)"; [ "$PROMO_MIG" = "true" ] || PROMO_MIG="false"
  if [ "$GEN_PROMOTION" = "1" ] && [ "$GEN_KIND" != "rollback" ] && [ "$PROMO_MIG" = "true" ]; then
    if ! run_snapshot "$GEN_VERSION" "$GEN_OP"; then
      log "pre-migration snapshot failed for $GEN_VERSION"
      handle_failed_promotion "迁移前数据库快照失败，未执行迁移，已自动回滚" "false"
      continue
    fi
  fi

  if ! run_migrate "$RELEASE_DIR"; then
    log "migration failed for $GEN_VERSION"
    handle_failed_promotion "迁移失败，已回滚代码（数据库结构未回退）" "true"
    continue
  fi

  export CHORDV_SYSTEM_VERSION="$GEN_VERSION"
  log "launching $GEN_VERSION"
  ( cd "$RELEASE_DIR" && exec "$NODE_BIN" "$APP_ENTRY" ) &
  APP_PID=$!

  if wait_healthy "$APP_PID" && confirm_stable "$APP_PID"; then
    # Finalization must keep retrying while this app serves, not exhaust a fixed
    # retry budget and wait for an unrelated app exit. Keep ALL generation context
    # and the promoting marker until last-good AND the result are persisted.
    LG_OK=0
    FINALIZED=0
    # Finalize the operation ONLY now — after health + stabilization. The app does
    # not self-confirm on boot (a version can open the port then fail during delayed
    # init); it consumes this marker to mark the op succeeded.
    SUCC_MIG="$(json_get "$PROMOTING_FILE" migrationApplied)"; [ "$SUCC_MIG" = "true" ] || SUCC_MIG="false"
    # 'rolledback' is reserved for an AUTOMATIC rollback LANDING — identified by a
    # non-empty rollbackFrom (the failed version handle_failed_promotion recorded) —
    # and written only now that last-good has itself passed readiness + stabilization,
    # so we never claim a rollback that failed to restore service. An OPERATOR-requested
    # rollback (kind=rollback but NO rollbackFrom) that comes up healthy is a normal
    # 'success': the target is exactly what the admin asked for, and reporting it as
    # "auto-rolled-back after a failed health check" would be wrong. migrationApplied
    # carries the failed update's value so the app can still warn about the schema.
    RB_FROM="${GEN_ROLLBACK_FROM:-$(json_get "$PROMOTING_FILE" rollbackFrom)}"
    if [ -n "$RB_FROM" ]; then
      RES_STATUS="rolledback"
      RES_REASON="${GEN_ROLLBACK_REASON:-新版本未通过验证，已自动回滚}（原版本 ${RB_FROM}）"
    else
      RES_STATUS="success"; RES_REASON=""
    fi
    while kill -0 "$APP_PID" 2>/dev/null; do
      # Last-good MUST be durable before publishing success. Once committed, retry
      # only the result so a separate last-good I/O failure cannot block that retry.
      if [ "$LG_OK" != "1" ]; then
        if write_last_good "$GEN_VERSION"; then
          LG_OK=1
        else
          log "WARN: last-good write for $GEN_VERSION failed; keeping full promotion context, retrying in 2s"
          sleep 2
          continue
        fi
      fi
      if [ -n "$GEN_OP" ] && ! write_result "$GEN_OP" "$RES_STATUS" "$GEN_VERSION" "$RES_REASON" "$SUCC_MIG"; then
        log "WARN: could not persist ${RES_STATUS} result; keeping full promotion context, retrying in 2s"
        sleep 2
        continue
      fi
      clear_promoting
      FINALIZED=1
      break
    done
    if [ "$FINALIZED" != "1" ]; then
      # App exited during persistence retries: reap it and re-gate with the SAME
      # operation context. Do not process a new pending op or lose rollbackFrom.
      wait "$APP_PID"; EXIT_CODE=$?
      APP_PID=""
      log "app for $GEN_VERSION exited (code $EXIT_CODE); re-gating to retry finalization (op ${GEN_OP:-none})"
      continue
    fi
    log "$GEN_VERSION healthy + stable (last-good)"
    GEN_OP=""; GEN_KIND=""; GEN_PROMOTION=0; GEN_ROLLBACK_FROM=""; GEN_ROLLBACK_REASON=""
    wait "$APP_PID"; EXIT_CODE=$?
    APP_PID=""
    log "app for $GEN_VERSION exited (code $EXIT_CODE)"

    if [ -f "$PENDING_FILE" ]; then
      PV="$(json_get "$PENDING_FILE" version)"
      POP="$(json_get "$PENDING_FILE" operationId)"
      PKIND="$(json_get "$PENDING_FILE" kind)"
      PMIG="$(json_get "$PENDING_FILE" migrationApplied)"; [ "$PMIG" = "true" ] || PMIG="false"
      if [ -n "$PV" ] && [ -d "$RELEASES_DIR/$PV" ]; then
        # Persist the promotion BEFORE deleting pending / flipping desired-version, so
        # a crash in the gap is resumed as a health-gated promotion, not a bare start.
        # Only proceed if the marker was durably written.
        if write_promoting "$PV" "$POP" "$PKIND" "$PMIG"; then
          rm -f "$PENDING_FILE"
          log "pending $PKIND -> $PV (op $POP)"
          GEN_VERSION="$PV"; GEN_OP="$POP"; GEN_KIND="$PKIND"; GEN_PROMOTION=1
        else
          # Could not persist the promotion marker (state volume full?). Do NOT
          # promote without it — keep serving the current version and surface it.
          # pending.json is dropped so a later app exit doesn't silently promote
          # without a durable marker; the op is recorded failed for the operator.
          log "FATAL: cannot persist promoting marker; NOT promoting $PV, keeping $GEN_VERSION"
          rm -f "$PENDING_FILE"
          [ -n "$POP" ] && write_result "$POP" "failed" "$PV" "无法持久化提升标记（状态卷可能已满），未切换版本"
        fi
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
