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
# The supervisor writes the result only after readiness + stabilization (including
# rollback landings), or after a terminal failure decision. The app consumes these
# markers to reconcile its operation records; merely booting is not proof of success.
#
# Docker's `restart: unless-stopped` is a secondary safety net: it only matters
# if this supervisor process itself dies. Normal self-updates never exit the
# container — this loop relaunches the app in place.
set -u

RELEASES_DIR="${CHORDV_SYSTEM_RELEASES_DIR:-/app/releases}"
STATE_DIR="${CHORDV_SYSTEM_STATE_DIR:-/app/state}"
PUBLIC_STATE_DIR="${CHORDV_SYSTEM_PUBLIC_STATE_DIR:-/app/public-state}"
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
BACKUP_DIR="${CHORDV_SYSTEM_UPDATE_BACKUP_DIR:-/app/backups}"
SNAPSHOT_KEEP="${CHORDV_SYSTEM_UPDATE_SNAPSHOT_KEEP:-5}"
SNAPSHOT_TIMEOUT="${CHORDV_SYSTEM_UPDATE_SNAPSHOT_TIMEOUT:-600}"
API_PORT="${CHORDV_API_PORT:-3000}"
# Gate promotions on READINESS (exercises the DB), not bare liveness: a version
# that opens its port but has a broken Prisma runtime/schema must fail the gate
# and roll back, not become last-good.
HEALTH_PATH="${CHORDV_SYSTEM_HEALTH_PATH:-/api/health/ready}"
HEALTH_TIMEOUT="${CHORDV_SYSTEM_UPDATE_HEALTH_TIMEOUT_SECONDS:-90}"
FAILED_STOP_TIMEOUT="${CHORDV_SYSTEM_FAILED_STOP_TIMEOUT_SECONDS:-30}"
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
APPROVAL_FILE="$STATE_DIR/approved-generation"
# A new release must stay up AND healthy for this long before it is trusted as
# last-good — otherwise a version that serves one probe then crashes on delayed
# init would be restarted forever instead of rolled back.
STABILIZE_SECONDS="${CHORDV_SYSTEM_UPDATE_STABILIZE_SECONDS:-10}"

