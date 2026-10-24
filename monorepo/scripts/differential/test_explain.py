#!/usr/bin/env python3
"""The tests of `explain.py` and of its use in `compare.py` (Python 3, standard library): `python3 -m unittest -v test_explain` from this directory, or through the file named in the `tools` suite.

  Rules      each rule rewrites the reference's output into the new side's for its own deliberate difference and claims its entry; a text that differs in anything else is left alone
             (no rule absorbs a plain difference), and an entry is claimed only when the rewrite made the outputs equal
  Logs       each line of a service's log is accounted for by one rule that names its entries, and a line no rule knows is a finding
  Dumps      the differences of a dump that a command makes: the ghost folder's document, the documents the new side's load skipped, the hash of a file that holds minted ids
  Compare    `compare.compare_dumps` with commands and logs: an explained command claims, a plain difference is a finding, an emptied container is found from the dumps
  Mutations  a copy of this directory in which one rule of `explain.py` is made wrong or loose fails this module (the cases of `MUTATIONS`)

Only scratch directories are used and no service is started.
"""
import copy
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import compare  # noqa: E402
import explain  # noqa: E402


def out(status=0, stdout="", stderr=""):
    return {"status": status, "stdout": stdout, "stderr": stderr}


class Ctx:
    """A stand-in for `compare.Context` with the answers a rule asks for."""

    def __init__(self, emptied=(), dead=(), rejected=None, facts=None, new_ids=(), left=0, refused=()):
        self._emptied, self._dead, self.rejected = set(emptied), set(dead), rejected or {}
        self.facts, self._new_ids = facts, set(new_ids)
        self._left, self._refused = left, sorted(refused)   # the blocks that the refused commands left (entry 31), and the indexes of those commands

    def leftovers_before(self, index=None):
        return self._left if index is None else min(self._left, len([i for i in self._refused if i < index]))

    def new_has(self, cid):
        return cid in self._new_ids

    def emptied_ids(self):
        return self._emptied

    def is_emptied(self, cid):
        return cid in self._emptied

    def is_dead_in_ref(self, cid):
        return cid in self._dead


def readme_facts():
    """A snapshot that holds the six README documents of the migration (two of them are enough to name paths: the table reads the ids, so all twelve are given)."""
    files = {"ArtifactNode.jsonld": [], "BlockNode.jsonld": []}
    for k, (a, b) in enumerate(zip(compare.README_ARTIFACTS, compare.README_PARAGRAPHS)):
        path = ["README.md", "history/README.md", "planning/README.md", "issues/README.md", "discussion/README.md", "design/README.md"][k]
        files["ArtifactNode.jsonld"].append({"@id": a, "@type": "ArtifactNode", "path": path, "title": "README.md", "children": [b]})
        files["BlockNode.jsonld"].append({"@id": b, "@type": "BlockNode", "title": "readme", "type": "paragraph", "parent": a})
    return compare.Facts(files)


def tomb_facts():
    """A snapshot with a tombstoned block in the tree of `d/a.md` (hosting one link), a tombstoned artifact `d/t.md`, a block of the thread graph and a view that unfolds the tombstone."""
    A, T = "ArtifactNode:00D8A0000000A", "ArtifactNode:00D8A0000000B"
    return compare.Facts({
        "BlockNode.jsonld": [
            {"@id": "BlockNode:00D8B0000000A", "@type": "BlockNode", "title": "# H", "type": "heading", "parent": A, "children": ["BlockNode:00D8B0000000B"]},
            {"@id": "BlockNode:00D8B0000000B", "@type": "BlockNode", "title": "gone", "type": "listItem", "tombstonedAt": "2026-10-01T00:00:00.000Z", "parent": "BlockNode:00D8B0000000A",
             "links": [{"@id": "BlockNode:00D8B0000000B:links:Link:L0", "@type": "Link", "target": "BlockNode:00D8B0000000A"}]}],
        "ArtifactNode.jsonld": [{"@id": A, "@type": "ArtifactNode", "path": "d/a.md", "children": ["BlockNode:00D8B0000000A"]}, {"@id": T, "@type": "ArtifactNode", "path": "d/t.md", "tombstonedAt": "2026-10-01T00:00:00.000Z"}],
        ".state/BlockNode.jsonld": [{"@id": "BlockNode:00D8T0000000A", "@type": "BlockNode", "title": "t", "type": "paragraph"}],
        ".state/TreeView.jsonld": [{"@id": "TreeView:00D8V0000000A", "@type": "TreeView", "unfolds": ["BlockNode:00D8B0000000B", "BlockNode:00D8B0000000A"]},
                                   {"@id": "TreeView:00D8V0000000B", "@type": "TreeView", "unfolds": ["BlockNode:00D8B0000000A"]}]})


def run(argv, ref, new, ctx=None, index=None):
    claims, r, n = explain.explain(argv, ref, new, ctx, index)
    return claims, r, n


