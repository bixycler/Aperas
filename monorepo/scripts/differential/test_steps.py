#!/usr/bin/env python3
"""The tests of what piece 4 added to `harness.py` (Python 3, standard library): `python3 -m unittest -v test_steps` from this directory, or through the file named in the `differential` suite.

  Steps      the object form of a list with `final_flush`, a step of `fs` edits or of a `wait`, and the edits of files on a scratch side (`write`, `modify-document`, `edit-embedded`,
             `duplicate-document`, `truncate`, `delete`) and their refusals; nothing is started
  StepsLive  a run of the demo snapshot with the new code on both sides: a step of files, a wait, a capture, the expected statuses of the two sides, the sides expected to hang, and
             the logs copied; an unexpected hang and the command that follows a hang are problems

Only scratch directories are used. The live cases start two services of their own in a scratch runtime directory each, on ports of 2800 to 2899 (the slices of `test_harness.py`).
"""
import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import harness  # noqa: E402
import test_harness as th  # noqa: E402  (the module, so that its cases are not collected again)

scratch, read = th.scratch, th.read


class Steps(unittest.TestCase):
    """The keys that piece 4 added to a list, and the edits of files, on a scratch side (no service)."""

    def setUp(self):
        self.dir = scratch(self)
        self.side = harness.Side("ref", harness.MONOREPO, self.dir, 2810, 509, "t")
        os.makedirs(self.side.apeiron)
        os.makedirs(self.side.artifacts)
        self.docs = [{"@id": "BlockNode:00AAAAAAAAAAA", "@type": "BlockNode", "text": "one", "links": [{"@id": "BlockNode:00AAAAAAAAAAA:links:Link:00BBBBBBBBBBB", "@type": "Link", "target": "BlockNode:00CCCCCCCCCCC",
                      "props": [{"@id": "p1", "@type": "StringProp", "key": "position", "value": "3"}, {"@id": "p2", "@type": "StringProp", "key": "other", "value": "x"}]}]},
                     {"@id": "BlockNode:00DDDDDDDDDDD", "@type": "BlockNode", "text": "two"}]
        self.write_docs(self.docs)

    def path(self, name="BlockNode.jsonld"):
        return os.path.join(self.side.apeiron, name)

    def write_docs(self, docs):
        with open(self.path(), "w") as h:
            json.dump(docs, h)

    def read_docs(self):
        with open(self.path()) as h:
            return json.load(h)

    def test_a_list_may_be_an_object_and_a_step_may_be_a_file_edit_or_a_wait(self):
        path = os.path.join(self.dir, "list.json")
        with open(path, "w") as h:
            json.dump({"final_flush": False, "commands": [{"fs": [{"op": "write", "path": "x", "text": "y"}]}, {"wait": 1}, {"args": ["tree"], "capture": True, "status_ref": 0, "status_new": 1, "hangs": ["ref"], "comment": "c"}]}, h)
        commands, final_flush = harness.load_commands(path)
        self.assertFalse(final_flush)
        self.assertEqual(len(commands), 3)
        with open(path, "w") as h:
            json.dump([{"args": ["tree"]}], h)
        self.assertEqual(harness.load_commands(path)[1], True)

    def test_write_truncate_and_delete(self):
        harness.apply_fs(self.side, [{"op": "write", "root": "artifacts", "path": "d/a.md", "text": "hello world"}])
        a = os.path.join(self.side.artifacts, "d", "a.md")
        self.assertEqual(read(a), "hello world")
        harness.apply_fs(self.side, [{"op": "truncate", "root": "artifacts", "path": "d/a.md", "keep": 5}])
        self.assertEqual(read(a), "hello")
        harness.apply_fs(self.side, [{"op": "delete", "root": "artifacts", "path": "d/a.md"}])
        self.assertFalse(os.path.exists(a))

    def test_modify_document_sets_and_appends_once(self):
        op = {"op": "modify-document", "path": "BlockNode.jsonld", "match": {"@id": "00DDDDDDDDDDD"}, "set": {"text": "three"}, "append": {"unfolds": "BlockNode:00ZZZZZZZZZZZ"}}
        harness.apply_fs(self.side, [op])
        harness.apply_fs(self.side, [op])
        d = self.read_docs()[1]
        self.assertEqual((d["text"], d["unfolds"]), ("three", ["BlockNode:00ZZZZZZZZZZZ"]))
        self.assertEqual(self.read_docs()[0]["text"], "one")

    def test_edit_embedded_changes_the_entries_that_match_and_drops_props(self):
        harness.apply_fs(self.side, [{"op": "edit-embedded", "path": "BlockNode.jsonld", "match": {"@id": "BlockNode:00AAAAAAAAAAA"}, "field": "links", "where": {"target": "BlockNode:00CCCCCCCCCCC"},
                                      "set": {"target": "BlockNode:00ZZZZZZZZZZB"}, "remove_where_in": {"inner": "props", "where": {"key": "position"}}}])
        link = self.read_docs()[0]["links"][0]
        self.assertEqual(link["target"], "BlockNode:00ZZZZZZZZZZB")
        self.assertEqual([p["key"] for p in link["props"]], ["other"])
        with self.assertRaises(harness.Refusal):
            harness.apply_fs(self.side, [{"op": "edit-embedded", "path": "BlockNode.jsonld", "match": {"@id": "BlockNode:00AAAAAAAAAAA"}, "field": "links", "where": {"target": "nobody"}, "set": {}}])

    def test_duplicate_document_adds_the_document_once_and_leaves_a_file_that_holds_it_twice(self):
        op = {"op": "duplicate-document", "path": "BlockNode.jsonld", "match": {"@id": "00DDDDDDDDDDD"}}
        harness.apply_fs(self.side, [op])
        self.assertEqual([d["@id"] for d in self.read_docs()], ["BlockNode:00AAAAAAAAAAA", "BlockNode:00DDDDDDDDDDD", "BlockNode:00DDDDDDDDDDD"])
        harness.apply_fs(self.side, [op])
        self.assertEqual(len(self.read_docs()), 3)

    def test_an_edit_that_matches_nothing_or_leaves_the_root_is_refused(self):
        with self.assertRaises(harness.Refusal):
            harness.apply_fs(self.side, [{"op": "modify-document", "path": "BlockNode.jsonld", "match": {"@id": "00NOBODYNOBODY"}, "set": {"a": 1}}])
        with self.assertRaises(harness.Refusal):
            harness.apply_fs(self.side, [{"op": "write", "root": "artifacts", "path": "../escape.md", "text": "x"}])
        with self.assertRaises(harness.Refusal):
            harness.apply_fs(self.side, [{"op": "write", "root": "elsewhere", "path": "x", "text": "x"}])
        self.assertFalse(os.path.exists(os.path.join(self.dir, "escape.md")))


