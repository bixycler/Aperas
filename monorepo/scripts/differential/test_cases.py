#!/usr/bin/env python3
"""The tests of the corpus and of the lists of commands (Python 3, standard library): `python3 -m unittest -v test_cases` from this directory, or through the file named in the `differential` suite.

The corpus is built with the code under test standing in for the reference (`corpus.py` starts one service of it in a scratch directory and stops it), and the three lists are built from that snapshot.
What is checked is the shape of the script and not its outcome, which is the work of `cmdrun.py`:

  Corpus   the snapshot holds the artifacts, the thread, the views, the ghost folder (a `children` entry with no document) and the three links of `# Delta`, each of six positions
  Lists    each list is accepted by the harness; the names are unique; every id a command names is in the snapshot (but for the ones that are absent on purpose); the main list holds every
           one of the 19 verbs with a flag or a refusal for most, the reference's three own verbs, one move into an own subtree, last and expected to hang on the reference's side only
  Entries  each of the 28 entries of Layer 4 is aimed at by a case of a list, or named in `cmdrun.UNREACHABLE` with its reason, and no entry is in both

Only a scratch directory is used; the one service is on a port of 2800 to 2899.
"""
import json
import os
import re
import shutil
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import cases  # noqa: E402
import cmdrun  # noqa: E402
import compare  # noqa: E402
import corpus  # noqa: E402
import harness  # noqa: E402
import test_harness as th  # noqa: E402


