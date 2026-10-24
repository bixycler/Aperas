#!/usr/bin/env python3
"""The tests of what piece 5 of Batch 13 added for the run on a copy of the real mirror (Python 3, standard library): `python3 -m unittest -v test_realcopy` from this directory,
or through the file named in the `differential` suite. No service is started.

  Overlay     `overlay.py` lays the `cmd_demo` corpus over a copy of a real mirror: the real documents are not touched, the folder joins the root's children in sorted place, the thread
              is renamed, a profile and a view the real graph has are not added twice, and the real directory is only read
  Thread      `cases.Builder.thread_path` finds the corpus's own thread on the small snapshot and on the overlaid one
  Labels      the comparer gives a side's label only to a token the side's dump defines and the snapshot lacks (an id written in a text as an example is the same on both sides),
              and maps a token written in lower case in a slug
  Settle      the harness waits for a service to answer a ping after a start or a restart, and for nothing after another verb
"""
import json
import os
import shutil
import socket
import sys
import tempfile
import threading
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import cases  # noqa: E402
import compare  # noqa: E402
import harness  # noqa: E402
import overlay  # noqa: E402


def scratch(test):
    d = tempfile.mkdtemp(prefix="rc-")
    test.addCleanup(shutil.rmtree, d, True)
    return d


def write(path, docs):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as h:
        json.dump(docs, h, indent=2, ensure_ascii=False)
        h.write("\n")


def tree_digest(root):
    out = {}
    for dirpath, _, names in os.walk(root):
        for n in names:
            p = os.path.join(dirpath, n)
            with open(p, "rb") as h:
                out[os.path.relpath(p, root)] = h.read()
    return out


ROOT, ARCH, DESIGN, HOLD = "FolderNode:00R0000000001", "FolderNode:00R0000000002", "FolderNode:00R0000000003", "FolderNode:00R0000000004"
SROOT, SDEMO, SHOLD = "FolderNode:00S0000000001", "FolderNode:00S0000000002", "FolderNode:00S0000000003"


def make_real(d):
    """A real graph root: a root folder with a paragraph, two folders and the `.threads` holder; a thread `.threads/coder.md` of its own; a profile `default`; a view `default`."""
    ap = os.path.join(d, "Apeiron")
    write(os.path.join(ap, "FolderNode.jsonld"), [
        {"@id": ROOT, "@type": "FolderNode", "title": "Artifacts", "path": ".", "children": ["BlockNode:00R000000000P", ARCH, DESIGN, HOLD]},
        {"@id": ARCH, "@type": "FolderNode", "title": "archive", "parent": ROOT, "path": "archive", "children": []},
        {"@id": DESIGN, "@type": "FolderNode", "title": "design", "parent": ROOT, "path": "design", "children": []}])
    write(os.path.join(ap, "ArtifactNode.jsonld"), [])
    write(os.path.join(ap, "BlockNode.jsonld"), [{"@id": "BlockNode:00R000000000P", "@type": "BlockNode", "title": "00R000000000P", "text": "Root paragraph.", "parent": ROOT, "type": "paragraph", "children": []}])
    write(os.path.join(ap, "Profile.jsonld"), [{"@id": "Profile:00CA03JXD8000", "@type": "Profile", "handle": "default"}])
    write(os.path.join(ap, ".state", "FolderNode.jsonld"), [{"@id": HOLD, "@type": "FolderNode", "holder": True, "title": ".threads", "parent": ROOT, "path": ".threads", "children": ["ArtifactNode:00R0000000005"]}])
    write(os.path.join(ap, ".state", "ArtifactNode.jsonld"), [{"@id": "ArtifactNode:00R0000000005", "@type": "ArtifactNode", "holder": True, "title": "coder.md", "parent": HOLD, "path": ".threads/coder.md", "children": ["BlockNode:00R0000000006"]}])
    write(os.path.join(ap, ".state", "BlockNode.jsonld"), [{"@id": "BlockNode:00R0000000006", "@type": "BlockNode", "title": "# Coder thread", "parent": "ArtifactNode:00R0000000005", "type": "heading", "children": []}])
    write(os.path.join(ap, ".state", "TreeView.jsonld"), [{"@id": "TreeView:00R0000000007", "@type": "TreeView", "profile": "Profile:00CA03JXD8000", "name": "default", "unfolds": ["BlockNode:00R0000000006"]}])
    os.makedirs(os.path.join(d, "artifacts", "design"))
    with open(os.path.join(d, "artifacts", "design", "a.md"), "w") as h:
        h.write("# A\n")
    with open(os.path.join(d, "aperas.config.json"), "w") as h:
        h.write("{}\n")


