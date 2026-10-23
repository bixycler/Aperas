#!/usr/bin/env python3
"""The snapshot of the differential run's script of commands (Python 3, standard library only; planning/core.md, Batch 13, piece 4).

  python3 monorepo/scripts/differential/corpus.py --out <snapshot-dir> --port <p> [--reference-code <monorepo>] [--workdir <dir>]

Builds, with the reference's own service (the old form is what the reference reads and what `migrate-mirror.py` migrates), a graph root that holds the `cmd_demo`
corpus of `tests/support/commandsCorpus.ts` (`beta.md`, `dup.md`, `alpha.md` and `gamma.md`, the last two linking to ids of the first) and a few artifacts of
its own for the cases of Layer 4 (a document with a front matter, one with lists, a quote, a code block and a table, one with three links of six positions each (so that a store that lists a set in an order of its own does not list the positions in the order an ingest writes them), and two documents that link to the same artifact as `alpha.md` and `rich.md` do, a nested
folder, and a thread under `.threads/`, made by holders, and two views). It then adds the fixture of the ghost folder (a `children` entry of the folder `cmd_demo` that names an id with no
document). `<snapshot-dir>` must not exist. The ids of the snapshot are the same on both sides of a run, so the list of commands names them; `ids_of(snapshot)`
reads them back by path and title (the thread's, which is in `.state/`, too).
"""
import argparse
import json
import os
import re
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import harness  # noqa: E402

GHOST_ID = "FolderNode:00GH0ST000000"   # 13 characters of the Crockford alphabet, and no document

PROFILES = [
    {"@id": "Profile:00CA03JXD8000", "@type": "Profile", "handle": "default"},
    {"@id": "Profile:00CJC4S69R000", "@type": "Profile", "handle": "dinhlx", "name": "Dinh Le"},
]

FIRST = {
    "cmd_demo/beta.md": "# Beta\n\nBeta intro.\n\n## Beta Section\n\nBeta section text.\n\n## Other\n\nOther text.\n",
    "cmd_demo/dup.md": "# Dup\n\nDup intro.\n\n## Item One\n\nOne.\n\n## Item Two\n\nTwo.\n",
}


def second(beta_art, beta_sec, alpha_sec, table):
    """The artifacts that name ids of the first two."""
    return {
        "cmd_demo/alpha.md": "# Alpha\n\nTo [beta]([[%s]]) and [section]([[%s]]).\n\n## Alpha Sec\n\nAlpha text.\n" % (beta_art, beta_sec),
        "cmd_demo/gamma.md": "# Gamma\n\nAlso [section]([[%s]]) and [later]([[NotYetWritten]]).\n" % beta_sec,
        "cmd_demo/delta.md": "# Delta\n\nSix to %s, six to %s and six to %s.\n\n## Delta Sec\n\nDelta text.\n" % tuple(" ".join("[%s%d]([[%s]])" % (c, n, target) for n in range(1, 7)) for c, target in (("a", beta_sec), ("b", alpha_sec), ("c", table))),
        "cmd_demo/eps.md": "# Eps\n\nTo [beta]([[%s]]).\n" % beta_art,
        "cmd_demo/zeta.md": "# Zeta\n\nTo [beta]([[%s]]).\n" % beta_art,
        "cmd_demo/front.md": "---\ndescription: A document with a front matter.\nlang: en\n---\n\n# Front\n\nFront text.\n",
        "cmd_demo/rich.md": (
            "# Rich\n\nRich intro, to [beta]([[%s]]).\n\n## Lists\n\n- first item\n- second item\n  - nested item\n\n1. one\n2. two\n\n"
            "## Single\n\n- only item\n\n## Wrapper\n\n- - inner item\n\n## Quote and code\n\n> A quote.\n\n```ts\nconst x = 1;\n```\n\n## Table\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n---\n\nClosing paragraph.\n" % beta_art),
        "cmd_demo/sub/deep.md": "# Deep\n\nDeep text.\n\n## Deeper\n\nDeeper text.\n",
    }


