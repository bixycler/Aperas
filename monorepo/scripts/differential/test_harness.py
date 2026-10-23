#!/usr/bin/env python3
"""The tests of `harness.py` (Python 3, standard library): `python3 -m unittest -v test_harness` from this directory, or through the file named in the `tools` suite.

  Assertions  the isolation checks refuse a start whose variables point at a working service's runtime directory or port, at the live or
              real roots, or outside the output directory, and the stop signals nothing but the side's own service
  Cli         the command line refuses (exit 2, nothing written, nothing started) the real graph root, an output directory that is not empty
              or lies inside the snapshot, a bad pair of ports, a bad list of commands and a code root without `tsx`
  Start       a start call that gave up early (the code's own client waits a few seconds of the wall clock) is waited out until the lock says ready,
              and a service that ends or never gets ready is still a failed start
  Live        a run of the demo list on the demo snapshot, with the new code on both sides, ends with no process left, the working service
              untouched, the reference copy unmigrated and the new copy migrated; a command with a status other than the one expected fails the run

Only scratch directories are used. The live cases start two services of their own in a scratch runtime directory each, on ports of 2800 to 2899, a slice of 20 for each test class and each live case.
"""
import json
import os
import random
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import threading
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import harness  # noqa: E402

HARNESS = os.path.join(HERE, "harness.py")
DEMO_LIST = os.path.join(HERE, "demo-commands.json")


def scratch(testcase):
    d = tempfile.mkdtemp(prefix="dh-")
    testcase.addCleanup(shutil.rmtree, d, True)
    return d


def read(path):
    with open(path, encoding="utf-8") as h:
        return h.read()


SLICE = 20


def free_ports(n, slot):
    """n different free ports in the slot-th slice of the harness's range (2800 + 20 * slot, 20 ports), in a random order. Each test class and each live case has a
    slice of its own, so that the test processes of one run, which are concurrent, never choose each other's ports; two runs at the same time still can, and a
    start that is refused for a port with a listener is repeated with other ports by `Live.run_list`."""
    lo = harness.PORT_RANGE[0] + SLICE * slot
    assert lo + SLICE - 1 <= harness.PORT_RANGE[1]
    found = []
    candidates = list(range(lo, lo + SLICE))
    random.shuffle(candidates)
    for p in candidates:
        if p != harness.WORKING_PORT and harness.port_is_free(p):
            found.append(p)
        if len(found) == n:
            return found
    raise RuntimeError("no free port")


def run_cli(*args, **kw):
    env = {k: v for k, v in os.environ.items() if k != "LD_LIBRARY_PATH"}
    return subprocess.run([sys.executable, HARNESS] + list(args), capture_output=True, text=True, stdin=subprocess.DEVNULL, env=env, timeout=kw.get("timeout", 120))


def fake_lock(directory, **fields):
    """A working service's run directory (`<directory>/aperas`) with a lock that names `fields`; -> the run directory."""
    run = os.path.join(directory, "aperas")
    os.makedirs(run)
    lock = {"pid": 2 ** 22 + 5, "socketPath": os.path.join(run, "apeironngn.sock"), "status": "ready", "apeironRoot": "/nowhere/Apeiron", "artifactsRoot": "/nowhere/artifacts", "httpPort": 2877}
    lock.update(fields)
    with open(os.path.join(run, "apeironngn.lock"), "w") as h:
        json.dump(lock, h)
    return run


