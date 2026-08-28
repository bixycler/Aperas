#!/usr/bin/env bash
# Compact, local-time, newest-first commit log for the Aperas KG substrate.
# A git-log --oneline equivalent for `tdb log`, which prints UTC in a multi-line
# Date:/Author:/Message: block and has no --oneline of its own.
#
# Usage:
#   tdb-log.sh [--count N] [--filter STRING]
#
#   --count N       how many commits to fetch before filtering (default: 20; use -1 for all)
#   --filter STRING only show commits whose message contains STRING (e.g. an artifact path) --
#                    much faster than `tdb history --id=...` for this project, since our
#                    commit messages already embed the artifact path.
#
# Auto-pipes through `less` when --count is -1 (unlimited) or greater than 20, and stdout
# is an interactive terminal -- small counts print directly, large/unlimited ones page.
set -euo pipefail

CONTAINER="${TERMINUSDB_CONTAINER:-terminusdb}"
DB_SPEC="${TERMINUSDB_DB_SPEC:-admin/aperas_apeiron}"
TDB_BIN="/app/terminusdb/terminusdb"

count=20
filter=""
while [ $# -gt 0 ]; do
  case "$1" in
    --count) count="$2"; shift 2 ;;
    --filter) filter="$2"; shift 2 ;;
    *) echo "Usage: $0 [--count N] [--filter STRING]" >&2; exit 1 ;;
  esac
done

run() {
  docker exec "$CONTAINER" "$TDB_BIN" log "$DB_SPEC" --json --count "$count" 2>/dev/null \
    | jq -c --arg f "$filter" '.[] | select($f == "" or (.message | contains($f)))' \
    | python3 -c "
import json, sys, datetime
for line in sys.stdin:
    c = json.loads(line)
    ts_local = datetime.datetime.fromtimestamp(c['timestamp']).astimezone()
    print(f\"{c['identifier'][:8]}  {ts_local.strftime('%Y-%m-%d %H:%M:%S %Z')}  {c['message']}\")
"
}

if [ -t 1 ] && { [ "$count" -eq -1 ] || [ "$count" -gt 20 ]; }; then
  run | less
else
  run
fi
