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

    def __init__(self, emptied=(), dead=(), rejected=None):
        self._emptied, self._dead, self.rejected = set(emptied), set(dead), rejected or {}

    def emptied_ids(self):
        return self._emptied

    def is_emptied(self, cid):
        return cid in self._emptied

    def is_dead_in_ref(self, cid):
        return cid in self._dead


def run(argv, ref, new, ctx=None):
    claims, r, n = explain.explain(argv, ref, new, ctx)
    return claims, r, n


class Rules(unittest.TestCase):
    def assertExplained(self, argv, ref, new, claims, ctx=None):
        got, r, n = run(argv, ref, new, ctx)
        self.assertEqual(sorted(map(str, got)), sorted(map(str, claims)))
        self.assertEqual(r, n, "the outputs are not equal after the rules")

    def assertLeft(self, argv, ref, new, ctx=None):
        got, r, n = run(argv, ref, new, ctx)
        self.assertNotEqual(r, n, "the outputs became equal: a plain difference was absorbed (claims %s)" % got)

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
        for verb, key in (("link", "H10"), ("unlink", "H10"), ("migrate-frontmatter", "P1")):
            self.assertExplained([verb, "x"], out(stdout="[aperas %s] done" % verb), out(1, "Usage: ...", "[aperas] Unknown command '%s'.\n" % verb), [key])
        ref = "Verbs:\n  backlinks            List\n  link                 Prompt\n  migrate-frontmatter  One\n  path                 Resolve\n  unlink               Remove\n"
        new = "Verbs:\n  backlinks    List\n  path         Resolve\n"
        self.assertExplained(["--help"], out(stdout=ref), out(stdout=new), ["H10", "H10", "P1"])
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
    ("the refused documents are not told from the repeated id", "def m_repeated_id_rejected(d, c):", "def m_repeated_id_rejected(d, c):\n    return d.scope == 'doc' and d.op == 'only-ref'\n\n\ndef _unused(d, c):"),
]


class Mutations(unittest.TestCase):
    def test_each_mutation_fails_this_module(self):
        with open(os.path.join(HERE, "explain.py"), encoding="utf-8") as h:
            source = h.read()
        failed = []
        for name, old, new in MUTATIONS:
            self.assertIn(old, source, "the mutation %r does not apply: %r" % (name, old))
            tmp = tempfile.mkdtemp(prefix="dmut-")
            try:
                for f in ("explain.py", "compare.py", "test_explain.py"):
                    shutil.copy(os.path.join(HERE, f), tmp)
                shutil.copy(os.path.join(HERE, "migrate-mirror.py") if os.path.exists(os.path.join(HERE, "migrate-mirror.py")) else os.path.join(os.path.dirname(HERE), "migrate-mirror.py"), tmp)
                with open(os.path.join(tmp, "explain.py"), "w", encoding="utf-8") as h:
                    h.write(source.replace(old, new, 1))
                r = subprocess.run([sys.executable, "-W", "error", "-m", "unittest", "test_explain.Rules", "test_explain.Logs", "test_explain.Dumps", "test_explain.Compare"], cwd=tmp, capture_output=True, text=True, stdin=subprocess.DEVNULL, timeout=120)
                if r.returncode != 0:
                    failed.append(name)
            finally:
                shutil.rmtree(tmp, True)
        self.assertEqual(sorted(failed), sorted(n for n, _, _ in MUTATIONS), "mutations that no case caught: %s" % sorted(set(n for n, _, _ in MUTATIONS) - set(failed)))


if __name__ == "__main__":
    unittest.main()