class Assertions(unittest.TestCase):
    def setUp(self):
        self.out = scratch(self)
        self.world = harness.World(self.out, working_run_dirs=[], real_graph=os.path.join(self.out, "..", "no-such-real-graph"))
        self.ports = free_ports(2, 0)
        self.ref = harness.Side("ref", harness.MONOREPO, self.out, self.ports[0], 509, "g")
        self.new = harness.Side("new", harness.MONOREPO, self.out, self.ports[1], 509, "g")

    def refused(self, side, pattern, world=None, others=()):
        with self.assertRaisesRegex(harness.Refusal, pattern):
            harness.assert_isolated(side, world or self.world, others)

    def test_a_side_of_its_own_is_accepted(self):
        harness.assert_isolated(self.ref, self.world, [self.new])
        harness.assert_isolated(self.new, self.world, [self.ref])

    def test_refuses_the_working_services_run_directory(self):
        working = os.path.join(self.out, "ref", "run", "aperas")
        self.refused(self.ref, "runtime directory .* working service's", harness.World(self.out, working_run_dirs=[working], real_graph="/nowhere"))
        # The working service's run directory may also be the parent of the side's, or lie inside it.
        self.refused(self.ref, "working service's", harness.World(self.out, working_run_dirs=[self.out], real_graph="/nowhere"))
        self.refused(self.ref, "working service's", harness.World(self.out, working_run_dirs=[os.path.join(working, "x")], real_graph="/nowhere"))

    def test_refuses_the_environment_of_a_user_session(self):
        user = "/run/user/%d" % os.getuid()
        self.ref.env["XDG_RUNTIME_DIR"] = user
        self.refused(self.ref, "XDG_RUNTIME_DIR")
        self.ref.xdg_run = user
        self.ref.run_dir = os.path.join(user, "aperas")
        self.refused(self.ref, "outside the output directory|working service's", harness.World(self.out, working_run_dirs=[self.ref.run_dir], real_graph="/nowhere"))

    def test_refuses_a_variable_that_is_not_the_sides_own(self):
        for key in ("XDG_CONFIG_HOME", "APERAS_HTTP_PORT", "APERAS_APEIRON_ROOT", "APERAS_ARTIFACTS_ROOT"):
            side = harness.Side("ref", harness.MONOREPO, self.out, self.ports[0], 509, "g")
            side.env[key] = "/elsewhere"
            self.refused(side, key)
        for key in ("APERAS_GRAPH_NAME", "APERAS_MACHINE_NUMBER"):
            side = harness.Side("ref", harness.MONOREPO, self.out, self.ports[0], 509, "g")
            del side.env[key]
            self.refused(side, key)
        self.ref.env["LD_LIBRARY_PATH"] = "/opt/lib"
        self.refused(self.ref, "LD_LIBRARY_PATH")

    def test_refuses_a_port_that_is_not_free_or_not_ours(self):
        for port, pattern in ((harness.WORKING_PORT, "outside|working service's"), (2900, "outside"), (80, "outside"), (harness.PORT_RANGE[0] - 1, "outside")):
            side = harness.Side("ref", harness.MONOREPO, self.out, port, 509, "g")
            self.refused(side, pattern)
        # The port a working service's lock names, whatever it is.
        port = self.ports[0]
        world = harness.World(self.out, working_run_dirs=[fake_lock(os.path.join(self.out, "w"), httpPort=port)], real_graph="/nowhere")
        self.refused(self.ref, "port .* working service's", world)
        # The other side's port, and a port something listens on.
        twin = harness.Side("new", harness.MONOREPO, self.out, self.ports[0], 509, "g")
        self.refused(twin, "port .* side ref", others=[self.ref])
        s = socket.socket()
        self.addCleanup(s.close)
        s.bind(("127.0.0.1", self.ports[1]))
        s.listen(1)
        self.refused(self.new, "listens on the port")

    def test_refuses_the_live_roots_and_the_real_graph(self):
        real = os.path.join(self.out, "live-graph")
        for root_field in ("apeiron", "artifacts"):
            side = harness.Side("ref", harness.MONOREPO, self.out, self.ports[0], 509, "g")
            setattr(side, root_field, os.path.join(real, "Apeiron" if root_field == "apeiron" else "artifacts"))
            side.env["APERAS_APEIRON_ROOT"], side.env["APERAS_ARTIFACTS_ROOT"] = side.apeiron, side.artifacts
            self.refused(side, "live root|outside", harness.World(self.out, working_run_dirs=[], real_graph=real))
        # A real graph that holds the side's roots, and the roots a working service's lock names.
        self.refused(self.ref, "live root", harness.World(self.out, working_run_dirs=[], real_graph=self.out))
        for field in ("apeironRoot", "artifactsRoot"):
            lock = fake_lock(os.path.join(self.out, "w"), **{field: self.ref.apeiron if field == "apeironRoot" else self.ref.artifacts})
            self.refused(self.ref, "live root", harness.World(self.out, working_run_dirs=[lock], real_graph="/nowhere"))
            shutil.rmtree(os.path.join(self.out, "w"))

    def test_refuses_the_real_graph_beside_this_checkout_by_default(self):
        side = harness.Side("ref", harness.MONOREPO, self.out, self.ports[0], 509, "g")
        side.apeiron = os.path.join(harness.REAL_GRAPH, "Apeiron")
        side.env["APERAS_APEIRON_ROOT"] = side.apeiron
        self.refused(side, "live root|outside", harness.World(self.out, working_run_dirs=[]))

    def test_refuses_roots_and_run_directories_outside_the_output_directory(self):
        elsewhere = scratch(self)
        side = harness.Side("ref", harness.MONOREPO, elsewhere, self.ports[0], 509, "g")
        self.refused(side, "outside the output directory")

    def test_refuses_a_root_outside_the_output_directory_that_is_not_a_live_one(self):
        elsewhere = scratch(self)
        for field, var in (("apeiron", "APERAS_APEIRON_ROOT"), ("artifacts", "APERAS_ARTIFACTS_ROOT")):
            side = harness.Side("ref", harness.MONOREPO, self.out, self.ports[0], 509, "g")
            setattr(side, field, os.path.join(elsewhere, field))
            side.env[var] = os.path.join(elsewhere, field)
            self.refused(side, "root .* outside the output directory")

    def test_refuses_a_side_that_already_has_a_lock_a_socket_or_a_process(self):
        os.makedirs(self.ref.run_dir)
        with open(self.ref.socket_path(), "w"):
            pass
        self.refused(self.ref, "socket exists")
        os.remove(self.ref.socket_path())
        with open(os.path.join(self.ref.run_dir, "apeironngn.lock"), "w") as h:
            h.write("{}")
        self.refused(self.ref, "lock exists")
        os.remove(os.path.join(self.ref.run_dir, "apeironngn.lock"))
        env = dict(os.environ, APERAS_APEIRON_ROOT=self.ref.apeiron)
        p = subprocess.Popen(["sleep", "30"], env=env)
        self.addCleanup(p.wait)
        self.addCleanup(p.kill)
        self.refused(self.ref, "already run")

    def test_refuses_a_socket_path_that_is_too_long(self):
        long_out = os.path.join(self.out, "x" * 90)
        side = harness.Side("ref", harness.MONOREPO, long_out, self.ports[0], 509, "g")
        self.refused(side, "socket path", harness.World(long_out, working_run_dirs=[], real_graph="/nowhere"))

    def test_never_signals_a_process_that_is_not_the_services_of_the_side(self):
        sleeper = subprocess.Popen(["sleep", "30"])
        self.addCleanup(sleeper.wait)
        self.addCleanup(sleeper.kill)
        for pid, pattern in ((os.getpid(), "this process"), (sleeper.pid, "command line")):
            with self.assertRaisesRegex(harness.Refusal, pattern):
                harness.verify_ours(self.ref, pid, self.world)
        # A working service's pid is refused even when the check on the process would otherwise pass.
        working = harness.World(self.out, working_run_dirs=[fake_lock(os.path.join(self.out, "w"), pid=sleeper.pid)], real_graph="/nowhere")
        with self.assertRaisesRegex(harness.Refusal, "working service's lock names it"):
            harness.verify_ours(self.ref, sleeper.pid, working)
        # A side whose lock names a process that is not its service: the stop leaves it running and says so.
        os.makedirs(self.ref.run_dir)
        with open(os.path.join(self.ref.run_dir, "apeironngn.lock"), "w") as h:
            json.dump({"pid": sleeper.pid}, h)
        info = harness.stop_side(self.ref, self.world, 1)
        self.assertEqual(info["signal"], None)
        self.assertEqual(len(info["unverified"]), 1)
        self.assertIsNone(sleeper.poll(), "the process was signalled")