class Rules(unittest.TestCase):
    def assertExplained(self, argv, ref, new, claims, ctx=None, index=None):
        got, r, n = run(argv, ref, new, ctx, index)
        self.assertEqual(sorted(map(str, got)), sorted(map(str, claims)))
        self.assertEqual(r, n, "the outputs are not equal after the rules")

    def assertLeft(self, argv, ref, new, ctx=None, index=None):
        got, r, n = run(argv, ref, new, ctx, index)
        self.assertNotEqual(r, n, "the outputs became equal: a plain difference was absorbed (claims %s)" % got)

    def assertNot31(self, argv, ref, new, ctx=None, index=None):
        got, r, n = run(argv, ref, new, ctx, index)
        self.assertNotIn(31, got)
        self.assertNotEqual(r, n)

    def test_the_predicate_of_a_link_is_not_printed_by_the_new_side(self):
        j = '{\n  "links": [\n    {\n      "target": "X",\n      "predicate": "[[wikilink]]",\n      "props": []\n    }\n  ]\n}'
        self.assertExplained(["show", "a"], out(stdout=j), out(stdout=j.replace('      "predicate": "[[wikilink]]",\n', "")), ["H1"])
        t = "BlockNode:A:links:Link:B  [Link]  [[wikilink]] → BlockNode:C  ## T"
        self.assertExplained(["unfold", "a"], out(stdout=t), out(stdout=t.replace("[[wikilink]] ", "")), ["H1"])
        self.assertLeft(["show", "a"], out(stdout=j), out(stdout=j.replace('      "predicate": "[[wikilink]]",\n', "").replace('"target": "X"', '"target": "Y"')))

    def test_an_artifact_has_no_type(self):
        a = '{\n  "@type": "ArtifactNode",\n  "title": "a.md",\n  "type": "root",\n  "children": []\n}'
        self.assertExplained(["show", "a.md"], out(stdout=a), out(stdout=a.replace('  "type": "root",\n', "")), [8])
        b = a.replace("ArtifactNode", "BlockNode")
        self.assertLeft(["show", "a.md"], out(stdout=b), out(stdout=b.replace('  "type": "root",\n', "")))

    def test_the_kind_of_a_profile(self):
        self.assertExplained(["profile", "list", "dinhlx"], out(stdout="dinhlx  [-]  Dinh Le  P:1\n"), out(stdout="dinhlx  [human]  Dinh Le  P:1\n"), ["H2"])
        self.assertLeft(["profile", "list", "dinhlx"], out(stdout="dinhlx  [-]  Dinh Le  P:1\n"), out(stdout="dinhlx  [agent]  Dinh Le  P:1\n"))

    def test_the_removed_verbs_and_the_list_of_verbs(self):
        for verb, key in (("link", "H10"), ("unlink", "H10"), ("migrate-frontmatter", 29)):
            self.assertExplained([verb, "x"], out(stdout="[aperas %s] done" % verb), out(1, "Usage: ...", "[aperas] Unknown command '%s'.\n" % verb), [key])
        ref = "Verbs:\n  backlinks            List\n  link                 Prompt\n  migrate-frontmatter  One\n  path                 Resolve\n  unlink               Remove\n"
        new = "Verbs:\n  backlinks    List\n  path         Resolve\n"
        self.assertExplained(["--help"], out(stdout=ref), out(stdout=new), ["H10", "H10", 29])
        self.assertLeft(["--help"], out(stdout=ref), out(stdout=new.replace("Resolve", "Resolve it")))
        self.assertLeft(["show", "x"], out(stdout="a"), out(1, "", "[aperas] Unknown command 'show'.\n"))

    def test_a_node_that_has_no_path(self):
        self.assertExplained(["path", "L"], out(1, "", "[aperas] Failed: wrap(...).toPath is not a function\n"),
                             out(1, "", "[aperas] Failed: 'L' is a Link, which has no path: only a tracked artifact, folder or block does.\n"), [17])
        self.assertExplained(["path", "B"], out(1, "", "[aperas] Failed: 'B' has no walkable parent chain — a Link (no structural parent), or a BlockNode ingested before the 'parent' field existed (needs re-ingestion).\n"),
                             out(1, "", "[aperas] Failed: 'B' has no walkable parent chain — a BlockNode ingested before the 'parent' field existed (needs re-ingestion), or a tombstone.\n"), [17])
        self.assertLeft(["path", "B"], out(1, "", "[aperas] Failed: nope\n"), out(1, "", "[aperas] Failed: 'B' is a Link, which has no path: only a tracked artifact, folder or block does.\n"))

    def test_the_ghost_folder_in_the_reverse_track(self):
        ref = "[aperas track --reverse] Never projected:\n  [FolderNode] 'a'\n  [FolderNode] 'undefined'\n"
        self.assertExplained(["track", "--reverse"], out(stdout=ref), out(stdout=ref.replace("  [FolderNode] 'undefined'\n", "")), [20])
        self.assertLeft(["track", "--reverse"], out(stdout=ref), out(stdout=ref.replace("  [FolderNode] 'a'\n", "").replace("  [FolderNode] 'undefined'\n", "")))

    def test_a_tombstone_leaves_the_list_of_its_container(self):
        ref = "aperas://tree/x\nFolderNode:F  [FolderNode]  f\n│ BlockNode:A  [heading]  # A\n│ BlockNode:B  [heading]  # B  (tombstoned)\n│ │ BlockNode:C  [heading]  ## C  (tombstoned)\n│ BlockNode:D  [heading]  # D\n"
        new = "aperas://tree/x\nFolderNode:F  [FolderNode]  f\n│ BlockNode:A  [heading]  # A\n│ BlockNode:D  [heading]  # D\n"
        self.assertExplained(["tree", "x", "--tombstoned"], out(stdout=ref), out(stdout=new), [1])
        self.assertLeft(["tree", "x", "--tombstoned"], out(stdout=ref), out(stdout=new.replace("# D", "# E")))
        self.assertLeft(["tree", "x"], out(stdout=ref), out(stdout=new))
        # a removed node shown by its id has no breadcrumb in the new side
        r = "aperas://tree/x/--b\nBlockNode:B  [heading]  # B  ║  text  (tombstoned)\n"
        self.assertExplained(["unfold", "BlockNode:B", "--tombstoned"], out(stdout=r), out(stdout=r.split("\n", 1)[1]), [1])

    def test_the_empty_tombstone(self):
        ref = {"@id": "B:1", "@type": "BlockNode", "tombstonedAt": "<timestamp>", "text": "x", "parent": "B:0", "type": "listItem", "children": []}
        new = {k: v for k, v in ref.items() if k != "parent"}
        self.assertExplained(["show", "B:1"], out(stdout=json.dumps(ref, indent=2)), out(stdout=json.dumps(new, indent=2)), ["H8"])
        self.assertLeft(["show", "B:1"], out(stdout=json.dumps(ref, indent=2)), out(stdout=json.dumps(dict(new, text="y"), indent=2)))

    def test_an_emptied_container_is_live_in_the_reference_until_a_sweep(self):
        ref = "FolderNode:F  [FolderNode]  f\n│ BlockNode:W  [listItem]  W\n│ BlockNode:D  [heading]  # D\n"
        new = "FolderNode:F  [FolderNode]  f\n│ BlockNode:D  [heading]  # D\n"
        self.assertExplained(["tree", "f"], out(stdout=ref), out(stdout=new), [3], Ctx(emptied={"BlockNode:W"}))
        self.assertLeft(["tree", "f"], out(stdout=ref), out(stdout=new), Ctx(emptied=set()))
        self.assertLeft(["tree", "f"], out(stdout=ref), out(stdout=new), Ctx(emptied={"BlockNode:OTHER"}))
        self.assertExplained(["check-links"], out(stdout="Scanned 41 live blocks (3 with internal link text).\n"), out(stdout="Scanned 40 live blocks (3 with internal link text).\n"), [3], Ctx(emptied={"BlockNode:W"}))
        self.assertLeft(["check-links"], out(stdout="Scanned 42 live blocks (3 with internal link text).\n"), out(stdout="Scanned 40 live blocks (3 with internal link text).\n"), Ctx(emptied={"BlockNode:W"}))
        a = {"@id": "BlockNode:W", "@type": "BlockNode", "props": [{"key": "k"}], "title": "W", "parent": "BlockNode:H", "type": "listItem", "children": ["BlockNode:I"]}
        b = {"@id": "BlockNode:W", "@type": "BlockNode", "tombstonedAt": "<timestamp>", "title": "W", "type": "listItem", "children": []}
        self.assertExplained(["show", "BlockNode:W"], out(stdout=json.dumps(a, indent=2)), out(stdout=json.dumps(b, indent=2)), [3, "H8"], Ctx(emptied={"BlockNode:W"}))

    def test_a_path_that_only_a_tombstone_held_names_nothing(self):
        ref = out(0, "aperas://id/ArtifactNode:G  [ArtifactNode]  gamma.md\n")
        new = out(1, "", "[aperas] Failed: 'cmd_demo/gamma.md' isn't a tracked artifact/folder path, deep path, bare node code, or full node id.\n")
        self.assertExplained(["resolve", "cmd_demo/gamma.md"], ref, new, [4, 1], Ctx(dead={"ArtifactNode:G"}))
        self.assertLeft(["resolve", "cmd_demo/gamma.md"], ref, new, Ctx(dead=set()))

    def test_the_words_of_the_sweeps_and_of_the_load(self):
        self.assertExplained(["reload"], out(stdout="[aperas reload] Reloaded 420 quad(s), 86 node(s).\n"), out(stdout="[aperas reload] Reloaded 82 record(s), 67 document(s).\n"), [9])
        self.assertExplained(["reload"], out(stdout="[aperas reload] Reloaded 420 quad(s), 86 node(s). GC: 1 stale unfold(s) cleared.\n"), out(stdout="[aperas reload] Reloaded 82 record(s), 67 document(s).\n"), [9, 23])
        self.assertLeft(["reload"], out(stdout="[aperas reload] Reloaded 420 quad(s), 86 node(s). GC: 1 stale unfold(s) cleared.\n"), out(stdout="[aperas reload] Reloaded 82 record(s), 67 document(s). Something else.\n"))
        self.assertExplained(["flush", "--clobber"], out(stdout="[aperas flush] Flushed (clobbered — 12 unreachable tombstone(s) pruned, 1 vacuous container(s) tombstoned).\n"),
                             out(stdout="[aperas flush] Flushed (clobbered — 16 unreachable tombstone(s) pruned).\n"), [2, 3], Ctx(emptied={"BlockNode:W"}))
        self.assertExplained(["service", "nonsense"], out(1, "", "Usage: aperas service {start|stop|restart}\n"), out(1, "", "Usage: aperas service {start|stop|restart} [--start-anyway]\n"), [25])

    def test_a_load_that_is_not_whole(self):
        refused = "[aperas] Failed: Refusing to reload: the mirror was not read in full — 1 id(s) carried by more than one document, none kept: BlockNode:X (<root>/Apeiron/BlockNode.jsonld) (to accept it: aperas reload --start-anyway)\n"
        self.assertExplained(["reload"], out(0, "[aperas reload] Reloaded 1 quad(s), 1 node(s).\n"), out(1, "", refused), [10, "H7"])
        self.assertExplained(["reload", "--discard"], out(0, "[aperas reload] Reloaded 1 quad(s), 1 node(s).\n"), out(1, "", refused.replace("carried by more than one document", "carried by more than one document — 1 document(s) the engine refused")), [10, "H7", 28])
        start = "[aperas] Failed: ApeironNgn service REFUSING TO START: the mirror was not read in full — 1 document(s) the engine refused: BlockNode:X (Refused)\n"
        self.assertExplained(["service", "start"], out(0, "[aperas service] Started — bound to graph: g\n"), out(1, "", start), [10, 28, 24])
        self.assertExplained(["service", "start", "--start-anyway"], out(0, "[aperas service] Already running (pid <pid>), bound to graph: g\n"), out(0, "[aperas service] Started — bound to graph: g\n"), [25])
        self.assertLeft(["reload"], out(0, "x"), out(1, "", "[aperas] Failed: something else\n"))

    def test_the_documents_the_load_skipped_are_not_nodes_of_the_new_side(self):
        ctx = Ctx(rejected={"AAAAAAAAAAAAA": 2, "BBBBBBBBBBBBB": 1})
        doc = json.dumps({"@id": "BlockNode:AAAAAAAAAAAAA", "@type": "BlockNode"}, indent=2)
        self.assertExplained(["show", "BlockNode:AAAAAAAAAAAAA"], out(0, doc), out(1, "", "[aperas] Failed: Node 'BlockNode:AAAAAAAAAAAAA' not found.\n"), [10], ctx)
        doc = json.dumps({"@id": "BlockNode:BBBBBBBBBBBBB", "@type": "BlockNode"}, indent=2)
        self.assertExplained(["show", "BlockNode:BBBBBBBBBBBBB"], out(0, doc), out(1, "", "[aperas] Failed: Node 'BlockNode:BBBBBBBBBBBBB' not found.\n"), [28], ctx)
        self.assertLeft(["show", "BlockNode:CCCCCCCCCCCCC"], out(0, doc.replace("BBBB", "CCCC")), out(1, "", "[aperas] Failed: Node 'BlockNode:CCCCCCCCCCCCC' not found.\n"), ctx)
        ref = "FolderNode:F  [FolderNode]  f\n│ BlockNode:AAAAAAAAAAAAA  [heading]  ## A\n"
        new = "FolderNode:F  [FolderNode]  f\n│ BlockNode:AAAAAAAAAAAAA  [?]  <not found>\n"
        self.assertExplained(["tree", "f"], out(stdout=ref), out(stdout=new), [10], ctx)

    def test_a_move_into_the_own_subtree_is_refused_by_the_new_side_and_loops_in_the_reference(self):
        new = out(1, "", "[aperas] Failed: 'B:1' cannot be moved into its own subtree: 'B:1' is the node itself or lies under it (refused).\n")
        self.assertExplained(["insert", "B:1", "--after", "B:2"], out("timed out"), new, [5])
        self.assertLeft(["insert", "B:1", "--after", "B:2"], out("timed out"), out(1, "", "[aperas] Failed: other\n"))
        self.assertLeft(["insert", "B:1", "--after", "B:2"], out(0, "ok"), new)

    def test_the_orders(self):
        a, b, c = "BlockNode:1:links:Link:1  [heading]  # A\n", "BlockNode:2:links:Link:2  [heading]  # B\n", "BlockNode:3:links:Link:3  [heading]  # C\n"
        self.assertExplained(["backlinks", "X"], out(stdout=c + b + a), out(stdout=a + b + c), [15])
        self.assertLeft(["backlinks", "X"], out(stdout=c + b + a), out(stdout=a + b))
        self.assertExplained(["profile", "list-view"], out(stdout=c + a), out(stdout=a + c), [15])
        tree = "X  [heading]  # X\n│ L1  [Link]  → A\n│ L2  [Link]  → B\n│ Y  [heading]  ## Y\n"
        self.assertExplained(["tree", "--view", "v"], out(stdout="X  [heading]  # X\n│ L2  [Link]  → B\n│ L1  [Link]  → A\n│ Y  [heading]  ## Y\n"), out(stdout=tree), [13])
        self.assertLeft(["tree", "--view", "v"], out(stdout="X  [heading]  # X\n│ Y  [heading]  ## Y\n│ L1  [Link]  → A\n│ L2  [Link]  → B\n"), out(stdout=tree))
        links = lambda ids: json.dumps({"links": [{"@id": i, "target": "T"} for i in ids], "text": "t"}, indent=2)
        self.assertExplained(["show", "B:1"], out(stdout=links(["L2", "L1"])), out(stdout=links(["L1", "L2"])), [19])
        self.assertLeft(["show", "B:1"], out(stdout=links(["L2", "L1"])), out(stdout=links(["L1", "L3"])))
        tree_json = lambda ids: json.dumps({"children": [{"kind": "link", "id": i} for i in ids] + [{"kind": "block", "id": "Z"}]}, indent=2)
        self.assertExplained(["tree", "--view", "v", "--format", "render-tree"], out(stdout=tree_json(["L2", "L1"])), out(stdout=tree_json(["L1", "L2"])), [13])
        self.assertExplained(["retype", "B:1", "--to", "h3"], out(stdout="  dropped listItem-only prop(s): startIndex, orderedList\n"), out(stdout="  dropped listItem-only prop(s): orderedList, startIndex\n"), ["N1"])

    def test_the_canonical_place_of_a_shared_node_moves_between_links(self):
        ref = ("X  [heading]  # X\n│ L1  [Link]  → T  ## T  [*see L2 (link)]\n│ Y  [heading]  ## Y\n│ L2  [Link]  → T  ## T  ║  text  [*]\n│ │ T1  [heading]  # T1  ║  text  [+2]\n")
        new = ("X  [heading]  # X\n│ L1  [Link]  → T  ## T  ║  text  [*]\n│ │ T1  [heading]  # T1  ║  text  [+2]\n│ Y  [heading]  ## Y\n│ L2  [Link]  → T  ## T  [*see L1 (link)]\n")
        self.assertExplained(["tree", "--view", "v"], out(stdout=ref), out(stdout=new), [14])
        # the same place on both sides is not the entry
        same = ref.replace("[*see L2 (link)]", "[*see L2 (link)]")
        self.assertLeft(["tree", "--view", "v"], out(stdout=ref), out(stdout=new.replace("# T1", "# T2")))
        link = lambda i, mode: {"kind": "link", "id": i, "targetId": "T", "mode": mode, **({"starred": True, "abstract": "a"} if mode == "expanded" else {"pointerTarget": "x (link)"})}
        doc = lambda a, b: json.dumps({"children": [link("L1", a), link("L2", b)]}, indent=2)
        self.assertExplained(["tree", "--view", "v", "--format", "render-tree"], out(stdout=doc("pointer", "expanded")), out(stdout=doc("expanded", "pointer")), [14])

    def test_a_link_with_several_positions_reads_another_text_in_each_side(self):
        block = lambda t, i="A": "  • Node N (p.md): id-names-no-node\n    Link: N:links:Link:%s \"%s\"\n    Target: T%s\n" % (i, t, i)
        self.assertExplained(["check-links"], out(stderr=block("a6", "A") + block("b6", "B")), out(stderr=block("a1", "A") + block("b1", "B")), [18])
        self.assertExplained(["check-links"], out(stderr=block("b6", "B") + block("a6", "A")), out(stderr=block("a1", "A") + block("b1", "B")), [18, 15])
        self.assertLeft(["check-links"], out(stderr=block("a6", "A")), out(stderr=block("a1", "B")))
        act = lambda ids: "  • Node N (p.md): 2 missing link(s)\n    Actual links: " + json.dumps([{"id": i, "targetId": "T"} for i in ids], separators=(",", ":")) + "\n"
        self.assertExplained(["check-links", "--verbose"], out(stderr=act(["B", "A"])), out(stderr=act(["A", "B"])), [15])
        self.assertLeft(["check-links", "--verbose"], out(stderr=act(["B", "A"])), out(stderr=act(["A", "C"])))
        j = lambda ids_texts: json.dumps({"unresolvedTargets": [{"linkId": i, "linkText": t} for i, t in ids_texts]}, indent=2)
        self.assertExplained(["check-links", "--json"], out(stdout=j([("B", "b6"), ("A", "a6")])), out(stdout=j([("A", "a1"), ("B", "b1")])), [18, 15])
        self.assertLeft(["check-links", "--json"], out(stdout=j([("B", "b6")])), out(stdout=j([("A", "a1")])))

    def test_the_ids_of_the_position_props_of_a_reused_link(self):
        show = lambda tok: '{\n  "props": [\n    {\n      "@id": "BlockNode:A:links:Link:B:props:StringProp:%s",\n      "key": "position"\n    }\n  ]\n}' % tok
        self.assertExplained(["show", "BlockNode:A"], out(stdout=show("ref!00D8NQ3ZWKZ81")), out(stdout=show("00D8NQ3ZWKZ81")), [21])
        self.assertLeft(["show", "BlockNode:A"], out(stdout=show("00D8NQ3ZWKZ81")), out(stdout=show("00D8NQ3ZWKZ82")))

    def test_a_character_cut_between_two_chunks_by_the_reference_client(self):
        ref = "FolderNode:F  [FolderNode]  f\n│ │ ��� │ BlockNode:A  [heading]  # A\n│ BlockNode:B  [heading]  # B\n"
        new = ref.replace("���", "│")
        self.assertExplained(["tree", "f"], out(stdout=ref), out(stdout=new), ["N3"])
        # a run of 2 for a character of 3 bytes, and of 2 for one of 2 bytes
        self.assertExplained(["tree", "f"], out(stdout="a �� b\n"), out(stdout="a — b\n"), ["N3"])
        self.assertExplained(["tree", "f"], out(stdout="a �� b\n"), out(stdout="a é b\n"), ["N3"])
        # the line is the same text but for the characters
        self.assertLeft(["tree", "f"], out(stdout=ref), out(stdout=new.replace("# A", "# C")))
        # a run of 1 is not a cut character, a run of 5 is not either, a run of 4 stands for a character of 4 bytes only, and a plain character is not a cut one
        self.assertLeft(["tree", "f"], out(stdout="a � b\n"), out(stdout="a — b\n"))
        self.assertLeft(["tree", "f"], out(stdout="a ����� b\n"), out(stdout="a 😀 b\n"))
        self.assertLeft(["tree", "f"], out(stdout="a ���� b\n"), out(stdout="a — b\n"))
        self.assertLeft(["tree", "f"], out(stdout="a �� b\n"), out(stdout="a x b\n"))
        # a run of the reference is two characters of the new side's line: not one cut
        self.assertLeft(["tree", "f"], out(stdout="a �� b\n"), out(stdout="a —— b\n"))
        # the new side's own U+FFFD is not explained
        self.assertLeft(["tree", "f"], out(stdout="a — b\n"), out(stdout="a �� b\n"))
        # a line the other side lacks keeps the rest apart
        self.assertLeft(["tree", "f"], out(stdout="x\na �� b\n"), out(stdout="a — b\n"))

    def test_the_six_readme_documents_the_migration_deleted(self):
        ctx = Ctx(facts=readme_facts())
        ref = "\n[aperas track] The following would be permanently removed (no matching file found on disk):\n  'concepts.md'\n  'history/README.md'\n  'README.md'\n[aperas track] Skipped — nothing was removed.\n[aperas track] Tracked 0 artifact(s), skipped 85 unchanged, 0 renamed, 0 removed.\n"
        new = "\n[aperas track] The following would be permanently removed (no matching file found on disk):\n  'concepts.md'\n[aperas track] Skipped — nothing was removed.\n[aperas track] Tracked 0 artifact(s), skipped 85 unchanged, 0 renamed, 0 removed.\n"
        self.assertExplained(["track", "--no-prompt"], out(stdout=ref), out(stdout=new), ["H3"], ctx)
        # the counts that follow an answered question
        yes_ref = ref.replace("0 removed", "3 removed")
        self.assertExplained(["track", "--force"], out(stdout=yes_ref), out(stdout=new.replace("0 removed", "1 removed")), ["H3"], ctx)
        self.assertLeft(["track", "--force"], out(stdout=yes_ref), out(stdout=new.replace("0 removed", "2 removed")), ctx)
        # ingest lists them as untracked from disk
        self.assertExplained(["ingest", "--track"], out(stdout="  'concepts.md' (untracked from disk)\n  'README.md' (untracked from disk)\n"), out(stdout="  'concepts.md' (untracked from disk)\n"), ["H3"], ctx)
        # a path that is not one of the six, a README the new side lists too, and a run with no snapshot
        self.assertLeft(["track", "--no-prompt"], out(stdout=ref.replace("'history/README.md'", "'docs/README.md'")), out(stdout=new), ctx)
        self.assertLeft(["track", "--no-prompt"], out(stdout=new.replace("  'concepts.md'\n", "  'concepts.md'\n  'history/README.md'\n")), out(stdout=new.replace("  'concepts.md'\n", "  'concepts.md'\n  'README.md'\n")), ctx)
        self.assertLeft(["track", "--no-prompt"], out(stdout=ref), out(stdout=new), Ctx())
        self.assertLeft(["track", "--no-prompt"], out(stdout=ref), out(stdout=new), Ctx(facts=compare.Facts({})))
        # the live blocks `check-links` counts: the six paragraphs, exactly
        for pat, fmt in (("[ApeironNgn check-links] Scanned %d live blocks (3 with internal link text).\n", None), ('{\n  "totalLiveBlocks": %d,\n  "discrepancies": []\n}', None)):
            self.assertExplained(["check-links"], out(stdout=pat % 106), out(stdout=pat % 100), ["H3"], ctx)
            self.assertLeft(["check-links"], out(stdout=pat % 107), out(stdout=pat % 100), ctx)
            self.assertLeft(["check-links"], out(stdout=pat % 105), out(stdout=pat % 100), ctx)
            self.assertLeft(["check-links"], out(stdout=pat % 106), out(stdout=pat % 100), Ctx())
        # six and the container a removal emptied (entry 3)
        self.assertExplained(["check-links"], out(stdout="Scanned 107 live blocks (3 with internal link text).\n"), out(stdout="Scanned 100 live blocks (3 with internal link text).\n"), ["H3", 3], Ctx(facts=readme_facts(), emptied={"BlockNode:W"}))

    def test_the_tombstones_the_reference_still_lists(self):
        ctx = Ctx(facts=tomb_facts())
        ref = "FolderNode:F  [FolderNode]  f\n│ │ BlockNode:00D8B0000000B  [?]  <not found>\n│ BlockNode:D  [heading]  # D\n"
        new = "FolderNode:F  [FolderNode]  f\n│ BlockNode:D  [heading]  # D\n"
        self.assertExplained(["tree", "f"], out(stdout=ref), out(stdout=new), ["H9"], ctx)
        self.assertExplained(["unfold", "f"], out(stdout=ref), out(stdout=new), ["H9"], ctx)
        # a node that is not a tombstone of the snapshot, one the new side holds, one the new side lists too, and a line that is not a missing node
        self.assertLeft(["tree", "f"], out(stdout=ref.replace("00D8B0000000B", "00D8B000000ZZ")), out(stdout=new), ctx)
        self.assertLeft(["tree", "f"], out(stdout=ref), out(stdout=new), Ctx(facts=tomb_facts(), new_ids={"BlockNode:00D8B0000000B"}))
        self.assertLeft(["tree", "f"], out(stdout=ref), out(stdout=new), Ctx())
        self.assertLeft(["tree", "f"], out(stdout=ref.replace("[?]  <not found>", "[heading]  # B")), out(stdout=new), ctx)
        # `track --reverse` names the tombstoned artifact of the snapshot, with its heading when it is the only one
        tr = "[aperas track --reverse] Never projected:\n  [ArtifactNode] 'a.md'\n[aperas track --reverse] Removed in-graph but still on disk (aperas project never deletes — remove manually if intended):\n  'd/t.md'\n  'd/s.md'\n"
        self.assertExplained(["track", "--reverse"], out(stdout=tr), out(stdout=tr.replace("  'd/t.md'\n", "")), ["H9"], ctx)
        alone = "[aperas track --reverse] Never projected:\n  [ArtifactNode] 'a.md'\n[aperas track --reverse] Removed in-graph but still on disk (aperas project never deletes — remove manually if intended):\n  'd/t.md'\n"
        self.assertExplained(["track", "--reverse"], out(stdout=alone), out(stdout="[aperas track --reverse] Never projected:\n  [ArtifactNode] 'a.md'\n"), ["H9"], ctx)
        self.assertLeft(["track", "--reverse"], out(stdout=tr.replace("'d/t.md'", "'d/other.md'")), out(stdout=tr.replace("  'd/t.md'\n", "")), ctx)
        self.assertLeft(["track", "--reverse"], out(stdout=tr), out(stdout=tr.replace("  'd/t.md'\n", "")), Ctx(facts=tomb_facts(), new_ids={"ArtifactNode:00D8A0000000B"}))
        # the counts of the unfolds of a view that name a tombstone
        lv = lambda n: "awork  profile: dinhlx  (%d unfold(s))  TreeView:00D8V0000000A\nother  profile: dinhlx  (4 unfold(s))  TreeView:00D8V0000000B\n" % n
        self.assertExplained(["profile", "list-view"], out(stdout=lv(5)), out(stdout=lv(4)), [2], ctx)
        self.assertLeft(["profile", "list-view"], out(stdout=lv(6)), out(stdout=lv(4)), ctx)
        self.assertLeft(["profile", "list-view"], out(stdout=lv(5)), out(stdout=lv(4)), Ctx(facts=tomb_facts(), new_ids={"BlockNode:00D8B0000000B"}))
        self.assertLeft(["profile", "list-view"], out(stdout=lv(5).replace("other  profile: dinhlx  (4", "other  profile: dinhlx  (5")), out(stdout=lv(4)), ctx)

    def test_the_blocks_ingest_lists_as_removed_and_counts(self):
        ctx = Ctx(facts=tomb_facts())
        sample = lambda *titles: "".join("    - [listItem] %s\n" % t for t in titles)
        head = "\n[aperas ingest] The following would be permanently removed:\n  'd/a.md':\n"
        ref = head + sample("gone", "real one") + "    ...and 8 more\n[aperas ingest] Skipped — nothing was removed.\n"
        new = head + sample("real one", "real two") + "    ...and 7 more\n[aperas ingest] Skipped — nothing was removed.\n"
        self.assertExplained(["ingest"], out(stdout=ref), out(stdout=new), ["H9"], ctx)
        # the totals differ by other than the tombstones, a line of the reference's sample that the new side does not list, no tombstone of the snapshot, or one the new side holds
        self.assertLeft(["ingest"], out(stdout=ref.replace("8 more", "9 more")), out(stdout=new), ctx)
        self.assertLeft(["ingest"], out(stdout=ref.replace("real one", "other one")), out(stdout=new), ctx)
        self.assertLeft(["ingest"], out(stdout=ref), out(stdout=new), Ctx())
        self.assertLeft(["ingest"], out(stdout=ref), out(stdout=new), Ctx(facts=tomb_facts(), new_ids={"BlockNode:00D8B0000000B"}))
        self.assertLeft(["ingest"], out(stdout=ref), out(stdout=new.replace("d/a.md", "d/b.md")), ctx)
        # the counts of the ingest of that artifact: one removed block, and the links it hosted (1) bound the links changed
        done = lambda removed, changed: "[aperas ingest] Ingested 'd/a.md' fractal tree (9 blocks) (reconciled: 5 matched, 0 moved, 2 changed, 1 added, %d removed).\n[aperas ingest]   Links: 20 resolved, 0 dangling, %d changed.\n" % (removed, changed)
        self.assertExplained(["ingest", "--force"], out(stdout=done(4, 8)), out(stdout=done(3, 7)), ["H9"], ctx)
        self.assertExplained(["ingest", "--force"], out(stdout=done(4, 7)), out(stdout=done(3, 7)), ["H9"], ctx)
        self.assertLeft(["ingest", "--force"], out(stdout=done(4, 9)), out(stdout=done(3, 7)), ctx)
        self.assertLeft(["ingest", "--force"], out(stdout=done(4, 6)), out(stdout=done(3, 7)), ctx)
        self.assertLeft(["ingest", "--force"], out(stdout=done(5, 8)), out(stdout=done(3, 7)), ctx)
        self.assertLeft(["ingest", "--force"], out(stdout=done(4, 8)), out(stdout=done(3, 7).replace("20 resolved", "21 resolved")), ctx)
        self.assertLeft(["ingest", "--force"], out(stdout=done(4, 8)), out(stdout=done(3, 7)), Ctx())

    def test_a_count_of_live_blocks_is_one_higher_on_the_reference_per_block_a_refused_command_left(self):
        text = lambda n: "[ApeironNgn check-links] Scanned %d live blocks (3 with internal link text).\n" % n
        js = lambda n: json.dumps({"totalLiveBlocks": n, "blocksWithLinkText": 3}, indent=2)
        one, two = Ctx(left=1, refused=[5]), Ctx(left=2, refused=[5, 6])
        self.assertExplained(["check-links"], out(stdout=text(101)), out(stdout=text(100)), [31], one, 9)
        self.assertExplained(["check-links", "--json"], out(stdout=js(101)), out(stdout=js(100)), [31], one, 9)
        self.assertExplained(["check-links"], out(stdout=text(102)), out(stdout=text(100)), [31], two, 9)
        self.assertExplained(["check-links"], out(stdout=text(101)), out(stdout=text(100)), [31], one)   # no index: after every command
        # the leftovers of the refused commands before this command only
        self.assertExplained(["check-links"], out(stdout=text(101)), out(stdout=text(100)), [31], two, 6)
        self.assertNot31(["check-links"], out(stdout=text(102)), out(stdout=text(100)), two, 6)
        self.assertNot31(["check-links"], out(stdout=text(101)), out(stdout=text(100)), one, 5)
        # a gap that is not the leftovers' (a plain difference, or the leftovers and something else), no leftover, or another verb
        self.assertNot31(["check-links"], out(stdout=text(102)), out(stdout=text(100)), one, 9)
        self.assertNot31(["check-links"], out(stdout=text(100)), out(stdout=text(101)), one, 9)
        self.assertNot31(["check-links"], out(stdout=text(101)), out(stdout=text(100)), Ctx(), 9)
        self.assertNot31(["check-links", "--json"], out(stdout=js(102)), out(stdout=js(100)), one, 9)
        self.assertNot31(["tree", "x"], out(stdout=text(101)), out(stdout=text(100)), one, 9)
        # with the emptied containers (entry 3) and the README paragraphs (H3) that the reference counts too
        emptied = Ctx(left=1, refused=[5], emptied=["BlockNode:00D8W0000000A"])
        self.assertExplained(["check-links"], out(stdout=text(102)), out(stdout=text(100)), [31, 3], emptied, 9)
        self.assertNot31(["check-links"], out(stdout=text(103)), out(stdout=text(100)), emptied, 9)
        readme = Ctx(left=1, refused=[5], facts=readme_facts())
        self.assertExplained(["check-links"], out(stdout=text(107)), out(stdout=text(100)), ["H3", 31], readme, 9)
        self.assertNot31(["check-links"], out(stdout=text(108)), out(stdout=text(100)), readme, 9)

    def test_a_link_of_a_thread_to_a_tombstone_of_the_content_graph_is_dangling_in_the_new_side_only(self):
        ctx = Ctx(facts=tomb_facts())
        blk = lambda host, link, target: "  • Node %s (.threads/coder.md): id-names-no-node\n    Link: %s \"text\"\n    Target: %s\n" % (host, link, target)
        mine = blk("BlockNode:00D8T0000000A", "BlockNode:00D8T0000000A:links:Link:L1", "BlockNode:00D8B0000000B")
        other = blk("BlockNode:00D8B0000000A", "BlockNode:00D8B0000000A:links:Link:L2", "BlockNode:00D8Z0000000Z")
        warn = lambda n: "[ApeironNgn check-links] WARNING: Found %d stored link(s) whose target names no node (--repair leaves these alone):\n" % n
        clean = "[ApeironNgn check-links] Clean pass: 0 link integrity discrepancies found.\n"
        scanned = "[ApeironNgn check-links] Scanned 100 live blocks (3 with internal link text).\n"
        # only that link: the reference prints a clean pass and the new side prints none
        self.assertExplained(["check-links"], out(stdout=scanned + clean), out(stdout=scanned, stderr=warn(1) + mine), [30], ctx)
        # that link and another dangling one both sides report: the warning follows
        self.assertExplained(["check-links"], out(stdout=scanned, stderr=warn(1) + other), out(stdout=scanned, stderr=warn(2) + mine + other), [30], ctx)
        self.assertLeft(["check-links"], out(stdout=scanned, stderr=warn(2) + other), out(stdout=scanned, stderr=warn(2) + mine + other), ctx)
        # the link is not of the shape: its host is in the content graph, its target is no tombstone of the snapshot, the new side holds the target, or the run has no snapshot
        self.assertLeft(["check-links"], out(stdout=scanned + clean), out(stdout=scanned, stderr=warn(1) + other), ctx)
        self.assertLeft(["check-links"], out(stdout=scanned + clean), out(stdout=scanned, stderr=warn(1) + mine.replace("00D8B0000000B", "00D8B000000ZZ")), ctx)
        self.assertLeft(["check-links"], out(stdout=scanned + clean), out(stdout=scanned, stderr=warn(1) + mine.replace("00D8T0000000A", "00D8B0000000A")), ctx)
        self.assertLeft(["check-links"], out(stdout=scanned + clean), out(stdout=scanned, stderr=warn(1) + mine), Ctx(facts=tomb_facts(), new_ids={"BlockNode:00D8B0000000B"}))
        self.assertLeft(["check-links"], out(stdout=scanned + clean), out(stdout=scanned, stderr=warn(1) + mine), Ctx())
        # a count that does not match the list is not trusted
        self.assertLeft(["check-links"], out(stdout=scanned + clean), out(stdout=scanned, stderr=warn(2) + mine), ctx)
        # and the reference's clean pass is dropped only when the warning is left empty
        self.assertLeft(["check-links"], out(stdout=scanned + clean + "extra\n"), out(stdout=scanned, stderr=warn(1) + mine), ctx)
        # the same, in the form of --json
        js = lambda us: json.dumps({"totalLiveBlocks": 100, "unresolvedTargets": us}, indent=2)
        u = lambda host, target: {"blockId": host, "targetId": target, "kind": "id-names-no-node"}
        self.assertExplained(["check-links", "--json"], out(stdout=js([])), out(stdout=js([u("BlockNode:00D8T0000000A", "BlockNode:00D8B0000000B")])), [30], ctx)
        self.assertLeft(["check-links", "--json"], out(stdout=js([])), out(stdout=js([u("BlockNode:00D8B0000000A", "BlockNode:00D8B0000000B")])), ctx)
        self.assertLeft(["check-links", "--json"], out(stdout=js([])), out(stdout=js([u("BlockNode:00D8T0000000A", "BlockNode:00D8B0000000B")])), Ctx())

    def test_a_start_the_reference_gives_up_on_after_five_seconds(self):
        gave_up = "[aperas] Failed: ApeironNgn service did not become ready in time\n"
        self.assertExplained(["service", "restart"], out(1, "[aperas service] Stopping service (pid <pid>)...\n", gave_up),
                             out(0, "[aperas service] Stopping service (pid <pid>)...\n[aperas service] Restarted — now running the current on-disk code, bound to graph: <root>/Apeiron, artifacts: <root>/artifacts.\n"), ["D1"])
        self.assertExplained(["service", "start"], out(1, "", gave_up), out(0, "[aperas service] Started — bound to graph: <root>/Apeiron, artifacts: <root>/artifacts.\n"), ["D1"])
        started = out(0, "[aperas service] Started — bound to graph: <root>/Apeiron, artifacts: <root>/artifacts.\n")
        # another failure of the reference, a status it did not have, a stderr the new side has, other words in the new side's stdout, a verb that is not a start
        self.assertLeft(["service", "start"], out(1, "", "[aperas] Failed: something else\n"), started)
        self.assertLeft(["service", "start"], out(2, "", gave_up), started)
        self.assertLeft(["service", "start"], out(1, "", gave_up + "more\n"), started)
        self.assertLeft(["service", "start"], out(1, "", gave_up), out(0, started["stdout"], "warning\n"))
        self.assertLeft(["service", "start"], out(1, "", gave_up), out(1, "", "[aperas] Failed: other\n"))
        self.assertLeft(["service", "start"], out(1, "", gave_up), out(0, "[aperas service] Started — bound to graph: <root>/Apeiron.\nand something else\n"))
        self.assertLeft(["service", "start"], out(1, "ref text\n", gave_up), started)
        self.assertLeft(["service", "stop"], out(1, "", gave_up), started)
        # a refused start of a mirror not read in full: the reference gave up before its service refused (or took the mirror in)
        refused = "[aperas] Failed: ApeironNgn service REFUSING TO START: the mirror was not read in full — 1 id(s) carried by more than one document, none kept: BlockNode:X (<root>/Apeiron/BlockNode.jsonld)\n"
        self.assertExplained(["service", "start"], out(1, "", gave_up), out(1, "", refused), [10, 24, "D1", "H7"])
        self.assertLeft(["service", "start"], out(1, "", "[aperas] Failed: something else\n"), out(1, "", refused))

    def test_the_artifacts_whose_links_were_re_resolved_are_listed_in_order_by_the_new_side(self):
        t = lambda names: "[aperas ingest] Re-resolved links in 2 artifact(s) whose own text didn't change but a target they reference just did: %s.\n" % names
        self.assertExplained(["ingest"], out(stdout=t("b.md, a.md")), out(stdout=t("a.md, b.md")), [15])
        self.assertLeft(["ingest"], out(stdout=t("b.md, c.md")), out(stdout=t("a.md, b.md")))
        self.assertExplained(["track", "--no-prompt"], out(stdout="  'b.md'\n  'a.md'\n[aperas track] Skipped\n"), out(stdout="  'a.md'\n  'b.md'\n[aperas track] Skipped\n"), [15])
        self.assertLeft(["track", "--no-prompt"], out(stdout="  'b.md'\n  'c.md'\n"), out(stdout="  'a.md'\n  'b.md'\n"))

    def test_a_plain_difference_of_every_verb_is_left_alone(self):
        for argv in (["tree", "x"], ["show", "x"], ["backlinks", "x"], ["reload"], ["flush"], ["service", "start"], ["insert", "a", "--after", "b"], ["track", "--reverse"], ["resolve", "x"]):
            self.assertLeft(argv, out(0, "one\n"), out(0, "two\n"))
            self.assertLeft(argv, out(0, "same\n"), out(1, "same\n"))


