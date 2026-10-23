#!/usr/bin/env python3
"""The script of commands of the differential run on the small corpus (Python 3, standard library only; planning/core.md, Batch 13, piece 4).

  python3 monorepo/scripts/differential/cases.py --snapshot <snapshot built by corpus.py> --out <list.json> [--part main|lifecycle]

Writes the list of commands `harness.py` runs on both sides, naming the ids of the snapshot. Two parts, each started from a fresh copy of the snapshot:

  main       every verb of the new side (19) with its flags and its refusals, the verbs only the reference has (`link`, `unlink`, `migrate-frontmatter`), the
             views, the writes and the removals, the sweeps that `reload`, `flush --clobber` and `service restart` reach, and the cases of the deliberate
             differences of Layer 4; the one command that makes the reference engine loop (a move into its own subtree) is the last of it, and the reference
             side of it is expected to outlive its timeout
  lifecycle  the starts that the main part cannot make: a service stopped and started again on a mirror that holds a duplicated id, a document with a key
             its kind does not declare, a file that is not JSON, and the options `--start-anyway`

`CASES` is the table of what each case is for: its name, the entries of Layer 4 it is meant to reach (the keys of `compare.MATCHERS`, 1 to 28) and what it
is. The driver (`cmdrun.py`) prints it beside what the run saw.
"""
import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import corpus  # noqa: E402

CASES = []   # (name, entries, what)


class Builder:
    def __init__(self, snapshot):
        self.by_path, self.by_title = corpus.ids_of(snapshot)
        self.snapshot = snapshot
        self.commands = []
        self.docs = {}
        for kind in ("BlockNode", "ArtifactNode", "FolderNode"):
            with open(os.path.join(snapshot, "Apeiron", kind + ".jsonld"), encoding="utf-8") as h:
                for d in json.load(h):
                    self.docs[d["@id"]] = d
        state = os.path.join(snapshot, "Apeiron", ".state")
        for kind in ("BlockNode", "ArtifactNode", "FolderNode"):
            f = os.path.join(state, kind + ".jsonld")
            if os.path.isfile(f):
                with open(f, encoding="utf-8") as h:
                    for d in json.load(h):
                        self.docs[d["@id"]] = d

    def kids(self, id_):
        return list(self.docs[id_].get("children", []))

    def art(self, path):
        return self.by_path[path]

    def blk(self, path, title):
        return self.by_title[(path, title)]

    def link(self, path, title, target_title=None, target=None):
        """The id of the first link of a block (or the one that names `target`)."""
        host = self.docs[self.blk(path, title)]
        for l in host.get("links", []):
            if target is None or l["target"] == target:
                return l["@id"]
        raise KeyError((path, title, target))

    def add(self, name, *args, entries=(), what="", **kw):
        if any(c["name"] == name for c in self.commands):
            raise ValueError("two cases named " + name)
        c = {"name": name}
        if args:
            c["args"] = list(args)
        c.update(kw)
        self.commands.append(c)
        CASES.append((name, tuple(entries), what))
        return c


