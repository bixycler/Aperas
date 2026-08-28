#!/usr/bin/env bash
# Backup/restore helpers for the Aperas KG's TerminusDB-backed state.
# See config.md for what these snapshots are (and aren't) a substitute for.
set -euo pipefail

CONTAINER="${TERMINUSDB_CONTAINER:-terminusdb}"
DB_SPEC="${TERMINUSDB_DB_SPEC:-admin/aperas_apeiron}"
VOLUME="${TERMINUSDB_VOLUME:-terminusdb_storage}"
SNAPSHOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/snapshots"
TDB_BIN="/app/terminusdb/terminusdb"

usage() {
  echo "Usage: $0 backup | restore <bundle-file> | verify [--keep] <bundle-file> |" >&2
  echo "       backup-full | verify-full [--keep] <tarball> | restore-full [--overwrite] <tarball>" >&2
  echo "" >&2
  echo "  backup / restore / verify   -- terminusdb bundle/unbundle. Same-store only" >&2
  echo "                                 (see terminusdb/terminusdb#2509) -- NOT for" >&2
  echo "                                 moving data to a different machine/instance." >&2
  echo "  backup-full / verify-full   -- whole-volume tarball, disposable boot-check." >&2
  echo "                                 Store-format-agnostic, safe between machines." >&2
  echo "  restore-full                -- extracts a tarball into a NEW, separately-named" >&2
  echo "                                 instance (never touches your live container/" >&2
  echo "                                 volume). Prints how to promote it manually --" >&2
  echo "                                 promotion replaces your live store wholesale, it" >&2
  echo "                                 does not merge, so check for other databases the" >&2
  echo "                                 tarball doesn't know about first (see" >&2
  echo "                                 terminusdb/terminusdb#2509 discussion)." >&2
  echo "  restore-full --overwrite   -- same, but promotes automatically instead of" >&2
  echo "                                 printing instructions. Old container/volume are" >&2
  echo "                                 renamed aside (*-old), not deleted." >&2
  exit 1
}

backup() {
  local ts
  ts="$(date +%Y%m%d_%H%M%S)"
  local dbname="${DB_SPEC#*/}"
  local remote_path="/tmp/${dbname}_${ts}.bundle"
  local local_path="${SNAPSHOT_DIR}/${dbname}_${ts}.bundle"

  echo "Bundling ${DB_SPEC} inside container '${CONTAINER}'..."
  docker exec "$CONTAINER" "$TDB_BIN" bundle "$DB_SPEC" -o "$remote_path"

  echo "Copying bundle to ${local_path}..."
  docker cp "${CONTAINER}:${remote_path}" "$local_path"
  docker exec "$CONTAINER" rm -f "$remote_path"

  echo "Done: ${local_path}"

  # A bundle can be written successfully yet still be unusable (truncation, transport
  # corruption, whatever produced the mojibake-mangled snapshot this script once left
  # behind) — restoring into a disposable database is the only way to actually know it
  # works, and doing it now, at backup time, is the only point where "just take another
  # snapshot" is still a cheap fix.
  if ! verify "$local_path"; then
    echo "[!] WARNING: the snapshot just taken failed verification. It has been kept" \
      "at ${local_path} for forensics, but do not rely on it — investigate or re-run backup." >&2
    return 1
  fi
}

restore() {
  local bundle_file="$1"
  [ -f "$bundle_file" ] || { echo "No such file: $bundle_file" >&2; exit 1; }

  local remote_path="/tmp/$(basename "$bundle_file")"
  echo "Copying ${bundle_file} into container '${CONTAINER}'..."
  docker cp "$bundle_file" "${CONTAINER}:${remote_path}"

  echo "Unbundling into ${DB_SPEC}..."
  docker exec "$CONTAINER" "$TDB_BIN" unbundle "$DB_SPEC" "$remote_path"
  docker exec "$CONTAINER" rm -f "$remote_path"

  echo "Done. Restored ${DB_SPEC} from ${bundle_file}."
}

