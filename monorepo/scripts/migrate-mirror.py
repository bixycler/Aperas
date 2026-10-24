#!/usr/bin/env python3
"""One-time migration of the Apeiron mirror at the cutover to the new engine.

Rewrites the mirror's JSON-LD files (`Apeiron/*.jsonld` and `Apeiron/.state/*.jsonld`) so that they
hold what the new engine's design states and nothing of what the reference engine left in them. Python 3,
standard library only. Run it once, on a copy first; the real mirror is migrated at the cutover and not
before it, because the reference engine cannot read the migrated mirror (it needs the `predicate` of a
`Link` and reads removed nodes through the `children` of their container).

  python3 monorepo/scripts/migrate-mirror.py <graph-root> --dry               # counts only, writes nothing
  python3 monorepo/scripts/migrate-mirror.py <graph-root>                     # migrates in place
  python3 monorepo/scripts/migrate-mirror.py <graph-root> --rules 123456      # all six: the project's own graph
  python3 monorepo/scripts/migrate-mirror.py <graph-root> --rules 34          # only the two that are the project's own
  python3 monorepo/scripts/migrate-mirror.py <graph-root> --roundtrip         # proves the writer only

Reads and writes: `<graph-root>/Apeiron/*.jsonld` and `<graph-root>/Apeiron/.state/*.jsonld`, nothing else.
Both directories are read together because ids refer across them; a file is rewritten only when the rules
change it, and the documents of every file are written sorted by `@id`. The graph root is a required
argument and has no default: with no argument the script prints this text on stderr and exits with status 2,
and a first argument that starts with `-` (`--help` among them) or is not a directory that holds `Apeiron/` is a usage
error (a usage line on stderr, exit status 2, nothing read or written), so it never reaches the real graph unless a caller names it. `--dry` writes nothing and prints the counts.
`--roundtrip` writes nothing in the graph root: every file is loaded, written back to a temporary place
and compared byte for byte with the original. Any condition the rules cannot decide makes the script stop,
list it and write nothing; so does a usage error, `--rules` with no value or with a value that is not a
list of rule numbers 1 to 6 (a message on stderr, nothing read or written).
Exit status 0 is a completed run (or a clean `--roundtrip`); 1 is a `--roundtrip` that finds a file
different; 2 is a usage error or a stop condition.

Rules (1, 2, 5 and 6 by default, the general ones; --rules selects the rules to run instead, e.g. --rules 123456
for all six, which is what this project's own graph needs, or --rules 34 for the two that are its own):
  1. every embedded Link loses its `predicate` key and nothing else
  2. every document with `tombstonedAt` loses parent, links, props; its
     children becomes []; its id leaves the children of the container its
     parent named (in whichever file that container is); literals stay
  3. (this project's graph only) the six README.md artifacts and their six
     paragraphs are deleted, after a re-check that nothing in either
     directory refers to them
  4. (this project's graph only) Profile:00CJC4S69R000 (dinhlx) gets
     `kind: human`, placed in the field order handle, name, kind, preferences
  5. every `unfolds` entry whose target is not defined (no document and no
     embedded entry of that id stands in either directory) is stripped; a
     document left with no entry loses the key
  6. the `type` of every ArtifactNode is stripped

The rules are the six parts of the migration of the mirror in `planning/core.md`, Batch 9, step 6. The companion
`verify-migration.py` (same directory) checks a migrated clone against its baseline commit; a second run of
this script on a migrated mirror changes nothing.
"""
import glob
import json
import os
import sys
import tempfile

README_ARTIFACTS = [
    "ArtifactNode:00CN1QE950000", "ArtifactNode:00CN4ZQ8Y0000",
    "ArtifactNode:00CN4ZSF58000", "ArtifactNode:00CN4ZTZRR000",
    "ArtifactNode:00CN4ZWHCG000", "ArtifactNode:00CN4ZXWJ8000",
]
README_PARAGRAPHS = [
    "BlockNode:00CN1QEAGG001", "BlockNode:00CN4ZQAPG001",
    "BlockNode:00CN4ZSHMG001", "BlockNode:00CN4ZV1G8001",
    "BlockNode:00CN4ZWJMG001", "BlockNode:00CN4ZXXRR001",
]
DELETE_SET = set(README_ARTIFACTS + README_PARAGRAPHS)
DINHLX = "Profile:00CJC4S69R000"
PROFILE_ORDER = ["@id", "@type", "handle", "name", "kind", "preferences"]
TOMBSTONE_DROP = ("parent", "links", "props")
RULES = "123456"          # every rule there is: the values `--rules` may name
DEFAULT_RULES = "1256"    # the general rules: what a run without `--rules` applies
USAGE = "usage: migrate-mirror.py <graph-root> [--dry | --roundtrip] [--rules 1..6]   (the first argument is a graph root: a directory that holds Apeiron/)"


