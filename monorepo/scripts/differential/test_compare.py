#!/usr/bin/env python3
"""The tests of `compare.py` (Python 3, standard library): `python3 -m unittest -v test_compare` from this directory, or through the file named in the `commit` suite.

  Values      the comparison of two dumps as parsed values: the order of keys, of documents and of sets does not matter, `children` is a list, an empty set is an
              absent one, a minted id is mapped by order, and a changed literal, a missing child, an id swapped or a timestamp that is missing or not a time is caught
  Table       the table of matchers: 31 entries keyed 1 to 31 in the groups of Layer 4, the five a dump can show have a function, every other says why it is not seen by a dump
  Matchers    for each entry with a function, a minimal pair of dumps that only that entry claims (no finding), and near misses that no entry claims
  Facts       what the snapshot says about the six README documents, the tombstones (by artifact, by graph) and the unfolds that name one, for the matchers of the outputs
  Emptied     the containers a removal of the run left empty, without the tombstones the snapshot already held
  Outputs     the ids that only a command's stdout names are mapped by order, and the two ways of mapping must agree; times in an output are masked
  Migration   the reference's dump is migrated with `migrate-mirror.py` before the comparison, so the migration's own changes are not differences
  Cli         the exit status (0, 1, 2), the table, `--json`, and `--run` on a run directory

Only scratch directories are used; no service is started.
"""
import copy
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import compare  # noqa: E402

COMPARE = os.path.join(HERE, "compare.py")


KINDS = ["BlockNode", "ArtifactNode", "FolderNode", "Profile", "TreeView", "Link", "StringProp"]


def tid(prefix, n):
    """A token of 13 characters: five of a prefix and eight digits."""
    return "%s%08d" % (prefix, n)


def mk(prefix, kind, n):
    """An id whose token no other kind shares (the tokens of a graph are unique)."""
    return "%s:%s" % (kind, tid(prefix, n + 1000 * KINDS.index(kind)))


def S(kind, n):
    """An id of the snapshot (the same on both sides)."""
    return mk("00D8S", kind, n)


def R(kind, n):
    return mk("00D8R", kind, n)


def N(kind, n):
    return mk("00D8N", kind, n)


def block(i, parent, title, type_="paragraph", text=None, children=None, **more):
    d = {"@id": i, "@type": "BlockNode", "title": title}
    if text is not None:
        d["text"] = text
    d.update({"parent": parent, "type": type_, "children": children if children is not None else []})
    d.update(more)
    return d


def base():
    """The snapshot: a folder, an artifact, a heading with a paragraph and a list of two items, a profile and a view. In the form of the new engine."""
    H, P, L, I1, I2 = S("BlockNode", 1), S("BlockNode", 2), S("BlockNode", 3), S("BlockNode", 4), S("BlockNode", 5)
    A, F = S("ArtifactNode", 1), S("FolderNode", 1)
    return {
        "BlockNode.jsonld": [
            block(H, A, "# Head", "heading", "Intro.", [P, L]),
            block(P, H, "A paragraph", text="Paragraph text."),
            block(L, H, "- list", "list", children=[I1, I2]),
            block(I1, L, "- one", "listItem", children=[]),
            block(I2, L, "- two", "listItem", "Two.", []),
        ],
        "ArtifactNode.jsonld": [{"@id": A, "@type": "ArtifactNode", "title": "a.md", "text": "Intro.", "parent": F, "children": [H], "path": "d/a.md",
                                 "fileHash": "h1", "lastTrackedAt": "2026-10-20T10:00:00.000Z", "ingestedHash": "h1", "lastIngestedAt": "2026-10-20T10:00:01.000Z"}],
        "FolderNode.jsonld": [{"@id": F, "@type": "FolderNode", "title": "d", "path": "d", "children": [A]}],
        "Profile.jsonld": [{"@id": "Profile:00CJC4S69R000", "@type": "Profile", "handle": "dinhlx", "name": "Dinh Le", "kind": "human"},
                           {"@id": S("Profile", 1), "@type": "Profile", "handle": "default"}],
        ".state/TreeView.jsonld": [{"@id": S("TreeView", 1), "@type": "TreeView", "profile": S("Profile", 1), "name": "default", "unfolds": [A, H], "root": F}],
    }


IDS = {"H": S("BlockNode", 1), "P": S("BlockNode", 2), "L": S("BlockNode", 3), "I1": S("BlockNode", 4), "I2": S("BlockNode", 5), "A": S("ArtifactNode", 1), "F": S("FolderNode", 1),
       "V": S("TreeView", 1)}


def find(files, i):
    for docs in files.values():
        for d in docs:
            if d["@id"] == i:
                return d
    raise KeyError(i)


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


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="dcmp-")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.n = 0
        self.snap = os.path.join(self.tmp, "snap")
        os.makedirs(self.snap)
        write_dump(os.path.join(self.snap, "Apeiron"), base())

    def dump(self, files, extras=None):
        self.n += 1
        d = os.path.join(self.tmp, "d%d" % self.n)
        os.makedirs(d)
        write_dump(d, files, extras)
        return d

    def run_pair(self, edit_ref=None, edit_new=None, extras_ref=None, extras_new=None, commands=None, migrate=False, ref_files=None, new_files=None):
        ref, new = (copy.deepcopy(ref_files or base()), copy.deepcopy(new_files or base()))
        if edit_ref:
            edit_ref(ref)
        if edit_new:
            edit_new(new)
        return compare.compare_dumps(self.dump(ref, extras_ref), self.dump(new, extras_new), snapshot=self.snap, commands=commands, migrate=migrate)

    def clean(self, result):
        self.assertEqual([d.describe() for d, _ in result.findings], [], "findings")
        self.assertEqual(result.problems, [])
        self.assertEqual(result.unexpected, 0)

    def caught(self, result, n=1):
        self.assertEqual(len(result.findings), n, [d.describe() for d, _ in result.findings])
        self.assertEqual(result.seen, {})

    def only(self, result, key):
        self.assertEqual([d.describe() + " :: " + why for d, why in result.findings], [], "findings")
        self.assertEqual(set(result.seen), {key}, result.seen)


