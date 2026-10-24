#!/usr/bin/env python3
"""Check a migrated clone of the mirror against its baseline, key by key (companion of migrate-mirror.py).

One-time tool of the cutover to the new engine, with `migrate-mirror.py`, which must sit in the same
directory (the verifier loads it for the rules' constants). Python 3, standard library and `git` only.

  python3 monorepo/scripts/verify-migration.py <clone dir> [--rules 1256]

<clone dir> is a git clone of the graph (the argument is required and has no default, so the verifier
never reads the real graph unless it is named) whose HEAD is the baseline commit, committed before the
migration, and whose working tree is the migrated mirror: run `migrate-mirror.py <clone dir>` on it first.
`--rules` names the rules that the migration was run with (default 1256, the general rules, as in `migrate-mirror.py`; 123456 for this project's own graph; see
`migrate-mirror.py` and `planning/core.md`, Batch 9, step 6).

Reads: `Apeiron/*.jsonld` and `Apeiron/.state/*.jsonld` of the clone, before = `git show HEAD:<file>`,
after = the working tree; both directories are read together. Writes nothing in the clone and nothing
anywhere but the terminal. Every difference is classified as one of the rules' that were run; anything else is
listed as UNEXPECTED, and so is a migrated clone that still holds an `unfolds` entry whose target is not defined (rule 5) or
an ArtifactNode that holds a `type` (rule 6). Also prints the conformity checks of the migrated state and five samples of each
kind of change, then ends with the exit status: 0 for a clean check (`UNEXPECTED differences: 0`), 1 when
unexpected differences are listed, 2 for a usage error or a stop condition: with no argument, or with an
argument that is not a graph root (a directory holding `Apeiron/`; an argument that starts with `-`, `--help` among them, is never one), the verifier prints this text on stderr,
reads nothing and exits with status 2; so does a `--rules` with no value or with a value that is not a list
of rule numbers 1 to 6 (a usage message on stderr, nothing read); it has no other stop condition. Read the conformity counts as well:
they do not change the status. Any other failure (an unreadable file, a `git` error) still ends in a Python
traceback, which is status 1: the verifier does not tell it from unexpected differences.
"""
import glob
import json
import os
import subprocess
import sys
import collections

if len(sys.argv) < 2:
    print(__doc__, file=sys.stderr)
    sys.exit(2)
if sys.argv[1].startswith("-") or not os.path.isdir(os.path.join(sys.argv[1], "Apeiron")):
    print("usage error: the first argument must be a graph root, a directory that holds Apeiron/; got %r; nothing was read\nusage: verify-migration.py <clone dir> [--rules 1..6]" % sys.argv[1], file=sys.stderr)
    sys.exit(2)

if "--rules" in sys.argv:
    _k = sys.argv.index("--rules")
    _v = sys.argv[_k + 1] if _k + 1 < len(sys.argv) else ""
    if not _v or any(c not in "123456" for c in _v):
        print("usage error: --rules takes a list of rule numbers 1 to 6, e.g. --rules 3 or --rules 12; nothing was read\nusage: verify-migration.py <clone dir> [--rules 1..6]", file=sys.stderr)
        sys.exit(2)

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import importlib.util
spec = importlib.util.spec_from_file_location("mm", os.path.join(os.path.dirname(os.path.abspath(__file__)), "migrate-mirror.py"))
mm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mm)
DELETE_SET = mm.DELETE_SET

clone = sys.argv[1]
rules = sys.argv[sys.argv.index("--rules") + 1] if "--rules" in sys.argv else mm.DEFAULT_RULES
rels = [os.path.relpath(f, clone) for f in sorted(glob.glob(clone + "/Apeiron/*.jsonld")) + sorted(glob.glob(clone + "/Apeiron/.state/*.jsonld"))]


def git_show(rel):
    return subprocess.run(["git", "show", "HEAD:" + rel], cwd=clone, check=True, capture_output=True).stdout.decode("utf-8")