class Logs(unittest.TestCase):
    def lines(self, side, text):
        c, f = explain.explain_logs(text if side == "ref" else "", text if side == "new" else "", ("/r",), ("/n",))
        return c, f

    def test_each_known_line_is_accounted_for_by_the_entries_it_shows(self):
        T = "2026-10-22T17:24:18.177Z [ApeironNgn service] "
        cases = [
            ("ref", "Rehydrated 390 quad(s) from /r/Apeiron.", [9]),
            ("new", "Loaded 86 record(s) from /n/Apeiron.", [9]),
            ("ref", "Reloaded 390 quad(s), 86 node(s).", [9]),
            ("ref", "Reloaded 390 quad(s), 86 node(s). GC: 1 stale unfold(s) cleared.", [9, 23]),
            ("new", "Reloaded 85 record(s), 56 document(s); 3 graph(s) of the old store freed.", [9, 26]),
            ("new", "Flush intervals: tree 10000 ms, threads.tree 3000 ms, treeviews 3000 ms.", [22]),
            ("new", "WARNING: 1 id(s) referenced and never defined: FolderNode:00GH0ST000000", [27]),
            ("ref", "WARNING: 1 duplicate @id(s) in the mirror — quads from every occurrence merged onto one subject, so at most one document per id survives the next dehydrate: BlockNode:X", ["H7"]),
            ("new", "WARNING: the id BlockNode:X is carried 2 times (BlockNode:X in /n/Apeiron/BlockNode.jsonld; BlockNode:X in /n/Apeiron/BlockNode.jsonld): every document that carries it is rejected", ["H7", 10]),
            ("new", "Reload refused, the graph in memory is kept: the mirror was not read in full — 1 id(s) carried by more than one document, none kept: BlockNode:X (/n/Apeiron/BlockNode.jsonld)", [10]),
            ("new", "REFUSING TO START: the mirror was not read in full — 1 document(s) the engine refused: BlockNode:X (Refused) (to work on: aperas service start --start-anyway)", [10, 24, 28]),
            ("new", "START-ANYWAY: the mirror was not read in full — 1 id(s) carried by more than one document", [25]),
            ("new", "The documents the load skipped are copied to /n/Apeiron/BlockNode.jsonld.rejected-20261022T172425Z.json.", [25]),
            ("ref", "Startup GC: cleaned 3 unreachable tombstone(s), 1 vacuous container(s), 1 stale unfold(s).", [2, 3, 23]),
            ("new", "Startup GC: cleaned 4 unreachable tombstone(s), 0 vacuous container(s).", [2, 3, 23]),
            ("new", "WARNING: /n/aperas.config.json: the graphs table has an entry named tree; the name may collide with the main graph, which has no identifier of its own and is called tree today (the entry is used)", ["N4"]),
            ("ref", "Timed flush: Refusing to flush: BlockNode.jsonld changed on disk", [22]),
            ("new", "Timed flush of tree: Refusing to flush: BlockNode.jsonld changed on disk", [22]),
        ]
        for side, line, keys in cases:
            claims, findings = self.lines(side, T + line + "\n")
            self.assertEqual(findings, [], line)
            self.assertEqual([k for _, _, ks in claims for k in ks], keys, line)

    def test_a_line_that_no_rule_knows_is_a_finding_and_a_side_is_not_the_other(self):
        T = "2026-10-22T17:24:18.177Z [ApeironNgn service] "
        claims, findings = self.lines("new", T + "Something new happened\n")
        self.assertEqual((claims, [l for _, l in findings]), ([], [T + "Something new happened"]))
        # a line that both logs hold is equal, and a line held once on one side and twice on the other is not
        both = T + "LINK INTEGRITY: 1 live block(s) cite a resolvable target\n"
        c, f = explain.explain_logs(both, both, (), ())
        self.assertEqual((c, f), ([], []))
        c, f = explain.explain_logs(both + both, both, (), ())
        self.assertEqual(len(f), 1)
        # the line of one side is not accepted from the other
        claims, findings = self.lines("ref", T + "Loaded 86 record(s) from /n/Apeiron.\n")
        self.assertEqual(len(findings), 1)
        claims, findings = self.lines("new", T + "Rehydrated 390 quad(s) from /n/Apeiron.\n")
        self.assertEqual(len(findings), 1)