class StepsLive(th.LiveBase):
    def test_steps_of_files_and_waits_a_capture_expected_statuses_and_a_hang_leave_no_problem(self):
        path = os.path.join(self.dir, "list.json")
        with open(path, "w") as h:
            json.dump({"final_flush": False, "commands": [
                {"name": "edit", "fs": [{"op": "write", "root": "artifacts", "path": "cmd_demo/extra.md", "text": "# Extra\n"}]},
                {"name": "track", "args": ["track", "cmd_demo/extra.md"]},
                {"name": "missing", "args": ["show", "cmd_demo/none.md"], "status_ref": 1, "status_new": 1},
                {"name": "pause", "wait": 0.2, "capture": True},
                {"name": "slow", "args": ["tree", "cmd_demo/beta.md"], "timeout": 0.05, "hangs": ["ref", "new"]}]}, h)
        r = self.run_list(path)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        res = self.results()
        self.assertEqual(res["problems"], [])
        self.assertEqual(res["hung"], ["new", "ref"])
        self.assertEqual([c["name"] for c in res["commands"]], ["edit", "track", "missing", "pause", "slow"])
        self.assertTrue(res["commands"][4]["ref"]["expectedHang"])
        self.assertNotIn("ref", res["commands"][0])
        for side in ("ref", "new"):
            self.assertTrue(os.path.isfile(os.path.join(self.out, side, "artifacts", "cmd_demo", "extra.md")))
            self.assertTrue(os.path.isdir(os.path.join(self.out, res["commands"][3]["capture"], side, "Apeiron")))
            self.assertTrue(os.path.isfile(os.path.join(self.out, "logs", side + ".service.log")))
        self.assertEqual(self.own_processes(), [])

    def test_a_hang_that_was_not_expected_and_a_command_that_follows_a_hang_are_problems(self):
        path = os.path.join(self.dir, "list.json")
        with open(path, "w") as h:
            json.dump({"final_flush": False, "commands": [{"name": "slow", "args": ["tree", "cmd_demo/beta.md"], "timeout": 0.05, "hangs": ["ref"]}, {"name": "after", "args": ["tree", "cmd_demo/beta.md"]}]}, h)
        r = self.run_list(path)
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        problems = "\n".join(self.results()["problems"])
        self.assertIn("command 1 (slow) on the side new outlived its timeout", problems)
        self.assertIn("command 2 (after) was not run on the side ref", problems)
        self.assertEqual(self.own_processes(), [])


if __name__ == "__main__":
    unittest.main()