def main_part(b):
    a = b.add
    ALPHA, BETA, GAMMA, DELTA, DUP, FRONT, RICH, DEEP = (b.art("cmd_demo/%s.md" % n) if n != "deep" else b.art("cmd_demo/sub/deep.md") for n in ("alpha", "beta", "gamma", "delta", "dup", "front", "rich", "deep"))
    BS = b.blk("cmd_demo/beta.md", "## Beta Section")
    ALPHA_H = b.blk("cmd_demo/alpha.md", "# Alpha")
    DELTA_H = b.blk("cmd_demo/delta.md", "# Delta")
    FOLDER = b.by_path["cmd_demo"]
    LINK_TO_SEC = b.link("cmd_demo/alpha.md", "# Alpha", target=BS)
    PROFILE = "Profile:00CJC4S69R000"
    DEFAULT = "cmd_demo/alpha.md/Alpha"

    # ---------------------------------------------------------------------------------------------------------------- reads
    a("tree-root", "tree", ".", what="the whole tree; the ghost is in no list")
    a("tree-root-noarg", "tree")
    a("tree-root-depth1", "tree", ".", "--depth", "1")
    a("tree-artifact", "tree", "cmd_demo/beta.md")
    a("tree-deep-path", "tree", "cmd_demo/beta.md/Beta/Beta Section")
    a("tree-by-id", "tree", BS)
    a("tree-by-bare-code", "tree", BS.split(":")[1])
    a("tree-gamma", "tree", "cmd_demo/gamma.md", what="a holder is shown")
    a("tree-gamma-noholders", "tree", "cmd_demo/gamma.md", "--no-holders")
    a("tree-folder", "tree", "cmd_demo", what="the folder that lists the ghost")
    a("tree-folder-tombstoned", "tree", "cmd_demo", "--tombstoned")
    a("tree-threads", "tree", ".threads")
    a("tree-rich", "tree", "cmd_demo/rich.md")
    a("tree-missing", "tree", "cmd_demo/nothing.md", what="a refusal")
    a("tree-bad-depth", "tree", ".", "--depth", "x", what="a refusal")
    a("tree-bad-flag", "tree", ".", "--nonsense", what="a refusal")
    a("tree-render-tree-needs-view", "tree", ".", "--format", "render-tree", what="a refusal")
    a("show-alpha", "show", "cmd_demo/alpha.md/Alpha", entries=(19,), what="a block with two links")
    a("show-alpha-text", "show", "cmd_demo/alpha.md/Alpha", "--text")
    a("show-delta", "show", "cmd_demo/delta.md/Delta", entries=(19,), what="three links of six positions")
    a("show-artifact", "show", "cmd_demo/alpha.md", entries=(8,), what="an artifact has no `type`")
    a("show-folder", "show", "cmd_demo", what="the folder that lists the ghost")
    a("show-thread-block", "show", ".threads/coder.md/Coder-thread/topic/task/Turn-1/Ask")
    a("show-link-id", "show", LINK_TO_SEC)
    a("show-profile", "show", PROFILE)
    a("show-reload", "show", "cmd_demo/beta.md", "--reload")
    a("show-missing", "show", "cmd_demo/nothing.md", what="a refusal")
    a("show-no-arg", "show", what="a refusal")
    a("path-block", "path", BS)
    a("path-artifact", "path", ALPHA)
    a("path-folder", "path", FOLDER)
    a("path-link", "path", LINK_TO_SEC, entries=(17,), what="a Link has no path")
    a("path-profile", "path", PROFILE, entries=(17,), what="a Profile has no path")
    a("path-missing", "path", "BlockNode:00ZZZZZZZZZZZ", what="a refusal")
    a("path-no-arg", "path", what="a refusal")
    a("resolve-two", "resolve", "cmd_demo/alpha.md/Alpha", "cmd_demo/beta.md/Beta/Other")
    a("resolve-missing", "resolve", "cmd_demo/nothing.md", what="a refusal")
    a("resolve-base", "resolve", "--base", "cmd_demo", "beta.md")
    a("resolve-base-missing", "resolve", "--base", "cmd_demo", "nothing.md")
    a("resolve-no-arg", "resolve", what="a refusal")
    a("resolve-titles-without-create", "resolve", "cmd_demo/beta.md", "--titles", "# X", what="a refusal")
    a("backlinks-section", "backlinks", BS, entries=(15,), what="three referrers")
    a("backlinks-section-text", "backlinks", BS, "--text", entries=(15,))
    a("backlinks-artifact", "backlinks", BETA, entries=(15,), what="two referrers")
    a("backlinks-none", "backlinks", DUP)
    a("backlinks-missing", "backlinks", "cmd_demo/nothing.md", what="a refusal")
    a("backlinks-reload", "backlinks", BS, "--reload")
    a("check-links", "check-links")
    a("check-links-json", "check-links", "--json", entries=(15,))
    a("check-links-verbose", "check-links", "--verbose")
    a("check-links-reload", "check-links", "--reload")
    a("check-links-bad-flag", "check-links", "--nonsense", what="a refusal")
    a("profile-list", "profile", "list", entries=(15,), what="two profiles")
    a("profile-list-one", "profile", "list", "dinhlx")
    a("profile-list-missing", "profile", "list", "nobody", what="a refusal")
    a("profile-list-view", "profile", "list-view", entries=(15,))
    a("profile-list-view-one", "profile", "list-view", "work")
    a("profile-bad-subcommand", "profile", "nonsense", what="a refusal")
    a("profile-no-subcommand", "profile", what="a refusal")
    a("track-reverse", "track", "--reverse", entries=(15, 20), what="the ghost folder is in no list of the new side")
    a("project-dry-artifact", "project", "cmd_demo/alpha.md", "--dry-run")
    a("project-dry-rich", "project", "cmd_demo/rich.md", "--dry-run")
    a("project-dry-front", "project", "cmd_demo/front.md", "--dry-run")
    a("project-dry-folder", "project", "cmd_demo", "--dry-run")
    a("project-missing", "project", "cmd_demo/nothing.md", "--dry-run", what="a refusal")
    a("unfold-peek", "unfold", DEFAULT, entries=(13,), what="two links of one block")
    a("unfold-peek-link", "unfold", LINK_TO_SEC, what="a Link by its bare id")
    a("unfold-peek-missing", "unfold", "cmd_demo/nothing.md", what="a refusal")
    a("unfold-peek-tombstoned-flag", "unfold", DEFAULT, "--tombstoned")

    # the verbs only the reference has
    a("link-removed", "link", "cmd_demo/alpha.md/Alpha", what="a verb of the reference only (the removal of manual links)")
    a("unlink-removed", "unlink", "cmd_demo/alpha.md/Alpha", "cmd_demo/beta.md", what="a verb of the reference only (the removal of manual links)")
    a("migrate-frontmatter-removed", "migrate-frontmatter", "--help", what="a verb of the reference only; its run changes the reference's mirror, so only its help is asked")
    a("unknown-verb", "frobnicate", what="a refusal")
    a("help", "--help")
    a("show-help", "show", "--help")
    a("identity-show", "identity", what="reaches no service")
    a("init-help", "init", "--help", what="reaches no service")
    a("skill-help", "skill", "--help", what="reaches no service")
    a("serve-help", "serve", "--help", what="reaches no service")

    v = dict(locals())
    views_section(b, a, v)
    writes_section(b, a, v)
    ingest_section(b, a, v)
    sweeps_section(b, a, v)
    hang_section(b, a, v)
    return b.commands