def serialize(docs):
    return json.dumps(docs, indent=2, ensure_ascii=False) + "\n"


def load(root):
    """-> ({path of file: list of documents}, {path of file: raw text}), in file order.

    The keys are the full paths of the files under `root` (absolute when `root` is), not names relative
    to it: `Apeiron/*.jsonld` first, then `Apeiron/.state/*.jsonld`, each sorted.
    """
    base = os.path.join(root, "Apeiron")
    files = sorted(glob.glob(base + "/*.jsonld")) + sorted(glob.glob(base + "/.state/*.jsonld"))
    out = {}
    raws = {}
    for f in files:
        raw = open(f, encoding="utf-8").read()
        raws[f] = raw
        out[f] = json.loads(raw)
    return out, raws


def defined_ids(documents, gone=frozenset()):
    """The ids that stand in the mirror: every document and every embedded entry, but the documents (and what they embed) in `gone`."""
    out = set()

    def walk(value):
        if isinstance(value, dict):
            if isinstance(value.get("@id"), str):
                out.add(value["@id"])
            for k, v in value.items():
                if k != "@id":
                    walk(v)
        elif isinstance(value, list):
            for v in value:
                walk(v)

    for d in documents:
        if d["@id"] not in gone:
            walk(d)
    return out


def roundtrip(root):
    files, raws = load(root)
    bad = 0
    with tempfile.TemporaryDirectory() as tmp:
        for i, (f, docs) in enumerate(files.items()):
            t = os.path.join(tmp, "%d.jsonld" % i)
            with open(t, "w", encoding="utf-8", newline="") as h:
                h.write(serialize(docs))
            same = open(t, "rb").read() == open(f, "rb").read()
            print("%-60s %6d docs  %s" % (os.path.relpath(f, root), len(docs), "identical" if same else "DIFFERENT"))
            bad += 0 if same else 1
    return bad