def doc(i, kind="BlockNode", **fields):
    d = {"@id": "%s:%s" % (kind, i), "@type": kind}
    d.update(fields)
    return d


def write_dump(directory, files, extras=None):
    for name, docs in files.items():
        path = os.path.join(directory, *name.split("/"))
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as h:
            json.dump(docs, h, indent=2)
    for name, text in (extras or {}).items():
        path = os.path.join(directory, *name.split("/"))
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as h:
            h.write(text)


class DumpBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="dexp-")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.n = 0
        self.snap = os.path.join(self.tmp, "snap")
        os.makedirs(self.snap)
        write_dump(os.path.join(self.snap, "Apeiron"), self.base())

    def base(self):
        return {"FolderNode.jsonld": [doc("00FFFFFFFFFFA", "FolderNode", title="f", path="f", children=["BlockNode:00AAAAAAAAAAA", "FolderNode:00GH0ST000000"])],
                "BlockNode.jsonld": [doc("00AAAAAAAAAAA", title="# A", text="a", type="heading", parent="FolderNode:00FFFFFFFFFFA"),
                                     doc("00BBBBBBBBBBB", title="# B", text="b", type="heading", parent="FolderNode:00FFFFFFFFFFA")]}

    def dump(self, files, extras=None):
        self.n += 1
        d = os.path.join(self.tmp, "d%d" % self.n)
        os.makedirs(d)
        write_dump(d, files, extras)
        return d

    def pair(self, ref=None, new=None, extras_new=None, commands=None, logs=None, artifacts=None):
        r, n = ref or self.base(), new or self.base()
        return compare.compare_dumps(self.dump(r), self.dump(n, extras_new), snapshot=self.snap, commands=commands, migrate=False, logs=logs, artifacts=artifacts, roots_ref=("/r",), roots_new=("/n",))