def views_section(b, a, v):
    BS, ALPHA_H, LINK_TO_SEC = v["BS"], v["ALPHA_H"], v["LINK_TO_SEC"]
    GAMMA_H = b.blk("cmd_demo/gamma.md", "# Gamma")
    GAMMA_LINK = b.link("cmd_demo/gamma.md", "# Gamma", target=BS)
    a("profile-create", "profile", "create", "dev", "--name", "Dev Agent", "--kind", "agent")
    a("profile-create-duplicate", "profile", "create", "dev", what="a refusal")
    a("profile-create-no-handle", "profile", "create", what="a refusal")
    a("profile-list-after-create", "profile", "list", entries=(15,))
    a("profile-create-view", "profile", "create-view", "v1", "--profile", "dev")
    a("profile-create-view-duplicate", "profile", "create-view", "v1", "--profile", "dev", what="a refusal")
    a("profile-create-view-no-profile", "profile", "create-view", "v2", "--profile", "nobody", what="a refusal")
    a("profile-create-view-missing-flag", "profile", "create-view", "v3", what="a refusal")
    a("profile-list-view-after", "profile", "list-view", entries=(15,))
    a("zoom-alpha", "zoom", "cmd_demo/alpha.md", "--view", "default")
    a("zoom-missing", "zoom", "cmd_demo/nothing.md", "--view", "default", what="a refusal")
    a("zoom-no-view", "zoom", "cmd_demo/beta.md", what="mints the default view on first use if omitted")
    a("tree-view", "tree", "--view", "default")
    a("tree-view-missing", "tree", "--view", "nothing", what="a refusal")
    a("unfold-alpha", "unfold", ALPHA_H, "--view", "default", entries=(13,))
    a("unfold-alpha-link-sec", "unfold", LINK_TO_SEC, "--view", "default")
    a("tree-view-after-link", "tree", "--view", "default", entries=(13,))
    a("zoom-folder", "zoom", "cmd_demo", "--view", "default")
    a("unfold-gamma", "unfold", GAMMA_H, "--view", "default")
    a("unfold-gamma-link-sec", "unfold", GAMMA_LINK, "--view", "default", entries=(14,), what="the same target reached through two unfolded links")
    a("tree-view-two-links", "tree", "--view", "default", entries=(13, 14), what="where the shared target is expanded")
    a("tree-view-two-links-depth", "tree", "--view", "default", "--depth", "3")
    a("tree-view-render-tree", "tree", "--view", "default", "--format", "render-tree", entries=(13, 14))
    a("tree-view-work", "tree", "--view", "work")
    a("unfold-bad-flag", "unfold", ALPHA_H, "--nonsense", what="a refusal")
    a("fold-gamma-link", "fold", GAMMA_LINK, "--view", "default", entries=(14,), what="the canonical place moves when the first link is folded")
    a("tree-view-after-fold", "tree", "--view", "default", entries=(14,))
    a("fold-not-unfolded", "fold", "cmd_demo/dup.md", "--view", "default", what="a node that is not unfolded")
    a("fold-missing", "fold", "cmd_demo/nothing.md", "--view", "default", what="a refusal")
    a("fold-alpha", "fold", ALPHA_H, "--view", "default", what="cascades to what was reached from it")
    a("tree-view-after-fold-alpha", "tree", "--view", "default")
    # the canonical place of a node reached through several unfolded links (entry 14): four artifacts link to the artifact beta.md, in two views and two orders
    ARTS = ("zeta", "rich", "eps", "alpha")
    a("profile-create-view-canon", "profile", "create-view", "canon", "--profile", "default")
    a("zoom-canon", "zoom", "cmd_demo", "--view", "canon")
    for n in ARTS:
        a("unfold-canon-%s" % n, "unfold", b.art("cmd_demo/%s.md" % n), "--view", "canon")
    for n in ARTS:
        h = b.blk("cmd_demo/%s.md" % n, "# " + n.capitalize())
        a("unfold-canon-%s-heading" % n, "unfold", h, "--view", "canon")
    BETA_ART = b.art("cmd_demo/beta.md")
    for n in ARTS:
        l = b.link("cmd_demo/%s.md" % n, "# " + n.capitalize(), target=BETA_ART)
        a("unfold-canon-%s-link" % n, "unfold", l, "--view", "canon", entries=(14,))
    a("tree-canon", "tree", "--view", "canon", entries=(13, 14), what="where the artifact beta.md is expanded: under which of the four links")
    a("tree-canon-render-tree", "tree", "--view", "canon", "--format", "render-tree", entries=(13, 14))
    a("fold-canon-first-link", "fold", b.link("cmd_demo/alpha.md", "# Alpha", target=BETA_ART), "--view", "canon", entries=(14,))
    a("tree-canon-after-fold", "tree", "--view", "canon", entries=(14,), what="the place moves to the next link")
    a("profile-create-view-canon2", "profile", "create-view", "canon2", "--profile", "default")
    a("zoom-canon2", "zoom", "cmd_demo", "--view", "canon2")
    for n in ARTS[::-1]:
        a("unfold-canon2-%s" % n, "unfold", b.art("cmd_demo/%s.md" % n), "--view", "canon2")
        a("unfold-canon2-%s-heading" % n, "unfold", b.blk("cmd_demo/%s.md" % n, "# " + n.capitalize()), "--view", "canon2")
        a("unfold-canon2-%s-link" % n, "unfold", b.link("cmd_demo/%s.md" % n, "# " + n.capitalize(), target=BETA_ART), "--view", "canon2", entries=(14,))
    a("tree-canon2", "tree", "--view", "canon2", entries=(13, 14))
    a("profile-remove-view", "profile", "remove-view", "v1")
    a("profile-remove-view-missing", "profile", "remove-view", "v1", what="a refusal")
    a("profile-remove-dev", "profile", "remove", "dev")
    a("profile-remove-missing", "profile", "remove", "dev", what="a refusal")
    a("profile-list-view-end", "profile", "list-view", entries=(15,))