def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__, file=sys.stderr)
        return 2
    root = args[0]
    if root.startswith("-") or not os.path.isdir(os.path.join(root, "Apeiron")):
        print("usage error: the first argument must be the graph root, a directory that holds Apeiron/; got %r; nothing was read or written\n%s" % (root, USAGE), file=sys.stderr)
        return 2
    dry = "--dry" in args
    rules = DEFAULT_RULES
    if "--rules" in args:
        k = args.index("--rules")
        rules = args[k + 1] if k + 1 < len(args) else ""
        if not rules or any(c not in RULES for c in rules):
            print("usage error: --rules takes a list of rule numbers 1 to 6, e.g. --rules 3 or --rules 12; nothing was written\n%s" % USAGE, file=sys.stderr)
            return 2
    if "--roundtrip" in args:
        return 1 if roundtrip(root) else 0

    files, raws = load(root)
    where = {}   # id -> file
    docs = {}    # id -> doc
    for f, lst in files.items():
        for d in lst:
            if d["@id"] in docs:
                print("STOP: id defined twice:", d["@id"])
                return 2
            docs[d["@id"]] = d
            where[d["@id"]] = f
    stats = {k: 0 for k in (
        "links_changed_mirror", "links_changed_state",
        "links_dropped_with_tombstones", "tombstones_changed_mirror",
        "tombstones_changed_state", "containers_edited_mirror",
        "containers_edited_state", "deleted_mirror", "deleted_state",
        "profiles_changed", "unfolds_stripped_mirror", "unfolds_stripped_state",
        "artifact_types_stripped_mirror", "artifact_types_stripped_state")}

    def side(f):
        return "state" if os.sep + ".state" + os.sep in f else "mirror"

    stops = []

    # ---- pre-checks on the untouched state -------------------------------
    tomb_ids = {i for i, d in docs.items() if "tombstonedAt" in d}
    if "2" in rules:
        for i in sorted(tomb_ids):
            d = docs[i]
            for c in d.get("children", []):
                if c not in docs:
                    stops.append("tombstone %s holds child %s that is not defined" % (i, c))
                elif c not in tomb_ids:
                    stops.append("tombstone %s holds child %s that is not tombstoned" % (i, c))
            p = d.get("parent")
            if p is not None:
                if p not in docs:
                    stops.append("tombstone %s has parent %s that is not defined" % (i, p))
                elif i not in docs[p].get("children", []):
                    stops.append("tombstone %s names parent %s which does not list it" % (i, p))
    if "3" in rules:
        present = [i for i in DELETE_SET if i in docs]
        if present and len(present) != len(DELETE_SET):
            stops.append("only some of the twelve README documents exist: missing %s" % sorted(DELETE_SET - set(present)))
        def names_deleted(ref):
            return any(ref == x or ref.startswith(x + ":") for x in DELETE_SET)
        for i, d in docs.items():
            inside = i in DELETE_SET
            for key in ("children",):
                for c in d.get(key, []):
                    if names_deleted(c) and not (inside and c in DELETE_SET):
                        stops.append("%s lists %s in %s" % (i, c, key))
            for key in ("parent", "root"):
                v = d.get(key)
                if isinstance(v, str) and names_deleted(v) and not (inside and v in DELETE_SET):
                    stops.append("%s names %s as %s" % (i, v, key))
            for u in d.get("unfolds", []):
                if names_deleted(u):
                    stops.append("%s unfolds %s" % (i, u))
            for l in d.get("links", []):
                t = l.get("target")
                if isinstance(t, str) and names_deleted(t) and not inside:
                    stops.append("%s has a Link to %s" % (i, t))
        # the twelve must only refer to each other
        for i in DELETE_SET & set(docs):
            d = docs[i]
            for c in d.get("children", []):
                if c not in DELETE_SET:
                    stops.append("deleted %s has child %s outside the set" % (i, c))
            if "parent" in d and d["parent"] not in DELETE_SET:
                stops.append("deleted %s has parent %s outside the set" % (i, d["parent"]))
    if "4" in rules and DINHLX not in docs:
        stops.append("%s not found" % DINHLX)
    if stops:
        print("STOP: %d condition(s) the rules cannot decide; nothing was written" % len(stops))
        for s in stops:
            print("  -", s)
        return 2

    orig_parent = {i: docs[i]["parent"] for i in tomb_ids if "parent" in docs[i]}
    skip = DELETE_SET if "3" in rules else set()

    # ---- rule 2: strip the tombstones, then take them out of their containers
    if "2" in rules:
        for i in sorted(tomb_ids - skip):
            d = docs[i]
            before = json.dumps(d)
            if "links" in d:
                stats["links_dropped_with_tombstones"] += len(d["links"])
            for k in TOMBSTONE_DROP:
                d.pop(k, None)
            d["children"] = []
            if json.dumps(d) != before:
                stats["tombstones_changed_" + side(where[i])] += 1
        removals = {}
        for i, p in orig_parent.items():
            if i not in skip:
                removals.setdefault(p, set()).add(i)
        for p, ids in sorted(removals.items()):
            c = docs[p].get("children", [])
            new = [x for x in c if x not in ids]
            if new != c:
                docs[p]["children"] = new
                stats["containers_edited_" + side(where[p])] += 1

    # ---- rule 3
    if "3" in rules:
        for i in sorted(DELETE_SET & set(docs)):
            stats["deleted_" + side(where[i])] += 1

    # ---- rule 1
    if "1" in rules:
        for i, d in docs.items():
            if i in DELETE_SET and "3" in rules:
                continue
            for l in d.get("links", []):
                if "predicate" in l:
                    del l["predicate"]
                    stats["links_changed_" + side(where[i])] += 1
        
    # ---- rule 4
    if "4" in rules:
        d = docs[DINHLX]
        if "kind" not in d:
            d["kind"] = "human"
            ordered = {k: d[k] for k in PROFILE_ORDER if k in d}
            for k in d:
                if k not in ordered:
                    ordered[k] = d[k]
            d.clear()
            d.update(ordered)
            stats["profiles_changed"] += 1

    # ---- rule 5: an `unfolds` entry whose target is not defined
    if "5" in rules:
        defined = defined_ids(docs.values(), DELETE_SET if "3" in rules else set())
        for i, d in docs.items():
            if i in skip or "unfolds" not in d:
                continue
            kept = [u for u in d["unfolds"] if u in defined]
            if len(kept) != len(d["unfolds"]):
                stats["unfolds_stripped_" + side(where[i])] += len(d["unfolds"]) - len(kept)
                if kept:
                    d["unfolds"] = kept
                else:
                    del d["unfolds"]

    # ---- rule 6: no ArtifactNode holds a `type`
    if "6" in rules:
        for i, d in docs.items():
            if i in skip or d.get("@type") != "ArtifactNode" or "type" not in d:
                continue
            del d["type"]
            stats["artifact_types_stripped_" + side(where[i])] += 1

    # ---- write
    out = {}
    for f, lst in files.items():
        keep = [d for d in lst if not ("3" in rules and d["@id"] in DELETE_SET)]
        keep.sort(key=lambda d: d["@id"])
        out[f] = serialize(keep)
    really = [f for f in files if out[f] != raws[f]]
    print("graph root:", root, "(dry run, nothing written)" if dry else "")
    for k, v in stats.items():
        print("  %-32s %d" % (k, v))
    print("  files that differ after the rules: %d" % len(really))
    for f in really:
        print("    ", os.path.relpath(f, root))
    if not dry:
        for f in really:
            with open(f, "w", encoding="utf-8", newline="") as h:
                h.write(out[f])
    return 0


if __name__ == "__main__":
    sys.exit(main())