def make_small(d):
    """The small corpus: a root folder (another id) with `cmd_demo` and `.threads`; the artifact `cmd_demo/beta.md`; the thread `.threads/coder.md` with `# Coder thread` over `## topic`; the views `default` and `work`."""
    ap = os.path.join(d, "Apeiron")
    write(os.path.join(ap, "FolderNode.jsonld"), [
        {"@id": SROOT, "@type": "FolderNode", "title": "Artifacts", "path": ".", "children": [SDEMO, SHOLD]},
        {"@id": SDEMO, "@type": "FolderNode", "title": "cmd_demo", "parent": SROOT, "path": "cmd_demo", "children": ["ArtifactNode:00S0000000004"]}])
    write(os.path.join(ap, "ArtifactNode.jsonld"), [{"@id": "ArtifactNode:00S0000000004", "@type": "ArtifactNode", "title": "beta.md", "parent": SDEMO, "path": "cmd_demo/beta.md", "children": []}])
    write(os.path.join(ap, "BlockNode.jsonld"), [])
    write(os.path.join(ap, "Profile.jsonld"), [{"@id": "Profile:00CA03JXD8000", "@type": "Profile", "handle": "default"}])
    write(os.path.join(ap, ".state", "FolderNode.jsonld"), [{"@id": SHOLD, "@type": "FolderNode", "holder": True, "title": ".threads", "parent": SROOT, "path": ".threads", "children": ["ArtifactNode:00S0000000005"]}])
    write(os.path.join(ap, ".state", "ArtifactNode.jsonld"), [{"@id": "ArtifactNode:00S0000000005", "@type": "ArtifactNode", "holder": True, "title": "coder.md", "parent": SHOLD, "path": ".threads/coder.md", "children": ["BlockNode:00S0000000006"]}])
    write(os.path.join(ap, ".state", "BlockNode.jsonld"), [
        {"@id": "BlockNode:00S0000000006", "@type": "BlockNode", "title": "# Coder thread", "parent": "ArtifactNode:00S0000000005", "type": "heading", "children": ["BlockNode:00S0000000007"]},
        {"@id": "BlockNode:00S0000000007", "@type": "BlockNode", "title": "## topic", "parent": "BlockNode:00S0000000006", "type": "heading", "children": []}])
    write(os.path.join(ap, ".state", "TreeView.jsonld"), [
        {"@id": "TreeView:00S0000000008", "@type": "TreeView", "profile": "Profile:00CA03JXD8000", "name": "default"},
        {"@id": "TreeView:00S0000000009", "@type": "TreeView", "profile": "Profile:00CA03JXD8000", "name": "work"}])
    os.makedirs(os.path.join(d, "artifacts", "cmd_demo"))
    with open(os.path.join(d, "artifacts", "cmd_demo", "beta.md"), "w") as h:
        h.write("# Beta\n")


def load(path):
    with open(path, encoding="utf-8") as h:
        return json.load(h)