class Dumps(DumpBase):
    def test_the_ghost_folder_is_a_document_of_the_reference_only(self):
        ref = self.base()
        ref["FolderNode.jsonld"].append(doc("00GH0ST000000", "FolderNode", parent="FolderNode:00FFFFFFFFFFA", children=[]))
        r = self.pair(ref=ref)
        self.assertEqual([k for _, k in r.claims], [20])
        self.assertEqual(r.unexpected, 0)
        # a document with a title is not a ghost
        ref["FolderNode.jsonld"][-1]["title"] = "ghost"
        r = self.pair(ref=ref)
        self.assertEqual(r.unexpected, 1)

    def test_a_document_the_new_sides_load_skipped_is_not_in_its_dump(self):
        ref = self.base()
        new = self.base()
        new["BlockNode.jsonld"] = [new["BlockNode.jsonld"][0]]
        extras = {"BlockNode.jsonld.rejected-20261022T172425Z.json": json.dumps([doc("00BBBBBBBBBBB"), doc("00BBBBBBBBBBB")])}
        r = self.pair(ref=ref, new=new, extras_new=extras)
        self.assertIn(10, [k for _, k in r.claims])
        extras = {"BlockNode.jsonld.rejected-20261022T172425Z.json": json.dumps([doc("00BBBBBBBBBBB")])}
        r = self.pair(ref=ref, new=new, extras_new=extras)
        self.assertIn(28, [k for _, k in r.claims])
        # with no copy it is a finding
        r = self.pair(ref=ref, new=new)
        self.assertEqual(r.unexpected, 1)

    def refused(self, index, argv, ref=(1, "", "[aperas] Failed: no anchor\n"), new=None):
        item = {"index": index, "name": argv[0], "argv": argv}
        for side, o in (("ref", ref), ("new", new or ref)):
            item[side] = {"status": o[0], "timedOut": False, "stdout": o[1], "stderr": o[2]}
        return item

    def leftover(self, token="00CCCCCCCCCCC", **more):
        return doc(token, title=token, text="text", type="paragraph", **more)

    def test_a_block_a_refused_command_left_is_a_document_of_the_reference_only(self):
        ref = self.base()
        ref["BlockNode.jsonld"].append(self.leftover())
        r = self.pair(ref=ref, commands=[self.refused(3, ["insert", "f/a.md/A", "--after", "BlockNode:00ZZZZZZZZZZZ"])])
        self.assertEqual([k for _, k in r.claims], [31], [d.describe() for d, _ in r.findings])
        self.assertEqual(r.unexpected, 0)
        # an `update` that both sides refused leaves the same
        r = self.pair(ref=ref, commands=[self.refused(3, ["update", "BlockNode:00AAAAAAAAAAA"])])
        self.assertEqual([k for _, k in r.claims], [31])

    def test_a_parentless_block_of_the_reference_is_not_a_leftover_without_a_refusal_that_both_sides_made(self):
        ref = self.base()
        ref["BlockNode.jsonld"].append(self.leftover())
        base, one = ["insert", "f/a.md/A"], (1, "", "[aperas] Failed: one\n")
        timed_out = dict(self.refused(3, base), ref={"status": 1, "timedOut": True, "stdout": "", "stderr": "x"})
        for name, commands in (
                ("no command", []),
                ("a command that succeeded", [self.refused(3, base, (0, "", "[aperas] Failed: one\n"))]),
                ("a refusal with no text", [self.refused(3, base, (1, "", ""))]),
                ("a status that differs", [self.refused(3, base, one, (2, "", "[aperas] Failed: one\n"))]),
                ("a text that differs", [self.refused(3, base, one, (1, "", "[aperas] Failed: two\n"))]),
                ("a verb that makes no block", [self.refused(3, ["tree", "f"])]),
                ("a refusal that timed out", [timed_out])):
            r = self.pair(ref=ref, commands=commands)
            self.assertEqual([k for _, k in r.claims if k == 31], [], name)
            self.assertIn(("doc", "only-ref"), [(d.scope, d.op) for d, _ in r.findings], name)

    def test_only_a_live_minted_block_with_no_parent_and_no_container_that_the_new_side_lacks_is_a_leftover(self):
        cmd = self.refused(3, ["insert", "f/a.md/A"])
        # it has a parent
        ref = self.base()
        ref["BlockNode.jsonld"].append(self.leftover(parent="BlockNode:00AAAAAAAAAAA"))
        r = self.pair(ref=ref, commands=[cmd])
        self.assertNotIn(31, [k for _, k in r.claims])
        self.assertGreaterEqual(r.unexpected, 1)
        # a container lists it
        ref = self.base()
        ref["BlockNode.jsonld"].append(self.leftover())
        ref["BlockNode.jsonld"][0]["children"] = ["BlockNode:00CCCCCCCCCCC"]
        r = self.pair(ref=ref, commands=[cmd])
        self.assertNotIn(31, [k for _, k in r.claims])
        self.assertGreaterEqual(r.unexpected, 1)
        # it is a tombstone: entry 2 takes it and entry 31 does not
        ref = self.base()
        ref["BlockNode.jsonld"].append(doc("00CCCCCCCCCCC", tombstonedAt="2026-10-22T17:24:18.177Z"))
        r = self.pair(ref=ref, commands=[cmd])
        self.assertEqual([k for _, k in r.claims], [2])
        self.assertEqual(r.unexpected, 0)
        # the snapshot held it
        snap = self.base()
        snap["BlockNode.jsonld"].append(self.leftover())
        write_dump(os.path.join(self.snap, "Apeiron"), snap)
        ref = self.base()
        ref["BlockNode.jsonld"].append(self.leftover())
        r = self.pair(ref=ref, commands=[cmd])
        self.assertNotIn(31, [k for _, k in r.claims])
        self.assertEqual(r.unexpected, 1)

    def test_a_block_both_sides_hold_does_not_take_the_place_of_the_leftover_and_each_refused_command_leaves_one(self):
        # a parentless block of both sides, older than the leftover
        ref, new = self.base(), self.base()
        ref["BlockNode.jsonld"].append(self.leftover("00CAAAAAAAAAA"))
        new["BlockNode.jsonld"].append(self.leftover("00CEEEEEEEEEE"))
        ref["BlockNode.jsonld"].append(self.leftover("00CCCCCCCCCCC"))
        r = self.pair(ref=ref, new=new, commands=[self.refused(3, ["insert", "f/a.md/A"])])
        self.assertEqual([k for _, k in r.claims], [31], [d.describe() for d, _ in r.findings])
        self.assertEqual(r.unexpected, 0)
        # two leftovers, one refused command: the earlier is claimed (the file lists the later first), the other is a finding
        ref = self.base()
        ref["BlockNode.jsonld"] += [self.leftover("00CDDDDDDDDDD"), self.leftover("00CBBBBBBBBBB")]
        r = self.pair(ref=ref, commands=[self.refused(3, ["insert", "f/a.md/A"])])
        self.assertEqual([k for _, k in r.claims], [31])
        self.assertEqual([d.ref_id for d, _ in r.findings], ["BlockNode:00CDDDDDDDDDD"])
        r = self.pair(ref=ref, commands=[self.refused(3, ["insert", "f/a.md/A"]), self.refused(4, ["update", "x"])])
        self.assertEqual([k for _, k in r.claims], [31, 31])
        self.assertEqual(r.unexpected, 0)

    def test_the_hash_of_a_file_that_holds_minted_ids(self):
        ref, new = self.base(), self.base()
        ref["BlockNode.jsonld"].append(doc("00CCCCCCCCCCC", title="# C", type="heading"))
        new["BlockNode.jsonld"].append(doc("00DDDDDDDDDDD", title="# C", type="heading"))
        for files, h in ((ref, "h1"), (new, "h2")):
            files["ArtifactNode.jsonld"] = [doc("00EEEEEEEEEEE", "ArtifactNode", title="e.md", path="e.md", fileHash=h, children=["BlockNode:%s" % ("00CCCCCCCCCCC" if h == "h1" else "00DDDDDDDDDDD")])]
        roots = {}
        for side, tok in (("ref", "00CCCCCCCCCCC"), ("new", "00DDDDDDDDDDD")):
            roots[side] = os.path.join(self.tmp, side + "-artifacts")
            os.makedirs(roots[side])
            with open(os.path.join(roots[side], "e.md"), "w") as h:
                h.write("# C <a name='id/BlockNode:%s'></a>\n" % tok)
        r = self.pair(ref=ref, new=new, artifacts=roots)
        self.assertIn("N2", [k for _, k in r.claims])
        self.assertEqual(r.unexpected, 0, [d.describe() for d, _ in r.findings])
        with open(os.path.join(roots["new"], "e.md"), "a") as h:
            h.write("one more line\n")
        r = self.pair(ref=ref, new=new, artifacts=roots)
        self.assertGreaterEqual(r.unexpected, 1)