class Values(Base):
    def test_identical_dumps_have_no_difference(self):
        r = self.run_pair()
        self.clean(r)
        self.assertEqual(r.diffs, [])
        self.assertEqual(r.seen, {})

    def test_the_order_of_keys_documents_and_sets_does_not_matter(self):
        def reorder(files):
            for docs in files.values():
                docs.reverse()
                for i, d in enumerate(docs):
                    docs[i] = dict(reversed(list(d.items())))
            find(files, IDS["V"])["unfolds"].reverse()
            p = find(files, IDS["P"])
            p["links"] = [{"@id": "%s:links:Link:%s" % (IDS["P"], tid("00D8E", i)), "@type": "Link", "target": IDS["H"] if i == 1 else IDS["L"],
                           "props": [{"@id": "%s:links:Link:%s:props:StringProp:%s" % (IDS["P"], tid("00D8E", i), tid("00D8E", 10 + i)), "@type": "StringProp", "key": "position", "value": str(i)}]} for i in (1, 2)]
        base_with_links = base()
        reorder(base_with_links)
        # the snapshot must hold the links too, so that their ids are the same on both sides
        shutil.rmtree(os.path.join(self.snap, "Apeiron"))
        write_dump(os.path.join(self.snap, "Apeiron"), base_with_links)
        ref = copy.deepcopy(base_with_links)
        new = copy.deepcopy(base_with_links)
        find(new, IDS["P"])["links"].reverse()
        find(new, IDS["V"])["unfolds"].reverse()
        new["BlockNode.jsonld"].reverse()
        r = compare.compare_dumps(self.dump(ref), self.dump(new), snapshot=self.snap, migrate=False)
        self.clean(r)

    def test_an_empty_set_or_list_is_an_absent_one(self):
        def drop(files):
            del find(files, IDS["I1"])["children"]
        self.clean(self.run_pair(edit_new=drop))

    def test_minted_ids_are_mapped_by_order_of_container_and_place(self):
        def add(prefix, pre):
            def go(files):
                H = find(files, IDS["H"])
                a, b = pre("BlockNode", 1), pre("BlockNode", 2)
                files["BlockNode.jsonld"] += [block(a, IDS["H"], "New one", text="x"), block(b, IDS["H"], "New two", text="y", children=[])]
                H["children"] = H["children"] + [a, b]
                lk = pre("ArtifactNode", 1)
                files["ArtifactNode.jsonld"].append({"@id": lk, "@type": "ArtifactNode", "title": "b.md", "parent": IDS["F"], "children": [], "path": "d/b.md",
                                                     "lastTrackedAt": "2026-10-22T11:11:11.111Z"})
                find(files, IDS["F"])["children"].append(lk)
                find(files, IDS["P"])["links"] = [{"@id": "%s:links:Link:%s" % (IDS["P"], pre("Link", 1).split(":")[1]), "@type": "Link", "target": a,
                                                   "props": [{"@id": "%s:links:Link:%s:props:StringProp:%s" % (IDS["P"], pre("Link", 1).split(":")[1], pre("StringProp", 1).split(":")[1]),
                                                              "@type": "StringProp", "key": "position", "value": "3"}]}]
            return go
        r = self.run_pair(edit_ref=add("r", R), edit_new=add("n", N))
        self.clean(r)
        self.assertEqual(r.counts["paired minted documents"], 3)

    def test_a_changed_literal_is_caught(self):
        def edit(files):
            find(files, IDS["P"])["text"] = "Paragraph text!"
        r = self.run_pair(edit_new=edit)
        self.caught(r)
        d = r.findings[0][0]
        self.assertEqual((d.scope, d.op, d.field, d.id), ("field", "changed", "text", IDS["P"]))

    def test_a_literal_of_another_type_is_caught(self):
        def with_value(v):
            def edit(files):
                find(files, IDS["P"])["rank"] = v
            return edit
        self.caught(self.run_pair(edit_ref=with_value(1), edit_new=with_value(True)))
        self.caught(self.run_pair(edit_ref=with_value(1), edit_new=with_value("1")))
        self.clean(self.run_pair(edit_ref=with_value(1), edit_new=with_value(1)))

    def test_a_missing_child_is_caught(self):
        def edit(files):
            find(files, IDS["H"])["children"].remove(IDS["P"])
        r = self.run_pair(edit_new=edit)
        self.caught(r)
        d = r.findings[0][0]
        self.assertEqual((d.scope, d.op, d.field, d.ref), ("element", "only-ref", "children", IDS["P"]))

    def test_the_order_of_the_children_is_a_difference(self):
        def edit(files):
            find(files, IDS["H"])["children"].reverse()
        r = self.run_pair(edit_new=edit)
        self.caught(r)
        self.assertEqual(r.findings[0][0].op, "reordered")

    def test_an_id_swapped_is_caught(self):
        def edit(files):
            find(files, IDS["H"])["children"][0] = IDS["I1"]
        r = self.run_pair(edit_new=edit)
        self.assertGreaterEqual(len(r.findings), 2)  # the child that left and the one that came
        self.assertEqual(r.seen, {})

        def edit_parent(files):
            find(files, IDS["P"])["parent"] = IDS["L"]
        self.caught(self.run_pair(edit_new=edit_parent))

    def test_two_minted_ids_swapped_are_caught(self):
        def add(pre, swap):
            def go(files):
                a, b = pre("BlockNode", 1), pre("BlockNode", 2)
                files["BlockNode.jsonld"] += [block(a, IDS["H"], "First", text="1"), block(b, IDS["H"], "Second", text="2")]
                find(files, IDS["H"])["children"] += [b, a] if swap else [a, b]
            return go
        r = self.run_pair(edit_ref=add(R, False), edit_new=add(N, True))
        self.assertGreaterEqual(len(r.findings), 1)
        self.assertEqual(r.seen, {})

    def test_an_extra_minted_node_is_caught(self):
        def edit(files):
            files["BlockNode.jsonld"].append(block(N("BlockNode", 1), IDS["H"], "Extra", text="e"))
            find(files, IDS["H"])["children"].append(N("BlockNode", 1))
        r = self.run_pair(edit_new=edit)
        self.assertEqual(sorted((d.scope, d.op) for d, _ in r.findings), [("doc", "only-new"), ("element", "only-new")])

    def test_a_timestamp_is_masked_and_a_missing_or_malformed_one_is_caught(self):
        def at(v):
            def edit(files):
                a = find(files, IDS["A"])
                if v is None:
                    del a["lastIngestedAt"]
                else:
                    a["lastIngestedAt"] = v
            return edit
        self.clean(self.run_pair(edit_ref=at("2026-10-22T01:02:03.004Z"), edit_new=at("2026-10-23T05:06:07Z")))
        r = self.run_pair(edit_new=at(None))
        self.caught(r)
        self.assertEqual((r.findings[0][0].op, r.findings[0][0].field), ("only-ref", "lastIngestedAt"))
        r = self.run_pair(edit_new=at("yesterday"))
        self.caught(r)
        self.assertEqual(r.findings[0][0].op, "changed")

    def test_the_stamps_of_a_view_are_masked(self):
        def stamp(v):
            def edit(files):
                find(files, IDS["V"])["lastUsedAt"] = v
            return edit
        self.clean(self.run_pair(edit_ref=stamp("2026-10-22T01:02:03.004Z"), edit_new=stamp("2026-10-23T05:06:07.000Z")))
        self.caught(self.run_pair(edit_new=stamp("2026-10-23T05:06:07.000Z")))

    def test_a_block_titled_by_its_own_id_is_the_same_block(self):
        def add(pre):
            def go(files):
                b = pre("BlockNode", 1)
                files["BlockNode.jsonld"].append(block(b, IDS["H"], b.split(":")[1], "listItem", b.split(":")[1]))
                find(files, IDS["H"])["children"].append(b)
            return go
        self.clean(self.run_pair(edit_ref=add(R), edit_new=add(N)))

    def test_a_file_with_no_document_is_no_file(self):
        def empty(files):
            files[".state/BlockNode.jsonld"] = []
        r = self.run_pair(edit_new=empty)
        self.clean(r)
        self.assertEqual(r.diffs, [])

    def test_a_file_only_one_side_holds_is_a_difference(self):
        r = self.run_pair(extras_new={"notes.txt": "x"})
        self.caught(r)
        self.assertEqual((r.findings[0][0].scope, r.findings[0][0].op), ("file", "only-new"))

    def test_a_dump_that_is_not_a_list_of_documents_fails(self):
        d = self.dump(base())
        with open(os.path.join(d, "BlockNode.jsonld"), "w", encoding="utf-8") as h:
            h.write('{"not": "a list"}')
        with self.assertRaises(compare.Failure):
            compare.compare_dumps(d, self.dump(base()), snapshot=self.snap, migrate=False)

    def test_the_same_id_defined_twice_is_a_problem(self):
        def dup(files):
            files["BlockNode.jsonld"].append(copy.deepcopy(find(files, IDS["P"])))
        r = self.run_pair(edit_new=dup)
        self.assertEqual(len(r.problems), 1)
        self.assertEqual(r.unexpected, 1)