def read(from_git):
    docs, where = {}, {}
    for rel in rels:
        raw = git_show(rel) if from_git else open(os.path.join(clone, rel), encoding="utf-8").read()
        for d in json.loads(raw):
            assert d["@id"] not in docs, d["@id"]
            docs[d["@id"]] = d
            where[d["@id"]] = rel
    return docs, where


B, bw = read(True)
A, aw = read(False)
tomb = {i for i, d in B.items() if "tombstonedAt" in d}
unexpected = []
kinds = collections.defaultdict(list)   # kind of change -> samples


def strip_link(l):
    return {k: v for k, v in l.items() if k != "predicate"}


removed_from = collections.defaultdict(set)   # container -> tombstone ids expected out
for i in tomb:
    if "2" in rules and "parent" in B[i] and not (i in DELETE_SET and "3" in rules):
        removed_from[B[i]["parent"]].add(i)

counts = collections.Counter()

# 1. ids: only the twelve may vanish; nothing may appear
vanished = set(B) - set(A)
appeared = set(A) - set(B)
expected_gone = DELETE_SET & set(B) if "3" in rules else set()
# the ids that rule 5 may keep an `unfolds` entry for: those that stand before the migration, but the twelve
expected_defined = mm.defined_ids(B.values(), expected_gone)
if vanished != expected_gone:
    unexpected.append(("document set", "vanished %s, expected %s" % (sorted(vanished - expected_gone), sorted(expected_gone - vanished))))
if appeared:
    unexpected.append(("document set", "appeared %s" % sorted(appeared)))
for i in sorted(vanished & expected_gone):
    counts["deleted"] += 1
    kinds["rule 3 deleted"].append(i)

for i in sorted(set(B) & set(A)):
    b, a = B[i], A[i]
    if b == a:
        counts["unchanged"] += 1
        continue
    if bw[i] != aw[i]:
        unexpected.append((i, "moved between files %s -> %s" % (bw[i], aw[i])))
    exp = json.loads(json.dumps(b))
    cats = []
    # rule 4
    if i == mm.DINHLX and "4" in rules and "kind" not in exp:
        exp["kind"] = "human"
        exp = {k: exp[k] for k in mm.PROFILE_ORDER if k in exp}
        cats.append("rule 4 profile")
    # rule 5 (an unfolds entry whose target is not defined)
    if "5" in rules and "unfolds" in exp:
        kept = [u for u in exp["unfolds"] if u in expected_defined]
        if len(kept) != len(exp["unfolds"]):
            if kept:
                exp["unfolds"] = kept
            else:
                del exp["unfolds"]
            cats.append("rule 5 unfolds")
    # rule 6 (the type of an artifact)
    if "6" in rules and exp.get("@type") == "ArtifactNode" and "type" in exp:
        del exp["type"]
        cats.append("rule 6 artifact type")
    # rule 2 (tombstone itself)
    if i in tomb and "2" in rules:
        for k in ("parent", "links", "props"):
            exp.pop(k, None)
        exp["children"] = []
        cats.append("rule 2 tombstone")
    # rule 2 (container)
    if i in removed_from:
        new = [c for c in exp.get("children", []) if c not in removed_from[i]]
        if new != exp.get("children", []):
            exp["children"] = new
            cats.append("rule 2 container")
    # rule 1 (links of surviving documents)
    if "1" in rules and "links" in exp and i not in (tomb if "2" in rules else set()):
        if any("predicate" in l for l in exp["links"]):
            exp["links"] = [strip_link(l) for l in exp["links"]]
            cats.append("rule 1 links")
    if exp == a and list(exp.keys()) == list(a.keys()):
        for c in cats:
            counts[c] += 1
            kinds[c].append(i)
    else:
        diff = sorted(k for k in set(exp) | set(a) if exp.get(k) != a.get(k))
        if not diff:
            diff = ["key order %s vs %s" % (list(exp.keys()), list(a.keys()))]
        unexpected.append((i, "differs from what the rules give in %s" % diff))

# rules 5 and 6 leave nothing of what they strip
if "5" in rules:
    left = [(i, u) for i, d in A.items() for u in d.get("unfolds", []) if u not in mm.defined_ids(A.values())]
    if left:
        unexpected.append(("rule 5", "%d unfolds entries still name an id that is not defined, e.g. %s" % (len(left), left[0])))