class Compare(DumpBase):
    def command(self, index, name, argv, ref, new):
        item = {"index": index, "name": name, "argv": argv}
        for side, o in (("ref", ref), ("new", new)):
            item[side] = {"status": o[0], "timedOut": False, "stdout": o[1], "stderr": o[2]}
        return item

    def test_an_explained_command_claims_and_a_plain_difference_is_a_finding(self):
        explained = self.command(1, "show", ["show", "BlockNode:00AAAAAAAAAAA"], (0, '{\n  "links": [\n    {\n      "target": "X",\n      "predicate": "[[wikilink]]",\n      "props": []\n    }\n  ]\n}', ""),
                                 (0, '{\n  "links": [\n    {\n      "target": "X",\n      "props": []\n    }\n  ]\n}', ""))
        plain = self.command(2, "tree", ["tree", "f"], (0, "one", ""), (0, "two", ""))
        r = self.pair(commands=[explained])
        self.assertEqual([k for _, k in r.claims], ["H1"])
        self.assertEqual(r.unexpected, 0)
        r = self.pair(commands=[explained, plain])
        self.assertEqual([d.command for d, _ in r.findings], ["002-tree"])
        self.assertEqual(r.seen.get("H1"), 1)

    def test_a_refused_command_leaves_nothing_behind_in_the_dump_and_in_the_counts_after_it(self):
        ref = self.base()
        ref["BlockNode.jsonld"].append(doc("00CCCCCCCCCCC", title="00CCCCCCCCCCC", text="text", type="paragraph"))
        refused = self.command(3, "insert", ["insert", "f/a.md/A", "--after", "BlockNode:00ZZZZZZZZZZZ"], (1, "", "[aperas] Failed: no anchor\n"), (1, "", "[aperas] Failed: no anchor\n"))
        scanned = lambda n: "[ApeironNgn check-links] Scanned %d live blocks (0 with internal link text).\n" % n
        count = lambda i, a, b: self.command(i, "check-links", ["check-links"], (0, scanned(a), ""), (0, scanned(b), ""))
        r = self.pair(ref=ref, commands=[count(2, 100, 100), refused, count(4, 101, 100)])
        self.assertEqual(r.unexpected, 0, [d.describe() for d, _ in r.findings])
        self.assertEqual(r.seen.get(31), 2)   # the block, and the count after the command
        # a count one higher before the refusal, or two higher after it, is a finding
        r = self.pair(ref=ref, commands=[count(2, 101, 100), refused, count(4, 101, 100)])
        self.assertEqual([d.command for d, _ in r.findings], ["002-check-links"])
        r = self.pair(ref=ref, commands=[count(2, 100, 100), refused, count(4, 102, 100)])
        self.assertEqual([d.command for d, _ in r.findings], ["004-check-links"])

    def test_the_snapshot_names_the_tombstones_the_reference_still_lists(self):
        # the snapshot holds a tombstone of a block; the reference's dump keeps it, the new side's has pruned it; `tree` lists it as not found in the reference only
        ghost = doc("00TTTTTTTTTTT", title="gone", type="listItem", tombstonedAt="2026-10-01T00:00:00.000Z", parent="BlockNode:00AAAAAAAAAAA")
        files = self.base()
        files["BlockNode.jsonld"].append(ghost)
        write_dump(os.path.join(self.snap, "Apeiron"), files)
        tree_ref = "FolderNode:00FFFFFFFFFFA  [FolderNode]  f\n│ BlockNode:00AAAAAAAAAAA  [heading]  # A\n│ │ BlockNode:00TTTTTTTTTTT  [?]  <not found>\n"
        tree_new = "FolderNode:00FFFFFFFFFFA  [FolderNode]  f\n│ BlockNode:00AAAAAAAAAAA  [heading]  # A\n"
        cmd = self.command(1, "tree", ["tree", "f"], (0, tree_ref, ""), (0, tree_new, ""))
        r = self.pair(ref=files, commands=[cmd])
        self.assertEqual([k for d, k in r.claims if d.scope == "output"], ["H9"], [d.describe() for d, _ in r.findings])
        # a block of the same shape that the snapshot did not hold as a tombstone is a finding
        other = self.command(1, "tree", ["tree", "f"], (0, tree_ref.replace("00TTTTTTTTTTT", "00SSSSSSSSSSS"), ""), (0, tree_new, ""))
        r = self.pair(ref=files, commands=[other])
        self.assertEqual([d.command for d, _ in r.findings if d.scope == "output"], ["001-tree"])

    def test_the_logs_are_compared_and_an_unknown_line_is_a_finding(self):
        T = "2026-10-22T17:24:18.177Z [ApeironNgn service] "
        r = self.pair(logs=(T + "Rehydrated 1 quad(s) from /r.\n", T + "Loaded 1 record(s) from /n.\n"))
        self.assertEqual(r.unexpected, 0)
        self.assertEqual(r.seen.get(9), 2)
        r = self.pair(logs=("", T + "Surprise\n"))
        self.assertEqual(r.unexpected, 1)

    def test_a_container_that_a_removal_emptied_is_found_from_the_dumps_and_not_when_a_command_removed_it(self):
        ref, new = self.base(), self.base()
        ref["BlockNode.jsonld"].append(doc("00WWWWWWWWWWW", type="listItem", title="00WWWWWWWWWWW", parent="BlockNode:00AAAAAAAAAAA"))
        new["BlockNode.jsonld"].append(doc("00WWWWWWWWWWW", type="listItem", title="00WWWWWWWWWWW", tombstonedAt="2026-10-22T17:24:18.177Z"))
        tree_ref = "FolderNode:00FFFFFFFFFFA  [FolderNode]  f\n│ BlockNode:00WWWWWWWWWWW  [listItem]  00WWWWWWWWWWW\n│ BlockNode:00AAAAAAAAAAA  [heading]  # A\n"
        tree_new = "FolderNode:00FFFFFFFFFFA  [FolderNode]  f\n│ BlockNode:00AAAAAAAAAAA  [heading]  # A\n"
        cmd = self.command(1, "tree", ["tree", "f"], (0, tree_ref, ""), (0, tree_new, ""))
        r = self.pair(ref=ref, new=new, commands=[cmd])
        self.assertEqual([k for d, k in r.claims if d.scope == "output"], [3], [d.describe() for d, _ in r.findings])
        removal = self.command(0, "remove", ["remove", "BlockNode:00WWWWWWWWWWW"], (0, "", ""), (0, "", ""))
        r = self.pair(ref=ref, new=new, commands=[removal, cmd])
        self.assertEqual([k for d, k in r.claims if d.scope == "output"], [])
        self.assertTrue([d for d, _ in r.findings if d.scope == "output"])


