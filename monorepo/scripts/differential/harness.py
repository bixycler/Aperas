#!/usr/bin/env python3
"""The skeleton of the differential harness (Python 3, standard library only; planning/core.md, Batch 13, piece 2).

  python3 monorepo/scripts/differential/harness.py --snapshot <graph-root> --out <dir> --commands <list.json> --ports <p1,p2>
         [--reference-code <monorepo>] [--new-code <monorepo>] [--machine-number N] [--graph-name NAME] [--thread-size-cap N]
         [--command-timeout S] [--start-timeout S] [--stop-timeout S] [--tools <dir>] [--allow-real-root]
  python3 monorepo/scripts/differential/harness.py --demo-snapshot <dir>      # writes a small old-form snapshot and exits

From one snapshot of a graph root (`<graph-root>/Apeiron/` with its `.state/`, `<graph-root>/artifacts/`, and `aperas.config.json` when
there is one) the harness makes two copies under `<dir>`: `ref/`, the reference, unmigrated, and `new/`, migrated by `migrate-mirror.py`
(`--tools` names the directory that holds it; default: the directory above this one). It starts two services apart, `ref` from the
reference code (`--reference-code`, default: the `Aperas/` checkout beside this one, run without writing in it) and `new` from this
checkout (`--new-code`), each with its own `XDG_RUNTIME_DIR` (`<dir>/<side>/run`), `XDG_CONFIG_HOME`, port (`--ports`, two ports of the
range 2800 to 2899, the reference's first), both roots, graph name and the one `APERAS_MACHINE_NUMBER`. Before each start it asserts
all of it again (`assert_isolated`) and refuses to start if anything points at the working service's runtime directory, port or roots,
at the real graph, or outside `<dir>`. It then runs the list of commands on each side in turn (every command with the side's
environment, in the side's graph root, with stdin closed unless the command gives a `stdin` text, under a timeout, with `--flush`
and `--no-prompt` added where the verb has them), records for each the exit status, stdout and stderr, ends with `flush` on each,
copies both dumps (`<dir>/dumps/<side>/Apeiron`), and stops its own services by the pid of each one's own lock, after checking
that the pid is that service (its command line holds the side's code root, its environment the side's roots and run directory, and
it is not a pid a working service's lock names). It never signals any other process. The `untouched` of `results["working"]` means that no pid a working service's lock named was
signalled by the harness (`World.signal` records every signal sent by pid); it does not say the working service is still alive, which an idle stop of its own can end during a run. Nothing is compared: the normaliser and the comparer are piece 3.

The list of commands is a JSON list of objects: `{"name": "...", "args": ["verb", ...], "stdin": "text" (optional, piped; without it
the command reads /dev/null), "timeout": S (optional), "status": N (optional: the exit status each side must give; a command that does
not is an unexpected status and the run exits 1), "flush": false, "no_prompt": false (optional: leave the flag out)}`.

Output under `<dir>`: `ref/`, `new/` (roots, run directory, config directory), `commands/NNN-<name>.<side>.{stdout,stderr}`, `dumps/`,
`results.json` (the snapshot's digest, both code roots with their git state before and after, the ports, the working service seen,
every command's status, time and files, the starts and stops, the processes left over) and a table on stdout that ends
`DIFFERENTIAL RUN: COMPLETE` (exit 0) or `DIFFERENTIAL RUN: FAILED` (exit 1: a start, a stop or a migration that failed, an unexpected
status, a process left over, the reference's checkout changed). Exit 2: a usage error or a refusal; nothing is started.
`--allow-real-root` lets the snapshot be the real graph root (which is only read); a copy made with `cp -a` is the normal snapshot.

The list may also be an object `{"final_flush": false, "commands": [...]}`; `final_flush` (default true) says whether the run ends with the `flush` of the table above.
Piece 4 adds these keys to a command: `"fs": [...]` (edits of the files of both sides before the command: `write`, `modify-document`, `edit-embedded`, `duplicate-document`, `truncate`, `delete`; see
`apply_fs`), `"wait": S` (seconds to wait before the command), a step with no `args` (an `fs` or `wait` step alone), `"capture": true` (copy the side's `Apeiron/` to
`captures/NNN-<name>/<side>/Apeiron` right after the command), `"status_ref"` and `"status_new"` (the status each side must give, for a command whose sides differ on
purpose; they replace `status` for their side), `"hangs": ["ref"]` (the sides on which the command is expected to outlive its timeout: the reference engine loops on a move into
its own subtree; such a side is not given another command, and its service, which cannot answer a signal, is killed by the pid of its lock after a short wait) and
`"comment"`. The services' `service.log` files are copied to `<dir>/logs/<side>.service.log` after the stops.
A command may also carry `"then_fs": [...]` (the same edits as `fs`, applied to a side right after that side's command, before the next side's command starts: a command and the edit that
must follow it by milliseconds, as a case that edits a file under a pending write needs; the service's timer has no time to flush in between).
`--content-flush-ms N` writes a flush interval of N ms for the content graph (`graphs.tree.flushIntervalMs`) into the new side's scratch `aperas.config.json` (made from the snapshot's, or
a minimal one beside the roots), so that no timer of the new service flushes the content during a case; the reference has no such setting and keeps its 10 s timer.
A command whose answer on a side is exactly `No ApeironNgn service running` while that side's service process is alive is run again (the client throws before it sends anything, so the
command did not run), up to 3 times after a wait for the service to answer a ping; every retry is recorded in `results.json` (`retries`) and printed, never hidden.
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.dirname(HERE)
MONOREPO = os.path.dirname(SCRIPTS)
REAL_GRAPH = os.path.realpath(os.path.join(MONOREPO, "..", "AperasKG"))
DEFAULT_REFERENCE = os.path.join(MONOREPO, "..", "..", "Aperas", "monorepo")
ENTRY = os.path.join("packages", "cli", "src", "aperas.ts")
WORKING_PORT = 2736
PORT_RANGE = (2800, 2899)
SOCKET_PATH_LIMIT = 100
# The verbs that take `--flush` and `--no-prompt` (read from the sources of both code bases; the reference also has `unlink` and `migrate-frontmatter`).
FLUSH_VERBS = {"fold", "ingest", "remove", "project", "insert", "profile", "retype", "resolve", "unfold", "zoom", "track", "update", "unlink", "migrate-frontmatter"}
NO_PROMPT_VERBS = {"ingest", "track"}
DEMO_FILES = {
    "cmd_demo/beta.md": "# Beta\n\nBeta intro.\n\n## Beta Section\n\nBeta section text.\n\n## Other\n\nOther text.\n",
    "cmd_demo/dup.md": "# Dup\n\nDup intro.\n\n## Item One\n\nOne.\n\n## Item Two\n\nTwo.\n",
    "cmd_demo/gamma.md": "# Gamma\n\nSee [later]([[NotYetWritten]]).\n",
}
DEMO_PROFILES = [
    {"@id": "Profile:00CA03JXD8000", "@type": "Profile", "handle": "default"},
    {"@id": "Profile:00CJC4S69R000", "@type": "Profile", "handle": "dinhlx", "name": "Dinh Le"},
]


class Refusal(Exception):
    """A usage error or a refusal to start or signal something: exit status 2."""


class Failure(Exception):
    """The run cannot go on: exit status 1."""


# ---------------------------------------------------------------------------------------------------------------- paths

def real(path):
    return os.path.realpath(path)


def same_or_inside(path, directory):
    rel = os.path.relpath(real(path), real(directory))
    return rel == "." or not (rel == ".." or rel.startswith(".." + os.sep) or os.path.isabs(rel))


def overlaps(a, b):
    """True when one path is the other or lies inside it."""
    return same_or_inside(a, b) or same_or_inside(b, a)


def default_working_run_dirs():
    """The run directories a working service of this user can have: the one this environment names, the user's session directory and the fallback."""
    uid = os.getuid()
    found = []
    if os.environ.get("XDG_RUNTIME_DIR"):
        found.append(os.path.join(os.environ["XDG_RUNTIME_DIR"], "aperas"))
    found.append(os.path.join("/run/user", str(uid), "aperas"))
    found.append(os.path.join(tempfile.gettempdir(), "aperas-%d" % uid))
    out = []
    for d in found:
        if real(d) not in [real(x) for x in out]:
            out.append(d)
    return out


