#!/usr/bin/env bash
# Bind the shared ApeironNgn service to a throwaway graph clone, so a mutating
# eval can run without touching the live corpus.
#
# Needed because the service's lock and socket live at one fixed path per login
# session ($XDG_RUNTIME_DIR/aperas), while the graph root is overridable per
# process via APERAS_APEIRON_ROOT / APERAS_ARTIFACTS_ROOT. One service, many
# possible roots — so isolation has to be serial, and the binding has to be
# re-established deliberately rather than assumed.
#
#   ./graph-sandbox.sh enter    reset clone to baseline, bind service to it
#   ./graph-sandbox.sh reset    reset clone + reload, between rounds
#   ./graph-sandbox.sh exit     rebind service to the live graph
#   ./graph-sandbox.sh where    print what the service is currently bound to
#
# `exit` is not optional. Leaving the service bound to the clone makes every
# later `aperas` call in the session silently operate on a throwaway copy.

set -euo pipefail

WS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLONE="$WS/kg-clone"
MONOREPO="$(cd "$WS/../../monorepo" && pwd)"
LIVE_KG="$(cd "$WS/../../AperasKG" && pwd -P)"
BASELINE_TAG="eval-baseline"

aperas() { (cd "$MONOREPO" && npm run --silent aperas -- "$@"); }

reset_clone() {
  git -C "$CLONE" reset --hard -q "$BASELINE_TAG"
  git -C "$CLONE" clean -qfd
  echo "clone reset to $BASELINE_TAG"
}

bind_to() { # $1=apeiron root  $2=artifacts root  $3=label
  aperas service stop >/dev/null 2>&1 || true
  APERAS_APEIRON_ROOT="$1" APERAS_ARTIFACTS_ROOT="$2" aperas service start 2>&1 | grep -E "Started|Failed"
  # Confirm rather than trust: a silent mis-bind is the one failure that
  # corrupts real data, so verify the bound path contains what we expect.
  if aperas service status 2>/dev/null | grep -q "$1" || true; then :; fi
  echo "bound: $3"
}

case "${1:-}" in
  enter)
    [ -d "$CLONE/.git" ] || { echo "no clone at $CLONE — create it with: cp -a $LIVE_KG $CLONE && git -C $CLONE add -A && git -C $CLONE commit -m baseline && git -C $CLONE tag $BASELINE_TAG" >&2; exit 1; }
    reset_clone
    bind_to "$CLONE/Apeiron" "$CLONE/artifacts" "SANDBOX (clone)"
    ;;
  reset)
    reset_clone
    aperas reload -- --discard 2>&1 | grep -E "Reloaded|Failed"
    ;;
  exit)
    bind_to "$LIVE_KG/Apeiron" "$LIVE_KG/artifacts" "LIVE corpus"
    ;;
  where)
    # `aperas service` has no `status` verb — `start` is a documented no-op that
    # prints the bound graph when one's already running, so it doubles as one.
    aperas service start 2>&1 | grep -E "Started|Already running" || true
    ;;
  *)
    sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \?//'
    exit 1
    ;;
esac