log() { printf '%s [supervisor] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }

read_file_trim() { [ -f "$1" ] && tr -d ' \t\r\n' < "$1" || true; }

parse_journal() {
  "$NODE_BIN" - "$1" "$2" <<'NODE'
try {
  const fs = require("node:fs");
  const file = process.argv[2], source = process.argv[3];
  if (!fs.statSync(file).isFile()) throw new Error();
  const journal = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!journal || typeof journal !== "object" || Array.isArray(journal)) throw new Error();
  const version = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
  const safeVersion = value => typeof value === "string" && value.trim() === value && version.test(value);
  if (!safeVersion(journal.version) || typeof journal.operationId !== "string" ||
      journal.operationId.trim() !== journal.operationId || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(journal.operationId) ||
      !["update", "rollback", "restart"].includes(journal.kind) ||
      typeof journal.migrationApplied !== "boolean") throw new Error();
  for (const key of ["rollbackFrom", "failureVersion", "failureReason"]) {
    if (Object.hasOwn(journal, key) && typeof journal[key] !== "string") throw new Error();
  }
  const rollback = journal.rollbackFrom || "", failure = journal.failureVersion || "", reason = journal.failureReason || "";
  if (rollback && (!safeVersion(rollback) || journal.kind !== "rollback" || rollback === journal.version)) throw new Error();
  if (failure && (!safeVersion(failure) || failure !== (rollback || journal.version))) throw new Error();
  // Reasons must be representable by supervisor JSON writers and single-line
  // transport. Recovery metadata belongs only to promoting.json, never pending.json.
  if (!!failure !== !!reason || /["\\\x00-\x1f\x7f]/.test(reason) ||
      (source === "pending" && (rollback || failure || reason))) throw new Error();
  process.stdout.write([journal.version, journal.operationId, journal.kind,
    String(journal.migrationApplied), rollback, failure, reason, "."].join("\n"));
} catch {
  process.exitCode = 1;
}
NODE
}

load_journal() {
  # Parse ONCE and carry validated fields in memory. Never let a truncated marker,
  # missing boolean, or read failure silently turn a promotion into a normal start.
  # Newline-separated output is data (never eval); safe fields cannot contain LF.
  local fields
  if ! fields="$(parse_journal "$1" "$2")"; then
    log "FATAL: invalid/unreadable $2 journal at $1; retaining marker and blocking recovery (repair offline)"
    exit 1
  fi
  {
    IFS= read -r JOURNAL_VERSION
    IFS= read -r JOURNAL_OP
    IFS= read -r JOURNAL_KIND
    IFS= read -r JOURNAL_MIG
    IFS= read -r JOURNAL_ROLLBACK
    IFS= read -r JOURNAL_FAILURE
    IFS= read -r JOURNAL_REASON
  } <<< "$fields"
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
  sync || return 1
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
  sync || return 1
  return 0
}

write_promoting() {
  # write_promoting <version> <operationId> <kind> [migrationApplied] [rollbackFrom] [failureVersion] [failureReason]
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
  if ! printf '{"version":"%s","operationId":"%s","kind":"%s","migrationApplied":%s,"rollbackFrom":"%s","failureVersion":"%s","failureReason":"%s"}\n' \
      "$1" "$2" "$3" "$migrated" "$rollback_from" "${6:-}" "${7:-}" > "$tmp"; then
    rm -f "$tmp" 2>/dev/null; return 1
  fi
  [ -s "$tmp" ] || { rm -f "$tmp" 2>/dev/null; return 1; }
  mv -f "$tmp" "$PROMOTING_FILE" || { rm -f "$tmp" 2>/dev/null; return 1; }
  sync || return 1
  return 0
}

prune_releases() {
  # Only called after this forward update is healthy and approved, while promoting
  # still fences competing system operations. Reuse the release's SemVer ordering.
  "$NODE_BIN" - "$RELEASES_DIR" "$GEN_VERSION" "$(read_file_trim "$LAST_GOOD_FILE.previous")" "${CHORDV_SYSTEM_UPDATE_KEEP_RELEASES:-3}" <<'NODE'
const fs = require("node:fs/promises"), path = require("node:path");
(async () => {
  const [root, current, previous, rawKeep] = process.argv.slice(2);
  if (!/^[1-9][0-9]{0,5}$/.test(rawKeep)) throw new Error("Invalid release retention");
  const { compareSemver } = require(path.join(root, current, "apps/api/dist/apps/api/src/modules/common/release-center.utils.js"));
  const entries = await fs.readdir(root, { withFileTypes: true });
  const names = entries.filter(entry => {
    if (!entry.isDirectory() || entry.name.startsWith(".")) return false;
    try { compareSemver(entry.name, entry.name); return true; } catch { return false; }
  }).map(entry => entry.name).sort((a, b) => compareSemver(b, a));
  const protectedNames = new Set([current, previous].filter(name => names.includes(name)));
  const removable = names.filter(name => !protectedNames.has(name));
  for (const name of removable.slice(Math.max(Number(rawKeep) - protectedNames.size, 0))) {
    await fs.rm(path.join(root, name), { recursive: true });
  }
})().catch(error => { console.error(`Release pruning failed: ${error.message}`); process.exitCode = 1; });
NODE
}

approve_generation() {
  # Ephemeral authorization for this exact process: a new random token is generated
  # on EVERY launch. Atomic visibility is enough; a lost file after host restart
  # cannot authorize the next process, which always has a different token.
  local tmp="$APPROVAL_FILE.tmp.$$"
  [ ! -d "$APPROVAL_FILE" ] || return 1
  if ! printf '%s' "$GEN_APPROVAL_TOKEN" > "$tmp" || ! mv -f "$tmp" "$APPROVAL_FILE"; then
    rm -f "$tmp" 2>/dev/null; return 1
  fi
}

clear_promoting() { rm -f "$PROMOTING_FILE" || return 1; sync; }

consume_pending() {
  # Keep the only recovery journal until its complete promotion context is durable.
  # Storage failures leave the operation pending, with bounded retry frequency; a
  # supervisor restart resumes from the same journal. Never launch during this gap.
  load_journal "$PENDING_FILE" pending
  GEN_VERSION="$JOURNAL_VERSION"; GEN_OP="$JOURNAL_OP"; GEN_KIND="$JOURNAL_KIND"
  GEN_PROMOTION=1; GEN_MIG="$JOURNAL_MIG"
  until write_promoting "$GEN_VERSION" "$GEN_OP" "$GEN_KIND" "$GEN_MIG"; do
    log "WARN: cannot persist promoting marker; retaining pending journal, retrying in 2s"
    sleep 2
  done
  # If removal fails, stop instead of leaving a stale request for a later app exit.
  rm -f "$PENDING_FILE" || { log "FATAL: cannot remove transferred pending journal"; exit 1; }
  log "pending $GEN_KIND -> $GEN_VERSION (op $GEN_OP)"
}

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
    sync || { log "FATAL: cannot synchronize seeded release"; exit 1; }
  fi
  printf '%s' "$seed_version"
}

