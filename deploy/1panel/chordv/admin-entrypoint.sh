#!/usr/bin/env sh
# ChordV admin (static) container entrypoint.
#
# The admin bundle is NOT baked into this image. api + admin ship as one release
# unit: the api container writes each release into the shared releases volume and
# records the active version in the shared state volume. This container just serves
# apps/admin/dist out of whatever version is current, and re-points when the api
# self-updates — so admin follows the backend with no updater of its own.
set -u

RELEASES_DIR="${CHORDV_ADMIN_RELEASES_DIR:-/usr/share/nginx/releases}"
STATE_DIR="${CHORDV_ADMIN_STATE_DIR:-/usr/share/nginx/state}"
WEBROOT_LINK="${CHORDV_ADMIN_WEBROOT_LINK:-/usr/share/nginx/current}"
ADMIN_SUBPATH="${CHORDV_ADMIN_SUBPATH:-apps/admin/dist}"
DESIRED_FILE="$STATE_DIR/desired-version"
POLL_SECONDS="${CHORDV_ADMIN_POLL_SECONDS:-3}"
WAIT_TIMEOUT="${CHORDV_ADMIN_WAIT_TIMEOUT:-300}"

log() { printf '%s [admin] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }

# Render the nginx server config ourselves: the stock nginx entrypoint only runs
# its envsubst/template init when the command is "nginx", which it isn't here.
TEMPLATE="/etc/nginx/templates/default.conf.template"
if [ -f "$TEMPLATE" ]; then
  envsubst '${CHORDV_API_UPSTREAM}' < "$TEMPLATE" > /etc/nginx/conf.d/default.conf
  log "rendered nginx conf (upstream ${CHORDV_API_UPSTREAM:-unset})"
fi

resolve_dist() {
  # echoes the admin dist dir for the desired (or newest) release, or nothing.
  local v dir
  v="$( [ -f "$DESIRED_FILE" ] && tr -d ' \t\r\n' < "$DESIRED_FILE" )"
  if [ -n "$v" ] && [ -d "$RELEASES_DIR/$v/$ADMIN_SUBPATH" ]; then
    printf '%s' "$RELEASES_DIR/$v/$ADMIN_SUBPATH"; return 0
  fi
  # fall back to the newest release dir that has an admin bundle
  for dir in $(ls -1 "$RELEASES_DIR" 2>/dev/null | sort -Vr); do
    if [ -d "$RELEASES_DIR/$dir/$ADMIN_SUBPATH" ]; then
      printf '%s' "$RELEASES_DIR/$dir/$ADMIN_SUBPATH"; return 0
    fi
  done
  return 1
}

point_webroot() { ln -sfn "$1" "$WEBROOT_LINK"; }

# Wait for the api container to populate the shared release volume on first boot.
waited=0
until DIST="$(resolve_dist)"; do
  if [ "$waited" -ge "$WAIT_TIMEOUT" ]; then
    log "FATAL: no admin bundle in $RELEASES_DIR after ${WAIT_TIMEOUT}s"; exit 1
  fi
  log "waiting for a release with $ADMIN_SUBPATH ..."
  sleep "$POLL_SECONDS"; waited=$((waited + POLL_SECONDS))
done
point_webroot "$DIST"
CURRENT_DIST="$DIST"
log "serving $DIST"

nginx -g 'daemon on;'

# Follow the active version: when the api self-updates, re-point + reload.
while true; do
  sleep "$POLL_SECONDS"
  NEW_DIST="$(resolve_dist || true)"
  if [ -n "$NEW_DIST" ] && [ "$NEW_DIST" != "$CURRENT_DIST" ]; then
    log "version change: $CURRENT_DIST -> $NEW_DIST"
    point_webroot "$NEW_DIST"
    CURRENT_DIST="$NEW_DIST"
    nginx -s reload || log "nginx reload failed"
  fi
done