def read_json(path):
    try:
        with open(path, encoding="utf-8") as h:
            return json.load(h)
    except (OSError, ValueError):
        return None


def lock_of(run_dir):
    """The lock a run directory holds (`<run_dir>/apeironngn.lock`, `run_dir` being the `aperas` directory), or None."""
    return read_json(os.path.join(run_dir, "apeironngn.lock"))


class World:
    """What the harness must never touch: the working service's run directories, locks, ports, pids and roots, and the real graph."""

    def __init__(self, out, working_run_dirs=None, real_graph=REAL_GRAPH):
        self.out = out
        self.working_run_dirs = list(default_working_run_dirs() if working_run_dirs is None else working_run_dirs)
        self.real_graph = real_graph
        self.signalled = set()   # every pid the harness has sent a signal to by its pid (not the groups of its own children), recorded before the signal is sent

    def signal(self, pid, sig):
        """The only way the harness signals a service by its pid: refuses a pid a working service's lock names, records the pid, then sends the signal."""
        if pid in self.pids():
            raise Refusal("refusing to signal pid %d: a working service's lock names it" % pid)
        self.signalled.add(pid)
        os.kill(pid, sig)

    def untouched(self, pids_at_start):
        """The verdict on the working service: True while no pid a working lock named (at the start or now) was signalled by the harness. It says nothing about whether those
        pids are alive at the end: a working service that stopped by its own idle timer during the run leaves it True."""
        return not (self.signalled & (set(pids_at_start) | self.pids()))

    def locks(self):
        return [lk for lk in (lock_of(d) for d in self.working_run_dirs) if isinstance(lk, dict)]

    def ports(self):
        return {WORKING_PORT} | {int(lk["httpPort"]) for lk in self.locks() if isinstance(lk.get("httpPort"), int)}

    def pids(self):
        return {int(lk["pid"]) for lk in self.locks() if isinstance(lk.get("pid"), int)}

    def live_roots(self):
        roots = [self.real_graph]
        for lk in self.locks():
            roots += [lk[k] for k in ("apeironRoot", "artifactsRoot") if isinstance(lk.get(k), str)]
        return roots


# ---------------------------------------------------------------------------------------------------------------- processes

def proc_text(pid, name):
    with open("/proc/%d/%s" % (pid, name), "rb") as h:
        return h.read().decode("utf-8", "replace")


def is_alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    try:
        return proc_text(pid, "stat").rsplit(")", 1)[1].split()[0] != "Z"
    except OSError:
        return False


def processes_with_env(needles):
    """The pids (other than this process) whose environment holds any of `needles` (`NAME=value`): the processes of a side."""
    found = []
    if not os.path.isdir("/proc/self"):
        raise Refusal("this harness needs /proc (Linux) to find the processes of its own services")
    for name in os.listdir("/proc"):
        if not name.isdigit() or int(name) == os.getpid():
            continue
        try:
            env = proc_text(int(name), "environ")
        except OSError:
            continue
        if any(n + "\0" in env for n in needles):
            found.append(int(name))
    return sorted(found)


# ---------------------------------------------------------------------------------------------------------------- a side

class Side:
    def __init__(self, name, code, base, port, machine, graph_name, thread_cap=None):
        self.name = name
        self.code = os.path.abspath(code)
        self.root = os.path.join(base, name)
        self.apeiron = os.path.join(self.root, "Apeiron")
        self.artifacts = os.path.join(self.root, "artifacts")
        self.xdg_run = os.path.join(self.root, "run")
        self.run_dir = os.path.join(self.xdg_run, "aperas")
        self.xdg_config = os.path.join(self.root, "config")
        self.port = port
        self.tsx = os.path.join(self.code, "node_modules", ".bin", "tsx")
        self.entry = os.path.join(self.code, ENTRY)
        self.env = self._env(machine, graph_name, thread_cap)

    def _env(self, machine, graph_name, thread_cap):
        env = {k: v for k, v in os.environ.items() if k != "LD_LIBRARY_PATH" and not k.startswith("APERAS_") and k not in ("XDG_RUNTIME_DIR", "XDG_CONFIG_HOME")}
        env.update({
            "XDG_RUNTIME_DIR": self.xdg_run,
            "XDG_CONFIG_HOME": self.xdg_config,
            "APERAS_HTTP_PORT": str(self.port),
            "APERAS_APEIRON_ROOT": self.apeiron,
            "APERAS_ARTIFACTS_ROOT": self.artifacts,
            "APERAS_GRAPH_NAME": graph_name,
            "APERAS_MACHINE_NUMBER": str(machine),
        })
        if thread_cap is not None:
            env["APERAS_THREAD_SIZE_CAP"] = str(thread_cap)
        return env

    def needles(self):
        """The `NAME=value` pairs that, in a process's environment, make it a process of this side."""
        return ["APERAS_APEIRON_ROOT=" + self.apeiron, "XDG_RUNTIME_DIR=" + self.xdg_run]

    def lock(self):
        return lock_of(self.run_dir)

    def socket_path(self):
        return os.path.join(self.run_dir, "apeironngn.sock")


def port_is_free(port):
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind(("127.0.0.1", port))
        return True
    except OSError:
        return False
    finally:
        s.close()