# Each mutation makes one rule of `explain.py` wrong or loose; the module must fail on a copy of this directory with the mutation applied.
MUTATIONS = [
    ("the predicate is dropped from the new side too", 'new["stdout"] = json.dumps(b, indent=2, ensure_ascii=False)\n            return ["H1"]', 'new["stdout"] = json.dumps(drop_key(b, "target"), indent=2, ensure_ascii=False)\n            return ["H1"]'),
    ("the type of any node is dropped, not an artifact's", """if '"@type": "ArtifactNode"' not in t:""", "if False:"),
    ("a path message is accepted whatever it says", 'if "toPath is not a function" in a and', "if True and"),
    ("the ghost line is dropped whatever it holds", """l.strip() != "[FolderNode] 'undefined'\"""", """l.strip() != "x\""""),
    ("any tombstoned line is dropped, even when the new side shows it", 'if "(tombstoned)" in line and line not in have:', 'if "(tombstoned)" in line:'),
    ("a line is taken for an emptied container whatever the context says", "if line not in have and m and ctx.is_emptied(m.group(1)):", "if line not in have and m:"),
    ("a count of live blocks is accepted whatever the difference", "== len(ctx.emptied_ids()) > 0", "> 0"),
    ("a reload's counts are accepted without the new side's words", 'mb = re.search(r"Reloaded \\d+ record\\(s\\), \\d+ document\\(s\\)\\.", b)', 'mb = re.search(r"Reloaded", b)'),
    ("a move is explained whatever the new side says", 'if re.search(r"cannot be moved into its own subtree", new["stderr"]) and', "if True and"),
    ("the order of any listing is absorbed, with a different content", "if (a != ref[\"stdout\"] or b != new[\"stdout\"]) and a == b:\n                ref[\"stdout\"], new[\"stdout\"] = a, b\n                applied.append(15)\n        if v == \"check-links\"", "if True:\n                ref[\"stdout\"], new[\"stdout\"] = a, a\n                applied.append(15)\n        if v == \"check-links\""),
    ("a log line of the other side is accepted", 'if s in (side, "both") and re.match(rx, line)', "if re.match(rx, line)"),
    ("a run of U+FFFD of any length is a cut character", "return all(2 <= len(r) <= 4 and len(c.encode(\"utf-8\")) >= len(r) for r, c in zip(runs, m.groups()))", "return all(len(c.encode(\"utf-8\")) >= 1 for r, c in zip(runs, m.groups()))"),
    ("a cut character may have fewer bytes than the run", "len(c.encode(\"utf-8\")) >= len(r) for r, c in zip(runs, m.groups())", "True for r, c in zip(runs, m.groups())"),
    ("any README path is dropped, not the six", "if m and m.group(1) in paths and line not in new_has:", "if m and line not in new_has:"),
    ("a count of live blocks is made the new side's whatever the gap", "ma.group(1) + str(gap - p + int(mb.group(2))) + ma.group(3)", "ma.group(1) + mb.group(2) + ma.group(3)"),
    ("the removed count of `track` is accepted whatever the gap", "if ma and mb and int(ma.group(2)) - int(mb.group(2)) == dropped:", "if ma and mb:"),
    ("a missing node is dropped whatever the snapshot says", "if m and gone(m.group(1)) and line not in have:", "if m and line not in have:"),
    ("a tombstoned artifact is dropped even when the new side holds it", "and gone(facts.tombstoned_artifacts[m.group(1)]) and line not in have:", "and line not in have:"),
    ("the unfold counts are accepted when the gap is larger than the tombstones", "if k and int(m.group(3)) - int(n.group(3)) == k:", "if k and int(m.group(3)) - int(n.group(3)) >= k:"),
    ("the removed blocks are accepted whatever the totals", "if not k or total_r - total_n != k:", "if not k:"),
    ("the sample of the reference is not compared", "if any(it not in nitems for it in rest):", "if False:"),
    ("the links changed are accepted without an upper bound", "0 <= int(m.group(11)) - int(n.group(11)) <= hosted", "0 <= int(m.group(11)) - int(n.group(11))"),
    ("a link of the content graph is taken for a thread's", 'return facts.graph_of(host) == "state" and target in facts.tomb', "return target in facts.tomb"),
    ("a target the new side holds is taken for a pruned one", 'and facts.graph_of(target) == "mirror" and not ctx.new_has(target)', 'and facts.graph_of(target) == "mirror"'),
    ("the count of the warning is not checked against its list", "if removed and removed <= int(m.group(2)) and i - idx - 1 == 3 * int(m.group(2)):", "if removed and removed <= int(m.group(2)):"),
    ("the give-up is any message that says not ready", 'if not (ref["status"] == 1 and ref["stderr"].strip() == NOT_READY and new["status"] == 0 and new["stderr"] == ""):', 'if not (ref["status"] == 1 and "not become ready" in ref["stderr"] and new["status"] == 0 and new["stderr"] == ""):'),
    ("the rest of a start is not compared", 'if join(rest).rstrip("\\n") != ref["stdout"].rstrip("\\n"):', "if False:"),
    ("any failure of the reference is a give-up before a refusal", '(ref["status"] == 0 or gave_up) and failed', "True and failed"),
    ("the re-resolved artifacts are accepted whatever they are", 'and sorted(ma.group(2).split(", ")) == sorted(mb.group(2).split(", ")):', ":"),
    ("the refused documents are not told from the repeated id", "def m_repeated_id_rejected(d, c):", "def m_repeated_id_rejected(d, c):\n    return d.scope == 'doc' and d.op == 'only-ref'\n\n\ndef _unused(d, c):"),
    ("any only-ref block is a leftover of a refusal", 'd.kind == "BlockNode" and d.id in c.leftovers()', 'd.kind == "BlockNode"'),
    ("a count is accepted whatever the gap beyond the leftovers", "if gap - k in {0, e, p, p + e}:", "if gap >= k:"),
    ("the leftovers of a refusal after this command are counted", "k = ctx.leftovers_before(self.index)", "k = ctx.leftovers_before(None)"),
    ("the count of any verb is rewritten", 'if ctx is None or verb_of(argv) != "check-links" or not hasattr(ctx, "leftovers_before"):', 'if ctx is None or not hasattr(ctx, "leftovers_before"):'),
    ("the count of the JSON form is not rewritten", """for pat in (r"(Scanned )(\\d+)( live blocks)", r'("totalLiveBlocks": )(\\d+)()'):""", """for pat in (r"(Scanned )(\\d+)( live blocks)",):"""),
]

