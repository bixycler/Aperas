#!/usr/bin/env bash
# The smoke list of the cutover (planning/core.md, Batch 13, piece 8; step 11 of the cutover): what must hold of a new-engine service that has just started on the migrated mirror.
#
#   scripts/cutover-smoke.sh [<aperas>] [--expect-root <graph-root>] [--parent <path>] [--docs <n>] [--read-only]
#
# <aperas> is the command to run: the name of a shim on the PATH or the path to one (default `aperas`). The script runs it and nothing else that has a side effect: the
# service it is pointed at is the one the shim reaches (the shim chooses the run directory, the port and the graph), it reads the artifacts directory and the mirror files that
# service names, and it writes nowhere itself. A line is printed for each check, `PASS` or `FAIL`, the seconds it took and what it checked, and the script ends
# `SMOKE: PASS` (exit 0) or `SMOKE: FAIL` (exit 1). Exit status 2: a usage error, with nothing run.
#
# The checks, in this order. The service must be up: the first check is `check-links`, and a service that is not answering ends the script there, because nothing after it can
# run (and the script never starts a service to make a check pass: its one `service start` is the one after its own `service stop`).
#   read-only:  check-links (the live-block count and the count of stored links that name no node are kept for the end) · the binding the service reports (with --expect-root,
#               its graph must be that root's Apeiron/) · `tree` of three documents · `show` of the first document's ArtifactNode and of its first block · `track --reverse` ·
#               `project --dry-run` of five documents, each compared with the file on disk
#   write:      only when every read-only check passed, so that the way back to the old engine stays open until the first write: an `insert` with an anchor that is not a child of
#               the parent (refused; no block left, in the count of live blocks and in the files of the mirror) · one write on a scratch node (`insert`, `show`, `remove`, with
#               `--flush`) · `flush` · `service stop` · `service start` (the stop prunes the tombstones nothing reaches, the start reloads the mirror) · `check-links` with the
#               same two counts as at the beginning · `show` of the scratch node, which now names no node
#   --read-only runs the read-only checks and stops.
#
# The scratch node is a paragraph created under --parent (default `.threads/coder.md`: the thread tree is the `.state` mirror, which git ignores), then tombstoned with `remove`.
# A tombstone stays in the mirror until the next stop or start of the service prunes it, and the script stops and starts the service for that: afterwards the node names nothing
# and the mirror files are byte for byte what they were before the write. A script that dies between the `insert` and the `remove` leaves a live paragraph whose text says
# `cutover-smoke scratch node`, to be removed by hand. The five documents are the first five tracked ones, in the order of their paths, under the artifacts directory (not `.threads/`, not
# `archive/`, no README) that `track --reverse` does not list as changed or never projected; --docs changes the five. A document's dry run is the file plus the newline the command adds.
set -u

AP=aperas
EXPECT_ROOT=
PARENT=.threads/coder.md
DOCS=5
READ_ONLY=0
usage() { sed -n '2,/^set -u/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//' >&2; exit 2; }
first=1
while [ $# -gt 0 ]; do
  case "$1" in
    --expect-root) [ $# -ge 2 ] || usage; EXPECT_ROOT=$2; shift 2 ;;
    --parent) [ $# -ge 2 ] || usage; PARENT=$2; shift 2 ;;
    --docs) [ $# -ge 2 ] || usage; DOCS=$2; shift 2 ;;
    --read-only) READ_ONLY=1; shift ;;
    -h|--help) usage ;;
    -*) echo "unknown option $1" >&2; usage ;;
    *) if [ $first = 1 ]; then AP=$1; first=0; shift; else echo "unexpected argument $1" >&2; usage; fi ;;
  esac
done
case "$DOCS" in ''|*[!0-9]*|0) echo "--docs takes a positive number" >&2; usage ;; esac
command -v "$AP" >/dev/null 2>&1 || { echo "$AP: no such command" >&2; exit 2; }

PASSED=0
FAILED=0
START_US=${EPOCHREALTIME/./}
STAMP="$(date +%s)-$$"