wait_healthy() {
  # wait_healthy <pid> — 0 if the app answers health before timeout while alive.
  # X-Forwarded-Proto: https satisfies the production HTTPS-only guard for this
  # in-container probe, mirroring what the openresty terminator sends upstream.
  local pid="$1" started="$SECONDS" remaining probe_timeout
  local url="http://127.0.0.1:${API_PORT}${HEALTH_PATH}"
  while [ $((SECONDS - started)) -lt "$HEALTH_TIMEOUT" ]; do
    if ! kill -0 "$pid" 2>/dev/null; then
      log "app pid $pid exited during health gate"; return 1
    fi
    remaining=$((HEALTH_TIMEOUT - (SECONDS - started)))
    probe_timeout=3
    [ "$remaining" -ge "$probe_timeout" ] || probe_timeout="$remaining"
    # Count probe latency too and never give curl more than the remaining budget.
    if curl -fsS -o /dev/null --max-time "$probe_timeout" -H "X-Forwarded-Proto: https" "$url" 2>/dev/null; then
      [ $((SECONDS - started)) -lt "$HEALTH_TIMEOUT" ] && return 0
      break
    fi
    [ $((SECONDS - started)) -lt "$HEALTH_TIMEOUT" ] || break
    sleep 1
  done
  log "health gate timed out after ${HEALTH_TIMEOUT}s"; return 1
}

validate_health_timeout() {
  if ! [[ "$HEALTH_TIMEOUT" =~ ^[1-9][0-9]{0,4}$ ]] || [ "$HEALTH_TIMEOUT" -gt 86400 ]; then
    log "FATAL: health timeout must be an integer between 1 and 86400 seconds"
    return 1
  fi
}