def write_files(root, files):
    for rel, text in files.items():
        path = os.path.join(root, "artifacts", rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as h:
            h.write(text)


def aperas(side, args, timeout=120, stdin=None):
    r = harness.run_aperas(side, args, timeout, stdin)
    if r["status"] != 0:
        raise harness.Failure("aperas %s ended with status %s: %s %s" % (" ".join(args), r["status"], r["stdout"], r["stderr"]))
    if os.environ.get("CORPUS_ECHO"):
        print("$ aperas %s\n%s%s" % (" ".join(args), r["stdout"], r["stderr"]))
    return r["stdout"]


def id_of(side, path):
    out = aperas(side, ["resolve", path])
    m = re.match(r"aperas://id/(\S+)", out.splitlines()[0])
    if not m:
        raise harness.Failure("resolve %s printed %r" % (path, out))
    return m.group(1)


def add_ghost(apeiron):
    """The ghost-folder fixture: the folder `cmd_demo` lists, in `children`, an id that no document has."""
    path = os.path.join(apeiron, "FolderNode.jsonld")
    with open(path, encoding="utf-8") as h:
        docs = json.load(h)
    folders = [d for d in docs if d.get("path") == "cmd_demo"]
    if len(folders) != 1:
        raise harness.Failure("the corpus has %d folders at cmd_demo, not one" % len(folders))
    folders[0].setdefault("children", []).append(GHOST_ID)
    with open(path, "w", encoding="utf-8") as h:
        json.dump(docs, h, indent=2, ensure_ascii=False)
        h.write("\n")


def build(out, reference_code, port, workdir):
    out, workdir = os.path.abspath(out), os.path.abspath(workdir)
    if os.path.exists(out):
        raise harness.Refusal("%s exists" % out)
    if os.path.exists(workdir) and os.listdir(workdir):
        raise harness.Refusal("%s is not empty" % workdir)
    os.makedirs(workdir, exist_ok=True)
    side = harness.Side("ref", reference_code, workdir, port, 509, "corpus")
    os.makedirs(side.apeiron)
    for kind, docs in (("ArtifactNode", []), ("BlockNode", []), ("FolderNode", []), ("Profile", PROFILES)):
        with open(os.path.join(side.apeiron, kind + ".jsonld"), "w", encoding="utf-8") as h:
            h.write(json.dumps(docs, indent=2, ensure_ascii=False) + "\n")
    os.makedirs(side.artifacts)
    os.makedirs(side.xdg_config)
    world = harness.World(workdir)
    harness.assert_isolated(side, world)
    started = False
    try:
        write_files(side.root, FIRST)
        harness.start_side(side, world, [], 120)
        started = True
        aperas(side, ["track", "--no-prompt", "--flush"] + list(FIRST))
        aperas(side, ["ingest", "--no-prompt", "--flush"] + list(FIRST))
        beta_art = id_of(side, "cmd_demo/beta.md").split(":")[1]
        beta_sec = id_of(side, "cmd_demo/beta.md/Beta/Beta Section").split(":")[1]
        files = second(beta_art, beta_sec, None, None)
        files.pop("cmd_demo/delta.md")
        write_files(side.root, files)
        aperas(side, ["track", "--no-prompt", "--flush"] + list(files))
        aperas(side, ["ingest", "--no-prompt", "--flush"] + list(files))
        # `delta.md` links to a node of `alpha.md` and one of `rich.md`, which have to exist, so it comes last
        alpha_sec = id_of(side, "cmd_demo/alpha.md/Alpha/Alpha Sec").split(":")[1]
        table = id_of(side, "cmd_demo/rich.md/Rich/Table").split(":")[1]
        files = {"cmd_demo/delta.md": second(beta_art, beta_sec, alpha_sec, table)["cmd_demo/delta.md"]}
        write_files(side.root, files)
        aperas(side, ["track", "--no-prompt", "--flush"] + list(files))
        aperas(side, ["ingest", "--no-prompt", "--flush"] + list(files))
        # A thread is made by holders, as the real graph's are (the track and the ingest leave the hidden folder `.threads` out). The reference marks the state of the
        # threads graph dirty on a write to a view only, so the thread is written to `.state/` with the first view.
        turn = ".threads/coder.md/Coder-thread/topic/task/Turn-1"
        aperas(side, ["resolve", "--create-holder", turn, "--titles", "# Coder thread", "## topic", "### task", "#### Turn 1", "--flush"])
        aperas(side, ["insert", turn, "--flush"], stdin="- **Ask**: do the thing\n- **Report**: done\n")
        aperas(side, ["profile", "create-view", "default", "--profile", "default", "--flush"])
        aperas(side, ["profile", "create-view", "work", "--profile", "dinhlx", "--flush"])
        aperas(side, ["flush"])
    finally:
        if started or side.lock() is not None:
            harness.stop_side(side, world, 60)
    left = harness.processes_with_env(side.needles())
    if left:
        raise harness.Failure("processes left: %s" % left)
    os.makedirs(out)
    for sub in ("Apeiron", "artifacts"):
        shutil.copytree(os.path.join(side.root, sub), os.path.join(out, sub), symlinks=True)
    add_ghost(os.path.join(out, "Apeiron"))
    return out


def ids_of(snapshot):
    """-> {path: id} for the artifacts and folders, and {(artifact path, title): id} for the blocks, read from the snapshot's mirror files."""
    apeiron = os.path.join(snapshot, "Apeiron")
    by_path, by_title = {}, {}
    docs = {}
    for sub in ("", ".state"):
        for kind in ("ArtifactNode", "FolderNode", "BlockNode"):
            f = os.path.join(apeiron, sub, kind + ".jsonld")
            if os.path.isfile(f):
                with open(f, encoding="utf-8") as h:
                    for d in json.load(h):
                        docs[d["@id"]] = d
    for i, d in docs.items():
        if d.get("path"):
            by_path[d["path"]] = i
    parent = {}
    for i, d in docs.items():
        for c in d.get("children", []):
            parent[c] = i
    for i, d in docs.items():
        if d["@type"] != "BlockNode" or not d.get("title"):
            continue
        top = i
        while top in parent and docs[top]["@type"] != "ArtifactNode":
            top = parent[top]
        path = docs[top].get("path") if top in docs and docs[top]["@type"] == "ArtifactNode" else None
        if path:
            by_title.setdefault((path, d["title"]), i)
    return by_path, by_title


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--out", required=True)
    p.add_argument("--port", type=int, required=True)
    p.add_argument("--reference-code", default=harness.DEFAULT_REFERENCE)
    p.add_argument("--workdir")
    args = p.parse_args(argv)
    out = os.path.abspath(args.out)
    workdir = args.workdir or out + ".build"
    try:
        build(out, args.reference_code, args.port, workdir)
    except harness.Refusal as e:
        print("REFUSED: %s" % e, file=sys.stderr)
        return 2
    except harness.Failure as e:
        print("FAILED: %s" % e, file=sys.stderr)
        return 1
    print("snapshot written to %s" % out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