def writes_section(b, a, v):
    BS = v["BS"]
    BETA_H = b.blk("cmd_demo/beta.md", "# Beta")
    OTHER = b.blk("cmd_demo/beta.md", "## Other")
    ITEM_ONE = b.blk("cmd_demo/dup.md", "## Item One")
    ITEM_TWO = b.blk("cmd_demo/dup.md", "## Item Two")
    DUP_H = b.blk("cmd_demo/dup.md", "# Dup")
    SINGLE = b.blk("cmd_demo/rich.md", "## Single")
    single_item = b.kids(SINGLE)[0]
    WRAPPER = b.blk("cmd_demo/rich.md", "## Wrapper")
    wrapper_item = b.kids(WRAPPER)[0]
    wrapper_inner = b.kids(wrapper_item)[0]
    LISTS = b.blk("cmd_demo/rich.md", "## Lists")
    QUOTE = b.blk("cmd_demo/rich.md", "## Quote and code")
    THREAD_TURN = ".threads/coder.md/Coder-thread/topic/task/Turn-1"
    THREAD_ASK = THREAD_TURN + "/Ask"
    v.update(dict(BETA_H=BETA_H, OTHER=OTHER, ITEM_ONE=ITEM_ONE, ITEM_TWO=ITEM_TWO, DUP_H=DUP_H, single_item=single_item, SINGLE=SINGLE, wrapper_item=wrapper_item, wrapper_inner=wrapper_inner))

    # insert: create
    a("insert-paragraph", "insert", "cmd_demo/beta.md/Beta", stdin="A new paragraph under Beta.\n")
    a("insert-list", "insert", "cmd_demo/beta.md/Beta/Beta Section", stdin="- item a\n- item b\n")
    a("insert-heading-section", "insert", "cmd_demo/beta.md/Beta", stdin="## New Section\n\nNew section text.\n")
    a("insert-after", "insert", "cmd_demo/beta.md/Beta", "--after", BS, stdin="Placed after Beta Section.\n")
    a("insert-before", "insert", "cmd_demo/beta.md/Beta", "--before", BS, stdin="Placed before Beta Section.\n")
    a("insert-base", "insert", "--base", "cmd_demo/beta.md", "Beta", stdin="Under Beta by a base.\n")
    a("insert-parent-missing", "insert", "cmd_demo/nothing.md/X", stdin="text\n", what="a refusal")
    a("insert-anchor-missing", "insert", "cmd_demo/beta.md/Beta", "--after", "BlockNode:00ZZZZZZZZZZZ", stdin="text\n", what="a refusal")
    a("insert-both-anchors", "insert", "cmd_demo/beta.md/Beta", "--after", BS, "--before", BS, stdin="text\n", what="a refusal")
    a("insert-no-arg", "insert", what="a refusal")
    a("insert-thread", "insert", THREAD_TURN, stdin="- **Note**: a note\n")
    a("tree-beta-after-inserts", "tree", "cmd_demo/beta.md")
    # insert: move
    a("move-reorder", "insert", ITEM_TWO, "--before", ITEM_ONE, what="a move within a parent")
    a("tree-dup-after-reorder", "tree", "cmd_demo/dup.md")
    a("move-cross-parent", "insert", OTHER, "--after", ITEM_ONE, what="a move to another artifact")
    a("tree-after-cross-move", "tree", "cmd_demo")
    a("move-missing", "insert", "cmd_demo/nothing.md", "--after", ITEM_ONE, what="a refusal")
    a("move-missing-anchor", "insert", OTHER, "--after", "BlockNode:00ZZZZZZZZZZZ", what="a refusal")
    # update
    a("update-text", "update", BS, stdin="Beta section text, updated.\n")
    a("update-text-only", "update", BS, "--text-only", stdin="Beta section text, again.\n")
    a("update-rename", "update", BS, stdin="## Beta Section Renamed\n\nRenamed text.\n", what="a heading rename")
    a("update-rename-wrong-depth", "update", BS, stdin="# Wrong Depth\n\nText.\n", what="a refusal")
    a("update-children", "update", DUP_H, stdin="# Dup\n\nDup intro, changed.\n\n## Item Two\n\nTwo, changed.\n\n## Item Three\n\nThree.\n", what="reconciles the children")
    a("update-frontmatter", "update", "cmd_demo/front.md", stdin="---\ndescription: A new description.\nlang: fr\n---\n\n# Front\n\nFront text, changed.\n")
    a("update-folder", "update", "cmd_demo", stdin="---\ndescription: The demo folder.\n---\n")
    a("update-missing", "update", "cmd_demo/nothing.md", stdin="text\n", what="a refusal")
    a("update-no-stdin", "update", BS, what="a refusal")
    a("update-thread-timer", "update", THREAD_ASK, "--text-only", stdin="**Ask**: do the thing, by a timer\n", flush=False, entries=(22,), what="a thread node alone is updated, with no flush")
    a("wait-thread-timer", wait=5, capture=True, entries=(22,), what="after the thread graph's own timer (3 s): the state file holds the update on the new side")
    a("update-thread-flush", "update", THREAD_ASK, "--text-only", stdin="**Ask**: do the thing, flushed\n")
    # retype
    a("retype-heading-depth", "retype", ITEM_ONE, "--to", "h3")
    a("retype-paragraph-quote", "retype", b.kids(QUOTE)[0], "--to", "paragraph", what="a blockquote to a paragraph")
    a("retype-to-heading", "retype", b.kids(LISTS)[0], "--to", "h3", what="crosses the heading boundary")
    a("retype-bad-type", "retype", ITEM_ONE, "--to", "nonsense", what="a refusal")
    a("retype-no-to", "retype", ITEM_ONE, what="a refusal")
    a("retype-missing", "retype", "cmd_demo/nothing.md", "--to", "h2", what="a refusal")
    # resolve --create-holder
    a("holder-create", "resolve", "--create-holder", "cmd_demo/fresh.md/Fresh/Part", "--titles", "# Fresh", "## Part")
    a("holder-create-again", "resolve", "--create-holder", "cmd_demo/fresh.md/Fresh/Part", "--titles", "# Fresh", "## Part")
    a("holder-titles-mismatch", "resolve", "--create-holder", "cmd_demo/other.md/Other", "--titles", "# One", "## Two", what="a refusal")
    a("holder-no-titles", "resolve", "--create-holder", "cmd_demo/other.md/Other", what="a refusal")
    a("tree-holders", "tree", "cmd_demo/fresh.md")
    # remove (entries 1, 2, 3)
    a("remove-single-item", "remove", single_item, entries=(1,), what="the only item under a heading")
    a("remove-wrapper-inner", "remove", wrapper_inner, entries=(3,), capture=True, what="the last child of a textless item: the emptied wrapper goes with it")
    a("tree-rich-after-remove", "tree", "cmd_demo/rich.md", entries=(1, 3))
    a("tree-rich-tombstoned", "tree", "cmd_demo/rich.md", "--tombstoned", entries=(1, 3))
    a("show-removed-item", "show", single_item, entries=(1,), what="the tombstone, by its id")
    a("show-emptied-wrapper", "show", wrapper_item, entries=(3,))
    a("remove-block", "remove", "cmd_demo/dup.md/Dup/Item-Three", what="a block with text")
    a("tree-dup-tombstoned", "tree", "cmd_demo/dup.md", "--tombstoned", entries=(1,))
    a("unfold-removed-tombstoned", "unfold", ITEM_ONE, "--tombstoned", entries=(1,))
    a("remove-artifact", "remove", "cmd_demo/gamma.md", entries=(2,), what="a whole artifact")
    a("track-reverse-after-remove", "track", "--reverse", entries=(2, 15))
    a("remove-folder", "remove", "cmd_demo/sub", entries=(2,))
    a("remove-missing", "remove", "cmd_demo/nothing.md", what="a refusal")
    a("remove-base", "remove", "--base", "cmd_demo/beta.md", "Beta/Other-Not-There", what="a refusal")
    a("remove-no-arg", "remove", what="a refusal")
    a("backlinks-after-remove", "backlinks", BS, entries=(15,))
    a("check-links-after-remove", "check-links")
    a("resolve-removed-path", "resolve", "cmd_demo/gamma.md", entries=(4,), what="the live node at a path")
    # a path reused after a removal makes a new artifact (the tombstone is no answer)
    a("write-gamma-again", fs=[{"op": "write", "root": "artifacts", "path": "cmd_demo/gamma.md", "text": "# Gamma\n\nGamma again.\n"}], entries=(4,))
    a("track-gamma-again", "track", "cmd_demo/gamma.md", entries=(4,), what="a path reused after a removal")
    a("ingest-gamma-again", "ingest", "cmd_demo/gamma.md", entries=(4,))
    a("resolve-gamma-again", "resolve", "cmd_demo/gamma.md", entries=(4,), what="names the live node, not the tombstone")