# Each mutation makes the matcher of entry 31 in `compare.py` wrong or loose; the module must fail on a copy of this directory with it applied.
COMPARE_MUTATIONS = [
    ("a tombstone is a leftover", 'd.kind == "BlockNode" and d.live() and', 'd.kind == "BlockNode" and'),
    ("a block with a parent is a leftover", '"parent" not in d.fields and cid not in listed', "cid not in listed"),
    ("a block that a container lists is a leftover", "and cid not in listed and", "and"),
    ("a block that both sides hold is a leftover", "and cid not in self.new\n", "\n"),
    ("a block of the snapshot is a leftover", "and token_of(d.raw_id) not in self.snapshot]", "]"),
    ("the leftovers are not as few as the refused commands", "self._leftovers = found[:len(self.refused)]", "self._leftovers = found"),
    ("the leftovers are not in the order of their tokens", "found.sort(key=lambda cid: token_of(self.ref[cid].raw_id))", "pass"),
    ("a refusal that succeeded is a refusal", 'or r["status"] in (0, None) or', "or"),
    ("a refusal with a status of its own is the same refusal", ' or r["status"] != n["status"]:', ":"),
    ("a refusal with another text is the same refusal", "if rt.strip() and rt == nt:", "if rt.strip():"),
    ("a command that makes no block can leave one", "argv[0] not in BLOCK_MAKERS or ", ""),
    ("the leftovers of a later refusal are counted by a command", "len([i for i in self.refused if i < index])", "len(self.refused)"),
]


class Mutations(unittest.TestCase):
    def test_each_mutation_fails_this_module(self):
        failed = []
        for target, name, old, new in [("explain.py",) + m for m in MUTATIONS] + [("compare.py",) + m for m in COMPARE_MUTATIONS]:
            with open(os.path.join(HERE, target), encoding="utf-8") as h:
                source = h.read()
            self.assertIn(old, source, "the mutation %r does not apply: %r" % (name, old))
            tmp = tempfile.mkdtemp(prefix="dmut-")
            try:
                for f in ("explain.py", "compare.py", "test_explain.py"):
                    shutil.copy(os.path.join(HERE, f), tmp)
                shutil.copy(os.path.join(HERE, "migrate-mirror.py") if os.path.exists(os.path.join(HERE, "migrate-mirror.py")) else os.path.join(os.path.dirname(HERE), "migrate-mirror.py"), tmp)
                with open(os.path.join(tmp, target), "w", encoding="utf-8") as h:
                    h.write(source.replace(old, new, 1))
                r = subprocess.run([sys.executable, "-W", "error", "-m", "unittest", "test_explain.Rules", "test_explain.Logs", "test_explain.Dumps", "test_explain.Compare"], cwd=tmp, capture_output=True, text=True, stdin=subprocess.DEVNULL, timeout=120)
                if r.returncode != 0:
                    failed.append(name)
            finally:
                shutil.rmtree(tmp, True)
        self.assertEqual(sorted(failed), sorted(n for n, _, _ in MUTATIONS + COMPARE_MUTATIONS), "mutations that no case caught: %s" % sorted(set(n for n, _, _ in MUTATIONS + COMPARE_MUTATIONS) - set(failed)))


if __name__ == "__main__":
    unittest.main()