now_us() { local t=$EPOCHREALTIME; echo "${t/./}"; }
secs() { local us=$1; printf '%d.%02d' $((us / 1000000)) $(((us % 1000000) / 10000)); }
# run <args...>: the command's output (both streams) in OUT, its status in RC, its time in microseconds in US. RUN_ERR=0 keeps stderr out of OUT.
RUN_ERR=1
run() {
  local t0 t1
  t0=$(now_us)
  if [ "$RUN_ERR" = 1 ]; then OUT=$("$AP" "$@" 2>&1 </dev/null); RC=$?; else OUT=$("$AP" "$@" 2>/dev/null </dev/null); RC=$?; fi
  t1=$(now_us)
  US=$((t1 - t0))
}
# report <ok 0|1> <microseconds> <text>
report() {
  if [ "$1" = 1 ]; then PASSED=$((PASSED + 1)); printf 'PASS  %7ss  %s\n' "$(secs "$2")" "$3"; else FAILED=$((FAILED + 1)); printf 'FAIL  %7ss  %s\n' "$(secs "$2")" "$3"; fi
}
finish() {
  local total=$(($(now_us) - START_US))
  if [ $FAILED -eq 0 ]; then echo "SMOKE: PASS ($PASSED checks, $(secs $total) s)"; exit 0; fi
  echo "SMOKE: FAIL ($FAILED of $((PASSED + FAILED)) checks failed, $(secs $total) s)"
  exit 1
}
live_blocks() { printf '%s\n' "$1" | sed -n 's/.*Scanned \([0-9][0-9]*\) live blocks.*/\1/p' | tail -1; }
dangling() { local n; n=$(printf '%s\n' "$1" | sed -n 's/.*Found \([0-9][0-9]*\) stored link(s) whose target names no node.*/\1/p' | head -1); echo "${n:-0}"; }
block_id() { printf '%s\n' "$1" | grep -o 'BlockNode:[0-9A-Za-z]*' | head -1; }

# ---- read-only ------------------------------------------------------------------------------------------------------------------------------------------------------

run check-links
LIVE0=$(live_blocks "$OUT")
DANG0=$(dangling "$OUT")
if [ $RC -ne 0 ] || [ -z "$LIVE0" ]; then
  report 0 $US "check-links: exit $RC, no count of live blocks: $(printf '%s' "$OUT" | tail -c 300 | tr '\n' ' ')"
  echo "SMOKE: FAIL (the service does not answer; nothing else was run)"
  exit 1
fi
report 1 $US "check-links: $LIVE0 live blocks, $DANG0 stored links that name no node"

run service start
BIND=$(printf '%s\n' "$OUT" | grep 'bound to graph:' | head -1)
GRAPH=$(printf '%s\n' "$BIND" | sed -n 's/.*bound to graph: \(.*\), artifacts: .*/\1/p')
ART=$(printf '%s\n' "$BIND" | sed -n 's/.*, artifacts: \(.*\)\.$/\1/p')
if [ $RC -eq 0 ] && printf '%s' "$OUT" | grep -q 'Already running' && [ -n "$GRAPH" ] && [ -d "$ART" ] && [ -d "$GRAPH" ]; then
  ok=1; text="binding: graph $GRAPH, artifacts $ART"
  if [ -n "$EXPECT_ROOT" ]; then
    want=$(realpath "$EXPECT_ROOT/Apeiron" 2>/dev/null); got=$(realpath "$GRAPH" 2>/dev/null)
    if [ -n "$want" ] && [ "$want" = "$got" ]; then text="$text (is $EXPECT_ROOT/Apeiron)"; else ok=0; text="$text, not the expected $EXPECT_ROOT/Apeiron"; fi
  fi
  report $ok $US "$text"
else
  report 0 $US "binding: exit $RC, no 'Already running ... bound to graph' line or a directory it names is missing: $(printf '%s' "$OUT" | tail -c 300 | tr '\n' ' ')"
  [ -n "$ART" ] || { echo "SMOKE: FAIL (no artifacts directory known; the rest cannot run)"; exit 1; }
fi

run track --reverse
if [ $RC -eq 0 ] && printf '%s' "$OUT" | grep -q '^\[aperas track --reverse\] '; then
  CHANGED=$(printf '%s\n' "$OUT" | sed -n "/^\[aperas track --reverse\] Changed since last projection/,/^\[aperas track --reverse\] [A-Z]/p" | sed -n "s/^ *\[ArtifactNode\] '\(.*\)'.*/\1/p")
  NEVER=$(printf '%s\n' "$OUT" | sed -n "/^\[aperas track --reverse\] Never projected/,/^\[aperas track --reverse\] [A-Z]/p" | sed -n "s/^ *\[ArtifactNode\] '\(.*\)'.*/\1/p")
  report 1 $US "track --reverse: $(printf '%s' "$CHANGED" | grep -c .) documents changed since their projection, $(printf '%s' "$NEVER" | grep -c .) never projected"
else
  CHANGED=; NEVER=
  report 0 $US "track --reverse: exit $RC: $(printf '%s' "$OUT" | tail -c 300 | tr '\n' ' ')"