verify() {
  local keep=0
  if [ "${1:-}" = "--keep" ]; then
    keep=1
    shift
  fi
  local bundle_file="$1"
  [ -f "$bundle_file" ] || { echo "No such file: $bundle_file" >&2; exit 1; }

  local dbname="${DB_SPEC#*/}"
  local org="${DB_SPEC%/*}"
  local verify_db="${dbname}_verify_$$"
  local remote_path="/tmp/$(basename "$bundle_file")_verify_$$"

  echo "Verifying ${bundle_file} by restoring into a disposable database (${org}/${verify_db})..."
  docker cp "$bundle_file" "${CONTAINER}:${remote_path}"
  docker exec "$CONTAINER" "$TDB_BIN" db create "${org}/${verify_db}" --label="restore.sh verification (temporary)" >/dev/null

  local ok=1
  if docker exec "$CONTAINER" "$TDB_BIN" unbundle "${org}/${verify_db}" "$remote_path"; then
    ok=0
  fi

  docker exec "$CONTAINER" rm -f "$remote_path" >/dev/null 2>&1 || true

  if [ "$ok" -eq 0 ]; then
    echo "[✓] Verified: ${bundle_file} unbundles cleanly."
    if [ "$keep" -eq 1 ]; then
      echo "    --keep: leaving '${org}/${verify_db}' in place for inspection." \
        "Delete it yourself when done:" \
        "docker exec ${CONTAINER} ${TDB_BIN} db delete ${org}/${verify_db}"
    else
      docker exec "$CONTAINER" "$TDB_BIN" db delete "${org}/${verify_db}" >/dev/null 2>&1 || true
    fi
    return 0
  else
    echo "[!] Verification FAILED: ${bundle_file} did not unbundle cleanly." >&2
    # A failed unbundle leaves nothing worth inspecting — clean up regardless of --keep.
    docker exec "$CONTAINER" "$TDB_BIN" db delete "${org}/${verify_db}" >/dev/null 2>&1 || true
    return 1
  fi
}

backup_full() {
  local ts
  ts="$(date +%Y%m%d_%H%M%S)"
  local local_path="${SNAPSHOT_DIR}/${VOLUME}_full_${ts}.tar.gz"

  # Stop the server first: terminus-store's on-disk layout has a small mutable "head"
  # pointer alongside its append-only layer files, and tarring a live volume risks
  # capturing that pointer mid-update, pointing at a layer that isn't fully flushed yet.
  echo "Stopping '${CONTAINER}' for a consistent volume snapshot..."
  docker stop "$CONTAINER" >/dev/null

  local restarted=0
  restart_container() {
    if [ "$restarted" -eq 0 ]; then
      echo "Restarting '${CONTAINER}'..."
      docker start "$CONTAINER" >/dev/null
      restarted=1
    fi
  }
  trap restart_container EXIT

  echo "Archiving volume '${VOLUME}' to ${local_path}..."
  docker run --rm --user "$(id -u):$(id -g)" -v "${VOLUME}:/data:ro" -v "${SNAPSHOT_DIR}:/backup" alpine \
    tar czf "/backup/$(basename "$local_path")" -C /data .

  restart_container
  trap - EXIT

  echo "Done: ${local_path}"

  if ! verify_full "$local_path"; then
    echo "[!] WARNING: the full snapshot just taken failed verification. It has been kept" \
      "at ${local_path} for forensics, but do not rely on it — investigate or re-run backup-full." >&2
    return 1
  fi
}