def assert_isolated(side, world, others=()):
    """Raises `Refusal` unless everything that names `side`'s service is its own and none is the working service's, the real graph's or outside the output directory."""
    def fail(what):
        raise Refusal("refusing to touch the service of the side %s: %s" % (side.name, what))

    env = side.env
    expected = {
        "XDG_RUNTIME_DIR": side.xdg_run, "XDG_CONFIG_HOME": side.xdg_config, "APERAS_HTTP_PORT": str(side.port),
        "APERAS_APEIRON_ROOT": side.apeiron, "APERAS_ARTIFACTS_ROOT": side.artifacts,
    }
    for key, value in expected.items():
        if env.get(key) != value:
            fail("%s is %r in the environment it would start with, not %r" % (key, env.get(key), value))
    for key in ("APERAS_GRAPH_NAME", "APERAS_MACHINE_NUMBER"):
        if not env.get(key):
            fail("%s is not set" % key)
    if "LD_LIBRARY_PATH" in env:
        fail("LD_LIBRARY_PATH is set in the environment it would start with")
    if not os.path.isabs(side.xdg_run) or not os.path.isabs(side.apeiron) or not os.path.isabs(side.artifacts):
        fail("a runtime directory or a root is not an absolute path")
    # The run directory: ours, inside the output directory, and nowhere near a working service's.
    if not same_or_inside(side.xdg_run, world.out):
        fail("the runtime directory %s is outside the output directory %s" % (side.xdg_run, world.out))
    for d in world.working_run_dirs:
        if overlaps(side.run_dir, d):
            fail("the runtime directory %s is the working service's (%s)" % (side.xdg_run, d))
    for other in others:
        if overlaps(side.xdg_run, other.xdg_run):
            fail("the runtime directory %s overlaps the one of the side %s" % (side.xdg_run, other.name))
    if len(side.socket_path()) > SOCKET_PATH_LIMIT:
        fail("the socket path %s is longer than %d characters; give a shorter output directory" % (side.socket_path(), SOCKET_PATH_LIMIT))
    # The port.
    if not PORT_RANGE[0] <= side.port <= PORT_RANGE[1]:
        fail("the port %d is outside %d to %d" % (side.port, PORT_RANGE[0], PORT_RANGE[1]))
    if side.port in world.ports():
        fail("the port %d is the working service's" % side.port)
    for other in others:
        if other.port == side.port:
            fail("the port %d is the one of the side %s" % (side.port, other.name))
    # The roots: inside the output directory, not the live roots, not holding them, not inside them.
    for root in (side.apeiron, side.artifacts):
        if not same_or_inside(root, world.out):
            fail("the root %s is outside the output directory %s" % (root, world.out))
        for live in world.live_roots():
            if overlaps(root, live):
                fail("the root %s is, holds or lies inside the live root %s" % (root, live))
    # Nothing of ours is running or locked already.
    if os.path.exists(os.path.join(side.run_dir, "apeironngn.lock")):
        fail("a lock exists in %s" % side.run_dir)
    if os.path.exists(side.socket_path()):
        fail("a socket exists at %s" % side.socket_path())
    left = processes_with_env(side.needles())
    if left:
        fail("processes %s already run with this side's roots or runtime directory" % left)
    if not port_is_free(side.port):
        fail("something listens on the port %d" % side.port)


def verify_ours(side, pid, world):
    """Raises `Refusal` unless `pid` is the service of `side`: the only kind of pid this harness signals."""
    def fail(what):
        raise Refusal("refusing to signal pid %d: %s" % (pid, what))

    if pid == os.getpid():
        fail("it is this process")
    if pid in world.pids():
        fail("a working service's lock names it")
    try:
        cmdline = proc_text(pid, "cmdline").replace("\0", " ")
        env = proc_text(pid, "environ")
    except OSError as e:
        fail("its command line or environment cannot be read (%s)" % e)
    if side.code not in cmdline or "service" not in cmdline:
        fail("its command line is %r, not a service of the code %s" % (cmdline.strip()[:200], side.code))
    for needle in side.needles():
        if needle + "\0" not in env:
            fail("its environment lacks %s" % needle)


# ---------------------------------------------------------------------------------------------------------------- running

class Interrupted(Exception):
    pass


def decode(b):
    return (b or b"").decode("utf-8", "replace")


