#!/usr/bin/env sh
# Run on Linux (the admin image uses GNU mv), against the actual production helper.
set -eu
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
root="$(mktemp -d)"
reader=""
trap '[ -z "$reader" ] || kill "$reader" 2>/dev/null || true; rm -rf "$root"' EXIT
log() { printf '%s\n' "$*" >&2; }
eval "$(sed -n '/^point_webroot() {/,/^}/p' "$REPO/deploy/1panel/chordv/admin-entrypoint.sh")"
mkdir "$root/old" "$root/new"
printf old > "$root/old/index.html"
printf new > "$root/new/index.html"
WEBROOT_LINK="$root/current"
# Simulate the exact leftover name after a PID-reusing container restart.
ln -s "$root/missing-release" "${WEBROOT_LINK}.tmp.$$"
point_webroot "$root/old"
[ "$(cat "$WEBROOT_LINK/index.html")" = old ]
[ ! -L "${WEBROOT_LINK}.tmp.$$" ]
printf run > "$root/run"
(
  printf ready > "$root/reader-ready"
  while [ -f "$root/run" ]; do
    if value="$(cat "$WEBROOT_LINK/index.html")"; then
      case "$value" in old|new) ;; *) printf invalid > "$root/read-failed"; exit 1 ;; esac
    else
      printf missing > "$root/read-failed"; exit 1
    fi
  done
) &
reader=$!
while [ ! -f "$root/reader-ready" ]; do sleep 0.01; done
i=0
while [ "$i" -lt 300 ]; do
  point_webroot "$root/new"
  point_webroot "$root/old"
  i=$((i + 1))
done
rm "$root/run"
wait "$reader"
reader=""
[ ! -f "$root/read-failed" ]
[ "$(readlink "$WEBROOT_LINK")" = "$root/old" ]
# A failed rename must retain the prior root and remove only its own temporary link.
mv() { return 1; }
if point_webroot "$root/new"; then exit 1; fi
unset -f mv
[ "$(cat "$WEBROOT_LINK/index.html")" = old ]
[ ! -L "${WEBROOT_LINK}.tmp.$$" ]
# Failed stale-link cleanup must preserve both the active root and recovery evidence.
ln -s "$root/new" "${WEBROOT_LINK}.tmp.$$"
rm() { return 1; }
if point_webroot "$root/new"; then exit 1; fi
unset -f rm
[ "$(cat "$WEBROOT_LINK/index.html")" = old ]
[ -L "${WEBROOT_LINK}.tmp.$$" ]
point_webroot "$root/new"
[ "$(cat "$WEBROOT_LINK/index.html")" = new ]
# An unexpected regular file is not a stale symlink and must not be removed.
printf evidence > "${WEBROOT_LINK}.tmp.$$"
if point_webroot "$root/old"; then exit 1; fi
[ "$(cat "${WEBROOT_LINK}.tmp.$$")" = evidence ]
[ "$(cat "$WEBROOT_LINK/index.html")" = new ]
rm "${WEBROOT_LINK}.tmp.$$"
# A real directory destination must never be interpreted as a target container.
WEBROOT_LINK="$root/directory"
mkdir "$WEBROOT_LINK"
if point_webroot "$root/new"; then exit 1; fi
[ -d "$WEBROOT_LINK" ]
[ ! -e "${WEBROOT_LINK}.tmp.$$" ]
printf 'system-update-webroot.regression.sh passed (600 atomic replacements, continuous reads, failure preservation)\n'