def ingest_section(b, a, v):
    with open(os.path.join(b.snapshot, "artifacts", "cmd_demo", "delta.md"), encoding="utf-8") as h:
        delta_text = h.read().replace(".\n\n## Delta Sec", ". More words.\n\n## Delta Sec")
    a("track-sweep", "track", what="a sweep of every file under the artifacts root; paths removed earlier are tracked again")
    a("ingest-sweep", "ingest", what="every tracked artifact; the folder tree is rebuilt around the ghost")
    a("ingest-track-sweep", "ingest", "--track")
    a("track-path-missing", "track", "cmd_demo/nothing.md", what="a refusal")
    a("ingest-path-missing", "ingest", "cmd_demo/nothing.md", what="a refusal")
    a("ingest-bad-flag", "ingest", "--nonsense", what="a refusal")
    # the position props of a reused link (entry 21)
    a("write-delta", fs=[{"op": "write", "root": "artifacts", "path": "cmd_demo/delta.md", "text": delta_text}], entries=(21,))
    a("ingest-delta", "ingest", "--track", "cmd_demo/delta.md", entries=(21,), what="the link of # Delta keeps the ids of its position props where the reference minted them again")
    a("show-delta-after-ingest", "show", "cmd_demo/delta.md/Delta", entries=(19,))
    # removals held back, forced, and answered on stdin
    a("delete-front", fs=[{"op": "delete", "root": "artifacts", "path": "cmd_demo/front.md"}])
    a("track-sweep-removal-no-prompt", "track", what="a removal held back: nothing can answer")
    a("track-sweep-removal-answered-no", "track", no_prompt=False, stdin="no\n", what="the removal prompt answered no on stdin")
    a("track-sweep-removal-answered-yes", "track", no_prompt=False, stdin="yes\n", what="the removal prompt answered yes on stdin")
    a("tree-after-front-removed", "tree", "cmd_demo")
    a("delete-dup", fs=[{"op": "delete", "root": "artifacts", "path": "cmd_demo/dup.md"}])
    a("ingest-sweep-removal-no-prompt", "ingest", what="a removal held back by ingest")
    a("ingest-force", "ingest", "--force", what="applies every removal without prompting")
    a("tree-after-ingest-force", "tree", "cmd_demo")
    # a new file, projected
    a("write-new", fs=[{"op": "write", "root": "artifacts", "path": "cmd_demo/new.md", "text": "# New\n\nNew text.\n\n## New Part\n\nPart text.\n"}])
    a("track-new", "track", "cmd_demo/new.md")
    a("ingest-new", "ingest", "cmd_demo/new.md")
    a("track-new-unchanged", "track", "cmd_demo/new.md", what="nothing changed")
    a("project-new-dry", "project", "cmd_demo/new.md", "--dry-run")
    a("project-new", "project", "cmd_demo/new.md", what="writes the file")
    a("write-new-external", fs=[{"op": "write", "root": "artifacts", "path": "cmd_demo/new.md", "text": "# New\n\nChanged on disk.\n"}])
    a("project-new-conflict", "project", "cmd_demo/new.md", what="the file changed on disk since its last known content: a refusal")
    a("project-new-force", "project", "cmd_demo/new.md", "--force")
    a("project-beta", "project", "cmd_demo/beta.md", what="the artifact that the writes changed")
    a("project-folder", "project", "cmd_demo", what="a folder writes its README")
    a("project-folder-sub", "project", "cmd_demo/sub", what="a removed folder")
    a("track-reverse-after-project", "track", "--reverse", entries=(15,))


