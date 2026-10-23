#!/usr/bin/env python3
"""Rehearse the migration of the mirror at the cutover on a scratch copy (Python 3, standard library, git and the shell's own load).

  python3 monorepo/scripts/cutover-rehearsal.py <graph-root> --out <dir> [--allow-real-root] [--tools <dir>]

<graph-root> is a graph root: a directory that holds `Apeiron/` (and so `Apeiron/.state/`). The script only reads it. It copies
`Apeiron/` into `<dir>/Apeiron`, makes `<dir>` a git repository with a baseline commit of everything it holds (`.state/` too, which
the real graph's own repository ignores), then runs, in this order, and checks each step:

  1. the copy and the baseline commit            (the commit holds every file of the copy; the working tree is clean)
  2. `migrate-mirror.py --dry`                   (exit 0; writes nothing)
  3. `migrate-mirror.py`                         (exit 0; changes the files the dry run named, and no others)
  4. `verify-migration.py`                       (exit 0, `UNEXPECTED differences: 0`, every conformity count 0)
  5. `migrate-mirror.py` again                   (exit 0, `files that differ after the rules: 0`, no byte changes)
  6. the load with the new engine, in a child process (`packages/cli/diagnostics/mirror_loaddump.ts`): no error, no warning,
     no rejected id, nothing dangling, as many documents loaded as the files hold
  7. the dump of that load: each of the eight files of the mapping is the migrated file byte for byte, and the migrated copy
     holds no other `.jsonld` file

It prints a table with the result, the time and the counts of each step, and ends `REHEARSAL: PASS` (exit 0) or `REHEARSAL: FAIL`
(exit 1). The migrated copy is left in `<dir>`, which must not exist or must be empty, and which must lie neither in the graph
root nor in the real graph (`AperasKG` beside this monorepo). The dump goes to a temporary directory that is removed. Exit status 2:
a usage error or a refusal, with nothing read or written.

The real graph root (`AperasKG` beside this monorepo, however it is spelled) is refused unless `--allow-real-root` is given: the
rehearsal belongs on a copy of it made with `cp -a`, and run on the real one it is still read-only, but only on purpose.
`--tools <dir>` names the directory that holds `migrate-mirror.py` and `verify-migration.py` (default: this script's own).
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
MONOREPO = os.path.dirname(HERE)
REAL_GRAPH = os.path.realpath(os.path.join(MONOREPO, "..", "AperasKG"))
LOADDUMP = os.path.join(MONOREPO, "packages", "cli", "diagnostics", "mirror_loaddump.ts")
TSX = os.path.join(MONOREPO, "node_modules", ".bin", "tsx")
STEP_TIMEOUT = 300
GIT_ENV = {"GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1", "GIT_TERMINAL_PROMPT": "0"}


def usage_error(message):
    print("usage error: " + message, file=sys.stderr)
    print(__doc__, file=sys.stderr)
    return 2


def inside(path, directory):
    rel = os.path.relpath(os.path.realpath(path), os.path.realpath(directory))
    return rel == "." or not (rel == ".." or rel.startswith(".." + os.sep) or os.path.isabs(rel))


def child_env(extra=None):
    env = {k: v for k, v in os.environ.items() if k != "LD_LIBRARY_PATH"}
    env.update(GIT_ENV)
    env.update(extra or {})
    return env


def run(cmd, cwd=None):
    """-> (status, stdout + stderr, seconds). A command that outlives the step timeout is killed and has status -1."""
    t = time.time()
    try:
        r = subprocess.run(cmd, cwd=cwd, env=child_env(), capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=STEP_TIMEOUT, stdin=subprocess.DEVNULL)
        return r.returncode, r.stdout + r.stderr, time.time() - t
    except subprocess.TimeoutExpired:
        return -1, "timed out after %d s" % STEP_TIMEOUT, time.time() - t


def git(out, *args):
    return run(["git", "-c", "user.name=rehearsal", "-c", "user.email=rehearsal@localhost", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=" + os.devnull] + list(args), cwd=out)


def jsonld_files(base):
    """The `.jsonld` files under `<base>/Apeiron`, as paths relative to `base`, sorted."""
    found = []
    for d, _, names in os.walk(os.path.join(base, "Apeiron")):
        found += [os.path.relpath(os.path.join(d, n), base) for n in names if n.endswith(".jsonld")]
    return sorted(found)


def digests(base):
    import hashlib
    return {rel: hashlib.sha256(open(os.path.join(base, rel), "rb").read()).hexdigest() for rel in jsonld_files(base)}


def count_documents(base, rels):
    n = 0
    for rel in rels:
        n += len(json.load(open(os.path.join(base, rel), encoding="utf-8")))
    return n


def number_after(label, text):
    m = re.search(re.escape(label) + r"\s*(\d+)", text)
    return int(m.group(1)) if m else None


class Table:
    def __init__(self):
        self.rows = []
        self.failed = False

    def add(self, name, ok, seconds, detail, notes=()):
        self.rows.append((name, ok, seconds, detail, list(notes)))
        self.failed = self.failed or not ok

    def show(self):
        print()
        print("%-34s %-5s %8s  %s" % ("step", "", "seconds", "counts"))
        for name, ok, seconds, detail, notes in self.rows:
            print("%-34s %-5s %8.2f  %s" % (name, "ok" if ok else "FAIL", seconds, detail))
            for n in notes:
                print("    " + n)


def main(argv):
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__, file=sys.stderr)
        return 2
    root, out, allow_real, tools = None, None, False, HERE
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--out":
            out = argv[i + 1] if i + 1 < len(argv) else None
            i += 2
        elif a == "--tools":
            tools = argv[i + 1] if i + 1 < len(argv) else None
            i += 2
        elif a == "--allow-real-root":
            allow_real = True
            i += 1
        elif a.startswith("-") or root is not None:
            return usage_error("unknown or repeated argument %r" % a)
        else:
            root = a
            i += 1
    if root is None or out is None or tools is None:
        return usage_error("a graph root and --out <dir> are required, and --out and --tools take a value")
    if not os.path.isdir(os.path.join(root, "Apeiron")):
        return usage_error("%s is not a graph root: it holds no Apeiron/" % root)
    if inside(root, REAL_GRAPH) and not allow_real:
        return usage_error("%s is the real graph root (%s); pass --allow-real-root to rehearse on it on purpose" % (root, REAL_GRAPH))
    if inside(out, REAL_GRAPH) or inside(out, root):
        return usage_error("--out %s lies inside the graph root or the real graph" % out)
    if os.path.exists(out) and (not os.path.isdir(out) or os.listdir(out)):
        return usage_error("--out %s exists and is not an empty directory" % out)
    migrate = os.path.join(tools, "migrate-mirror.py")
    verify = os.path.join(tools, "verify-migration.py")
    for needed in (migrate, verify, LOADDUMP, TSX):
        if not os.path.exists(needed):
            return usage_error("%s does not exist" % needed)

    table = Table()
    os.makedirs(out, exist_ok=True)
    py = sys.executable

    # 1. the copy and the baseline commit
    t = time.time()
    shutil.copytree(os.path.join(root, "Apeiron"), os.path.join(out, "Apeiron"), symlinks=False)
    rels = jsonld_files(out)
    docs_before = count_documents(out, rels)
    status, text, _ = git(out, "init", "-q")
    ok = status == 0
    if ok:
        status, text, _ = git(out, "add", "-A")
        ok = status == 0
    if ok:
        status, text, _ = git(out, "commit", "-q", "-m", "baseline")
        ok = status == 0
    tracked, dirty = 0, "?"
    if ok:
        _, listing, _ = git(out, "ls-files", "--", "*.jsonld")
        tracked = len([l for l in listing.splitlines() if l.strip()])
        _, dirty, _ = git(out, "status", "--porcelain")
        ok = tracked == len(rels) and dirty.strip() == ""
    table.add("1 copy and baseline commit", ok, time.time() - t, "%d files, %d documents, %d tracked by the baseline" % (len(rels), docs_before, tracked), [] if ok else [text.strip()[:300] or "the baseline does not hold every file or the tree is not clean"])
    if not ok:
        table.show()
        print("REHEARSAL: FAIL")
        return 1

    # 2. the dry run
    status, text, secs = run([py, migrate, out, "--dry"])
    _, dirty, _ = git(out, "status", "--porcelain")
    would = number_after("files that differ after the rules:", text)
    ok = status == 0 and would is not None and dirty.strip() == ""
    table.add("2 migrate --dry", ok, secs, "exit %s, %s files would change, tree %s" % (status, would, "clean" if dirty.strip() == "" else "CHANGED"), [] if ok else [text.strip()[-400:]])
    stats = [l.strip() for l in text.splitlines() if re.match(r"^\s+\S.*\s\d+$", l) and "files that differ" not in l]

    # 3. the migration
    status, text, secs = run([py, migrate, out])
    _, changed, _ = git(out, "status", "--porcelain")
    changed_files = [l[3:] for l in changed.splitlines() if l.strip()]
    ok = status == 0 and would is not None and len(changed_files) == would and all(f.endswith(".jsonld") for f in changed_files)
    table.add("3 migrate", ok, secs, "exit %s, %d files changed (the dry run said %s)" % (status, len(changed_files), would), [] if ok else [text.strip()[-400:]])
    migrated = digests(out)

    # 4. the verifier
    status, text, secs = run([py, verify, out])
    gates = [
        ("UNEXPECTED differences:", "unexpected differences"),
        ("Link with a predicate (any document):", "links with a predicate"),
        ("unfolds entries whose target is not defined:", "unfolds to undefined"),
        ("artifacts that hold a type:", "artifacts with a type"),
        ("containers listing a tombstone:", "containers listing a tombstone"),
        ("references to ids defined in neither directory:", "dangling references"),
    ]
    values = {name: number_after(label, text) for label, name in gates}
    m = re.search(r"tombstones: (\d+); with parent (\d+), links (\d+), props (\d+), non-empty children (\d+)", text)
    tombstones = m.groups() if m else None
    ok = status == 0 and all(v == 0 for v in values.values()) and tombstones is not None and all(int(x) == 0 for x in tombstones[1:])
    detail = "exit %s, %s; tombstones %s with structure %s" % (status, ", ".join("%s %s" % (name, values[name]) for _, name in gates), tombstones[0] if tombstones else "?", "/".join(tombstones[1:]) if tombstones else "?")
    table.add("4 verify-migration", ok, secs, detail, [] if ok else [text.strip()[-600:]])
    parentless = re.search(r"parentless live documents: (\d+) (\{.*\})", text)

    # 5. the second run
    status, text, secs = run([py, migrate, out])
    again = number_after("files that differ after the rules:", text)
    same = digests(out) == migrated
    ok = status == 0 and again == 0 and same
    table.add("5 migrate again", ok, secs, "exit %s, %s files differ after the rules, bytes %s" % (status, again, "unchanged" if same else "CHANGED"), [] if ok else [text.strip()[-400:]])

    # 6 and 7. the load with the new engine and the dump
    dump = tempfile.mkdtemp(prefix="cutover-dump-")
    try:
        status, text, secs = run([TSX, LOADDUMP, out, dump], cwd=MONOREPO)
        report = None
        try:
            report = json.loads(text.strip().splitlines()[-1])
        except (ValueError, IndexError):
            pass
        after = jsonld_files(out)
        docs_after = count_documents(out, after) if after else 0
        if report is None:
            table.add("6 load, new engine", False, secs, "exit %s, no report" % status, [text.strip()[-600:]])
            table.add("7 dump, eight files", False, 0.0, "no dump", [])
        else:
            clean = all(report[k] == 0 for k in ("errors", "warnings", "rejected", "dangling"))
            built = report["documents"] == docs_after
            ok = status == 0 and clean and built
            detail = "exit %s, %d documents of %d in the files, %d embedded; errors %d, warnings %d, rejected %d, dangling %d; load %d ms, dump %d ms" % (
                status, report["documents"], docs_after, report["embedded"], report["errors"], report["warnings"], report["rejected"], report["dangling"], report["loadMs"], report["dumpMs"])
            table.add("6 load, new engine", ok, secs, detail, [] if ok else report["firstProblems"])
            files = report["files"]
            differ = []
            for rel in files:
                a, b = os.path.join(dump, rel), os.path.join(out, rel)
                if not os.path.exists(a) or not os.path.exists(b) or open(a, "rb").read() != open(b, "rb").read():
                    differ.append(rel)
            outside = [rel for rel in after if rel not in files]
            ok = not differ and not outside and len(files) == 8
            table.add("7 dump, byte for byte", ok, report["dumpMs"] / 1000.0, "%d of %d files identical%s" % (len(files) - len(differ), len(files), "" if not outside else ", files outside the mapping: " + ", ".join(outside)), differ if differ else [])
    finally:
        shutil.rmtree(dump, ignore_errors=True)

    print("graph root %s" % root)
    print("migrated copy left in %s (baseline commit holds the unmigrated files)" % out)
    if stats:
        print("what the dry run counted:")
        for s in stats:
            print("    " + s)
    if parentless:
        print("parentless live documents after the migration: %s %s" % (parentless.group(1), parentless.group(2)))
    table.show()
    print()
    print("REHEARSAL: FAIL" if table.failed else "REHEARSAL: PASS")
    return 1 if table.failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