class Cli(unittest.TestCase):
    def setUp(self):
        self.dir = scratch(self)
        self.snap = os.path.join(self.dir, "snap")
        harness.write_demo_snapshot(self.snap)
        self.out = os.path.join(self.dir, "out")
        self.ports = ",".join(str(p) for p in free_ports(2, 1))

    def refused(self, *args, pattern="", out_made=False):
        r = run_cli(*args)
        self.assertEqual(r.returncode, 2, r.stdout + r.stderr)
        self.assertRegex(r.stderr, pattern)
        if not out_made:
            self.assertFalse(os.path.exists(self.out), "an output directory was made for a refused run")
        return r

    def args(self, **over):
        a = {"--snapshot": self.snap, "--out": self.out, "--commands": DEMO_LIST, "--ports": self.ports}
        a.update(over)
        return [x for kv in a.items() for x in kv if x is not None]

    def test_refuses_the_real_graph_root(self):
        self.refused(*self.args(**{"--snapshot": harness.REAL_GRAPH}), pattern="real graph root")

    def test_refuses_an_output_directory_that_is_not_empty_or_lies_in_the_snapshot_or_in_the_real_graph(self):
        os.makedirs(self.out)
        with open(os.path.join(self.out, "x"), "w"):
            pass
        self.refused(*self.args(), pattern="not empty", out_made=True)
        self.assertEqual(os.listdir(self.out), ["x"])
        shutil.rmtree(self.out)
        self.refused(*self.args(**{"--out": os.path.join(self.snap, "inside")}), pattern="lies inside|holds")
        self.refused(*self.args(**{"--out": os.path.join(harness.REAL_GRAPH, "..", "AperasKG", "out-of-a-test")}), pattern="lies inside|holds")
        self.assertFalse(os.path.exists(os.path.join(harness.REAL_GRAPH, "out-of-a-test")))

    def test_refuses_a_snapshot_without_apeiron_or_artifacts(self):
        shutil.rmtree(os.path.join(self.snap, "artifacts"))
        self.refused(*self.args(), pattern="no artifacts/")
        self.refused(*self.args(**{"--snapshot": os.path.join(self.dir, "none")}), pattern="no Apeiron/")

    def test_refuses_bad_ports(self):
        p = self.ports.split(",")[0]   # a port of this class's own slice: another test's service may listen on any other, and that is a different refusal
        for ports in ("2736," + p, p + "," + p, p, "a,b", p + ",2900", p + ",2735"):
            self.refused(*self.args(**{"--ports": ports}), pattern="--ports|outside|working service")

    def test_refuses_a_bad_list_of_commands(self):
        bad = os.path.join(self.dir, "bad.json")
        for text, pattern in (("not json", "cannot be read"), ("[]", "non-empty"), ('[{"args": []}]', "args"), ('[{"args": ["tree"], "x": 1}]', "unknown keys"),
                              ('[{"args": ["tree"], "timeout": "5"}]', "wrong type"), ('{"args": ["tree"]}', "JSON list"),
                              ('[{"fs": [{"op": "nonsense"}]}]', "fs"), ('[{"args": ["tree"], "hangs": ["both"]}]', "hangs"), ('[{"name": "x"}]', "args"), ('{"commands": [{"args": ["tree"]}], "final_flush": 1}', "final_flush")):
            with open(bad, "w") as h:
                h.write(text)
            self.refused(*self.args(**{"--commands": bad}), pattern=pattern)
        self.refused(*self.args(**{"--commands": os.path.join(self.dir, "none.json")}), pattern="cannot be read")

    def test_refuses_a_code_root_without_tsx_and_a_missing_flag(self):
        self.refused(*self.args(**{"--reference-code": scratch(self)}), pattern="has no node_modules")
        self.refused("--snapshot", self.snap, pattern="required")
        self.refused(*self.args(**{"--bogus": "1"}), pattern="usage error")

    def test_the_demo_snapshot_needs_an_empty_directory(self):
        self.assertEqual(run_cli("--demo-snapshot", self.snap).returncode, 2)
        self.assertEqual(run_cli("--demo-snapshot", os.path.join(self.dir, "fresh")).returncode, 0)


