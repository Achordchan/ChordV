#!/usr/bin/env sh
# ChordV admin (static) container entrypoint.
#
# The admin bundle is NOT baked into this image. api + admin ship as one release
# unit: the api container writes each release into the shared releases volume and
# publishes only the health-approved last-good-version in the public marker volume.
# Private state (including legacy backups) is never mounted here. This container serves
# apps/admin/dist out of whatever version is current, and re-points when the api
# self-updates — so admin follows the backend with no updater of its own.
set -u

RELEASES_DIR="${CHORDV_ADMIN_RELEASES_DIR:-/usr/share/nginx/releases}"
# This must be the dedicated public marker mount, NEVER the API's private state.
STATE_DIR="${CHORDV_ADMIN_STATE_DIR:-/usr/share/nginx/public-state}"
WEBROOT_LINK="${CHORDV_ADMIN_WEBROOT_LINK:-/usr/share/nginx/current}"
ADMIN_SUBPATH="${CHORDV_ADMIN_SUBPATH:-apps/admin/dist}"
# Follow the HEALTH-APPROVED version (last-good-version), NOT desired-version. The
# supervisor flips desired-version/`current` BEFORE the candidate API passes readiness
# + stabilization; serving the admin bundle from that would let clients load an
# unapproved release during a promotion, and — after a rollback deletes that release —
# leave already-loaded pages requesting lazy chunks that now 404. last-good-version is
# written ONLY after the health gate + stabilization succeed, so admin always serves a
# confirmed release that matches (or safely lags) the API by at most the gate window.
LAST_GOOD_FILE="$STATE_DIR/last-good-version"
POLL_SECONDS="${CHORDV_ADMIN_POLL_SECONDS:-3}"
WAIT_TIMEOUT="${CHORDV_ADMIN_WAIT_TIMEOUT:-300}"

log() { printf '%s [admin] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }

# Render the nginx server config ourselves: the stock nginx entrypoint only runs
# its envsubst/template init when the command is "nginx", which it isn't here.
: "${CHORDV_ADMIN_RESOLVER:=127.0.0.11}" # Docker's embedded DNS by default
export CHORDV_ADMIN_RESOLVER
TEMPLATE="/etc/nginx/templates/default.conf.template"
if [ -f "$TEMPLATE" ]; then
  envsubst '${CHORDV_API_UPSTREAM} ${CHORDV_ADMIN_RESOLVER}' < "$TEMPLATE" > /etc/nginx/conf.d/default.conf
  log "rendered nginx conf (upstream ${CHORDV_API_UPSTREAM:-unset}, resolver ${CHORDV_ADMIN_RESOLVER})"
fi

resolve_dist() {
  # Echoes the admin dist dir for the HEALTH-APPROVED (last-good) release, or nothing.
  # Deliberately NO "newest release" fallback: serving an arbitrary/unapproved bundle
  # is exactly what we must avoid. Before the API's first healthy boot writes
  # last-good-version, this returns nothing and the caller waits (first boot) or keeps
  # serving the currently-approved bundle (steady state) instead of switching.
  local v
  v="$( [ -f "$LAST_GOOD_FILE" ] && tr -d ' \t\r\n' < "$LAST_GOOD_FILE" )"
  if [ -n "$v" ] && [ -d "$RELEASES_DIR/$v/$ADMIN_SUBPATH" ]; then
    printf '%s' "$RELEASES_DIR/$v/$ADMIN_SUBPATH"; return 0
  fi
  return 1
}

point_webroot() { ln -sfn "$1" "$WEBROOT_LINK"; }

# Wait for the api container to populate the shared release volume on first boot.
waited=0
until DIST="$(resolve_dist)"; do
  if [ "$waited" -ge "$WAIT_TIMEOUT" ]; then
    log "FATAL: no admin bundle in $RELEASES_DIR after ${WAIT_TIMEOUT}s"; exit 1
  fi
  log "waiting for a health-approved release with $ADMIN_SUBPATH (last-good-version) ..."
  sleep "$POLL_SECONDS"; waited=$((waited + POLL_SECONDS))
done
point_webroot "$DIST"
CURRENT_DIST="$DIST"
log "serving $DIST"

# Validate config, then start the master as a daemon. If nginx fails to start
# (bad config), abort so Docker's restart policy can react instead of leaving a
# "running" container serving nothing.
if ! nginx -t; then
  log "FATAL: nginx config test failed"; exit 1
fi
if ! nginx -g 'daemon on;'; then
  log "FATAL: nginx failed to start"; exit 1
fi

PID_FILE="${CHORDV_ADMIN_NGINX_PID:-/var/run/nginx.pid}"

# Follow the active version AND supervise the nginx master: exit (non-zero) if the
# master dies, so PID 1 does not keep the container "up" with no web server.
while true; do
  sleep "$POLL_SECONDS"

  NGINX_PID="$( [ -f "$PID_FILE" ] && tr -d ' \t\r\n' < "$PID_FILE" )"
  if [ -z "$NGINX_PID" ] || ! kill -0 "$NGINX_PID" 2>/dev/null; then
    log "FATAL: nginx master is not running; exiting so the container restarts"
    exit 1
  fi

  NEW_DIST="$(resolve_dist || true)"
  if [ -n "$NEW_DIST" ] && [ "$NEW_DIST" != "$CURRENT_DIST" ]; then
    log "version change: $CURRENT_DIST -> $NEW_DIST"
    point_webroot "$NEW_DIST"
    CURRENT_DIST="$NEW_DIST"
    nginx -s reload || log "nginx reload failed"
  fi
done