validate_stabilization() {
  # Reject typos before promotion/migration. Zero would disable the stability gate;
  # bound the decimal range to avoid shell overflow and indefinite misconfiguration.
  if ! [[ "$STABILIZE_SECONDS" =~ ^[1-9][0-9]{0,4}$ ]] || [ "$STABILIZE_SECONDS" -gt 86400 ]; then
    log "FATAL: stabilization duration must be an integer between 1 and 86400 seconds"
    return 1
  fi
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
  local version="$1" tmp="$LAST_GOOD_FILE.tmp.$$" public_tmp="$PUBLIC_STATE_DIR/.last-good-version.tmp.$$"
  # Preserve the previous private target DURABLY before changing it. Public marker
  # publication is a separate filesystem operation and may fail across a restart.
  # Repeated attempts for the same candidate must not overwrite this predecessor.
  local previous previous_tmp="$LAST_GOOD_FILE.previous.tmp.$$"
  previous="$( [ -f "$LAST_GOOD_FILE" ] && tr -d ' \t\r\n' < "$LAST_GOOD_FILE" )"
  if [ -n "$previous" ] && [ "$previous" != "$version" ]; then
    if [ -d "$LAST_GOOD_FILE.previous" ] || ! printf '%s' "$previous" > "$previous_tmp" || ! mv -f "$previous_tmp" "$LAST_GOOD_FILE.previous"; then
      rm -f "$previous_tmp" 2>/dev/null; return 1
    fi
    sync || return 1
  fi
  if [ -d "$LAST_GOOD_FILE" ] || ! printf '%s' "$version" > "$tmp" || ! mv -f "$tmp" "$LAST_GOOD_FILE"; then
    rm -f "$tmp" 2>/dev/null
    return 1
  fi
  sync || return 1
  # Publish only the health-approved marker, AFTER the private rollback target.
  # Admin never mounts private state (which may still contain legacy DB snapshots).
  # A failed public write leaves the previous approved marker intact; callers retry
  # finalization, never expose desired-version or copy private state as a fallback.
  if [ -d "$PUBLIC_STATE_DIR/last-good-version" ] || ! mkdir -p "$PUBLIC_STATE_DIR" ||
     ! printf '%s' "$version" > "$public_tmp" || ! mv -f "$public_tmp" "$PUBLIC_STATE_DIR/last-good-version"; then
    rm -f "$public_tmp" 2>/dev/null
    return 1
  fi
  sync || return 1
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

snapshot_dump_invocation() {
  # Emit the pg_dump invocation parts for the pre-migration snapshot, separated
  # by \x1f (rejected in all fields, so it cannot collide): the connection URI
  # with its password stripped, then the exact decoded password ("" if absent).
  #
  # The URI is passed through BYTE-VERBATIM except for two removals — the
  # password and Prisma-only query options — so libpq itself resolves every
  # connection semantic (service/servicefile selection, PGPORT/PGHOST/PGDATABASE
  # defaults, unix sockets, IPv6 hosts, keepalives, target_session_attrs, ...).
  # No URI re-serialization on our side: each earlier attempt to translate the
  # URI into another representation (positional args, a generated service file)
  # lost some valid corner and broke updates. The password travels through the
  # dump subshell's ENVIRONMENT, which preserves exact bytes (including
  # leading/trailing whitespace) and never appears in /proc/<pid>/cmdline,
  # `docker top` or process telemetry. A URL that puts a secret in its query
  # (sslpassword) or mixes a password with passfile fails closed instead of
  # leaking or dropping one. Never print parser errors, which may echo the
  # connection string.
  "$NODE_BIN" - <<'NODE'
try {
  const raw = process.env.CHORDV_SYSTEM_UPDATE_SNAPSHOT_DATABASE_URL || process.env.DATABASE_URL;
  const url = new URL(raw);
  if (!["postgres:", "postgresql:"].includes(url.protocol) || url.hash) throw new Error();
  const prismaOnly = new Set([
    "schema", "connection_limit", "pool_timeout", "socket_timeout", "pgbouncer",
    "statement_cache_size", "sslaccept", "sslidentity"
  ]);
  const schemeEnd = raw.indexOf("://") + 3;
  const authorityEnd = ["/", "?", "#"].reduce(
    (end, ch) => {
      const at = raw.indexOf(ch, schemeEnd);
      return at === -1 ? end : Math.min(end, at);
    },
    raw.length
  );
  let authority = raw.slice(schemeEnd, authorityEnd);
  const rest = raw.slice(authorityEnd);
  // Strip ONLY the password from the authority; keep user/host/port bytes as-is.
  const at = authority.lastIndexOf("@");
  if (at >= 0) {
    const userinfo = authority.slice(0, at);
    const colon = userinfo.indexOf(":");
    if (colon >= 0) authority = userinfo.slice(0, colon) + authority.slice(at);
  }
  let pathAndFragment = rest;
  let query = "";
  const queryIndex = rest.indexOf("?");
  let hasPassfile = false;
  if (queryIndex >= 0) {
    const rawQuery = rest.slice(queryIndex + 1);
    pathAndFragment = rest.slice(0, queryIndex);
    const kept = [];
    for (const part of rawQuery.split("&")) {
      if (!part) continue;
      const eq = part.indexOf("=");
      const key = decodeURIComponent(part.slice(0, eq < 0 ? part.length : eq));
      if (prismaOnly.has(key)) continue;
      if (key === "sslpassword") throw new Error();
      if (key === "passfile") hasPassfile = true;
      kept.push(part);
    }
    if (kept.length > 0) query = "?" + kept.join("&");
  }
  const hasPassword = url.password !== "";
  // A password AND a passfile parameter are ambiguous precedence; refuse
  // rather than silently drop one of them.
  if (hasPassword && hasPassfile) throw new Error();
  const password = hasPassword ? decodeURIComponent(url.password) : "";
  if (/[\x00-\x1f\x7f]/.test(password)) throw new Error();
  process.stdout.write(raw.slice(0, schemeEnd) + authority + pathAndFragment + query + "\x1f" + password);
} catch {
  process.exitCode = 1;
}
NODE
}
normalize_snapshot_setting() {
  "$NODE_BIN" - "$SNAPSHOT_ENABLED" <<'NODE'
const value = process.argv[2].trim().toLowerCase();
if (!value || ["1", "true", "yes", "on"].includes(value)) process.stdout.write("true");
else if (["0", "false", "no", "off"].includes(value)) process.stdout.write("false");
else { console.error("Invalid CHORDV_SYSTEM_UPDATE_SNAPSHOT; expected true/false, 1/0, yes/no or on/off"); process.exitCode = 1; }
NODE
}

run_snapshot() {
  # run_snapshot <version> <operationId> — pre-migration DB snapshot. Returns non-zero
  # if a snapshot was required but could not be durably created; the caller then rolls
  # back instead of migrating (never migrate without a trustworthy recovery point).
  local version="$1" op="$2"
  SNAPSHOT_ENABLED="$(normalize_snapshot_setting)" || return 1
  [ "$SNAPSHOT_ENABLED" = "true" ] || return 0
  if [ -z "${CHORDV_SYSTEM_UPDATE_SNAPSHOT_DATABASE_URL:-${DATABASE_URL:-}}" ]; then
    log "ERROR: snapshot database URL not set; cannot snapshot before migrate"
    return 1
  fi
  # Reject zero/invalid retention BEFORE creating or reusing a recovery point.
  if ! [[ "$SNAPSHOT_KEEP" =~ ^[1-9][0-9]{0,5}$ ]]; then
    log "ERROR: snapshot retention must be an integer between 1 and 999999"; return 1
  fi
  if [ -L "$BACKUP_DIR" ] || ! (umask 077; mkdir -p "$BACKUP_DIR") || ! chmod 700 "$BACKUP_DIR"; then
    log "ERROR: cannot secure backup directory"; return 1
  fi
  # Reuse a snapshot ONLY when it belongs to THIS SAME operation (keyed by opId), i.e.
  # we are resuming the very same promotion after a crash/re-gate. A later retry of the
  # same VERSION is a different operation (new opId) and MUST take a fresh snapshot, or
  # a restore would silently discard all writes that happened since the first attempt.
  # Only a fully-finalized snapshot (final name) counts as reusable — a crash mid-dump
  # leaves a distinct .partial file (below) that never matches this glob, so the resume
  # takes a fresh dump instead of trusting a truncated one.
  local base="pre-migrate-${version}-${op}"
  local existing
  for existing in "$BACKUP_DIR/$base"-*.sql.gz; do
    [ -e "$existing" ] || continue
    if [ -L "$existing" ] || [ ! -f "$existing" ] || ! chmod 600 "$existing"; then
      log "ERROR: cannot secure existing snapshot"; return 1
    fi
    # The finalized name proves a previous write completed, not that its bytes
    # survived later corruption. Do not replace a damaged pre-migration recovery
    # point with a fresh dump of a possibly already-migrated database.
    if [ ! -s "$existing" ] || ! timeout -k 30 "$SNAPSHOT_TIMEOUT" gzip -t "$existing" 2>/dev/null; then
      log "ERROR: existing snapshot is corrupt or cannot be verified; refusing migration"
      return 1
    fi
    sync || { log "ERROR: cannot synchronize reused snapshot"; return 1; }
    log "pre-migrate snapshot for op ${op} already exists; reusing it"
    return 0
  done
  local stamp target tmp out uri password
  if ! out="$(snapshot_dump_invocation)"; then
    log "ERROR: invalid snapshot database URL; cannot snapshot before migrate"
    return 1
  fi
  # \x1f cannot occur in either field (control characters are rejected), and
  # read with a non-whitespace IFS preserves leading/trailing spaces exactly.
  IFS=$'\x1f' read -r uri password <<< "$out"
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  target="$BACKUP_DIR/${base}-${stamp}.sql.gz"
  # Dump to a .partial temp name first; it is NOT reusable (doesn't match the glob) and
  # is only renamed to the final name after gzip integrity is verified and flushed —
  # so a truncated dump from a crash can never be mistaken for a valid recovery point.
  tmp="$(umask 077; mktemp "$BACKUP_DIR/.${base}-${stamp}.sql.gz.partial.XXXXXX")" || return 1
  log "snapshotting database before migrate -> $(basename "$target") (timeout ${SNAPSHOT_TIMEOUT}s)"
  # pipefail so a pg_dump failure fails the pipe even though gzip succeeds; timeout so a
  # hung dump can't wedge the container after the old process has already exited.
  # The URI argument carries no password (only the coordinates/options libpq
  # needs, exactly as before); the password travels via the subshell's
  # environment, which preserves exact bytes and stays out of /proc cmdline.
  # pg_dump errors are suppressed (they may echo connection data).
  if ! (
    umask 077
    set -o pipefail
    if [ -n "$password" ]; then export PGPASSWORD="$password"; fi
    timeout -k 30 "$SNAPSHOT_TIMEOUT" pg_dump "$uri" 2>/dev/null | gzip > "$tmp"
  ); then
    log "ERROR: database snapshot failed"
    rm -f "$tmp" 2>/dev/null
    return 1
  fi
  [ -s "$tmp" ] || { log "ERROR: database snapshot is empty"; rm -f "$tmp" 2>/dev/null; return 1; }
  # Verify the gzip archive is COMPLETE before trusting/renaming it.
  if ! gzip -t "$tmp" 2>/dev/null; then
    log "ERROR: snapshot archive is corrupt/incomplete"; rm -f "$tmp" 2>/dev/null; return 1
  fi
  if ! sync; then
    log "ERROR: cannot synchronize snapshot contents"; rm -f "$tmp" 2>/dev/null; return 1
  fi
  if ! mv -f "$tmp" "$target"; then
    log "ERROR: cannot finalize snapshot"; rm -f "$tmp" 2>/dev/null; return 1
  fi
  if ! sync; then
    log "ERROR: cannot synchronize published snapshot"; return 1
  fi
  prune_snapshots
  return 0
}

run_migrate() {
  local release="$1"
  # Both automatic and operator-requested rollbacks must launch the old code even
  # after a partially failed forward migration: Prisma migrate deploy would reject
  # the unfinished history with P3009, including from the older release. Readiness
  # and stabilization still verify the fallback actually works against this DB.
  [ "$GEN_KIND" != "rollback" ] || { log "skipping migrations for rollback $(basename "$release")"; return 0; }
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

persist_failed_promotion() {
  local attempted="$1" reason="$2" migrated="$3"
  # Journal the terminal decision before publishing it. A crash after this write
  # resumes the SAME failure, never re-gates a recovered app into a false success.
  # If the whole volume is unwritable, keep the decision/context in memory and do
  # not launch anything until the journal and result can both be persisted.
  until write_promoting "$GEN_VERSION" "$GEN_OP" "$GEN_KIND" "$migrated" \
      "${GEN_ROLLBACK_FROM:-}" "$attempted" "$reason"; do
    log "WARN: cannot persist terminal failure decision; retrying in 2s"
    sleep 2
  done
  if [ -n "$GEN_OP" ]; then
    until write_result "$GEN_OP" "failed" "$attempted" "$reason" "$migrated"; do
      log "WARN: could not persist failure result; keeping full promotion context, retrying in 2s"
      sleep 2
    done
  fi
  # The terminal journal is ALSO a durable launch interlock. Clearing it would turn
  # this candidate into an ordinary startup on the next loop/container restart,
  # bypassing its snapshot gate (migrationApplied=false describes the failed attempt,
  # not permission to run migrations without a snapshot). Never re-gate this operation
  # into success, even if the app or snapshot dependency has since recovered.
  # Offline recovery: stop the container, repair the cause, stage pending.json with a
  # NEW operationId and the appropriate migrationApplied/kind, then remove this
  # promoting.json interlock and restart. Keep the original failed result for audit.
  log "FATAL: promotion recovery blocked by $PROMOTING_FILE; stop container, repair cause, stage a NEW operation in pending.json, then remove promoting.json and restart (keep failed result)"
  exit 1
}

handle_failed_promotion() {
  # A promoted release failed to come up (migration / health gate / stabilization).
  # Roll back to last-good when we can; otherwise persist failure and block launch.
  # Mutates the GEN_* globals for the next loop iteration. $1 is a reason string.
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
    MIG="$GEN_MIG"
  fi
  if [ "$GEN_PROMOTION" = "1" ]; then
    # Restart promises to keep the selected version; an unhealthy restart must not
    # silently become a downgrade merely because a predecessor is available.
    if [ "$GEN_KIND" = "restart" ]; then
      persist_failed_promotion "$GEN_VERSION" "${reason}（重启失败，未切换版本，请人工恢复）" "$MIG"
    fi
    LG="$(read_file_trim "$LAST_GOOD_FILE")"
    if [ "$LG" = "$GEN_VERSION" ]; then
      LG="$(read_file_trim "$LAST_GOOD_FILE.previous")"
    fi
    # A failed rollback landing must never bounce back to the original bad candidate.
    [ "$LG" != "${GEN_ROLLBACK_FROM:-}" ] || LG=""
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
      GEN_VERSION="$LG"; GEN_KIND="rollback"; GEN_PROMOTION=1; GEN_MIG="$MIG"
      return 0
    fi
    # No fallback: persist a terminal failure AND retain the launch interlock.
    # Retrying as an ordinary startup could bypass a failed pre-migration snapshot.
    #
    # Record the ORIGINALLY ATTEMPTED version, not the version we happen to be sitting
    # on. If this is a rollback LANDING that ALSO failed, GEN_VERSION is now last-good
    # but the operation's real target was the candidate that started the failure
    # (GEN_ROLLBACK_FROM) — writing last-good here would collapse the audit's toVersion
    # and lose which candidate actually failed.
    local attempted="${GEN_ROLLBACK_FROM:-}"
    attempted="${attempted:-$GEN_VERSION}"
    persist_failed_promotion "$attempted" "${reason}（无可回滚版本）" "$MIG"
  fi
  log "no known-good version to fall back to; retrying $GEN_VERSION in 3s"
  sleep 3
  GEN_OP=""; GEN_KIND=""; GEN_PROMOTION=0; GEN_MIG="false"; GEN_ROLLBACK_FROM=""; GEN_ROLLBACK_REASON=""
  return 0
}

stop_failed_candidate() {
  # A failed health gate cannot rely on the application's drain eventually exiting.
  # Keep the existing promotion journal throughout graceful shutdown. Before forced
  # termination, persist a terminal decision so a supervisor crash cannot approve
  # this candidate on restart. Only a confirmed process exit permits rollback.
  local pid="$APP_PID" started="$SECONDS"
  if ! [[ "$FAILED_STOP_TIMEOUT" =~ ^[1-9][0-9]{0,2}$ ]]; then
    log "FATAL: failed-candidate shutdown timeout must be 1..999 seconds"; exit 1
  fi
  kill -TERM "$pid" 2>/dev/null || true
  while kill -0 "$pid" 2>/dev/null && [ $((SECONDS - started)) -lt "$FAILED_STOP_TIMEOUT" ]; do sleep 1; done
  if kill -0 "$pid" 2>/dev/null; then
    log "WARN: failed candidate did not stop within ${FAILED_STOP_TIMEOUT}s"
    if [ "$GEN_PROMOTION" = "1" ] && ! write_promoting "$GEN_VERSION" "$GEN_OP" "$GEN_KIND" "$GEN_MIG" \
        "${GEN_ROLLBACK_FROM:-}" "${GEN_ROLLBACK_FROM:-$GEN_VERSION}" "健康检查失败且应用关闭超时，需确认恢复状态"; then
      log "FATAL: cannot persist shutdown recovery decision; retaining original journal and stopping container"
      exit 1
    fi
    kill -KILL "$pid" 2>/dev/null || true
    started="$SECONDS"
    while kill -0 "$pid" 2>/dev/null && [ $((SECONDS - started)) -lt 5 ]; do sleep 1; done
    if kill -0 "$pid" 2>/dev/null; then
      log "FATAL: failed candidate still alive after SIGKILL; stopping container without launching fallback"
      exit 1
    fi
  fi
  wait "$pid" 2>/dev/null || true
  APP_PID=""
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

SNAPSHOT_ENABLED="$(normalize_snapshot_setting)" || exit 1
validate_stabilization || exit 1
validate_health_timeout || exit 1
mkdir -p "$STATE_DIR" "$RELEASES_DIR"

# Snapshot credentials now travel only through process environment variables,
# never files. Earlier iterations of this code wrote credential files (.pgpass.*
# in the persistent backup volume, .chordv-pgservice.* on ephemeral storage) —
# sweep every location those versions could have left behind.
rm -f /dev/shm/.chordv-pgservice.* "${TMPDIR:-/tmp}"/.chordv-pgservice.* 2>/dev/null
rm -f "$BACKUP_DIR"/.pgpass.* 2>/dev/null

# Resume an interrupted promotion: if we restarted after desired-version was
# switched but before the health gate finished, treat it as a promotion again so
# it is health-gated and can still roll back (instead of retrying forever / being
# reconciled as a success it never earned).
GEN_MIG="false"; GEN_ROLLBACK_FROM=""; GEN_ROLLBACK_REASON=""
if [ -e "$PROMOTING_FILE" ] || [ -L "$PROMOTING_FILE" ]; then
  load_journal "$PROMOTING_FILE" promoting
  sync || { log "FATAL: cannot synchronize resumed promotion journal; retaining all markers"; exit 1; }
  RESUME_V="$JOURNAL_VERSION"; RESUME_OP="$JOURNAL_OP"; RESUME_KIND="$JOURNAL_KIND"
  RESUME_FAILURE="$JOURNAL_FAILURE"; RESUME_REASON="$JOURNAL_REASON"
  GEN_MIG="$JOURNAL_MIG"; GEN_ROLLBACK_FROM="$JOURNAL_ROLLBACK"
  if [ -e "$PENDING_FILE" ] || [ -L "$PENDING_FILE" ]; then
    # Crash after promoting was committed but before pending was removed: finish
    # only that exact handoff. Conflicting journals need offline recovery, not replay.
    load_journal "$PENDING_FILE" pending
    if [ "$JOURNAL_VERSION" != "$RESUME_V" ] || [ "$JOURNAL_OP" != "$RESUME_OP" ] ||
       [ "$JOURNAL_KIND" != "$RESUME_KIND" ] || [ "$JOURNAL_MIG" != "$GEN_MIG" ]; then
      log "FATAL: conflicting pending/promoting journals; retaining both for offline recovery"
      exit 1
    fi
    rm -f "$PENDING_FILE" || { log "FATAL: cannot remove transferred pending journal"; exit 1; }
  fi
  if [ -n "$RESUME_FAILURE" ]; then
    log "resuming terminal failure persistence (op $RESUME_OP)"
    GEN_VERSION="$RESUME_V"; GEN_OP="$RESUME_OP"; GEN_KIND="$RESUME_KIND"; GEN_PROMOTION=1
    persist_failed_promotion "$RESUME_FAILURE" "$RESUME_REASON" "$GEN_MIG"
  elif [ -n "$RESUME_V" ] && [ -d "$RELEASES_DIR/$RESUME_V" ]; then
    log "resuming interrupted promotion -> $RESUME_V (op $RESUME_OP)"
    GEN_VERSION="$RESUME_V"; GEN_OP="$RESUME_OP"; GEN_KIND="$RESUME_KIND"; GEN_PROMOTION=1
  else
    # A previously started migration may have committed before the release was
    # lost. Preserve that risk and the original target, and block unverified starts.
    GEN_VERSION="$RESUME_V"; GEN_OP="$RESUME_OP"; GEN_KIND="$RESUME_KIND"; GEN_PROMOTION=1
    persist_failed_promotion "${GEN_ROLLBACK_FROM:-$RESUME_V}" "提升过程中断且目标版本缺失，请检查数据库并人工恢复" "$GEN_MIG"
  fi
elif [ -e "$PENDING_FILE" ] || [ -L "$PENDING_FILE" ]; then
  consume_pending
else
  GEN_VERSION="$(resolve_start_version)"; GEN_OP=""; GEN_KIND=""; GEN_PROMOTION=0
fi
# Validated migration/rollback context is retained across loop iterations and
# recovered from the journal above, never reread through a permissive extractor.

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
  # (kind=rollback) deliberately skips migrate deploy, including when unfinished
  # forward migrations remain; taking another snapshot would only delay recovery.
  # migrationApplied was validated with the complete journal before promotion.
  PROMO_MIG="$GEN_MIG"
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

  GEN_APPROVAL_TOKEN="$("$NODE_BIN" -e 'process.stdout.write(require("node:crypto").randomUUID())')" || exit 1
  [ -n "$GEN_APPROVAL_TOKEN" ] || exit 1
  export CHORDV_SYSTEM_APPROVAL_TOKEN="$GEN_APPROVAL_TOKEN"
  export CHORDV_SYSTEM_APPROVAL_FILE="$APPROVAL_FILE"
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
    RESULT_OK=0
    APPROVAL_OK=0
    PRUNE_OK=0
    # Finalize the operation ONLY now — after health + stabilization. The app does
    # not self-confirm on boot (a version can open the port then fail during delayed
    # init); it consumes this marker to mark the op succeeded.
    SUCC_MIG="$GEN_MIG"
    # 'rolledback' is reserved for an AUTOMATIC rollback LANDING — identified by a
    # non-empty rollbackFrom (the failed version handle_failed_promotion recorded) —
    # and written only now that last-good has itself passed readiness + stabilization,
    # so we never claim a rollback that failed to restore service. An OPERATOR-requested
    # rollback (kind=rollback but NO rollbackFrom) that comes up healthy is a normal
    # 'success': the target is exactly what the admin asked for, and reporting it as
    # "auto-rolled-back after a failed health check" would be wrong. migrationApplied
    # carries the failed update's value so the app can still warn about the schema.
    RB_FROM="${GEN_ROLLBACK_FROM:-}"
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
      if [ "$RESULT_OK" != "1" ]; then
        if [ -n "$GEN_OP" ] && ! write_result "$GEN_OP" "$RES_STATUS" "$GEN_VERSION" "$RES_REASON" "$SUCC_MIG"; then
          log "WARN: could not persist ${RES_STATUS} result; keeping full promotion context, retrying in 2s"
          sleep 2
          continue
        fi
        RESULT_OK=1
      fi
      if [ "$APPROVAL_OK" != "1" ]; then
        if ! approve_generation; then
          log "WARN: cannot approve current process; business traffic remains gated, retrying in 2s"
          sleep 2
          continue
        fi
        APPROVAL_OK=1
      fi
      if [ "$PRUNE_OK" != "1" ]; then
        if [ "$GEN_KIND" = "update" ] && [ "$RES_STATUS" = "success" ]; then
          prune_releases || log "WARN: historical release pruning failed; keeping remaining history"
        fi
        PRUNE_OK=1
      fi
      # A leftover marker fences future operations. Retry its removal before
      # dropping context, without republishing results already consumed by the API.
      if ! clear_promoting; then
        log "WARN: cannot clear promoting marker; keeping full promotion context, retrying in 2s"
        sleep 2
        continue
      fi
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
    GEN_OP=""; GEN_KIND=""; GEN_PROMOTION=0; GEN_MIG="false"; GEN_ROLLBACK_FROM=""; GEN_ROLLBACK_REASON=""
    wait "$APP_PID"; EXIT_CODE=$?
    APP_PID=""
    log "app for $GEN_VERSION exited (code $EXIT_CODE)"

    if [ -e "$PENDING_FILE" ] || [ -L "$PENDING_FILE" ]; then
      consume_pending
    else
      log "no pending marker; restarting $GEN_VERSION"
    fi
    continue
  fi

  # Failed to come up (never healthy, or crashed during stabilization) → roll back.
  log "$GEN_VERSION failed to become healthy+stable"
  stop_failed_candidate
  handle_failed_promotion "新版本健康检查未通过，已自动回滚"
done