def run_aperas(side, argv, timeout, stdin_text=None):
    """One `aperas` call on `side` -> dict(status, seconds, stdout, stderr, timed_out). `status` is None for a call that outlived `timeout` and was killed."""
    cmd = [side.tsx, side.entry] + list(argv)
    t = time.time()
    p = subprocess.Popen(cmd, cwd=side.root, env=side.env, stdin=subprocess.PIPE if stdin_text is not None else subprocess.DEVNULL,
                         stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
    timed_out = False
    try:
        out, err = p.communicate(stdin_text.encode("utf-8") if stdin_text is not None else None, timeout=timeout)
    except subprocess.TimeoutExpired:
        timed_out = True
        try:
            os.killpg(p.pid, signal.SIGKILL)  # the group of our own child, which started it as the leader of a session of its own
        except ProcessLookupError:
            pass
        out, err = p.communicate()
    return {"status": None if timed_out else p.returncode, "seconds": round(time.time() - t, 3), "stdout": decode(out), "stderr": decode(err), "timed_out": timed_out}


def build_argv(cmd):
    args = list(cmd["args"])
    verb = args[0]
    if cmd.get("flush", True) and verb in FLUSH_VERBS and "--flush" not in args:
        args.append("--flush")
    if cmd.get("no_prompt", True) and verb in NO_PROMPT_VERBS and "--no-prompt" not in args:
        args.append("--no-prompt")
    return args


NOT_READY_IN_TIME = "did not become ready in time"
# The reference's client throws this before it sends anything when its service does not answer a ping within 0.3 s (a busy service): the command did not run.
NO_SERVICE_ANSWER = "[aperas] Failed: No ApeironNgn service running. Start one with: aperas service start"
MAX_RETRIES = 3


def side_service_alive(side):
    """True while a process of the side's environment (its service; the short-lived client that claimed the lock is gone by then) is alive and not a zombie."""
    return any(is_alive(pid) for pid in processes_with_env(side.needles()))


def side_service_alive(side):
    """True while a process of the side's environment (its service; the short-lived client that claimed the lock is gone by then) is alive and not a zombie."""
    return any(is_alive(pid) for pid in processes_with_env(side.needles()))


def is_no_service_answer(res):
    """True when the call ended with exactly the client's refusal to send, and printed nothing else: the command did not run."""
    return res["status"] == 1 and not res["timed_out"] and res["stderr"].strip() == NO_SERVICE_ANSWER and res["stdout"].strip() == ""


def run_command(side, argv, timeout, stdin_text, wait_cap, then_fs=None):
    """One command on one side, given to a service that answers: a wait for a ping first (the reference's client takes a service that does not answer a ping within 0.3 s for no
    service, and a service of a large mirror is busy for seconds after a write), then the call; a call that ends with exactly `NO_SERVICE_ANSWER` while a process of the side is alive did
    not run, and is made again after a new wait, up to `MAX_RETRIES` times. `then_fs` (edits of files) is applied to the side right after the last call. The waits and the retries are
    returned, so how often a service was busy is data. -> dict(res, busy, retries=[{"seconds": the failed call's, "waited": the wait before the next}], fs_error=text or None)."""
    busy = wait_answering(side, wait_cap) if side.lock() is not None else 0.0
    res = run_aperas(side, argv, timeout, stdin_text)
    retries = []
    while is_no_service_answer(res) and len(retries) < MAX_RETRIES and side_service_alive(side):
        retries.append({"seconds": res["seconds"], "waited": wait_answering(side, wait_cap)})
        res = run_aperas(side, argv, timeout, stdin_text)
    fs_error = None
    if then_fs:
        try:
            apply_fs(side, then_fs)
        except Refusal as e:
            fs_error = str(e)
    return {"res": res, "busy": busy, "retries": retries, "fs_error": fs_error}


def place_config(side, snapshot, content_flush_ms=None):
    """Puts the side's scratch `aperas.config.json` beside its roots: the snapshot's own when it has one (the reference's always is a plain copy). With `content_flush_ms` the file of the new
    side also holds `graphs.tree.flushIntervalMs`; with no config in the snapshot it is a minimal one that names the side's two roots. -> the config written, or None when there is none."""
    src = os.path.join(snapshot, "aperas.config.json")
    dst = os.path.join(side.root, "aperas.config.json")
    if content_flush_ms is None or side.name != "new":
        if os.path.isfile(src):
            shutil.copy2(src, dst)
            return read_json(src)
        return None
    cfg = read_json(src) if os.path.isfile(src) else {"graph": {"apeiron": "./Apeiron", "artifacts": "./artifacts"}}
    if not isinstance(cfg, dict):
        raise Refusal("the snapshot's aperas.config.json is not a JSON object")
    graphs = dict(cfg.get("graphs") or {})
    graphs["tree"] = dict(graphs.get("tree") or {}, flushIntervalMs=content_flush_ms)
    cfg["graphs"] = graphs
    with open(dst, "w", encoding="utf-8") as h:
        json.dump(cfg, h, indent=2)
        h.write("\n")
    return cfg


def wait_ready(side, timeout):
    """Wait until the lock in the side's run directory says `ready`, or the process the lock names has ended and no other process of the side is alive (the lock of the reference's
    service names the short-lived client that claimed it until the service itself rewrites it, so a dead pid alone does not say the service has ended), or `timeout` seconds have passed."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        lock = side.lock()
        if isinstance(lock, dict) and lock.get("status") == "ready":
            return
        named_alive = isinstance(lock, dict) and isinstance(lock.get("pid"), int) and is_alive(lock["pid"])
        if not named_alive and not side_service_alive(side):
            return
        time.sleep(0.5)


def answers_ping(side, timeout=2.0):
    """True when the side's service answers a `ping` on its socket within `timeout` seconds (a lock that says `ready` names a service that may still be busy with its start)."""
    c = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    c.settimeout(timeout)
    try:
        c.connect(side.socket_path())
        c.sendall(b'{"op":"ping"}\n')
        data = b""
        while b"\n" not in data:
            chunk = c.recv(4096)
            if not chunk:
                return False
            data += chunk
        return json.loads(data.split(b"\n", 1)[0].decode("utf-8")).get("ok") is True
    except (OSError, ValueError):
        return False
    finally:
        c.close()


def wait_answering(side, timeout):
    """Waits until the side's service answers a ping, or no process of the side is alive any more, or `timeout` seconds have passed. -> seconds waited."""
    t = time.time()
    while time.time() - t < timeout:
        if answers_ping(side):
            break
        if not side_service_alive(side):
            break
        time.sleep(0.5)
    return round(time.time() - t, 3)


def rss_of(pid):
    """-> {"rss": kB, "peak": kB} of a process, from /proc (VmRSS and VmHWM), or None."""
    try:
        text = proc_text(pid, "status")
    except OSError:
        return None
    out = {}
    for key, name in (("VmRSS", "rss"), ("VmHWM", "peak")):
        m = re.search(r"^%s:\s+(\d+) kB" % key, text, re.M)
        if m:
            out[name] = int(m.group(1))
    return out or None


def settle_after_service_command(side, argv, res, timeout):
    """After a `service start` or `restart`: a call that gave up before the service was ready (the reference's client waits 5 s for the lock to say `ready`; a service on a large
    mirror takes far longer, and goes on starting) is waited out until the lock says `ready` or no process of the side is alive any more; then, whatever the call said, the
    side's service is waited for until it answers a ping (the reference's client takes a service that does not answer within 0.3 s for no service, and clears its lock: a service still busy
    with its start must not be given the next command). -> seconds waited, or None when there was nothing to wait for."""
    if argv[:2] not in (["service", "start"], ["service", "restart"]):
        return None
    t = time.time()
    if res["status"] not in (0, None) and NOT_READY_IN_TIME in (res["stdout"] + res["stderr"]):
        wait_ready(side, timeout)
    wait_answering(side, max(timeout - (time.time() - t), 0))
    return round(time.time() - t, 3)


def start_side(side, world, others, timeout):
    assert_isolated(side, world, others)
    t = time.time()
    r = run_aperas(side, ["service", "start"], timeout)
    late = False
    if r["status"] not in (0, None) and NOT_READY_IN_TIME in (r["stdout"] + r["stderr"]):
        # The code's own start call gives up after a few seconds of the wall clock (a constant of its client, in either code base) while the service it spawned goes
        # on starting, as slowly as a loaded machine makes it. What this run needs is the service ready, not the call: wait for the lock of the service to say
        # ready, or for that service to end, within `timeout`.
        wait_ready(side, max(timeout - (time.time() - t), 0))
        late = True
    lock = side.lock()
    info = {"seconds": round(time.time() - t, 3), "status": r["status"], "stdout": r["stdout"].strip(), "stderr": r["stderr"].strip(), "lock": lock, "late": late}
    if (r["status"] != 0 and not late) or not isinstance(lock, dict) or lock.get("status") != "ready":
        raise Failure("the service of the side %s did not start (status %s): %s %s" % (side.name, r["status"], r["stdout"].strip(), r["stderr"].strip()))
    if lock.get("socketPath") != side.socket_path() or lock.get("apeironRoot") != side.apeiron or lock.get("artifactsRoot") != side.artifacts or lock.get("httpPort") != side.port:
        raise Failure("the service of the side %s bound to something else than its own: %s" % (side.name, json.dumps(lock)))
    verify_ours(side, lock["pid"], world)
    info["pid"] = lock["pid"]
    info["rss"] = rss_of(lock["pid"])
    info["answeringAfter"] = wait_answering(side, max(timeout - (time.time() - t), 0))
    return info


def stop_side(side, world, timeout):
    """Stops the side's service: the pid its own lock names and any other process of the side that is a service of its code (a service that
    was still starting when its start failed). Each pid is checked by `verify_ours` first; a process of the side that fails the check is left alone and reported."""
    lock = side.lock()
    pids = {lock["pid"]} if isinstance(lock, dict) and isinstance(lock.get("pid"), int) else set()
    pids |= set(processes_with_env(side.needles()))
    info = {"pids": sorted(pids), "signal": None, "unverified": []}
    ours = []
    for pid in sorted(pids):
        if not is_alive(pid):
            continue
        try:
            verify_ours(side, pid, world)
            ours.append(pid)
        except Refusal as e:
            info["unverified"].append(str(e))
    for pid in ours:
        world.signal(pid, signal.SIGTERM)
        info["signal"] = "SIGTERM"
    deadline = time.time() + timeout
    while time.time() < deadline and any(is_alive(pid) for pid in ours):
        time.sleep(0.05)
    for pid in ours:
        if is_alive(pid):
            verify_ours(side, pid, world)
            world.signal(pid, signal.SIGKILL)
            info["signal"] = "SIGKILL"
    deadline = time.time() + 15
    while time.time() < deadline and processes_with_env(side.needles()):
        time.sleep(0.05)
    info["stopped"] = not any(is_alive(pid) for pid in pids)
    info["left"] = processes_with_env(side.needles())
    return info


def manifest(path):
    """{relative path: sha256} of every file under `path`, dot directories included."""
    out = {}
    for d, _, names in os.walk(path):
        for n in names:
            f = os.path.join(d, n)
            if os.path.islink(f):
                out[os.path.relpath(f, path)] = "link:" + os.readlink(f)
                continue
            h = hashlib.sha256()
            with open(f, "rb") as fh:
                for chunk in iter(lambda: fh.read(1 << 20), b""):
                    h.update(chunk)
            out[os.path.relpath(f, path)] = h.hexdigest()
    return out


def digest_of(m):
    return hashlib.sha256(json.dumps(m, sort_keys=True).encode()).hexdigest()


def git_state(code):
    """-> {head, status} of a checkout, read with no lock taken (nothing is written); None for a directory that is not a git checkout."""
    env = dict(os.environ, GIT_OPTIONAL_LOCKS="0")
    def git(*args):
        r = subprocess.run(["git", "--no-optional-locks", "-C", code] + list(args), capture_output=True, text=True, env=env, stdin=subprocess.DEVNULL)
        return r.stdout.strip() if r.returncode == 0 else None
    head = git("rev-parse", "HEAD")
    if head is None:
        return None
    return {"head": head, "status": git("status", "--porcelain") or ""}


def copy_tree(src, dst):
    shutil.copytree(src, dst, symlinks=True)


# ---------------------------------------------------------------------------------------------------------------- the demo snapshot

def write_demo_snapshot(directory):
    """A small snapshot in the old form: the two profiles the migration needs, the empty files of the other three kinds (the reference's loader needs all four) and three of the `cmd_demo` files."""
    if os.path.exists(directory) and os.listdir(directory):
        raise Refusal("%s is not empty" % directory)
    os.makedirs(os.path.join(directory, "Apeiron"), exist_ok=True)
    for kind, docs in (("ArtifactNode", []), ("BlockNode", []), ("FolderNode", []), ("Profile", DEMO_PROFILES)):
        with open(os.path.join(directory, "Apeiron", kind + ".jsonld"), "w", encoding="utf-8") as h:
            h.write(json.dumps(docs, indent=2, ensure_ascii=False) + "\n")
    for rel, text in DEMO_FILES.items():
        path = os.path.join(directory, "artifacts", rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as h:
            h.write(text)


# ---------------------------------------------------------------------------------------------------------------- the list

FS_OPS = {"write", "modify-document", "edit-embedded", "duplicate-document", "truncate", "delete"}
COMMAND_KEYS = {"name", "args", "stdin", "timeout", "status", "flush", "no_prompt", "fs", "then_fs", "wait", "capture", "status_ref", "status_new", "hangs", "comment"}


def load_commands(path):
    """-> (list of commands, final_flush)."""
    try:
        with open(path, encoding="utf-8") as h:
            raw = json.load(h)
    except (OSError, ValueError) as e:
        raise Refusal("the list of commands %s cannot be read: %s" % (path, e))
    final_flush = True
    if isinstance(raw, dict):
        extra = set(raw) - {"final_flush", "commands"}
        if extra or not isinstance(raw.get("final_flush", True), bool):
            raise Refusal("the list of commands must be a non-empty JSON list, or an object of `commands` and `final_flush` (a boolean): unknown keys %s" % sorted(extra))
        final_flush = raw.get("final_flush", True)
        raw = raw.get("commands")
    if not isinstance(raw, list) or not raw:
        raise Refusal("the list of commands must be a non-empty JSON list")
    out = []
    for i, c in enumerate(raw):
        if not isinstance(c, dict):
            raise Refusal("command %d needs an `args` list of strings" % (i + 1))
        has_args = "args" in c
        if has_args and (not isinstance(c["args"], list) or not c["args"] or not all(isinstance(a, str) for a in c["args"])):
            raise Refusal("command %d needs an `args` list of strings" % (i + 1))
        if not has_args and not (c.get("fs") or c.get("wait")):
            raise Refusal("command %d needs an `args` list of strings" % (i + 1))
        if c.get("then_fs") and not has_args:
            raise Refusal("command %d has `then_fs` and no `args`: the edits follow a command" % (i + 1))
        for key, kinds in (("stdin", str), ("timeout", (int, float)), ("status", int), ("status_ref", int), ("status_new", int), ("flush", bool), ("no_prompt", bool), ("name", str), ("capture", bool), ("wait", (int, float)), ("comment", str), ("fs", list), ("then_fs", list), ("hangs", list)):
            if key in c and (not isinstance(c[key], kinds) or isinstance(c[key], bool) and kinds is not bool):
                raise Refusal("command %d: `%s` has the wrong type" % (i + 1, key))
        extra = set(c) - COMMAND_KEYS
        if extra:
            raise Refusal("command %d: unknown keys %s" % (i + 1, sorted(extra)))
        if any(h not in ("ref", "new") for h in c.get("hangs", [])):
            raise Refusal("command %d: `hangs` names sides `ref` and `new` only" % (i + 1))
        for op in c.get("fs", []) + c.get("then_fs", []):
            if not isinstance(op, dict) or op.get("op") not in FS_OPS:
                raise Refusal("command %d: an `fs` step is an object whose `op` is one of %s" % (i + 1, sorted(FS_OPS)))
        out.append(c)
    return out, final_flush


def slug(text):
    return re.sub(r"[^A-Za-z0-9._-]+", "-", text).strip("-")[:40] or "command"


# ---------------------------------------------------------------------------------------------------------------- edits of the files

def _root_dir(side, root):
    if root == "apeiron":
        return side.apeiron
    if root == "artifacts":
        return side.artifacts
    raise Refusal("an `fs` step names the root `apeiron` or `artifacts`, not %r" % root)


def _file_of(side, op):
    base = _root_dir(side, op.get("root", "apeiron"))
    path = os.path.normpath(os.path.join(base, op["path"]))
    if not same_or_inside(path, base):
        raise Refusal("an `fs` step names a path outside the root: %s" % op["path"])
    return path


def _doc_matches(doc, match):
    for key, want in match.items():
        have = doc.get(key)
        if key == "@id" and isinstance(want, str) and isinstance(have, str):
            if not (have == want or have.endswith(":" + want)):
                return False
        elif have != want:
            return False
    return True


def apply_fs(side, ops):
    """Edit the files of one side. Ops: `{"op": "write", "root": "artifacts", "path": ..., "text": ...}`; `{"op": "modify-document", "path": "BlockNode.jsonld",
    "match": {"@id": token-or-id, ...}, "set": {field: value}, "append": {field: value}}` (the one document that matches; a list field gets the value appended
    unless it is already there); `{"op": "duplicate-document", "path": ..., "match": {...}}` (the document is added again at the end of its file, unless the file holds it twice already); `{"op": "edit-embedded", "path": ..., "match": {...}, "field": "links", "where": {...}, "set": {...}, "remove_where_in": {"inner": "props", "where": {...}}}` (the entries of an embedded list that match `where` are changed: `set` fields, and the entries of their own `inner` list that match are dropped);
    `{"op": "truncate", "path": ..., "keep": N}` (the file is cut to its first N bytes); `{"op": "delete", "root": "artifacts", "path": ...}`. `root` defaults to `apeiron`."""
    for op in ops:
        file = _file_of(side, op)
        kind = op["op"]
        if kind == "write":
            os.makedirs(os.path.dirname(file), exist_ok=True)
            with open(file, "w", encoding="utf-8") as h:
                h.write(op["text"])
        elif kind == "delete":
            os.remove(file)
        elif kind == "truncate":
            with open(file, "rb") as h:
                data = h.read()
            with open(file, "wb") as h:
                h.write(data[:int(op["keep"])])
        else:
            with open(file, encoding="utf-8") as h:
                docs = json.load(h)
            found = [d for d in docs if isinstance(d, dict) and _doc_matches(d, op.get("match", {}))]
            if kind == "duplicate-document" and len(found) > 1:
                continue   # the file holds the id twice already (a service that was refused did not rewrite it)
            if len(found) != 1:
                raise Refusal("an `fs` step %s: %d documents match %s in %s, not one" % (kind, len(found), json.dumps(op.get("match")), op["path"]))
            if kind == "duplicate-document":
                docs.append(json.loads(json.dumps(found[0])))
            elif kind == "edit-embedded":
                hit = 0
                for entry in found[0].get(op["field"], []):
                    if all(entry.get(k) == v for k, v in op.get("where", {}).items()):
                        hit += 1
                        entry.update(op.get("set", {}))
                        drop = op.get("remove_where_in")
                        if drop:
                            entry[drop["inner"]] = [e for e in entry.get(drop["inner"], []) if not all(e.get(k) == v for k, v in drop["where"].items())]
                if hit == 0:
                    raise Refusal("an `fs` step edit-embedded: no entry of %s matches %s in %s" % (op["field"], json.dumps(op.get("where")), op["path"]))
            else:
                for k, v in op.get("set", {}).items():
                    found[0][k] = v
                for k, v in op.get("append", {}).items():
                    lst = found[0].setdefault(k, [])
                    if v not in lst:
                        lst.append(v)
            with open(file, "w", encoding="utf-8") as h:
                json.dump(docs, h, indent=2, ensure_ascii=False)
                h.write("\n")



# ---------------------------------------------------------------------------------------------------------------- the run

def parse_args(argv):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter, add_help=False)
    p.add_argument("--snapshot")
    p.add_argument("--out")
    p.add_argument("--commands")
    p.add_argument("--ports")
    p.add_argument("--reference-code", default=DEFAULT_REFERENCE)
    p.add_argument("--new-code", default=MONOREPO)
    p.add_argument("--machine-number", type=int, default=509)
    p.add_argument("--graph-name", default="differential")
    p.add_argument("--thread-size-cap", type=int)
    p.add_argument("--command-timeout", type=float, default=120)
    p.add_argument("--start-timeout", type=float, default=120)
    p.add_argument("--stop-timeout", type=float, default=60)
    p.add_argument("--tools", default=SCRIPTS)
    p.add_argument("--content-flush-ms", type=float, help="the flush interval of the content graph written into the new side's scratch aperas.config.json (the reference has no such setting)")
    p.add_argument("--allow-real-root", action="store_true")
    p.add_argument("--demo-snapshot")
    p.add_argument("-h", "--help", action="store_true")
    try:
        args = p.parse_args(argv)
    except SystemExit:
        raise Refusal("usage error (see --help)")
    return args


def validate(args):
    """The checks that need nothing but the arguments and the disk; -> (snapshot, out, commands, ports, final_flush)."""
    if args.snapshot is None or args.out is None or args.commands is None or args.ports is None:
        raise Refusal("--snapshot, --out, --commands and --ports are required")
    snapshot, out = os.path.abspath(args.snapshot), os.path.abspath(args.out)
    for sub in ("Apeiron", "artifacts"):
        if not os.path.isdir(os.path.join(snapshot, sub)):
            raise Refusal("the snapshot %s has no %s/" % (snapshot, sub))
    if real(snapshot) == REAL_GRAPH and not args.allow_real_root:
        raise Refusal("the snapshot is the real graph root %s; make a copy with `cp -a` and name that (or give --allow-real-root: it is only read)" % REAL_GRAPH)
    if os.path.exists(out) and (not os.path.isdir(out) or os.listdir(out)):
        raise Refusal("the output directory %s exists and is not empty" % out)
    for what, other in (("the snapshot", snapshot), ("the real graph", REAL_GRAPH), ("the reference code", args.reference_code), ("the new code", args.new_code)):
        if overlaps(out, other):
            raise Refusal("the output directory %s is, holds or lies inside %s (%s)" % (out, what, other))
    for name, code in (("reference", args.reference_code), ("new", args.new_code)):
        for rel in (os.path.join("node_modules", ".bin", "tsx"), ENTRY):
            if not os.path.exists(os.path.join(code, rel)):
                raise Refusal("the %s code %s has no %s" % (name, code, rel))
    for tool in ("migrate-mirror.py",):
        if not os.path.exists(os.path.join(args.tools, tool)):
            raise Refusal("%s is not in %s" % (tool, args.tools))
    try:
        ports = [int(x) for x in args.ports.split(",")]
    except ValueError:
        ports = []
    if len(ports) != 2 or ports[0] == ports[1]:
        raise Refusal("--ports takes two different ports, the reference's first: e.g. 2851,2852")
    if args.content_flush_ms is not None and not 0 < args.content_flush_ms < 2 ** 31:
        raise Refusal("--content-flush-ms must be a positive number of milliseconds below 2^31")
    if not 0 <= args.machine_number <= 511:
        raise Refusal("--machine-number must be 0 to 511")
    commands, final_flush = load_commands(args.commands)
    return snapshot, out, commands, ports, final_flush


def run(args):
    snapshot, out, commands, ports, final_flush = validate(args)
    world = World(out)
    sides = [Side("ref", args.reference_code, out, ports[0], args.machine_number, args.graph_name, args.thread_size_cap),
             Side("new", args.new_code, out, ports[1], args.machine_number, args.graph_name, args.thread_size_cap)]
    # Everything that can be refused is refused before anything is written, the starts' own assertions included.
    for side in sides:
        assert_isolated(side, world, [s for s in sides if s is not side])

    results = {"snapshot": snapshot, "out": out, "machineNumber": args.machine_number, "graphName": args.graph_name, "problems": [],
               "loadAverageAtStart": os.getloadavg(), "working": {"runDirs": world.working_run_dirs, "pids": sorted(world.pids()), "ports": sorted(world.ports()), "locksBefore": world.locks()}}
    problems = results["problems"]
    os.makedirs(out)
    before = manifest(snapshot)
    results["snapshotDigest"] = digest_of(before)
    results["snapshotFiles"] = len(before)
    results["code"] = {s.name: {"root": s.code, "git": git_state(s.code)} for s in sides}
    started, stopped = [], {}
    old_handlers = {}

    def interrupt(signum, frame):
        raise Interrupted("signal %d" % signum)

    for sig in (signal.SIGINT, signal.SIGTERM):
        old_handlers[sig] = signal.signal(sig, interrupt)
    rows = []
    try:
        # The copies: the reference unmigrated, the new engine migrated.
        for side in sides:
            os.makedirs(side.root)
            copy_tree(os.path.join(snapshot, "Apeiron"), side.apeiron)
            copy_tree(os.path.join(snapshot, "artifacts"), side.artifacts)
            os.makedirs(side.xdg_config)
            config = place_config(side, snapshot, args.content_flush_ms)
            if side.name == "new" and args.content_flush_ms is not None:
                results["newConfig"] = config
        for sub, side_dir in (("Apeiron", "apeiron"), ("artifacts", "artifacts")):
            wanted = {k[len(sub) + 1:]: v for k, v in before.items() if k.startswith(sub + os.sep)}
            for side in sides:
                if manifest(getattr(side, side_dir)) != wanted:
                    raise Failure("the copy of %s/ for the side %s is not the snapshot's" % (sub, side.name))
        results["copies"] = {"ref": digest_of(manifest(sides[0].apeiron)), "new": digest_of(manifest(sides[1].apeiron))}
        r = subprocess.run([sys.executable, os.path.join(args.tools, "migrate-mirror.py"), sides[1].root, "--rules", "123456"], capture_output=True, text=True, stdin=subprocess.DEVNULL, env={k: v for k, v in os.environ.items() if k != "LD_LIBRARY_PATH"})
        results["migration"] = {"status": r.returncode, "stdout": r.stdout.strip()[-2000:], "stderr": r.stderr.strip()[-2000:]}
        if r.returncode != 0:
            raise Failure("migrate-mirror.py ended with status %d on the copy of the new side: %s %s" % (r.returncode, r.stdout.strip()[-400:], r.stderr.strip()[-400:]))
        results["copies"]["newMigrated"] = digest_of(manifest(sides[1].apeiron))

        # The starts.
        results["starts"] = {}
        for side in sides:
            others = [s for s in sides if s is not side]
            results["starts"][side.name] = start_side(side, world, others, args.start_timeout)
            started.append(side)

        # The list of commands, one after the other on each side.
        os.makedirs(os.path.join(out, "commands"))
        entries = [dict(c, name=c.get("name") or (c["args"][0] if c.get("args") else "step")) for c in commands]
        if final_flush:
            entries.append({"name": "final-flush", "args": ["flush"], "flush": False})
        results["commands"] = []
        hung = set()
        for i, c in enumerate(entries, 1):
            argv = build_argv(c) if c.get("args") else None
            record = {"index": i, "name": c["name"], "argv": argv, "expectedStatus": c.get("status")}
            if c.get("comment"):
                record["comment"] = c["comment"]
            if c.get("fs"):
                for side in sides:
                    try:
                        apply_fs(side, c["fs"])
                    except Refusal as e:
                        problems.append("command %d (%s) on the side %s: %s" % (i, c["name"], side.name, e))
                record["fs"] = c["fs"]
            if c.get("wait"):
                time.sleep(c["wait"])
                record["wait"] = c["wait"]
            for side in sides if argv else []:
                if side.name in hung:
                    problems.append("command %d (%s) was not run on the side %s: an earlier command hung there" % (i, c["name"], side.name))
                    continue
                # A command is given to a service that answers, and is made again if the reference's client says there is none while its service is alive (`run_command`); the waits and
                # the retries are recorded, so how often a service was busy is data and the commands do not depend on the moment they arrive.
                step = run_command(side, argv, c.get("timeout", args.command_timeout), c.get("stdin"), min(args.command_timeout, 300), c.get("then_fs"))
                res, busy = step["res"], step["busy"]
                if step["fs_error"]:
                    problems.append("command %d (%s) on the side %s: %s" % (i, c["name"], side.name, step["fs_error"]))
                waited = settle_after_service_command(side, argv, res, args.start_timeout)
                base = os.path.join(out, "commands", "%03d-%s.%s" % (i, slug(c["name"]), side.name))
                for stream in ("stdout", "stderr"):
                    with open(base + "." + stream, "w", encoding="utf-8") as h:
                        h.write(res[stream])
                record[side.name] = {"status": res["status"], "seconds": res["seconds"], "timedOut": res["timed_out"], "stdout": os.path.relpath(base + ".stdout", out), "stderr": os.path.relpath(base + ".stderr", out),
                                     "stdoutBytes": len(res["stdout"].encode()), "stderrBytes": len(res["stderr"].encode())}
                if waited is not None:
                    record[side.name]["settledAfter"] = waited
                if busy >= 0.5:
                    record[side.name]["busyBefore"] = busy
                if step["retries"]:
                    record[side.name]["retries"] = step["retries"]
                if c.get("then_fs"):
                    record["thenFs"] = c["then_fs"]
                expected_hang = side.name in c.get("hangs", [])
                if res["timed_out"]:
                    hung.add(side.name)
                    if expected_hang:
                        record[side.name]["expectedHang"] = True
                    else:
                        problems.append("command %d (%s) on the side %s outlived its timeout and was killed" % (i, c["name"], side.name))
                elif expected_hang:
                    problems.append("command %d (%s) on the side %s was expected to hang and ended with status %s" % (i, c["name"], side.name, res["status"]))
                want = c.get("status_" + side.name, c.get("status"))
                if want is not None and not expected_hang and res["status"] != want:
                    problems.append("command %d (%s) on the side %s ended with status %s, not the expected %s" % (i, c["name"], side.name, res["status"], want))
            if c.get("capture"):
                cap = os.path.join(out, "captures", "%03d-%s" % (i, slug(c["name"])))
                for side in sides:
                    copy_tree(side.apeiron, os.path.join(cap, side.name, "Apeiron"))
                record["capture"] = os.path.relpath(cap, out)
            results["commands"].append(record)
            rows.append(record)
        results["hung"] = sorted(hung)
        results["busyBefore"] = {sd.name: [[r["index"], r["name"], r[sd.name]["busyBefore"]] for r in results["commands"] if sd.name in r and "busyBefore" in r[sd.name]] for sd in sides}
        results["retries"] = {sd.name: {"count": sum(len(r[sd.name]["retries"]) for r in results["commands"] if "retries" in r.get(sd.name, {})),
                                        "commands": [[r["index"], r["name"], len(r[sd.name]["retries"])] for r in results["commands"] if "retries" in r.get(sd.name, {})]} for sd in sides}
        results["rssAtEnd"] = {}
        for side in sides:
            lk = side.lock()
            results["rssAtEnd"][side.name] = rss_of(lk["pid"]) if isinstance(lk, dict) and isinstance(lk.get("pid"), int) else None

        # The dumps: the files `flush` wrote, copied while the services still run.
        os.makedirs(os.path.join(out, "dumps"))
        for side in sides:
            copy_tree(side.apeiron, os.path.join(out, "dumps", side.name, "Apeiron"))
        results["dumps"] = {s.name: digest_of(manifest(os.path.join(out, "dumps", s.name, "Apeiron"))) for s in sides}
    except Interrupted as e:
        problems.append("interrupted: %s" % e)
    except Failure as e:
        problems.append(str(e))
    finally:
        for side in sides:
            if side in started or side.lock() is not None:
                try:
                    stopped[side.name] = stop_side(side, world, 5 if side.name in results.get("hung", []) else args.stop_timeout)
                except Refusal as e:
                    stopped[side.name] = {"stopped": False, "refused": str(e)}
                    problems.append("not stopped: %s" % e)
        for sig, handler in old_handlers.items():
            signal.signal(sig, handler)
    results["stops"] = stopped
    os.makedirs(os.path.join(out, "logs"), exist_ok=True)
    for side in sides:
        log = os.path.join(side.run_dir, "service.log")
        if os.path.isfile(log):
            shutil.copy2(log, os.path.join(out, "logs", side.name + ".service.log"))
    for name, info in stopped.items():
        if info.get("stopped") is False and "refused" not in info:
            problems.append("the service of the side %s did not stop" % name)
        if info.get("signal") == "SIGKILL" and name not in results.get("hung", []):
            problems.append("the service of the side %s had to be killed (SIGTERM did not end it)" % name)
    # What the stop changed on disk (the shutdown flush) is data, not a problem.
    if "dumps" in results:
        results["changedByStop"] = {s.name: digest_of(manifest(s.apeiron)) != results["dumps"][s.name] for s in sides}
    left = []
    for side in sides:
        left += processes_with_env(side.needles())
    results["processesLeft"] = left
    if left:
        problems.append("processes left over: %s" % left)
    after = {s.name: git_state(s.code) for s in sides}
    results["code"]["afterStatus"] = {k: (v or {}).get("status") for k, v in after.items()}
    for s in sides:
        was = (results["code"][s.name]["git"] or {})
        now = after[s.name] or {}
        if was != now:
            problems.append("the git state of the code %s changed during the run: %s -> %s" % (s.code, was, now))
    results["working"]["locksAfter"] = world.locks()
    results["working"]["signalled"] = sorted(world.signalled & (set(results["working"]["pids"]) | world.pids()))
    results["working"]["untouched"] = world.untouched(results["working"]["pids"])   # no working pid was signalled by the harness; whether the working service is still alive is not part of it
    if after_snapshot_changed(snapshot, before):
        problems.append("the snapshot changed during the run")
    results["loadAverageAtEnd"] = os.getloadavg()
    with open(os.path.join(out, "results.json"), "w", encoding="utf-8") as h:
        json.dump(results, h, indent=2)
        h.write("\n")
    print_table(results, rows)
    return 1 if problems else 0


def after_snapshot_changed(snapshot, before):
    return manifest(snapshot) != before


def print_table(results, rows):
    print()
    print("snapshot %s: %d files, digest %s" % (results["snapshot"], results["snapshotFiles"], results["snapshotDigest"][:16]))
    if "starts" in results:
        for name, s in results["starts"].items():
            print("start %-4s %6.2f s  pid %s  port %s" % (name, s["seconds"], s.get("pid"), (s.get("lock") or {}).get("httpPort")))
    print("%-4s %-28s %-9s %-9s %8s %8s" % ("#", "command", "ref", "new", "ref s", "new s"))
    for r in rows:
        if "ref" not in r and "new" not in r:
            print("%-4d %-28s %s" % (r["index"], r["name"][:28], "(a step of files or a wait)"))
            continue
        print("%-4d %-28s %-9s %-9s %8.2f %8.2f" % (r["index"], r["name"][:28], (r.get("ref") or {}).get("status", "-"), (r.get("new") or {}).get("status", "-"),
                                                     (r.get("ref") or {}).get("seconds", 0), (r.get("new") or {}).get("seconds", 0)))
    for name, busy in results.get("busyBefore", {}).items():
        if busy:
            print("busy  %-4s did not answer a ping for 0.5 s or more before %d command(s): %s" % (name, len(busy), ", ".join("%s (%.1f s)" % (b[1], b[2]) for b in busy[:8])))
    for name, info in results.get("retries", {}).items():
        if info["count"]:
            print("retry %-4s %d call(s) ended with `No ApeironNgn service running` while the service was alive and were made again: %s" % (name, info["count"], ", ".join("%s (x%d)" % (b[1], b[2]) for b in info["commands"][:8])))
    for name, s in results.get("stops", {}).items():
        print("stop  %-4s signal %s, stopped %s" % (name, s.get("signal"), s.get("stopped")))
    print("processes left: %s; working service pids %s, signalled by the harness: %s; untouched (no working pid was signalled by the harness; the working service may have stopped by itself): %s"
          % (results["processesLeft"], results["working"]["pids"], results["working"].get("signalled", []), results["working"]["untouched"]))
    for p in results["problems"]:
        print("PROBLEM: " + p)
    print("DIFFERENTIAL RUN: %s" % ("FAILED" if results["problems"] else "COMPLETE"))


def main(argv=None):
    try:
        args = parse_args(sys.argv[1:] if argv is None else argv)
        if args.help:
            print(__doc__)
            return 0
        if args.demo_snapshot:
            write_demo_snapshot(os.path.abspath(args.demo_snapshot))
            return 0
        return run(args)
    except Refusal as e:
        print("REFUSED: " + str(e), file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
