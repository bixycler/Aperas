#!/usr/bin/env bash
# `tdb doc get`, but readable: ISO-8601 UTC timestamps converted to local time, and
# string fields with embedded newlines (rawMarkdown, content, ...) printed as real line
# breaks instead of literal "\n" in the JSON text.
#
# Usage: forwards everything to `tdb doc get DB_SPEC OPTIONS` as-is, e.g.:
#   tdb-doc.sh --type="DocumentNode" --count 1
#   tdb-doc.sh --id="ArtifactNode/Aperas-design.md"
#
# Auto-pipes through `less` when stdout is an interactive terminal (documents like
# rawMarkdown are typically longer than a screenful) -- piped/redirected usage skips it.
set -euo pipefail

CONTAINER="${TERMINUSDB_CONTAINER:-terminusdb}"
DB_SPEC="${TERMINUSDB_DB_SPEC:-admin/aperas_apeiron}"
TDB_BIN="/app/terminusdb/terminusdb"

run() {
  docker exec "$CONTAINER" "$TDB_BIN" doc get "$DB_SPEC" "$@" 2>/dev/null | python3 -c "
import sys, json, re, datetime, signal
signal.signal(signal.SIGPIPE, signal.SIG_DFL)  # quiet exit when piped into head/less and truncated early

text = sys.stdin.read()
decoder = json.JSONDecoder()
idx = 0
docs = []
while idx < len(text):
    while idx < len(text) and text[idx] in ' \t\r\n':
        idx += 1
    if idx >= len(text):
        break
    obj, end = decoder.raw_decode(text, idx)
    idx = end
    docs.extend(obj) if isinstance(obj, list) else docs.append(obj)

iso_re = re.compile(r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z\$')

for i, doc in enumerate(docs):
    if i:
        print('-' * 40)
    for k, v in doc.items():
        if isinstance(v, str) and iso_re.match(v):
            dt = datetime.datetime.fromisoformat(v.replace('Z', '+00:00')).astimezone()
            print(f'{k}: {dt.strftime(\"%Y-%m-%d %H:%M:%S %Z\")}')
        elif isinstance(v, str) and '\n' in v:
            print(f'{k}:')
            for line in v.split('\n'):
                print(f'  {line}')
        elif isinstance(v, (dict, list)):
            print(f'{k}: {json.dumps(v)}')
        else:
            print(f'{k}: {v}')
"
}

if [ -t 1 ]; then
  run "$@" | less
else
  run "$@"
fi