fi

# the first documents, in the order of their paths, that are tracked in the graph and that track --reverse does not list
DOCLIST=()
while IFS= read -r f; do
  rel=${f#"$ART"/}
  printf '%s\n%s\n' "$CHANGED" "$NEVER" | grep -qxF "$rel" && continue
  DOCLIST+=("$rel")
done < <(find "$ART" -name '*.md' -not -path "$ART/.threads/*" -not -path "$ART/archive/*" ! -name README.md 2>/dev/null | LC_ALL=C sort)
if [ ${#DOCLIST[@]} -lt $DOCS ]; then report 0 0 "documents: ${#DOCLIST[@]} candidate document(s) under $ART, fewer than the $DOCS to compare"; fi

DOC1=${DOCLIST[0]:-}
FIRST_BLOCK=
for i in 0 1 2; do
  d=${DOCLIST[$i]:-}
  [ -n "$d" ] || continue
  run tree "$d"
  line2=$(printf '%s\n' "$OUT" | sed -n 2p)
  if [ $RC -eq 0 ] && printf '%s' "$line2" | grep -q '^ArtifactNode:'; then
    report 1 $US "tree $d: $(printf '%s\n' "$OUT" | wc -l) lines, root ${line2%% *}"
    [ $i -eq 0 ] && { ROOT1=${line2%% *}; FIRST_BLOCK=$(printf '%s\n' "$OUT" | sed -n 3p | grep -o 'BlockNode:[0-9A-Za-z]*' | head -1); }
  else
    report 0 $US "tree $d: exit $RC, second line '$line2'"
  fi
done

if [ -n "${ROOT1:-}" ]; then
  RUN_ERR=0; run show "$ROOT1"; RUN_ERR=1
  if [ $RC -eq 0 ] && printf '%s' "$OUT" | grep -q "\"@id\": \"$ROOT1\""; then report 1 $US "show $ROOT1 (the artifact $DOC1)"; else report 0 $US "show $ROOT1: exit $RC"; fi
else
  report 0 0 "show of the artifact: no document to take it from"
fi
if [ -n "$FIRST_BLOCK" ]; then
  RUN_ERR=0; run show "$FIRST_BLOCK"; RUN_ERR=1
  if [ $RC -eq 0 ] && printf '%s' "$OUT" | grep -q "\"@id\": \"$FIRST_BLOCK\"" && printf '%s' "$OUT" | grep -q '"title": "[^"]'; then report 1 $US "show $FIRST_BLOCK (a block of $DOC1, with its title)"; else report 0 $US "show $FIRST_BLOCK: exit $RC, ${#OUT} characters, no @id or no title"; fi
else
  report 0 0 "show of a block: no block under $DOC1"
fi

n=0
for d in "${DOCLIST[@]:0:$DOCS}"; do
  n=$((n + 1))
  t0=$(now_us)
  want=$(cat "$ART/$d"; echo x); want=${want%x}
  got=$("$AP" project "$d" --dry-run 2>/dev/null </dev/null; echo "x$?"); st=${got##*x}; got=${got%x*}
  got=${got%$'\n'}
  if [ "$st" = 0 ] && [ "$got" = "$want" ]; then report 1 $(($(now_us) - t0)) "project --dry-run $d: ${#want} bytes, the same as the file on disk"
  else report 0 $(($(now_us) - t0)) "project --dry-run $d: exit $st, ${#got} against ${#want} bytes on disk"; fi
done

# ---- write ----------------------------------------------------------------------------------------------------------------------------------------------------------

if [ $FAILED -gt 0 ]; then
  echo "SKIP  the write checks: a read-only check failed, and no write is made before they pass, so that the way back to the old engine stays open"
  finish
fi
if [ $READ_ONLY = 1 ]; then echo "SKIP  the write checks (--read-only)"; finish; fi

ANCHOR_DOC=
for d in "${DOCLIST[@]:0:$DOCS}"; do [ "$d" != "$PARENT" ] && { ANCHOR_DOC=$d; break; }; done
ANCHOR=
if [ -n "$ANCHOR_DOC" ]; then ANCHOR=$("$AP" tree "$ANCHOR_DOC" 2>/dev/null </dev/null | sed -n 3p | grep -o 'BlockNode:[0-9A-Za-z]*' | head -1); fi
MARKER="cutover-smoke refused marker $STAMP"
t0=$(now_us)
if [ -z "$ANCHOR" ]; then
  report 0 0 "refused insert: no block of another document to use as the anchor"
else
  OUT=$(printf '%s\n' "$MARKER" | "$AP" insert "$PARENT" --after "$ANCHOR" 2>&1); RC=$?
  INS_RC=$RC
  US=$(($(now_us) - t0))
  if [ $RC -eq 0 ]; then
    stray=$(block_id "$OUT")
    [ -n "$stray" ] && "$AP" remove "$stray" >/dev/null 2>&1 </dev/null
    report 0 $US "insert under $PARENT after $ANCHOR (a block of $ANCHOR_DOC) was NOT refused: ${OUT:0:200}; the block it made${stray:+, $stray,} was tombstoned"
  else
    "$AP" flush >/dev/null 2>&1 </dev/null
    run check-links
    LIVE_R=$(live_blocks "$OUT")
    left=0
    for f in "$GRAPH/BlockNode.jsonld" "$GRAPH/.state/BlockNode.jsonld"; do [ -f "$f" ] && grep -qF "$MARKER" "$f" && left=$((left + 1)); done
    if [ "$LIVE_R" = "$LIVE0" ] && [ $left -eq 0 ]; then
      report 1 $(($(now_us) - t0)) "insert after $ANCHOR, which is not a child of $PARENT: refused (exit $INS_RC), $LIVE_R live blocks as before, the text is in no file of the mirror"
    else
      report 0 $(($(now_us) - t0)) "insert after $ANCHOR, which is not a child of $PARENT: refused, but live blocks $LIVE_R against $LIVE0 and the text is in $left file(s) of the mirror"
    fi
  fi
fi

SCRATCH="cutover-smoke scratch node $STAMP"
t0=$(now_us)
OUT=$(printf '%s\n' "$SCRATCH" | "$AP" insert "$PARENT" --flush 2>&1); RC=$?
US=$(($(now_us) - t0))
SID=$(block_id "$OUT")
if [ $RC -eq 0 ] && [ -n "$SID" ]; then
  report 1 $US "write: insert of the scratch paragraph under $PARENT: $SID (flushed)"
  RUN_ERR=0; run show "$SID" --text; RUN_ERR=1
  if [ $RC -eq 0 ] && [ "$OUT" = "$SCRATCH" ]; then report 1 $US "write: show $SID --text gives the text written"; else report 0 $US "write: show $SID --text: exit $RC, '${OUT:0:100}'"; fi
  run remove "$SID" --flush
  if [ $RC -eq 0 ]; then report 1 $US "write: remove $SID --flush"; else report 0 $US "write: remove $SID: exit $RC: ${OUT:0:200}"; fi
  RUN_ERR=0; run show "$SID"; RUN_ERR=1
  if [ $RC -eq 0 ] && printf '%s' "$OUT" | grep -q '"tombstonedAt"'; then report 1 $US "write: $SID is a tombstone"; else report 0 $US "write: show $SID after remove: exit $RC, no tombstonedAt"; fi
else
  report 0 0 "write: insert of the scratch paragraph under $PARENT: exit $RC: ${OUT:0:300}"
fi

run flush
if [ $RC -eq 0 ] && printf '%s' "$OUT" | grep -q 'Flushed'; then report 1 $US "flush"; else report 0 $US "flush: exit $RC: ${OUT:0:200}"; fi

run service stop
if [ $RC -eq 0 ] && printf '%s' "$OUT" | grep -q 'Stopped'; then report 1 $US "service stop (prunes the tombstones nothing reaches)"; else report 0 $US "service stop: exit $RC: ${OUT:0:200}"; fi
run service start
STARTED_US=$US
if [ $RC -eq 0 ] && printf '%s' "$OUT" | grep -q 'Started'; then report 1 $US "service start (reloads the mirror, answers when it says ready)"; else report 0 $US "service start: exit $RC: ${OUT:0:300}"; finish; fi

run check-links
LIVE1=$(live_blocks "$OUT")
DANG1=$(dangling "$OUT")
if [ $RC -eq 0 ] && [ "$LIVE1" = "$LIVE0" ] && [ "$DANG1" = "$DANG0" ]; then
  report 1 $US "check-links after the restart: $LIVE1 live blocks (as before), $DANG1 stored links that name no node (as before)"
else
  report 0 $US "check-links after the restart: exit $RC, live blocks ${LIVE1:-?} against $LIVE0, dangling links $DANG1 against $DANG0"
fi
if [ -n "$SID" ]; then
  RUN_ERR=0; run show "$SID"; RUN_ERR=1
  if [ $RC -ne 0 ]; then report 1 $US "show $SID after the restart: names no node (the stop pruned the tombstone)"; else report 0 $US "show $SID after the restart still finds a node"; fi
fi

finish