class Table(unittest.TestCase):
    def test_the_31_entries_are_keyed_in_the_order_of_layer_4(self):
        self.assertEqual(sorted(compare.MATCHERS), list(range(1, 32)))
        groups = [m.group for _, m in sorted(compare.MATCHERS.items())]
        self.assertEqual([groups.count(g) for g in ("flip", "order", "ingest", "sweeps", "follow-up", "move", "refused")], [12, 7, 2, 7, 1, 1, 1])
        self.assertEqual(len({m.title for m in compare.MATCHERS.values()}), 31)
        for k, m in compare.MATCHERS.items():
            self.assertEqual(m.key, k)
            self.assertTrue(m.note, k)

    def test_five_entries_have_a_function_and_the_others_say_why_a_dump_cannot_show_them(self):
        by_dump = sorted(k for k, m in compare.MATCHERS.items() if m.by_dump)
        self.assertEqual(by_dump, [2, 3, 21, 23, 25])
        for k, m in compare.MATCHERS.items():
            if not m.by_dump:
                self.assertTrue(m.note.startswith("not seen by a dump"), (k, m.note))
            else:
                self.assertTrue(m.note.startswith("seen by a dump"), (k, m.note))

    def test_nothing_is_seen_on_identical_dumps(self):
        r = compare.Result()
        self.assertEqual(r.not_seen(), list(range(1, 32)))
        self.assertEqual(r.not_seen_by_a_dump(), [k for k in range(1, 32) if k not in (2, 3, 21, 23, 25)])


def tombstone(d):
    """An empty tombstone as the migration and the new engine write it: the literals stay, the tree and the links are gone."""
    for k in ("parent", "links", "props"):
        d.pop(k, None)
    d["children"] = []
    d["tombstonedAt"] = "2026-10-22T09:09:09.999Z"
    return d