if "6" in rules:
    left = [i for i, d in A.items() if d.get("@type") == "ArtifactNode" and "type" in d]
    if left:
        unexpected.append(("rule 6", "%d artifacts still hold a type, e.g. %s" % (len(left), left[0])))

# every document the rules should have changed did change
for i in tomb - (DELETE_SET if "3" in rules else set()):
    if "2" in rules and i in A and (set(A[i]) & {"parent", "links", "props"} or A[i].get("children") != []):
        unexpected.append((i, "tombstone still holds structure"))

print("documents before %d, after %d" % (len(B), len(A)))
for k in sorted(counts):
    print("  %-22s %d" % (k, counts[k]))
print("UNEXPECTED differences: %d" % len(unexpected))
for u in unexpected[:50]:
    print("  ", u)

# conformity
print("\nconformity of the migrated state")
live = A
nopred = sum(1 for d in A.values() for l in d.get("links", []) if "predicate" in l)
print("  Link with a predicate (any document):", nopred)
_defined_now = mm.defined_ids(A.values())
print("  unfolds entries whose target is not defined:", sum(1 for d in A.values() for u in d.get("unfolds", []) if u not in _defined_now))
print("  artifacts that hold a type:", sum(1 for d in A.values() if d.get("@type") == "ArtifactNode" and "type" in d))
ta = {i for i, d in A.items() if "tombstonedAt" in d}
print("  tombstones: %d; with parent %d, links %d, props %d, non-empty children %d" % (
    len(ta), sum("parent" in A[i] for i in ta), sum("links" in A[i] for i in ta),
    sum("props" in A[i] for i in ta), sum(bool(A[i].get("children")) for i in ta)))
print("  containers listing a tombstone:", sum(1 for i, d in A.items() for c in d.get("children", []) if c in ta))
defined = set(A)
for d in A.values():
    for l in d.get("links", []):
        defined.add(l["@id"])
        for p in l.get("props", []):
            defined.add(p["@id"])
    for p in d.get("props", []):
        defined.add(p["@id"])
missing = collections.Counter()
missing_list = []
for i, d in A.items():
    refs = [("children", c) for c in d.get("children", [])]
    if "parent" in d:
        refs.append(("parent", d["parent"]))
    if "root" in d:
        refs.append(("root", d["root"]))
    refs += [("unfolds", u) for u in d.get("unfolds", [])]
    refs += [("target", l["target"]) for l in d.get("links", [])]
    for k, r in refs:
        if r not in defined:
            missing[(k, r)] += 1
            missing_list.append((i, k, r))
print("  references to ids defined in neither directory:", len(missing_list))
for k, v in sorted(missing.items()):
    print("    ", k, "x%d" % v, "from", [m[0] for m in missing_list if (m[1], m[2]) == k][:3])
parentless = sorted(i for i, d in A.items() if "parent" not in d and "tombstonedAt" not in d and d["@type"] in ("BlockNode", "ArtifactNode", "FolderNode"))
byt = collections.Counter(i.split(":")[0] for i in parentless)
print("  parentless live documents: %d %s" % (len(parentless), dict(byt)))
print("   FolderNode:", [i for i in parentless if i.startswith("FolderNode")], " ArtifactNode:", [i for i in parentless if i.startswith("ArtifactNode")])
print("   READMEs among them:", [i for i in parentless if i in DELETE_SET])
print("   README.md artifacts still defined:", [i for i, d in A.items() if d["@type"] == "ArtifactNode" and d.get("path", "").endswith("README.md")])
for _profile in (mm.DINHLX, "Profile:00CA03JXD8000"):   # this project's own two profiles, when the graph has them
    if _profile in A:
        print("   %s:" % _profile, A[_profile])

print("\nsamples (up to five each)")
for c in sorted(kinds):
    print(" ", c, "(%d)" % len(kinds[c]))
    for i in kinds[c][:5]:
        print("    ", i)

sys.exit(1 if unexpected else 0)