class Start(unittest.TestCase):
    """The wait for a service the code's own start call gave up on: no process is started, the run of `aperas` and the checks of the pid are replaced."""

    def setUp(self):
        self.dir = scratch(self)
        self.side = harness.Side("ref", harness.MONOREPO, os.path.join(self.dir, "out"), 2800, 509, "g")
        os.makedirs(self.side.run_dir)
        self.lock_path = os.path.join(self.side.run_dir, "apeironngn.lock")
        for name, value in (("assert_isolated", lambda *a: None), ("verify_ours", lambda *a: None)):
            patcher = mock.patch.object(harness, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def write_lock(self, status, pid=None):
        lock = {"pid": os.getpid() if pid is None else pid, "status": status, "socketPath": self.side.socket_path(), "apeironRoot": self.side.apeiron,
                "artifactsRoot": self.side.artifacts, "httpPort": self.side.port}
        with open(self.lock_path + ".part", "w") as h:
            json.dump(lock, h)
        os.replace(self.lock_path + ".part", self.lock_path)

    def start(self, result, timeout=10):
        with mock.patch.object(harness, "run_aperas", return_value=result):
            return harness.start_side(self.side, harness.World(self.dir, working_run_dirs=[]), [], timeout)

    LATE = {"status": 1, "seconds": 5.0, "stdout": "", "stderr": "[aperas] Failed: ApeironNgn service did not become ready in time", "timed_out": False}

    def test_a_start_call_that_gave_up_early_is_waited_out_until_the_lock_says_ready(self):
        self.write_lock("starting")
        timer = threading.Timer(1.0, self.write_lock, ("ready",))
        timer.start()
        self.addCleanup(timer.join)
        t = time.time()
        info = self.start(self.LATE)
        self.assertGreaterEqual(time.time() - t, 0.9)
        self.assertTrue(info["late"])
        self.assertEqual(info["lock"]["status"], "ready")

    def test_a_service_that_ends_or_never_gets_ready_is_still_a_failed_start(self):
        self.write_lock("starting", pid=2 ** 22 + 5)   # no such process: the wait ends at once, whatever the timeout
        with self.assertRaisesRegex(harness.Failure, "did not start"):
            self.start(self.LATE, timeout=3600)
        self.write_lock("starting")   # alive and never ready: the wait ends at the start timeout
        t = time.time()
        with self.assertRaisesRegex(harness.Failure, "did not start"):
            self.start(self.LATE, timeout=0.5)
        self.assertGreaterEqual(time.time() - t, 0.4)

    def test_another_failure_of_the_start_call_is_not_waited_for(self):
        self.write_lock("starting")
        with mock.patch.object(harness, "wait_ready") as wait, self.assertRaisesRegex(harness.Failure, "did not start"):
            self.start(dict(self.LATE, stderr="[aperas] Failed: something else"))
        wait.assert_not_called()


class LiveBase(unittest.TestCase):
    """Two services of the new code, one on each side, on the demo snapshot: the harness's own run, with the reference code standing in for `Aperas/`. The cases are in `Live`
    and, for the keys of a list that piece 4 added, in `test_steps.py`, which uses this class as its base (it has no case of its own)."""

    def setUp(self):
        self.dir = scratch(self)
        self.snap = os.path.join(self.dir, "snap")
        harness.write_demo_snapshot(self.snap)
        self.out = os.path.join(self.dir, "out")
        self.slot = 2 + sorted(m for m in dir(self) if m.startswith("test_")).index(self._testMethodName)
        self.ports = ",".join(str(p) for p in free_ports(2, self.slot))
        self.before = harness.manifest(self.snap)

    def run_list(self, path):
        """The harness's run of `path` -> its process. A start refused because something listens on a port (a test run of another process at the same time took one of
        this case's ports between the choice and the start) writes and starts nothing that stays, so it is repeated with other ports, up to five times."""
        for attempt in range(5):
            r = run_cli("--snapshot", self.snap, "--out", self.out, "--commands", path, "--ports", self.ports, "--reference-code", harness.MONOREPO)
            if r.returncode != 2 or "something listens on the port" not in r.stderr + r.stdout:
                return r
            shutil.rmtree(self.out, True)
            self.ports = ",".join(str(p) for p in free_ports(2, self.slot))
        return r

    def own_processes(self):
        return harness.processes_with_env(["XDG_RUNTIME_DIR=" + os.path.join(self.out, side, "run") for side in ("ref", "new")])

    def results(self):
        with open(os.path.join(self.out, "results.json")) as h:
            return json.load(h)


class Live(LiveBase):
    def test_the_demo_list_runs_on_both_sides_and_leaves_nothing(self):
        working = {pid for pid in harness.World(self.out).pids() if harness.is_alive(pid)}
        r = self.run_list(DEMO_LIST)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("DIFFERENTIAL RUN: COMPLETE", r.stdout)
        res = self.results()
        self.assertEqual([c["name"] for c in res["commands"]], ["track", "ingest", "tree", "final-flush"])
        for c in res["commands"]:
            for side in ("ref", "new"):
                self.assertEqual(c[side]["status"], 0, c)
        # Each command's output is kept, and the tree is the one the ingest made on each side.
        for side in ("ref", "new"):
            tree = read(os.path.join(self.out, "commands", "003-tree.%s.stdout" % side))
            self.assertIn("## Beta Section", tree)
            self.assertTrue(os.path.isdir(os.path.join(self.out, "dumps", side, "Apeiron")))
        # The reference copy is the snapshot's; the new copy is migrated (the profile Dinh Le gets its kind).
        profile = lambda side: read(os.path.join(self.out, side, "Apeiron", "Profile.jsonld"))
        self.assertNotIn('"kind"', read(os.path.join(self.snap, "Apeiron", "Profile.jsonld")))
        self.assertNotIn('"kind"', profile("ref").split("dinhlx")[1][:200])
        self.assertIn('"kind": "human"', profile("new"))
        self.assertEqual(res["copies"]["ref"], res["copies"]["new"])
        self.assertNotEqual(res["copies"]["newMigrated"], res["copies"]["new"])
        # Two different services on two ports, none of them the working one; nothing left running; the working service and the snapshot untouched.
        pids = {s["pid"] for s in res["starts"].values()}
        self.assertEqual(len(pids), 2)
        self.assertFalse(pids & working)
        self.assertEqual(self.own_processes(), [])
        self.assertEqual(res["processesLeft"], [])
        self.assertTrue(res["working"]["untouched"])
        self.assertTrue(all(harness.is_alive(pid) for pid in working))
        self.assertEqual(harness.manifest(self.snap), self.before)
        self.assertEqual(res["problems"], [])

    def test_an_unexpected_status_fails_the_run_and_the_services_are_still_stopped(self):
        path = os.path.join(self.dir, "list.json")
        with open(path, "w") as h:
            json.dump([{"name": "missing", "args": ["show", "cmd_demo/none.md"], "status": 0}, {"name": "tree", "args": ["tree", "cmd_demo/none.md"], "stdin": "ignored\n"}], h)
        r = self.run_list(path)
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertIn("DIFFERENTIAL RUN: FAILED", r.stdout)
        self.assertRegex(r.stdout, r"command 1 \(missing\) on the side ref ended with status \d+, not the expected 0")
        self.assertEqual(self.own_processes(), [])
        self.assertEqual(self.results()["processesLeft"], [])

    def test_a_command_that_outlives_its_timeout_is_killed_and_reported(self):
        path = os.path.join(self.dir, "list.json")
        with open(path, "w") as h:
            json.dump([{"name": "slow", "args": ["tree", "cmd_demo/beta.md"], "timeout": 0.05}], h)
        r = self.run_list(path)
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertRegex(r.stdout, r"outlived its timeout and was killed")
        self.assertEqual(self.own_processes(), [])


if __name__ == "__main__":
    unittest.main()