class Overlay(unittest.TestCase):
    def setUp(self):
        self.dir = scratch(self)
        self.real, self.small, self.out = (os.path.join(self.dir, x) for x in ("real", "small", "out"))
        make_real(self.real)
        make_small(self.small)

    def test_lays_the_corpus_over_a_copy_and_reads_the_real_directory_only(self):
        before = tree_digest(self.real)
        small_before = tree_digest(self.small)
        added = overlay.build(self.real, self.small, self.out)
        self.assertEqual(tree_digest(self.real), before)
        self.assertEqual(tree_digest(self.small), small_before)
        self.assertEqual(added[os.path.join("", "ArtifactNode.jsonld")], 1)
        self.assertEqual(added[os.path.join(".state", "ArtifactNode.jsonld")], 1)
        self.assertEqual(added[os.path.join(".state", "BlockNode.jsonld")], 2)
        self.assertEqual(added[os.path.join(".state", "TreeView.jsonld")], 1)
        self.assertEqual(added[os.path.join("", "FolderNode.jsonld")], 1)
        self.assertNotIn("Profile.jsonld", added)
        self.assertTrue(os.path.isfile(os.path.join(self.out, "artifacts", "cmd_demo", "beta.md")))
        self.assertTrue(os.path.isfile(os.path.join(self.out, "artifacts", "design", "a.md")))
        self.assertTrue(os.path.isfile(os.path.join(self.out, "aperas.config.json")))

    def test_the_real_documents_are_not_touched(self):
        overlay.build(self.real, self.small, self.out)
        for rel in ("Apeiron/ArtifactNode.jsonld", "Apeiron/BlockNode.jsonld", "Apeiron/Profile.jsonld", "Apeiron/.state/BlockNode.jsonld"):
            real, out = load(os.path.join(self.real, rel)), load(os.path.join(self.out, rel))
            self.assertEqual(out[:len(real)], real, rel)
        # the files that gained nothing are the real files, byte for byte
        for rel in ("Apeiron/BlockNode.jsonld", "Apeiron/Profile.jsonld"):
            with open(os.path.join(self.real, rel), "rb") as a, open(os.path.join(self.out, rel), "rb") as b:
                self.assertEqual(a.read(), b.read(), rel)

    def test_the_folder_joins_the_root_in_sorted_place_and_the_thread_joins_the_holder(self):
        overlay.build(self.real, self.small, self.out)
        folders = {d["@id"]: d for d in load(os.path.join(self.out, "Apeiron", "FolderNode.jsonld"))}
        self.assertEqual(folders[ROOT]["children"], ["BlockNode:00R000000000P", ARCH, SDEMO, DESIGN, HOLD])
        self.assertEqual(folders[SDEMO]["parent"], ROOT)
        self.assertNotIn(SROOT, folders)
        holder = load(os.path.join(self.out, "Apeiron", ".state", "FolderNode.jsonld"))[0]
        self.assertEqual(holder["children"], ["ArtifactNode:00R0000000005", "ArtifactNode:00S0000000005"])
        thread = [d for d in load(os.path.join(self.out, "Apeiron", ".state", "ArtifactNode.jsonld")) if d["@id"] == "ArtifactNode:00S0000000005"][0]
        self.assertEqual((thread["path"], thread["title"], thread["parent"]), (".threads/difftest.md", "difftest.md", HOLD))

    def test_a_profile_and_a_view_the_real_graph_has_are_not_added_twice(self):
        overlay.build(self.real, self.small, self.out)
        views = load(os.path.join(self.out, "Apeiron", ".state", "TreeView.jsonld"))
        self.assertEqual(sorted(v["name"] for v in views), ["default", "work"])
        self.assertEqual([v for v in views if v["name"] == "default"][0]["unfolds"], ["BlockNode:00R0000000006"])
        self.assertEqual(len(load(os.path.join(self.out, "Apeiron", "Profile.jsonld"))), 1)

    def test_refuses_an_existing_output_a_missing_directory_and_a_thread_the_real_graph_has(self):
        os.makedirs(self.out)
        with self.assertRaisesRegex(overlay.Refusal, "exists"):
            overlay.build(self.real, self.small, self.out)
        with self.assertRaisesRegex(overlay.Refusal, "has no"):
            overlay.build(os.path.join(self.dir, "none"), self.small, os.path.join(self.dir, "out2"))
        with self.assertRaisesRegex(overlay.Refusal, "has the thread"):
            overlay.build(self.real, self.small, os.path.join(self.dir, "out3"), thread_artifact="coder.md")

    def test_the_command_line_prints_what_was_added(self):
        import contextlib
        import io
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            code = overlay.main(["--real", self.real, "--small", self.small, "--out", self.out])
        self.assertEqual(code, 0)
        self.assertIn("snapshot written to", buf.getvalue())
        self.assertIn("documents", buf.getvalue())


class Thread(unittest.TestCase):
    def test_finds_the_corpus_thread_on_the_small_snapshot_and_on_the_overlaid_one(self):
        d = scratch(self)
        real, small, out = (os.path.join(d, x) for x in ("real", "small", "out"))
        make_real(real)
        make_small(small)
        self.assertEqual(cases.Builder(small).thread_path(), ".threads/coder.md")
        overlay.build(real, small, out)
        # the real graph has a `.threads/coder.md` of its own, with no `## topic`: only the corpus's thread counts
        self.assertEqual(cases.Builder(out).thread_path(), ".threads/difftest.md")

    def test_a_snapshot_with_no_such_thread_is_refused(self):
        d = scratch(self)
        real = os.path.join(d, "real")
        make_real(real)
        with self.assertRaisesRegex(ValueError, "0 threads"):
            cases.Builder(real).thread_path()


