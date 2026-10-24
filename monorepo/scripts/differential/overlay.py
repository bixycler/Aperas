#!/usr/bin/env python3
"""The snapshot of the differential run on a copy of the real mirror (Python 3, standard library only; planning/core.md, Batch 13, piece 5).

  python3 monorepo/scripts/differential/overlay.py --real <copy of a graph root> --small <snapshot built by corpus.py> --out <dir> [--thread-artifact difftest.md]

The script of commands (`cases.py`) names the ids of the `cmd_demo` corpus, so on a copy of the real mirror the corpus is laid over it: `<dir>` is a copy of `--real` (the
graph root `Apeiron/` with its `.state/`, `artifacts/`, `aperas.config.json`) that also holds every document of `--small` that the real mirror does not have already, written into
the same files, and the files of the `cmd_demo` corpus under `artifacts/`:

  * the folder `cmd_demo` joins the children of the real root folder (after `archive`, where the sorted order puts it); `cmd_demo/sub` and the artifacts keep their parents;
  * the thread of the small corpus (`.threads/coder.md`, which the real graph has already) is renamed `--thread-artifact` and joins the real `.threads` folder;
  * the profiles and the view `default` the real graph already has are not added twice; the view `work` is added;
  * the real documents are not touched otherwise, and a file that the real mirror holds is written back only when it gains a document: the same JSON as it was read,
    with the formatting of the mirror (2 spaces, no ASCII escapes, a final newline), so that a real file's text changes by the documents added and nothing else.

`<dir>` must not exist. `<real>` is only read.
"""
import argparse
import json
import os
import shutil
import sys

KINDS = ("ArtifactNode", "BlockNode", "FolderNode", "Profile", "TreeView")


class Refusal(Exception):
    pass


def load(path):
    if not os.path.isfile(path):
        return []
    with open(path, encoding="utf-8") as h:
        return json.load(h)


def dump(path, docs):
    with open(path, "w", encoding="utf-8") as h:
        json.dump(docs, h, indent=2, ensure_ascii=False)
        h.write("\n")


def merge(real_dir, small_dir, out_dir, thread_artifact):
    """Adds to the files of `out_dir/<real_dir>` the documents of `small_dir` that it lacks; -> {file: added}."""
    added = {}
    real_docs, small_docs = {}, {}
    for sub in ("", ".state"):
        for kind in KINDS:
            real_docs[(sub, kind)] = load(os.path.join(real_dir, sub, kind + ".jsonld"))
            small_docs[(sub, kind)] = load(os.path.join(small_dir, sub, kind + ".jsonld"))
    real_ids = {d["@id"] for docs in real_docs.values() for d in docs}
    by_id = {d["@id"]: d for docs in real_docs.values() for d in docs}
    real_folder_by_path = {d["path"]: d for docs in real_docs.values() for d in docs if d["@type"] == "FolderNode" and d.get("path")}
    small_by_id = {d["@id"]: d for docs in small_docs.values() for d in docs}
    # the folders of the small corpus that the real graph has already (the root, `.threads`): their children join the real folder's, their id is replaced by the real one
    replaced = {}
    for d in small_by_id.values():
        if d["@type"] == "FolderNode" and d.get("path") in real_folder_by_path:
            replaced[d["@id"]] = real_folder_by_path[d["path"]]["@id"]
    # the thread artifact is renamed
    for d in small_by_id.values():
        if d["@type"] == "ArtifactNode" and d.get("path", "").startswith(".threads/"):
            if os.path.join(".threads", thread_artifact) in {x.get("path") for x in by_id.values() if x["@type"] == "ArtifactNode"}:
                raise Refusal("the real graph has the thread %s already" % thread_artifact)
            d["path"] = ".threads/" + thread_artifact
            d["title"] = thread_artifact
    for key in real_docs:
        sub, kind = key
        new = []
        for d in small_docs[key]:
            if d["@id"] in real_ids or d["@id"] in replaced:
                continue
            d = json.loads(json.dumps(d))
            if d.get("parent") in replaced:
                d["parent"] = replaced[d["parent"]]
            if kind == "TreeView" and any(x.get("name") == d.get("name") for x in real_docs[key]):
                continue
            new.append(d)
        if new:
            real_docs[key] = real_docs[key] + new
            added[os.path.join(sub, kind + ".jsonld")] = len(new)
    # the children the real folders gain
    for old_id, real_id in replaced.items():
        real = by_id[real_id]
        gains = [c for c in small_by_id[old_id].get("children", []) if c not in replaced]
        for c in gains:
            if c in real.setdefault("children", []):
                continue
            kids = real["children"]
            if c.startswith("FolderNode:") and real.get("path") == ".":
                # sorted among the folders: after the last folder whose path sorts before it
                path = small_by_id[c].get("path", "")
                at = 0
                for i, k in enumerate(kids):
                    if k.startswith("FolderNode:") and k in by_id and by_id[k].get("path", "") < path and not by_id[k].get("holder"):
                        at = i + 1
                kids.insert(at, c)
            else:
                kids.append(c)
    for (sub, kind), docs in real_docs.items():
        path = os.path.join(out_dir, sub, kind + ".jsonld")
        if docs or os.path.isfile(path):
            # a file is rewritten only when a document was added to it, or a folder gained a child
            if os.path.join(sub, kind + ".jsonld") in added or kind == "FolderNode":
                dump(path, docs)
    return added


def build(real, small, out, thread_artifact="difftest.md"):
    real, small, out = os.path.abspath(real), os.path.abspath(small), os.path.abspath(out)
    for what, root in (("--real", real), ("--small", small)):
        for sub in ("Apeiron", "artifacts"):
            if not os.path.isdir(os.path.join(root, sub)):
                raise Refusal("%s %s has no %s/" % (what, root, sub))
    if os.path.exists(out):
        raise Refusal("%s exists" % out)
    os.makedirs(out)
    shutil.copytree(os.path.join(real, "Apeiron"), os.path.join(out, "Apeiron"), symlinks=True)
    shutil.copytree(os.path.join(real, "artifacts"), os.path.join(out, "artifacts"), symlinks=True)
    if os.path.isfile(os.path.join(real, "aperas.config.json")):
        shutil.copy2(os.path.join(real, "aperas.config.json"), os.path.join(out, "aperas.config.json"))
    added = merge(os.path.join(real, "Apeiron"), os.path.join(small, "Apeiron"), os.path.join(out, "Apeiron"), thread_artifact)
    for dirpath, _, names in os.walk(os.path.join(small, "artifacts")):
        for name in names:
            src = os.path.join(dirpath, name)
            dst = os.path.join(out, "artifacts", os.path.relpath(src, os.path.join(small, "artifacts")))
            if os.path.exists(dst):
                raise Refusal("the real artifacts have %s already" % os.path.relpath(dst, os.path.join(out, "artifacts")))
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.copy2(src, dst)
    return added


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--real", required=True)
    p.add_argument("--small", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--thread-artifact", default="difftest.md")
    args = p.parse_args(argv)
    try:
        added = build(args.real, args.small, args.out, args.thread_artifact)
    except Refusal as e:
        print("REFUSED: %s" % e, file=sys.stderr)
        return 2
    for f, n in sorted(added.items()):
        print("%-28s +%d documents" % (f, n))
    print("snapshot written to %s" % os.path.abspath(args.out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