class Matchers(Base):
    # ---- 2: a removed node is unreachable, so a sweep prunes it
    def removed_paragraph(self, ref_keeps_tombstone=True, new_keeps_tombstone=False, ref_live=False):
        def edit(keeps):
            def go(files):
                find(files, IDS["H"])["children"].remove(IDS["P"])
                if keeps:
                    tombstone(find(files, IDS["P"]))
                else:
                    files["BlockNode.jsonld"] = [d for d in files["BlockNode.jsonld"] if d["@id"] != IDS["P"]]
            return go
        return edit(ref_keeps_tombstone), edit(new_keeps_tombstone)

    def test_entry_2_claims_an_empty_tombstone_only_the_reference_holds(self):
        er, en = self.removed_paragraph()
        r = self.run_pair(edit_ref=er, edit_new=en)
        self.only(r, 2)
        self.assertEqual(r.seen[2], 1)

    def test_entry_2_does_not_claim_a_live_node_or_a_tombstone_that_is_not_empty_or_one_on_the_new_side(self):
        def gone(files):
            find(files, IDS["H"])["children"].remove(IDS["P"])
            files["BlockNode.jsonld"] = [d for d in files["BlockNode.jsonld"] if d["@id"] != IDS["P"]]
        # a live node that only the reference holds
        r = self.run_pair(edit_new=gone)
        self.assertEqual({d.scope for d, _ in r.findings}, {"doc", "element"})
        self.assertEqual(r.seen, {})

        # a tombstone that still has its parent
        def stale(files):
            find(files, IDS["P"])["tombstonedAt"] = "2026-10-22T09:09:09.999Z"
        r = self.run_pair(edit_ref=stale, edit_new=gone)
        self.assertGreaterEqual(len(r.findings), 1)
        self.assertEqual(r.seen, {})
        # an empty tombstone that only the new side holds
        er, en = self.removed_paragraph(ref_keeps_tombstone=False, new_keeps_tombstone=True)
        r = self.run_pair(edit_ref=er, edit_new=en)
        self.caught(r)
        self.assertEqual((r.findings[0][0].scope, r.findings[0][0].op), ("doc", "only-new"))

    def test_entry_2_claims_an_unfold_of_a_tombstone_the_new_side_pruned(self):
        er, en = self.removed_paragraph()

        def ref_unfolds(files):
            er(files)
            find(files, IDS["V"])["unfolds"].append(IDS["P"])
        r = self.run_pair(edit_ref=ref_unfolds, edit_new=en)
        self.only(r, 2)
        self.assertEqual(r.seen[2], 2)   # the tombstone and the unfold that names it

    def test_entry_2_does_not_claim_an_unfold_of_a_live_node_or_of_a_tombstone_the_new_side_keeps_or_of_nothing(self):
        # a live node: the unfold is only the reference's
        r = self.run_pair(edit_ref=lambda f: find(f, IDS["V"])["unfolds"].append(IDS["P"]))
        self.caught(r)
        # a tombstone that the new side holds as well
        er, en = self.removed_paragraph(new_keeps_tombstone=True)

        def ref_unfolds(files):
            er(files)
            find(files, IDS["V"])["unfolds"].append(IDS["P"])
        r = self.run_pair(edit_ref=ref_unfolds, edit_new=en)
        self.assertEqual([(d.scope, d.op) for d, _ in r.findings], [("element", "only-ref")])
        # an id that no node has
        r = self.run_pair(edit_ref=lambda f: find(f, IDS["V"])["unfolds"].append(S("BlockNode", 99)))
        self.caught(r)
        # the other direction: an unfold only the new side holds
        er, en = self.removed_paragraph()

        def new_unfolds(files):
            en(files)
            find(files, IDS["V"])["unfolds"].append(IDS["P"])
        r = self.run_pair(edit_ref=er, edit_new=new_unfolds)
        self.assertNotIn(2, [k for d, k in r.claims if d.scope == "element" and d.field == "unfolds"])

    # ---- 3: a removal tombstones the container it empties
    def emptied_list(self, new_prunes):
        def both(files):
            for i in ("I1", "I2"):
                tombstone(find(files, IDS[i]))
            find(files, IDS["L"])["children"] = []

        def en(files):
            both(files)
            find(files, IDS["H"])["children"].remove(IDS["L"])
            if new_prunes:
                files["BlockNode.jsonld"] = [d for d in files["BlockNode.jsonld"] if d["@id"] not in (IDS["L"],)]
            else:
                tombstone(find(files, IDS["L"]))
        return both, en

    def test_entry_3_claims_the_tombstone_of_an_emptied_list(self):
        er, en = self.emptied_list(False)
        r = self.run_pair(edit_ref=er, edit_new=en)
        self.only(r, 3)
        self.assertEqual(r.seen[3], 3)  # the tombstone marker, the parent, the place in the container's list

    def test_entry_3_claims_an_emptied_list_the_sweep_has_pruned(self):
        er, en = self.emptied_list(True)
        r = self.run_pair(edit_ref=er, edit_new=en)
        self.only(r, 3)
        self.assertEqual(r.seen[3], 2)  # the list itself, only in the reference, and its place in the container's list

    def test_entry_3_claims_an_emptied_textless_list_item_and_the_container_it_empties_in_turn(self):
        inner = S("BlockNode", 6)
        snap = base()
        tombstone(find(snap, IDS["I2"]))
        find(snap, IDS["L"])["children"] = [IDS["I1"]]
        find(snap, IDS["I1"])["children"] = [inner]
        snap["BlockNode.jsonld"].append(block(inner, IDS["I1"], "- inner", "list", children=[]))
        shutil.rmtree(os.path.join(self.snap, "Apeiron"))
        write_dump(os.path.join(self.snap, "Apeiron"), snap)

        def en(files):
            # the inner list was emptied earlier in the run; the new side tombstones it, then the textless item that held it, then the list that held the item
            for i in (inner, IDS["I1"], IDS["L"]):
                tombstone(find(files, i))
            find(files, IDS["H"])["children"].remove(IDS["L"])
        r = self.run_pair(edit_new=en, ref_files=snap, new_files=snap)
        self.only(r, 3)

    def test_entry_3_does_not_claim_what_is_not_an_emptied_container(self):
        # a paragraph tombstoned in the new side and live in the reference
        def en(files):
            find(files, IDS["H"])["children"].remove(IDS["P"])
            tombstone(find(files, IDS["P"]))
        r = self.run_pair(edit_new=en)
        self.assertGreaterEqual(len(r.findings), 1)
        self.assertEqual(r.seen, {})

        # a list item with text
        def en2(files):
            find(files, IDS["L"])["children"].remove(IDS["I2"])
            tombstone(find(files, IDS["I2"]))
        r = self.run_pair(edit_new=en2)
        self.assertEqual(r.seen, {})
        self.assertGreaterEqual(len(r.findings), 1)

        # a list that still has a live child in the new side
        def en3(files):
            find(files, IDS["H"])["children"].remove(IDS["L"])
            tombstone(find(files, IDS["L"]))
        r = self.run_pair(edit_new=en3)
        self.assertEqual(r.seen, {})
        self.assertGreaterEqual(len(r.findings), 1)

        # a list tombstoned in the reference and live in the new side
        er, en4 = self.emptied_list(False)
        r = self.run_pair(edit_ref=en4, edit_new=er)
        self.assertEqual(r.seen, {})
        self.assertGreaterEqual(len(r.findings), 1)

    # ---- 21: positionsEqual compares two sorted lists
    def position_links(self, minted_in):
        def go(files, pre):
            lk = "%s:links:Link:%s" % (IDS["P"], tid("00D8S", 40))
            props = []
            for k, v in ((41, "3"), (42, "7")):
                pid = tid("00D8S", k) if pre is None else tid(pre, k)
                props.append({"@id": "%s:props:StringProp:%s" % (lk, pid), "@type": "StringProp", "key": "position", "value": v})
            find(files, IDS["P"])["links"] = [{"@id": lk, "@type": "Link", "target": IDS["H"], "props": props}]
        snap = base()
        go(snap, None)
        shutil.rmtree(os.path.join(self.snap, "Apeiron"))
        write_dump(os.path.join(self.snap, "Apeiron"), snap)
        return snap, (lambda f: go(f, "00D8R") if minted_in == "ref" else None), (lambda f: go(f, "00D8N") if minted_in == "new" else None)

    def test_entry_21_claims_prop_ids_minted_again_by_the_reference(self):
        snap, er, en = self.position_links("ref")
        r = self.run_pair(edit_ref=er, edit_new=en, ref_files=snap, new_files=snap)
        self.only(r, 21)
        self.assertEqual(r.seen[21], 2)

    def test_entry_21_does_not_claim_the_other_direction_another_key_or_two_ids_swapped(self):
        snap, er, en = self.position_links("new")
        r = self.run_pair(edit_ref=er, edit_new=en, ref_files=snap, new_files=snap)
        self.caught(r, 2)
        snap, er, en = self.position_links("ref")

        def other_key(files):
            er(files)
            for p in find(files, IDS["P"])["links"][0]["props"]:
                p["key"] = "offset"
        r = self.run_pair(edit_ref=other_key, edit_new=lambda f: [p.update(key="offset") for p in find(f, IDS["P"])["links"][0]["props"]], ref_files=snap, new_files=snap)
        self.assertEqual(r.seen, {})
        self.assertEqual(len(r.findings), 2)

        def swap(files):
            ps = find(files, IDS["P"])["links"][0]["props"]
            a, b = ps[0]["@id"], ps[1]["@id"]
            ps[0]["@id"], ps[1]["@id"] = b, a
            ps[0]["value"], ps[1]["value"] = "3", "7"
        # the same content under swapped snapshot ids is two props with the ids of each other: equal as a set of (id, content)? it is not: ids are compared
        r = self.run_pair(edit_new=swap, ref_files=snap, new_files=snap)
        self.assertEqual(r.seen, {})
        self.assertEqual(len(r.findings), 2)

    # ---- 23: a stale unfold is no longer swept
    def test_entry_23_claims_an_unfold_of_an_id_no_node_has(self):
        def en(files):
            find(files, IDS["V"])["unfolds"].append(S("BlockNode", 99))
        r = self.run_pair(edit_new=en)
        self.only(r, 23)
        self.assertEqual(r.seen[23], 1)

    def test_entry_23_does_not_claim_an_unfold_of_a_node_or_one_the_reference_holds(self):
        def en(files):
            find(files, IDS["V"])["unfolds"].append(IDS["P"])
        r = self.run_pair(edit_new=en)
        self.caught(r)
        r = self.run_pair(edit_ref=lambda f: find(f, IDS["V"])["unfolds"].append(S("BlockNode", 99)))
        self.caught(r)
        self.assertEqual(r.findings[0][0].op, "only-ref")

        # an id no node has, but the reference holds it as well: both sides keep it, so nothing differs
        def both(files):
            find(files, IDS["V"])["unfolds"].append(S("BlockNode", 99))
        self.clean(self.run_pair(edit_ref=both, edit_new=both))

    # ---- 25: the side copy of a rejected load
    def test_entry_25_claims_a_rejected_copy_next_to_its_file(self):
        r = self.run_pair(extras_new={"BlockNode.jsonld.rejected-20261022T152100Z.json": "[]", ".state/TreeView.jsonld.rejected-20261022T152101Z.json": "[]"})
        self.only(r, 25)
        self.assertEqual(r.seen[25], 2)

    def test_entry_25_does_not_claim_other_files_or_a_copy_only_the_reference_holds(self):
        r = self.run_pair(extras_new={"BlockNode.jsonld.rejected-20261022.json": "[]"})
        self.caught(r)
        r = self.run_pair(extras_new={"notes.json": "[]"})
        self.caught(r)
        r = self.run_pair(extras_ref={"BlockNode.jsonld.rejected-20261022T152100Z.json": "[]"})
        self.caught(r)

    def test_a_deliberate_difference_is_claimed_by_its_own_entry_and_a_plain_one_by_none(self):
        # one pair with an entry 23 difference and a plain difference: the first is claimed (by 23 only), the second is a finding
        def en(files):
            find(files, IDS["V"])["unfolds"].append(S("BlockNode", 99))
            find(files, IDS["P"])["text"] = "other"
        r = self.run_pair(edit_new=en)
        self.assertEqual(r.seen, {23: 1})
        self.assertEqual(len(r.findings), 1)
        self.assertEqual(r.findings[0][0].field, "text")

    def test_the_entries_are_exclusive(self):
        # a difference that two entries would claim is a finding that names them
        saved = compare.MATCHERS[23].fn
        compare.MATCHERS[23].fn = lambda d, c: compare.m_stale_unfold(d, c) or (d.scope == "element" and d.field == "unfolds")
        compare.MATCHERS[2].fn = lambda d, c: d.scope == "element" and d.field == "unfolds"
        try:
            def en(files):
                find(files, IDS["V"])["unfolds"].append(S("BlockNode", 99))
            r = self.run_pair(edit_new=en)
            self.assertEqual(len(r.findings), 1)
            self.assertIn("more than one entry: 2, 23", r.findings[0][1])
            self.assertEqual(r.seen, {})
        finally:
            compare.MATCHERS[23].fn = saved
            compare.MATCHERS[2].fn = compare.m_pruned_tombstone