verify_full() {
  local keep=0
  if [ "${1:-}" = "--keep" ]; then
    keep=1
    shift
  fi
  local tarball="$1"
  [ -f "$tarball" ] || { echo "No such file: $tarball" >&2; exit 1; }

  local image
  image="$(docker inspect "$CONTAINER" --format '{{.Config.Image}}')"
  local test_volume="${VOLUME}_fulltest_$$"
  local test_container="${CONTAINER}_fulltest_$$"

  echo "Restoring ${tarball} into a disposable instance (volume '${test_volume}', container '${test_container}')..."
  docker volume create "$test_volume" >/dev/null
  docker run --rm -v "${test_volume}:/data" -v "$(cd "$(dirname "$tarball")" && pwd):/backup:ro" alpine \
    tar xzf "/backup/$(basename "$tarball")" -C /data

  docker run -d --name "$test_container" -v "${test_volume}:/app/terminusdb/storage" "$image" >/dev/null
  sleep 3

  local ok=1
  if docker exec "$test_container" "$TDB_BIN" db list >/dev/null 2>&1; then
    ok=0
  fi

  if [ "$ok" -eq 0 ]; then
    echo "[✓] Verified: ${tarball} boots cleanly and lists databases."
    if [ "$keep" -eq 1 ]; then
      echo "    --keep: leaving container '${test_container}' / volume '${test_volume}' in place." \
        "Tear down yourself when done:" \
        "docker rm -f ${test_container} && docker volume rm ${test_volume}"
    else
      docker rm -f "$test_container" >/dev/null 2>&1 || true
      docker volume rm "$test_volume" >/dev/null 2>&1 || true
    fi
    return 0
  else
    echo "[!] Verification FAILED: ${test_container} did not come up cleanly from ${tarball}." >&2
    docker logs "$test_container" 2>&1 | tail -20 >&2 || true
    docker rm -f "$test_container" >/dev/null 2>&1 || true
    docker volume rm "$test_volume" >/dev/null 2>&1 || true
    return 1
  fi
}