class Labels(unittest.TestCase):
    def side(self, name, docs):
        return compare.Side(name, {"BlockNode.jsonld": docs}, [])

    def test_a_token_no_document_defines_is_the_same_on_both_sides(self):
        doc = {"@id": "BlockNode:00D8S00000001", "@type": "BlockNode", "title": "t", "text": "see BlockNode:00C5H15NT0000 and 00C5H15NT0000", "type": "paragraph", "children": []}
        for name in ("ref", "new"):
            s = self.side(name, [doc])
            self.assertEqual(s.label("00C5H15NT0000", set()), "00C5H15NT0000")
            self.assertEqual(s.canon("BlockNode:00C5H15NT0000", set()), "BlockNode:00C5H15NT0000")

    def test_a_token_the_dump_defines_and_the_snapshot_lacks_is_labelled_with_its_side(self):
        doc = {"@id": "BlockNode:00D8N00000001", "@type": "BlockNode", "title": "t", "type": "paragraph", "children": []}
        s = self.side("ref", [doc])
        self.assertEqual(s.label("00D8N00000001", set()), "ref!00D8N00000001")
        self.assertEqual(s.label("00D8N00000001", {"00D8N00000001"}), "00D8N00000001")

    def test_a_token_in_a_slug_is_mapped_like_the_same_token_in_upper_case(self):
        doc = {"@id": "BlockNode:00D93SGV23Z81", "@type": "BlockNode", "title": "t", "type": "paragraph", "children": []}
        s = self.side("ref", [doc])
        s.labels["00D93SGV23Z81"] = "~p3.1"
        self.assertEqual(s.canon("'a.md/00d93sgv23z81/---x'", set()), "'a.md/~p3.1/---x'")
        self.assertEqual(s.canon("'a.md/00d93sgv23z82/---x'", set()), "'a.md/00d93sgv23z82/---x'")
        self.assertEqual(compare.printed_tokens("'a.md/00d93sgv23z81/' (BlockNode:00D93SGV2BZ81 and BlockNode:00D93SGV2BZ82)", set()), ["00D93SGV23Z81", "00D93SGV2BZ81", "00D93SGV2BZ82"])
        self.assertEqual(compare.printed_tokens("a word of thirteen: hhhhhhhhhhhhh", set()), [])


class Settle(unittest.TestCase):
    def setUp(self):
        self.dir = scratch(self)
        self.side = harness.Side("ref", harness.MONOREPO, os.path.join(self.dir, "o"), 2800, 509, "g")
        os.makedirs(self.side.run_dir)

    def serve(self, answer=b'{"ok":true}\n', pause=0.0):
        srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        srv.bind(self.side.socket_path())
        srv.listen(4)
        self.addCleanup(srv.close)
        got = []

        def run():
            while True:
                try:
                    c, _ = srv.accept()
                except OSError:
                    return
                got.append(c.recv(4096))
                threading.Event().wait(pause)
                try:
                    c.sendall(answer)
                except OSError:
                    pass
                c.close()
        t = threading.Thread(target=run, daemon=True)
        t.start()
        return got

    def test_a_service_that_answers_a_ping_is_answering(self):
        got = self.serve()
        self.assertTrue(harness.answers_ping(self.side))
        self.assertEqual(got, [b'{"op":"ping"}\n'])

    def test_no_socket_a_refusal_and_a_silent_service_are_not_answering(self):
        self.assertFalse(harness.answers_ping(self.side, timeout=0.3))
        self.serve(answer=b'{"ok":false}\n')
        self.assertFalse(harness.answers_ping(self.side, timeout=0.3))

    def test_a_busy_service_is_waited_for_until_it_answers(self):
        self.serve(pause=1.2)
        self.assertFalse(harness.answers_ping(self.side, timeout=0.3))
        waited = harness.wait_answering(self.side, 10)
        self.assertGreaterEqual(waited, 0.0)
        # a side with a process of its own that does not answer is waited for until the time is out
        with unittest.mock.patch.object(harness, "side_service_alive", return_value=True), unittest.mock.patch.object(harness, "answers_ping", return_value=False):
            self.assertGreaterEqual(harness.wait_answering(self.side, 0.6), 0.5)
        # and one with no process is not waited for at all
        with unittest.mock.patch.object(harness, "side_service_alive", return_value=False), unittest.mock.patch.object(harness, "answers_ping", return_value=False):
            self.assertLess(harness.wait_answering(self.side, 30), 5)

    def test_only_a_start_or_a_restart_is_settled(self):
        res = {"status": 0, "stdout": "", "stderr": "", "seconds": 1, "timed_out": False}
        for argv in (["tree", "."], ["service", "stop"], ["service", "bogus"], ["flush"]):
            self.assertIsNone(harness.settle_after_service_command(self.side, argv, res, 5), argv)
        with unittest.mock.patch.object(harness, "answers_ping", return_value=True):
            for argv in (["service", "start"], ["service", "restart"], ["service", "start", "--start-anyway"]):
                self.assertIsNotNone(harness.settle_after_service_command(self.side, argv, res, 5), argv)


import unittest.mock  # noqa: E402,F401  (used by Settle)

if __name__ == "__main__":
    unittest.main()