def sweeps_section(b, a, v):
    BS = v["BS"]
    ALPHA_H = v["ALPHA_H"]
    DUP_H = v["DUP_H"]
    DELTA_SEC = b.blk("cmd_demo/delta.md", "## Delta Sec")
    BOGUS = "BlockNode:00ZZZZZZZZZZA"
    a("flush-plain", "flush")
    a("flush-clobber", "flush", "--clobber", entries=(25,), what="the text of `flush --clobber`")
    a("reload-plain", "reload", entries=(9, 26, 27), what="the reload's result: its counts, the old store freed, the dangling ids")
    a("tree-after-reload", "tree", "cmd_demo", "--tombstoned", entries=(2,), what="the tombstones the sweep pruned")
    a("show-gamma-old-after-reload", "show", "cmd_demo/gamma.md", entries=(2,))
    a("reload-discard", "reload", "--discard", entries=(26,))
    a("reload-start-anyway", "reload", "--start-anyway", entries=(25,), what="a load that read the mirror in full")
    a("reload-bad-flag", "reload", "--nonsense", what="a refusal")
    # links edited in the mirror: one with no position, and one whose target names no node
    ALPHA_H = v["ALPHA_H"]
    DELTA_H = v["DELTA_H"]
    a("flush-before-links-edit", "flush")
    a("edit-links", fs=[
        {"op": "edit-embedded", "path": "BlockNode.jsonld", "match": {"@id": ALPHA_H}, "field": "links", "where": {"target": BS}, "remove_where_in": {"inner": "props", "where": {"key": "position"}}},
        {"op": "edit-embedded", "path": "BlockNode.jsonld", "match": {"@id": DELTA_H}, "field": "links", "where": {"target": BS}, "set": {"target": "BlockNode:00ZZZZZZZZZZB"}},
        {"op": "edit-embedded", "path": "BlockNode.jsonld", "match": {"@id": DELTA_H}, "field": "links", "where": {"target": b.blk("cmd_demo/alpha.md", "## Alpha Sec")}, "set": {"target": "BlockNode:00ZZZZZZZZZZC"}},
        {"op": "edit-embedded", "path": "BlockNode.jsonld", "match": {"@id": DELTA_H}, "field": "links", "where": {"target": b.blk("cmd_demo/rich.md", "## Table")}, "set": {"target": "BlockNode:00ZZZZZZZZZZD"}}],
      entries=(16, 18))
    a("reload-links-edit", "reload", entries=(16, 18))
    a("unfold-alpha-links", "unfold", ALPHA_H, entries=(13, 16), what="a link with no position comes last")
    a("tree-alpha-links", "tree", "cmd_demo/alpha.md")
    a("show-alpha-after-edit", "show", ALPHA_H, entries=(19,), what="the links of a block after a reload from a file that lists them in another order")
    a("check-links-dangling", "check-links", entries=(18,), what="a stored link whose target names no node: the text at its position")
    a("check-links-dangling-verbose", "check-links", "--verbose", entries=(18,))
    a("check-links-dangling-json", "check-links", "--json", entries=(18,))
    a("unfold-delta-dangling", "unfold", DELTA_H, entries=(18,))
    # an unfold of an id that no node has (entry 23)
    a("flush-before-edit", "flush")
    a("edit-view-stale-unfold", fs=[{"op": "modify-document", "path": ".state/TreeView.jsonld", "match": {"name": "default"}, "append": {"unfolds": BOGUS}}], entries=(23,))
    a("reload-stale-unfold", "reload", entries=(23,), what="the reference sweeps the unfold of an id no node has; the new engine keeps it")
    a("flush-after-stale-unfold", "flush", capture=True, entries=(23,))
    a("tree-view-after-stale-unfold", "tree", "--view", "default")
    # an external edit, picked up by a reload
    a("flush-before-external", "flush")
    a("edit-block-text", fs=[{"op": "modify-document", "path": "BlockNode.jsonld", "match": {"@id": DELTA_SEC}, "set": {"text": "Delta text, edited on disk."}}])
    a("reload-external", "reload", what="picks up an edit made outside")
    a("show-delta-sec-external", "show", DELTA_SEC)
    # a conflict: the file changed on disk and the service holds a change of its own
    a("update-before-conflict", "update", DELTA_SEC, stdin="Delta text, edited in the service.\n", flush=False)
    a("edit-block-text-conflict", fs=[{"op": "modify-document", "path": "BlockNode.jsonld", "match": {"@id": DELTA_SEC}, "set": {"text": "Delta text, edited on disk again."}}])
    a("flush-conflict", "flush", what="refused: the file changed outside since the service read it")
    a("reload-conflict", "reload", what="stuck on the conflict")
    a("reload-conflict-discard", "reload", "--discard", what="takes the disk's content")
    a("show-delta-sec-conflict", "show", DELTA_SEC)
    # the service lifecycle
    a("service-start-again", "service", "start", what="a service already runs")
    a("service-restart", "service", "restart", entries=(9, 23), what="a restart: the sweeps at stop and at boot")
    a("tree-after-restart", "tree", "cmd_demo", "--tombstoned", entries=(2,))
    a("track-reverse-after-restart", "track", "--reverse", entries=(2,), what="forgets the tombstone of a removed artifact once it is pruned")
    a("service-stop", "service", "stop")
    a("service-stop-again", "service", "stop", what="none runs")
    a("service-start", "service", "start", what="starts a fresh service")
    a("service-bad-subcommand", "service", "nonsense", what="a refusal")
    a("show-after-restart", "show", BS)
    a("flush-end", "flush")