def command(index, name, ref_out, new_out, ref_status=0, new_status=0, ref_err="", new_err=""):
    return {"index": index, "name": name, "argv": [name], "ref": {"status": ref_status, "timedOut": False, "stdout": ref_out, "stderr": ref_err},
            "new": {"status": new_status, "timedOut": False, "stdout": new_out, "stderr": new_err}}


class FactsOfTheSnapshot(unittest.TestCase):
    """`Facts`: what the matchers of the outputs read from the mirror the run started from."""

    def files(self):
        A, T, F = "ArtifactNode:00D8A0000000A", "ArtifactNode:00D8A0000000B", "FolderNode:00D8F0000000F"
        return {
            "BlockNode.jsonld": [
                {"@id": "BlockNode:00D8B0000000A", "@type": "BlockNode", "title": "# H", "type": "heading", "parent": A, "children": ["BlockNode:00D8B0000000B"]},
                {"@id": "BlockNode:00D8B0000000B", "@type": "BlockNode", "title": "gone", "type": "listItem", "tombstonedAt": "2026-10-01T00:00:00.000Z", "parent": "BlockNode:00D8B0000000A", "children": [],
                 "links": [{"@id": "BlockNode:00D8B0000000B:links:Link:00D8L0000000A", "@type": "Link", "target": "BlockNode:00D8B0000000A"}]},
                {"@id": "BlockNode:00CN1QEAGG001", "@type": "BlockNode", "title": "readme", "type": "paragraph", "parent": "ArtifactNode:00CN1QE950000"},
                {"@id": "BlockNode:00CN4ZQAPG001", "@type": "BlockNode", "title": "readme", "type": "paragraph", "tombstonedAt": "2026-10-01T00:00:00.000Z"},
            ],
            "ArtifactNode.jsonld": [{"@id": A, "@type": "ArtifactNode", "title": "a.md", "path": "d/a.md", "parent": F, "children": ["BlockNode:00D8B0000000A"]},
                                    {"@id": T, "@type": "ArtifactNode", "title": "t.md", "path": "d/t.md", "tombstonedAt": "2026-10-01T00:00:00.000Z"},
                                    {"@id": "ArtifactNode:00CN1QE950000", "@type": "ArtifactNode", "title": "README.md", "path": "README.md", "parent": F}],
            ".state/BlockNode.jsonld": [{"@id": "BlockNode:00D8T0000000A", "@type": "BlockNode", "title": "t", "type": "paragraph"}],
            ".state/TreeView.jsonld": [{"@id": "TreeView:00D8V0000000A", "@type": "TreeView", "unfolds": ["BlockNode:00D8B0000000B", "BlockNode:00D8B0000000A", "BlockNode:00D8Z0000000Z"]}],
        }

    def test_the_tombstones_by_artifact_and_the_links_they_hosted(self):
        f = compare.Facts(self.files())
        self.assertEqual(f.tomb, {"BlockNode:00D8B0000000B", "ArtifactNode:00D8A0000000B", "BlockNode:00CN4ZQAPG001"})
        self.assertEqual(f.tomb_blocks("d/a.md"), [("BlockNode:00D8B0000000B", "listItem", "gone")])
        self.assertEqual(f.tomb_links("d/a.md"), 1)
        self.assertEqual((f.tomb_blocks("d/none.md"), f.tomb_links("d/none.md")), ([], 0))
        self.assertEqual(f.tombstoned_artifacts, {"d/t.md": "ArtifactNode:00D8A0000000B"})

    def test_the_readme_documents_the_graph_of_a_node_and_the_unfolds_that_name_a_tombstone(self):
        f = compare.Facts(self.files())
        self.assertEqual(f.readme_paths, ["README.md"])
        self.assertEqual(f.readme_paragraphs, 1)   # the tombstoned paragraph is not a live block
        self.assertEqual((f.graph_of("BlockNode:00D8T0000000A"), f.graph_of("BlockNode:00D8B0000000B"), f.graph_of("BlockNode:nothing")), ("state", "mirror", None))
        self.assertEqual(f.tomb_unfolds("TreeView:00D8V0000000A"), ["BlockNode:00D8B0000000B"])
        self.assertEqual(f.tomb_unfolds("TreeView:none"), [])

    def test_the_readme_ids_are_the_ones_the_migration_deletes(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location("migrate_mirror", os.path.join(os.path.dirname(HERE), "migrate-mirror.py"))
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        self.assertEqual((compare.README_ARTIFACTS, compare.README_PARAGRAPHS), (mod.README_ARTIFACTS, mod.README_PARAGRAPHS))

    def test_a_snapshot_directory_is_read_from_its_root_or_from_its_apeiron_directory(self):
        tmp = tempfile.mkdtemp(prefix="dfacts-")
        self.addCleanup(shutil.rmtree, tmp, True)
        write_dump(os.path.join(tmp, "Apeiron"), self.files())
        self.assertEqual(compare.snapshot_facts(tmp).readme_paths, ["README.md"])
        self.assertEqual(compare.snapshot_facts(os.path.join(tmp, "Apeiron")).readme_paths, ["README.md"])


class EmptiedIds(unittest.TestCase):
    """`Context.emptied_ids`: the containers that a removal of the run left empty, and not the tombstones the snapshot already held."""

    def ctx(self, facts):
        nd = lambda i, **f: compare.NDoc(i, i, "BlockNode", "BlockNode.jsonld", f, {})
        ref = {"BlockNode:W": nd("BlockNode:W", type="list", tombstonedAt="<timestamp>", children=[]), "BlockNode:OLD": nd("BlockNode:OLD", type="list", tombstonedAt="<timestamp>", children=[])}
        return compare.Context(ref, {}, set(), facts=facts)

    def test_without_the_snapshot_every_empty_container_of_the_reference_is_one(self):
        self.assertEqual(self.ctx(None).emptied_ids(), {"BlockNode:W", "BlockNode:OLD"})

    def test_a_tombstone_of_the_snapshot_is_not_emptied_by_the_run(self):
        facts = compare.Facts({"BlockNode.jsonld": [{"@id": "BlockNode:OLD", "@type": "BlockNode", "tombstonedAt": "2026-10-01T00:00:00.000Z"}]})
        self.assertEqual(self.ctx(facts).emptied_ids(), {"BlockNode:W"})


class Outputs(Base):
    def with_block(self, pre):
        def go(files):
            b = pre("BlockNode", 1)
            files["BlockNode.jsonld"].append(block(b, IDS["H"], "Made", text="m"))
            find(files, IDS["H"])["children"].append(b)
        return go

    def test_a_minted_id_in_the_output_is_mapped_through_the_dump(self):
        cmds = [command(1, "insert", "inserted %s\n" % R("BlockNode", 1), "inserted %s\n" % N("BlockNode", 1))]
        self.clean(self.run_pair(self.with_block(R), self.with_block(N), commands=cmds))

    def test_the_k_th_new_id_a_command_prints_is_mapped_to_the_k_th_of_the_other_side(self):
        # ids that no dump holds (pruned, or only named): the k-th printed id of each command is the other side's k-th
        cmds = [command(1, "insert", "made %s then %s\n" % (R("BlockNode", 7), R("BlockNode", 8)), "made %s then %s\n" % (N("BlockNode", 7), N("BlockNode", 8))),
                command(2, "show", "%s\n" % R("BlockNode", 8), "%s\n" % N("BlockNode", 8))]
        self.clean(self.run_pair(commands=cmds))

    def test_two_ways_of_mapping_that_disagree_are_a_finding(self):
        cmds = [command(1, "insert", "inserted %s\n" % R("BlockNode", 1), "inserted %s\n" % N("BlockNode", 77))]
        r = self.run_pair(self.with_block(R), self.with_block(N), commands=cmds)
        self.assertEqual([d.scope for d, _ in r.findings], ["id-map", "output"] if len(r.findings) == 2 else ["id-map"])
        self.assertEqual(r.seen, {})

    def test_a_different_status_or_text_is_a_finding_and_a_time_is_masked(self):
        cmds = [command(1, "x", "at 2026-10-22T01:02:03.004Z ok\n", "at 2026-10-23T05:06:07Z ok\n"),
                command(2, "y", "a\n", "b\n"),
                command(3, "z", "", "", ref_status=0, new_status=1, new_err="boom\n")]
        r = self.run_pair(commands=cmds)
        self.assertEqual(sorted((d.command, d.field) for d, _ in r.findings), [("002-y", "stdout"), ("003-z", "status"), ("003-z", "stderr")])

    def test_the_root_of_each_side_is_not_a_difference(self):
        cmds = [command(1, "x", "root /out/ref/Apeiron\n", "root /out/new/Apeiron\n")]
        r = compare.compare_dumps(self.dump(base()), self.dump(base()), snapshot=self.snap, commands=cmds, migrate=False, roots_ref=("/out/ref",), roots_new=("/out/new",))
        self.clean(r)


class Migration(Base):
    def old_form(self):
        files = base()
        P, H, X = IDS["P"], IDS["H"], S("BlockNode", 50)
        find(files, "Profile:00CJC4S69R000").pop("kind")
        find(files, IDS["A"])["type"] = "root"
        files["BlockNode.jsonld"].append({"@id": X, "@type": "BlockNode", "title": "gone", "text": "t", "tombstonedAt": "2026-10-01T00:00:00.000Z", "parent": H, "type": "paragraph", "children": [],
                                           "links": [{"@id": "%s:links:Link:%s" % (X, tid("00D8S", 60)), "@type": "Link", "target": P, "predicate": "[[wikilink]]"}]})
        find(files, H)["children"].append(X)
        find(files, P)["links"] = [{"@id": "%s:links:Link:%s" % (P, tid("00D8S", 61)), "@type": "Link", "target": H, "predicate": "[[wikilink]]"}]
        find(files, IDS["V"])["unfolds"].append(S("BlockNode", 99))
        return files

    def migrated(self):
        files = base()
        P, H, X = IDS["P"], IDS["H"], S("BlockNode", 50)
        files["BlockNode.jsonld"].append({"@id": X, "@type": "BlockNode", "title": "gone", "text": "t", "tombstonedAt": "2026-10-01T00:00:00.000Z", "type": "paragraph", "children": []})
        find(files, P)["links"] = [{"@id": "%s:links:Link:%s" % (P, tid("00D8S", 61)), "@type": "Link", "target": H}]
        return files

    def test_the_reference_dump_is_migrated_so_the_migrations_changes_are_not_differences(self):
        shutil.rmtree(os.path.join(self.snap, "Apeiron"))
        write_dump(os.path.join(self.snap, "Apeiron"), self.old_form())
        ref, new = self.dump(self.old_form()), self.dump(self.migrated())
        r = compare.compare_dumps(ref, new, snapshot=self.snap, migrate=True)
        self.clean(r)
        # without the migration the same dumps differ in all six rules' places (the `predicate`, the tombstone's tree, `kind`, the stale unfold, `type`)
        r = compare.compare_dumps(ref, new, snapshot=self.snap, migrate=False)
        self.assertGreaterEqual(len(r.findings), 6)

    def test_a_dump_the_migration_cannot_decide_fails_the_comparison(self):
        files = self.old_form()
        find(files, IDS["H"])["children"].remove(S("BlockNode", 50))   # the tombstone names a parent that does not list it
        with self.assertRaises(compare.Failure):
            compare.compare_dumps(self.dump(files), self.dump(self.migrated()), snapshot=self.snap, migrate=True)

    def test_the_scratch_copy_is_removed_and_the_dump_is_not_changed(self):
        ref = self.dump(self.old_form())
        def read_all(names):
            out = {}
            for n in names:
                with open(os.path.join(ref, n), "rb") as h:
                    out[n] = h.read()
            return out
        before = read_all(n for n in os.listdir(ref) if n.endswith(".jsonld"))
        new = self.dump(self.migrated())
        # the comparison's scratch copy goes to the directory `tempfile` names; point that at a directory of this test's own, so that a `dc-` directory of a
        # comparison running in another process at the same time (the other classes of this module do, as processes of the same suite) is not seen here
        own = os.path.join(self.tmp, "scratch-root")
        os.mkdir(own)
        with mock.patch.object(tempfile, "tempdir", own):
            compare.compare_dumps(ref, new, snapshot=self.snap, migrate=True)
        self.assertEqual(read_all(before), before)
        self.assertEqual(os.listdir(own), [])


class Cli(Base):
    def run_cli(self, *args):
        env = {k: v for k, v in os.environ.items() if k != "LD_LIBRARY_PATH"}
        return subprocess.run([sys.executable, COMPARE] + list(args), capture_output=True, text=True, stdin=subprocess.DEVNULL, env=env, timeout=120)

    def test_exit_0_on_a_clean_pair_and_1_on_a_finding(self):
        a, b = self.dump(base()), self.dump(base())
        p = self.run_cli("--ref", a, "--new", b, "--no-migrate", "--snapshot", self.snap)
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertIn("UNEXPECTED differences: 0", p.stdout)
        self.assertIn("28   Follow-up 1", p.stdout)
        self.assertIn("29   Move 1", p.stdout)
        self.assertIn("30   Sweeps 7", p.stdout)
        self.assertIn("31   Refused 1", p.stdout)
        files = base()
        find(files, IDS["P"])["text"] = "x"
        out = os.path.join(self.tmp, "r.json")
        p = self.run_cli("--ref", self.dump(files), "--new", b, "--no-migrate", "--snapshot", self.snap, "--json", out)
        self.assertEqual(p.returncode, 1, p.stdout + p.stderr)
        self.assertIn("UNEXPECTED differences: 1", p.stdout)
        self.assertIn("FINDING", p.stdout)
        with open(out, encoding="utf-8") as h:
            j = json.load(h)
        self.assertEqual(j["unexpected"], 1)
        self.assertEqual(j["findings"][0]["field"], "text")
        self.assertEqual(j["notSeenByADump"], [k for k in range(1, 32) if k not in (2, 3, 21, 23, 25)])
        self.assertEqual(j["seen"], {})

    def test_exit_2_on_a_usage_error(self):
        for args in ([], ["--ref", self.tmp], ["--run", os.path.join(self.tmp, "nope")], ["--ref", self.tmp, "--new", os.path.join(self.tmp, "nope")], ["--bogus"]):
            p = self.run_cli(*args)
            self.assertEqual(p.returncode, 2, (args, p.stdout, p.stderr))

    def test_exit_1_when_a_dump_cannot_be_migrated(self):
        files = Migration.old_form(self)
        find(files, IDS["H"])["children"].remove(S("BlockNode", 50))
        p = self.run_cli("--ref", self.dump(files), "--new", self.dump(base()), "--snapshot", self.snap)
        self.assertEqual(p.returncode, 1, p.stdout + p.stderr)
        self.assertIn("FAILED", p.stderr)

    def test_a_run_directory_is_read_with_its_commands(self):
        out = os.path.join(self.tmp, "run")
        for side, pre in (("ref", R), ("new", N)):
            files = base()
            b = pre("BlockNode", 1)
            files["BlockNode.jsonld"].append(block(b, IDS["H"], "Made", text="m"))
            find(files, IDS["H"])["children"].append(b)
            write_dump(os.path.join(out, "dumps", side, "Apeiron"), files)
            os.makedirs(os.path.join(out, "commands"), exist_ok=True)
            with open(os.path.join(out, "commands", "001-insert.%s.stdout" % side), "w", encoding="utf-8") as h:
                h.write("made %s at %s\n" % (b, "2026-10-22T10:00:0%d.000Z" % (1 if side == "ref" else 2)))
            with open(os.path.join(out, "commands", "001-insert.%s.stderr" % side), "w", encoding="utf-8") as h:
                h.write("")
        entry = {"index": 1, "name": "insert", "argv": ["insert"]}
        for side in ("ref", "new"):
            entry[side] = {"status": 0, "timedOut": False, "stdout": "commands/001-insert.%s.stdout" % side, "stderr": "commands/001-insert.%s.stderr" % side}
        with open(os.path.join(out, "results.json"), "w", encoding="utf-8") as h:
            json.dump({"snapshot": self.snap, "commands": [entry]}, h)
        p = self.run_cli("--run", out)  # the dumps are in the new form on both sides: the migration of the reference's changes nothing
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertIn("1 commands", p.stdout)
        with open(os.path.join(out, "commands", "001-insert.new.stdout"), "w", encoding="utf-8") as h:
            h.write("other\n")
        p = self.run_cli("--run", out)
        self.assertEqual(p.returncode, 1, p.stdout + p.stderr)
        self.assertIn("001-insert", p.stdout)
        p = self.run_cli("--run", out, "--no-outputs")
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)


if __name__ == "__main__":
    unittest.main()
