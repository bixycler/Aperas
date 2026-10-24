#!/usr/bin/env python3
"""The tests of what the harness does about the timing of a service (Python 3, standard library): `python3 -m unittest -v test_timing` from this directory, or through the file named in the `differential` suite.

  Retry   a call that ends with exactly the client's `No ApeironNgn service running` while the side's service is alive did not run, and is made again after a wait for a ping (at most
          `MAX_RETRIES` times) and recorded; any other answer, a side with no process and a call that timed out are not made again; the edits of `then_fs` follow the last call at once
  Config  the new side's scratch `aperas.config.json` gets `graphs.tree.flushIntervalMs` (from the snapshot's config, or a minimal one), the reference's is a plain copy, and a list whose
          `then_fs` is wrong is refused

No service is started; the live case that runs both is in `test_steps.py` (`StepsLive`). Only scratch directories are used.
"""
import json
import os
import sys
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import harness  # noqa: E402
import test_harness as th  # noqa: E402  (the module, so that its cases are not collected again)

scratch = th.scratch


def answer(status=0, stdout="", stderr="", timed_out=False):
    return {"status": status, "stdout": stdout, "stderr": stderr, "seconds": 0.5, "timed_out": timed_out}


REFUSAL = answer(1, stderr=harness.NO_SERVICE_ANSWER + "\n")


class Retry(unittest.TestCase):
    def setUp(self):
        self.dir = scratch(self)
        self.side = harness.Side("ref", harness.MONOREPO, self.dir, 2810, 509, "t")
        os.makedirs(self.side.apeiron)
        os.makedirs(self.side.artifacts)

    def run_with(self, answers, alive=True, then_fs=None, stdin="text\n"):
        """-> (the dict `run_command` returns, the calls given to `run_aperas`, the order of the events)"""
        events = []

        def fake_run(side, argv, timeout, stdin_text=None):
            events.append("call")
            return answers.pop(0)

        def fake_wait(side, timeout):
            events.append("wait")
            return 0.25

        def fake_fs(side, ops):
            events.append("fs")

        with mock.patch.object(harness, "run_aperas", side_effect=fake_run) as run, mock.patch.object(harness, "wait_answering", side_effect=fake_wait), \
                mock.patch.object(harness, "side_service_alive", return_value=alive), mock.patch.object(harness, "apply_fs", side_effect=fake_fs):
            out = harness.run_command(self.side, ["update", "x"], 30, stdin, 60, then_fs)
        return out, run.call_args_list, events

    def test_the_clients_refusal_to_send_is_made_again_after_a_wait_and_recorded(self):
        out, calls, events = self.run_with([REFUSAL, answer(0, stdout="Updated\n")])
        self.assertEqual(out["res"]["status"], 0)
        self.assertEqual(out["retries"], [{"seconds": 0.5, "waited": 0.25}])
        self.assertEqual(len(calls), 2)
        self.assertEqual([c.args[3] for c in calls], ["text\n", "text\n"])   # the same input both times
        self.assertEqual(events, ["call", "wait", "call"])   # no lock: no wait before the first call

    def test_an_answer_that_is_not_exactly_the_refusal_is_not_made_again(self):
        for other in (answer(1, stderr="[aperas] Failed: something else\n"), answer(2, stderr=harness.NO_SERVICE_ANSWER + "\n"), answer(1, stdout="x\n", stderr=harness.NO_SERVICE_ANSWER + "\n"),
                      answer(1, stderr=harness.NO_SERVICE_ANSWER + " And more.\n"), answer(None, stderr=harness.NO_SERVICE_ANSWER + "\n", timed_out=True), answer(0)):
            out, calls, _ = self.run_with([other])
            self.assertEqual((out["retries"], len(calls)), ([], 1), other)

    def test_a_side_with_no_process_is_not_given_the_command_again(self):
        out, calls, _ = self.run_with([REFUSAL], alive=False)
        self.assertEqual((out["retries"], len(calls), out["res"]["status"]), ([], 1, 1))

    def test_the_retries_are_bounded_and_the_last_answer_stands(self):
        out, calls, _ = self.run_with([REFUSAL] * (harness.MAX_RETRIES + 5))
        self.assertEqual(len(calls), 1 + harness.MAX_RETRIES)
        self.assertEqual(len(out["retries"]), harness.MAX_RETRIES)
        self.assertEqual(out["res"]["status"], 1)

    def test_the_edits_of_then_fs_follow_the_last_call_and_a_refused_edit_is_reported(self):
        ops = [{"op": "write", "root": "artifacts", "path": "x.md", "text": "y"}]
        out, _, events = self.run_with([REFUSAL, answer(0)], then_fs=ops)
        self.assertEqual(events, ["call", "wait", "call", "fs"])
        self.assertIsNone(out["fs_error"])
        with mock.patch.object(harness, "run_aperas", return_value=answer(0)), mock.patch.object(harness, "apply_fs", side_effect=harness.Refusal("no such document")):
            out = harness.run_command(self.side, ["tree"], 30, None, 60, ops)
        self.assertEqual(out["fs_error"], "no such document")
        self.assertEqual(out["res"]["status"], 0)

    def test_the_wait_before_a_call_is_made_only_when_the_side_has_a_lock(self):
        os.makedirs(self.side.run_dir)
        with open(os.path.join(self.side.run_dir, "apeironngn.lock"), "w") as h:
            json.dump({"pid": 1, "status": "ready"}, h)
        out, _, events = self.run_with([answer(0)])
        self.assertEqual(events, ["wait", "call"])
        self.assertEqual(out["busy"], 0.25)