def hang_section(b, a, v):
    DELTA_H = v["DELTA_H"]
    DELTA_SEC = b.blk("cmd_demo/delta.md", "## Delta Sec")
    if DELTA_SEC not in b.kids(DELTA_H):
        raise ValueError("the move into the own subtree needs # Delta to hold ## Delta Sec")
    a("move-into-own-subtree", "insert", DELTA_H, "--after", DELTA_SEC, timeout=20, hangs=["ref"], status_new=1, entries=(5,),
      what="a move of # Delta after its own child: the engine's no-cycle rule refuses it; the reference loops on the next walk of the parent chain (last in the list, under a timeout)")


def lifecycle_part(b):
    """The starts and reloads that the main part cannot make: a mirror that holds a repeated id, and a document with a key its kind does not declare."""
    a = b.add
    BS = b.blk("cmd_demo/beta.md", "## Beta Section")
    DELTA_SEC = b.blk("cmd_demo/delta.md", "## Delta Sec")
    dup = [{"op": "duplicate-document", "path": "BlockNode.jsonld", "match": {"@id": BS}}]
    bogus = [{"op": "modify-document", "path": "BlockNode.jsonld", "match": {"@id": DELTA_SEC}, "set": {"bogus": []}}]
    a("tree-start", "tree", "cmd_demo/beta.md")
    a("flush-start", "flush")
    # a reload of a mirror that holds a repeated id
    a("dup-on-disk", fs=dup, entries=(10,))
    a("reload-dup", "reload", entries=(10,), what="the new engine refuses a mirror read in part and keeps the graph in memory; the reference loads it")
    a("show-after-reload-dup", "show", BS, what="the graph in memory is the same on both sides")
    a("reload-dup-discard", "reload", "--discard", entries=(10,), what="a discard reads the disk first, so it is refused too")
    a("reload-dup-start-anyway", "reload", "--start-anyway", entries=(25,), what="accepts the load and copies the skipped documents to a side file")
    a("flush-after-dup", "flush", capture=True, entries=(25,))
    # a start of a mirror that holds a repeated id
    a("stop-1", "service", "stop")
    a("dup-on-disk-again", fs=dup, entries=(10,))
    a("start-refused-dup", "service", "start", timeout=60, entries=(10, 24), what="a refused start: the new service says why at once and exits 1")
    a("start-anyway-dup", "service", "start", "--start-anyway", timeout=60, entries=(25,), what="the load is accepted; the skipped documents are copied next to their file")
    a("tree-after-start-anyway", "tree", "cmd_demo/beta.md")
    a("flush-after-start-anyway", "flush")
    # a start of a mirror that holds a document with a key its kind does not declare
    a("stop-2", "service", "stop")
    a("bogus-key-on-disk", fs=bogus, entries=(28,))
    a("start-refused-bogus", "service", "start", timeout=60, entries=(28, 10, 24), what="a key the kind does not declare is refused, even with an empty array")
    a("start-anyway-bogus", "service", "start", "--start-anyway", timeout=60, entries=(28, 25))
    a("show-bogus", "show", DELTA_SEC)
    # a write on both sides, so that the reference rewrites the files that still hold a repeated id once
    a("update-end", "update", b.blk("cmd_demo/beta.md", "## Other"), stdin="Other text, edited.\n")
    a("flush-end", "flush")
    return b.commands


def broken_part(b):
    """The start of a mirror whose file is not JSON: the last of its run, which leaves no mirror to compare."""
    a = b.add
    a("tree-start", "tree", "cmd_demo/beta.md")
    a("stop", "service", "stop")
    a("truncate-artifacts", fs=[{"op": "truncate", "path": "ArtifactNode.jsonld", "keep": 100}], entries=(24,))
    a("start-broken", "service", "start", timeout=60, entries=(24,), what="a refused start: the time and the text")
    return b.commands


def build_list(snapshot, part):
    b = Builder(snapshot)
    cmds = {"main": main_part, "lifecycle": lifecycle_part, "broken": broken_part}[part](b)
    return {"final_flush": part == "lifecycle", "commands": cmds}


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--snapshot", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--part", default="main", choices=("main", "lifecycle", "broken"))
    args = p.parse_args(argv)
    lst = build_list(args.snapshot, args.part)
    with open(args.out, "w", encoding="utf-8") as h:
        json.dump(lst, h, indent=1, ensure_ascii=False)
        h.write("\n")
    print("%d commands written to %s" % (len(lst["commands"]), args.out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