class Lists(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dir = tempfile.mkdtemp(prefix="dcase-")
        cls.snapshot = os.path.join(cls.dir, "snap")
        port = th.free_ports(1, 4)[0]
        corpus.build(cls.snapshot, harness.MONOREPO, port, os.path.join(cls.dir, "build"))
        cls.lists = {}
        cases.CASES.clear()
        for part in cmdrun.PARTS:
            cls.lists[part] = cases.build_list(cls.snapshot, part)
        cls.cases = list(cases.CASES)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.dir, True)

    def docs(self):
        out = {}
        for root, _, names in os.walk(os.path.join(self.snapshot, "Apeiron")):
            for n in names:
                if n.endswith(".jsonld"):
                    with open(os.path.join(root, n), encoding="utf-8") as h:
                        for d in json.load(h):
                            out[d["@id"]] = d
        return out

    def test_the_snapshot_holds_the_corpus_the_ghost_and_the_links_of_six_positions(self):
        docs = self.docs()
        by_path, by_title = corpus.ids_of(self.snapshot)
        for p in ("cmd_demo", "cmd_demo/beta.md", "cmd_demo/dup.md", "cmd_demo/alpha.md", "cmd_demo/gamma.md", "cmd_demo/delta.md", "cmd_demo/front.md", "cmd_demo/rich.md", "cmd_demo/sub/deep.md",
                  "cmd_demo/eps.md", "cmd_demo/zeta.md", ".threads/coder.md"):
            self.assertIn(p, by_path)
        self.assertIn(corpus.GHOST_ID, docs["%s" % by_path["cmd_demo"]]["children"])
        self.assertNotIn(corpus.GHOST_ID, docs)
        delta = docs[by_title[("cmd_demo/delta.md", "# Delta")]]
        self.assertEqual(len(delta["links"]), 3)
        for link in delta["links"]:
            self.assertEqual(sorted(int(p["value"]) for p in link["props"] if p["key"] == "position").__len__(), 6)
        self.assertTrue(os.path.isfile(os.path.join(self.snapshot, "Apeiron", ".state", "TreeView.jsonld")))
        self.assertTrue(os.path.isfile(os.path.join(self.snapshot, "Apeiron", ".state", "BlockNode.jsonld")))

    def test_every_list_is_accepted_by_the_harness_and_the_names_are_unique(self):
        for part, lst in self.lists.items():
            path = os.path.join(self.dir, part + ".json")
            with open(path, "w", encoding="utf-8") as h:
                json.dump(lst, h)
            commands, final_flush = harness.load_commands(path)
            names = [c["name"] for c in commands]
            self.assertEqual(len(names), len(set(names)), part)
            self.assertEqual(final_flush, part == "lifecycle")

    def test_every_id_a_command_names_is_in_the_snapshot_but_for_the_absent_ones_on_purpose(self):
        docs = self.docs()
        known = {i for i in docs}
        for d in docs.values():
            for l in d.get("links", []):
                known.add(l["@id"])
        for part, lst in self.lists.items():
            for c in lst["commands"]:
                for a in c.get("args", []):
                    for m in re.finditer(r"\b(?:Block|Artifact|Folder)Node:[0-9A-Z]{13}(?::links:Link:[0-9A-Z]{13})?\b", a):
                        i = m.group(0)
                        if "ZZZZZZZZZZ" in i:
                            continue
                        self.assertIn(i, known, "%s: %s names %s" % (part, c["name"], i))

    def test_the_main_list_has_the_19_verbs_flags_and_refusals_the_reference_only_verbs_and_a_last_hang(self):
        cmds = self.lists["main"]["commands"]
        verbs = {}
        for c in cmds:
            if c.get("args"):
                verbs.setdefault(c["args"][0], []).append(c)
        for v in cmdrun.VERBS:
            self.assertIn(v, verbs, v)
        flags = {v: {a for c in cs for a in c["args"][1:] if a.startswith("--")} for v, cs in verbs.items()}
        for v, f in (("tree", {"--depth", "--view", "--no-holders", "--tombstoned", "--format"}), ("show", {"--text", "--reload"}), ("unfold", {"--view", "--tombstoned"}), ("fold", {"--view"}),
                     ("ingest", {"--track", "--force"}), ("track", {"--reverse"}), ("project", {"--dry-run", "--force"}), ("reload", {"--discard", "--start-anyway"}), ("flush", {"--clobber"}),
                     ("check-links", {"--json", "--verbose", "--reload"}), ("insert", {"--after", "--before", "--base"}), ("update", {"--text-only"}), ("retype", {"--to"}), ("remove", {"--base"}),
                     ("resolve", {"--create-holder", "--titles", "--base"}), ("profile", {"--name", "--kind", "--profile"}), ("backlinks", {"--text", "--reload"})):
            self.assertTrue(f <= flags[v], "%s lacks %s" % (v, sorted(f - flags[v])))
        for v in ("link", "unlink", "migrate-frontmatter"):
            self.assertIn(v, verbs)
        hangs = [c for c in cmds if c.get("hangs")]
        self.assertEqual([c["name"] for c in hangs], ["move-into-own-subtree"])
        self.assertIs(cmds[-1], hangs[0])
        self.assertEqual(hangs[0]["hangs"], ["ref"])
        self.assertIn("timeout", hangs[0])
        for part in ("lifecycle", "broken"):
            self.assertFalse([c for c in self.lists[part]["commands"] if c.get("hangs")])
        # a refusal for most verbs: a case named for it
        refusals = [n for n, _, what in self.cases if "a refusal" in what]
        self.assertGreaterEqual(len(refusals), 40)

    def test_each_entry_of_layer_4_is_aimed_at_by_a_case_or_named_unreachable(self):
        aimed = {e for _, entries, _ in self.cases for e in entries}
        for key in compare.MATCHERS:
            if key in cmdrun.UNREACHABLE:
                self.assertNotIn(key, aimed, "entry %d is aimed at and named unreachable" % key)
            else:
                self.assertIn(key, aimed, "entry %d is neither aimed at by a case nor named unreachable" % key)
        for key in cmdrun.AGREE:
            self.assertIn(key, aimed)
            self.assertNotIn(key, cmdrun.UNREACHABLE)
        self.assertFalse(aimed - set(compare.MATCHERS) - set(explain_keys()))


def explain_keys():
    import explain
    return explain.EXTRA


if __name__ == "__main__":
    unittest.main()