restore_full() {
  local overwrite=0
  if [ "${1:-}" = "--overwrite" ]; then
    overwrite=1
    shift
  fi
  local tarball="$1"
  [ -f "$tarball" ] || { echo "No such file: $tarball" >&2; exit 1; }

  local image
  image="$(docker inspect "$CONTAINER" --format '{{.Config.Image}}')"
  local new_volume="${VOLUME}_restored"
  local new_container="${CONTAINER}-restored"

  # Capture the live container's port publishing + restart policy now, while it's still
  # named $CONTAINER -- promotion needs to recreate a container with this same config on
  # the new volume, not just rename the port-less inspection container from below (a
  # renamed container keeps whatever ports/restart policy it was originally started
  # with, which for the inspection container is none -- so a naive rename would silently
  # drop the live port mapping and restart policy, exactly the way a bare "docker run"
  # without them would).
  local live_run_args=()
  readarray -d '' live_run_args < <(
    docker inspect "$CONTAINER" --format '{{json .HostConfig.PortBindings}}{{"\n"}}{{.HostConfig.RestartPolicy.Name}}' \
      | python3 -c '
import json, sys
lines = sys.stdin.read().split("\n")
bindings = json.loads(lines[0] or "{}")
restart = lines[1].strip() if len(lines) > 1 else ""
args = []
for container_port, hosts in (bindings or {}).items():
    for h in (hosts or []):
        hip = h.get("HostIp") or ""
        hport = h["HostPort"]
        args.append("-p")
        args.append(f"{hip}:{hport}:{container_port}" if hip else f"{hport}:{container_port}")
if restart and restart != "no":
    args.append("--restart")
    args.append(restart)
sys.stdout.write("\0".join(args))
'
  )

  local existing=0
  if docker volume inspect "$new_volume" >/dev/null 2>&1 || docker container inspect "$new_container" >/dev/null 2>&1; then
    existing=1
  fi

  if [ "$existing" -eq 1 ] && [ "$overwrite" -eq 1 ]; then
    # --overwrite re-run after a prior plain restore-full already extracted+booted this
    # tarball's inspection instance: reuse it instead of erroring, so the two-step
    # "inspect, then --overwrite to promote" flow this script's own instructions
    # recommend doesn't get blocked by the very instance it told you to inspect.
    echo "Reusing already-extracted '${new_volume}' / '${new_container}' from a prior run."
  elif [ "$existing" -eq 1 ]; then
    # Never silently overwrite a previous restore-in-progress otherwise -- the whole
    # point of this command is that promotion is a manual, deliberate step.
    echo "[!] '${new_volume}' and/or '${new_container}' already exist from a previous" \
      "restore-full run. Promote (--overwrite) or remove them first:" >&2
    echo "    docker rm -f ${new_container} && docker volume rm ${new_volume}" >&2
    exit 1
  else
    echo "Extracting ${tarball} into new volume '${new_volume}'..."
    docker volume create "$new_volume" >/dev/null
    docker run --rm -v "${new_volume}:/data" -v "$(cd "$(dirname "$tarball")" && pwd):/backup:ro" alpine \
      tar xzf "/backup/$(basename "$tarball")" -C /data

    echo "Starting new container '${new_container}' (not on the live port)..."
    docker run -d --name "$new_container" -v "${new_volume}:/app/terminusdb/storage" "$image" >/dev/null
    sleep 3
  fi

  if ! docker exec "$new_container" "$TDB_BIN" db list >/dev/null 2>&1; then
    echo "[!] '${new_container}' did not come up cleanly from ${tarball}. Not promoting." >&2
    docker logs "$new_container" 2>&1 | tail -20 >&2 || true
    docker rm -f "$new_container" >/dev/null 2>&1 || true
    docker volume rm "$new_volume" >/dev/null 2>&1 || true
    exit 1
  fi

  echo "[✓] '${new_container}' is up, backed by '${new_volume}'. Databases inside it:"
  docker exec "$new_container" "$TDB_BIN" db list --branches

  if [ "$overwrite" -eq 1 ]; then
    echo ""
    echo "--overwrite: promoting '${new_container}' to be the live '${CONTAINER}' now." >&2
    echo "'${CONTAINER}' (volume '${VOLUME}') is being replaced wholesale, not merged --" \
      "kept as '${CONTAINER}-old' / '${VOLUME}' as a fallback, not deleted." >&2

    # The inspection container above was deliberately started without ports (to avoid
    # clashing with the still-live original) -- discard it and recreate properly on the
    # new volume, carrying over the original's port bindings/restart policy captured earlier.
    docker rm -f "$new_container" >/dev/null 2>&1 || true
    docker stop "$CONTAINER" >/dev/null
    docker rename "$CONTAINER" "${CONTAINER}-old"
    docker run -d --name "$CONTAINER" "${live_run_args[@]}" -v "${new_volume}:/app/terminusdb/storage" "$image" >/dev/null
    sleep 3

    if ! docker exec "$CONTAINER" "$TDB_BIN" db list >/dev/null 2>&1; then
      echo "[!] '${CONTAINER}' did not come up cleanly after promotion. Rolling back..." >&2
      docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
      docker rename "${CONTAINER}-old" "$CONTAINER"
      docker start "$CONTAINER" >/dev/null
      echo "[✓] Rolled back -- '${CONTAINER}' is running the original data again." >&2
      exit 1
    fi

    echo "[✓] '${CONTAINER}' is now serving the restored data, with the original port(s)/restart policy intact." \
      "Remove the fallback once confident: docker rm ${CONTAINER}-old && docker volume rm ${VOLUME}" >&2
    return 0
  fi

  cat >&2 <<EOF

Inspect it before promoting:
  docker exec ${new_container} ${TDB_BIN} db list --branches
  docker exec ${new_container} ${TDB_BIN} doc get <DB_SPEC> --type=<TYPE>

Your LIVE '${CONTAINER}' (volume '${VOLUME}') has NOT been touched. If it holds other
databases the tarball doesn't know about (check with 'docker exec ${CONTAINER} ${TDB_BIN} db list'),
decide what to do about those before promoting -- promotion below replaces '${CONTAINER}'
wholesale, it does not merge.

To promote '${new_container}' to be the live '${CONTAINER}' once you're satisfied, re-run
this same command with --overwrite (it recreates the container on '${new_volume}' with
'${CONTAINER}''s original port bindings/restart policy carried over -- a plain
'docker rename' would silently lose those, since '${new_container}' was started without
them on purpose, to avoid port-clashing with the still-live original):
  $0 restore-full --overwrite ${tarball}

To discard this restore instead:
  docker rm -f ${new_container} && docker volume rm ${new_volume}
EOF
}

case "${1:-}" in
  backup) backup ;;
  restore) [ $# -ge 2 ] || usage; restore "$2" ;;
  verify)
    shift
    [ $# -ge 1 ] || usage
    verify "$@"
    ;;
  backup-full) backup_full ;;
  verify-full)
    shift
    [ $# -ge 1 ] || usage
    verify_full "$@"
    ;;
  restore-full)
    shift
    [ $# -ge 1 ] || usage
    restore_full "$@"
    ;;
  *) usage ;;
esac