class Config(unittest.TestCase):
    def setUp(self):
        self.dir = scratch(self)
        self.snap = os.path.join(self.dir, "snap")
        os.makedirs(self.snap)
        self.out = os.path.join(self.dir, "out")
        self.sides = {n: harness.Side(n, harness.MONOREPO, self.out, 2812, 509, "t") for n in ("ref", "new")}
        for s in self.sides.values():
            os.makedirs(s.root)

    def written(self, name):
        with open(os.path.join(self.sides[name].root, "aperas.config.json")) as h:
            return json.load(h)

    def test_the_new_sides_config_gets_the_interval_and_keeps_the_rest_of_the_snapshots(self):
        snap_cfg = {"graph": {"apeiron": "./Apeiron", "artifacts": "./artifacts"}, "name": "G", "threadSizeCap": 7, "graphs": {"tree": {"mirror": "./Apeiron"}, "treeviews": {"flushIntervalMs": 5000}}}
        with open(os.path.join(self.snap, "aperas.config.json"), "w") as h:
            json.dump(snap_cfg, h)
        got = harness.place_config(self.sides["new"], self.snap, 3600000)
        expected = json.loads(json.dumps(snap_cfg))
        expected["graphs"]["tree"]["flushIntervalMs"] = 3600000
        self.assertEqual(self.written("new"), expected)
        self.assertEqual(got, expected)
        with open(os.path.join(self.snap, "aperas.config.json")) as h:
            self.assertEqual(json.load(h), snap_cfg)   # the snapshot's own is not touched

    def test_the_reference_gets_a_plain_copy_and_so_does_the_new_side_with_no_interval(self):
        snap_cfg = {"graph": "./g", "name": "G"}
        with open(os.path.join(self.snap, "aperas.config.json"), "w") as h:
            json.dump(snap_cfg, h)
        harness.place_config(self.sides["ref"], self.snap, 3600000)
        harness.place_config(self.sides["new"], self.snap, None)
        self.assertEqual(self.written("ref"), snap_cfg)
        self.assertEqual(self.written("new"), snap_cfg)

    def test_with_no_config_in_the_snapshot_the_new_side_gets_a_minimal_one_naming_its_roots_and_the_reference_none(self):
        self.assertIsNone(harness.place_config(self.sides["ref"], self.snap, 3600000))
        self.assertFalse(os.path.exists(os.path.join(self.sides["ref"].root, "aperas.config.json")))
        self.assertIsNone(harness.place_config(self.sides["new"], self.snap, None))
        self.assertFalse(os.path.exists(os.path.join(self.sides["new"].root, "aperas.config.json")))
        harness.place_config(self.sides["new"], self.snap, 120000)
        self.assertEqual(self.written("new"), {"graph": {"apeiron": "./Apeiron", "artifacts": "./artifacts"}, "graphs": {"tree": {"flushIntervalMs": 120000}}})

    def test_a_list_with_a_wrong_then_fs_is_refused_and_a_bad_interval_is_refused(self):
        path = os.path.join(self.dir, "list.json")
        for bad in ({"name": "x", "then_fs": [{"op": "write"}]}, {"name": "x", "args": ["tree"], "then_fs": "no"}, {"name": "x", "args": ["tree"], "then_fs": [{"op": "nothing"}]}):
            with open(path, "w") as h:
                json.dump([bad], h)
            with self.assertRaises(harness.Refusal, msg=bad):
                harness.load_commands(path)
        with open(path, "w") as h:
            json.dump([{"name": "x", "args": ["tree"], "then_fs": [{"op": "delete", "root": "artifacts", "path": "a.md"}]}], h)
        self.assertEqual(len(harness.load_commands(path)[0]), 1)
        os.makedirs(os.path.join(self.snap, "Apeiron"))
        os.makedirs(os.path.join(self.snap, "artifacts"))
        r = th.run_cli("--snapshot", self.snap, "--out", self.out + "2", "--commands", path, "--ports", "2814,2815", "--content-flush-ms", "0")
        self.assertEqual(r.returncode, 2)
        self.assertIn("--content-flush-ms", r.stderr)


if __name__ == "__main__":
    unittest.main()
