#!/usr/bin/env python3
"""The service-level figures of the cutover decision (Python 3, standard library only; planning/core.md, Batch 13, piece 7).

  python3 monorepo/scripts/differential/service_figures.py --out <dir> --ports <ref-port>,<new-port> [--snapshot <migrated-from>] [--raw <raw-copy>]
         [--n 10] [--series starts,dump,write,lifecycle] [--reference-code <monorepo>] [--new-code <monorepo>]

Measures, one engine at a time and only on isolated services (the harness's `Side`, `World` and `assert_isolated`: each service has its own run directory, its own port and its own
roots under `<dir>`; nothing here signals a pid but a service it started, checked by `verify_ours`), on scratch copies of the real mirror:

  starts      N starts of each service from a fresh copy of the same state: the time from the call to `service start` to the lock saying `ready`, to the end of the call, and to the
              first answered ping; then the first and the second `show` (what the first request waits for is the difference); the rss at the first answered ping, after the first
              `show` and after one `flush`; the time of that `flush`; the stop.
  dump        on one service per engine: N times `update` (no flush) then `flush`, and N times `flush --clobber`.
  write       on one service per engine: the idle floor of a `show`, then N times `insert` of a short list item with `--flush` and N without: the time to the reply, the time until the
              service answers a ping after the reply, and the time of the next `show` of the new id.
  lifecycle   on one service per engine: N times `reload`, then N times `service restart`.

The reference is started on a copy of `--raw` (the real mirror, unmigrated), the new engine on a copy of `--snapshot` migrated once by `migrate-mirror.py`. The load average is read
before and after every series and with every reading; a series starts only when the one-minute load average is 2 or less, or after at most 5 minutes of waiting (it then runs anyway,
and says so). Output: `<dir>/figures.json` (every reading), `<dir>/figures.txt` (a table per figure: n, median, range, load) and a copy of each service's log.
"""
import argparse
import json
import os
import select
import shutil
import signal
import socket
import statistics
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import harness as h  # noqa: E402

SHOW_ID = "BlockNode:00D24N87T000S"     # a live list item of design/core.md, `## Open points` (on both engines)
INSERT_PARENT = "BlockNode:00D24N87T000J"   # that heading
POLL = 0.02
QUIET_LOAD = 2.0
QUIET_WAIT = 300


def load1():
    return os.getloadavg()[0]


def uptime_text():
    with open("/proc/loadavg") as f:
        return f.read().strip()


def quiet_gate(log, label):
    """-> the note for the series: the load at the start and whether it had to wait or went on loud."""
    t = time.time()
    first = load1()
    while load1() > QUIET_LOAD and time.time() - t < QUIET_WAIT:
        time.sleep(5)
    waited = round(time.time() - t, 1)
    now = load1()
    note = {"label": label, "loadAtFirstRead": first, "waited": waited, "loadAtStart": now, "proceededLoud": now > QUIET_LOAD, "loadavg": uptime_text()}
    log("series %s: load %.2f at first read, waited %.1f s, load %.2f at start%s" % (label, first, waited, now, " (above %.0f: ran anyway)" % QUIET_LOAD if now > QUIET_LOAD else ""))
    return note


def stats(values):
    v = sorted(x for x in values if x is not None)
    if not v:
        return {"n": 0}
    return {"n": len(v), "median": round(statistics.median(v), 3), "min": round(v[0], 3), "max": round(v[-1], 3)}


class Engine:
    """One engine's pristine copy, and fresh services made from it."""

    def __init__(self, name, code, source, out, port, world, others_ports):
        self.name = name
        self.code = code
        self.source = source
        self.out = out
        self.port = port
        self.world = world
        self.pristine = os.path.join(out, "pristine", name)
        self.side = None

    def prepare(self, tools, log):
        os.makedirs(self.pristine)
        h.copy_tree(os.path.join(self.source, "Apeiron"), os.path.join(self.pristine, "Apeiron"))
        h.copy_tree(os.path.join(self.source, "artifacts"), os.path.join(self.pristine, "artifacts"))
        shutil.copy2(os.path.join(self.source, "aperas.config.json"), self.pristine)
        if self.name == "new":
            r = subprocess.run([sys.executable, os.path.join(tools, "migrate-mirror.py"), self.pristine, "--rules", "123456"], capture_output=True, text=True, stdin=subprocess.DEVNULL,
                               env={k: v for k, v in os.environ.items() if k != "LD_LIBRARY_PATH"})
            if r.returncode != 0:
                raise h.Failure("migrate-mirror.py ended with %d: %s %s" % (r.returncode, r.stdout[-300:], r.stderr[-300:]))
            log("migrated the copy for new: %s" % r.stdout.strip()[-200:])
        self.digest = h.digest_of(h.manifest(os.path.join(self.pristine, "Apeiron")))
        log("pristine %s: digest %s" % (self.name, self.digest[:16]))

    def fresh(self, tag):
        """A new side on a fresh copy of the pristine state: a run directory and roots of their own under `<out>/runs/<tag>/<name>`."""
        base = os.path.join(self.out, "runs", tag)
        side = h.Side(self.name, self.code, base, self.port, 509, "differential")
        os.makedirs(side.root)
        h.copy_tree(os.path.join(self.pristine, "Apeiron"), side.apeiron)
        h.copy_tree(os.path.join(self.pristine, "artifacts"), side.artifacts)
        os.makedirs(side.xdg_config)
        shutil.copy2(os.path.join(self.pristine, "aperas.config.json"), side.root)
        self.world.out = os.path.join(self.out, "runs")
        h.assert_isolated(side, self.world, ())
        self.side = side
        return side


def ping_until(side, timeout, t0):
    """Polls for a ping answer; -> seconds from t0 to the first answer, or None."""
    while time.time() - t0 < timeout:
        if h.answers_ping(side, 2.0):
            return time.time() - t0
        if not h.side_service_alive(side):
            return None
        time.sleep(POLL)
    return None


def timed_launch(side, argv, timeout, old_pid=None):
    """Runs `aperas <argv>` (`service start` or `service restart`) and polls the lock and a ping: -> dict(call, ready, ping, status, stdout, stderr, pid). `ready` is the time from the call
    to the lock saying `ready` (of a service that is not `old_pid`); `call` the time until the client ended; `ping` the time until a ping, sent once on one connection as soon as the
    socket accepted it, was answered (so a service busy after `ready` shows as the gap between the two)."""
    cmd = [side.tsx, side.entry] + list(argv)
    t0 = time.time()
    p = subprocess.Popen(cmd, cwd=side.root, env=side.env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
    ready = call = ping = None
    pid = None
    conn = None
    buf = b""
    while time.time() - t0 < timeout:
        if ready is None:
            lk = side.lock()
            if isinstance(lk, dict) and lk.get("status") == "ready" and isinstance(lk.get("pid"), int) and lk["pid"] != old_pid:
                ready = time.time() - t0
                pid = lk["pid"]
        if ready is not None and ping is None:
            if conn is None:
                c = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                try:
                    c.connect(side.socket_path())
                    c.sendall(b'{"op":"ping"}\n')
                    conn = c
                except OSError:
                    c.close()
            else:
                r, _, _ = select.select([conn], [], [], 0)
                if r:
                    chunk = conn.recv(4096)
                    buf += chunk
                    if b"\n" in buf or not chunk:
                        ping = time.time() - t0 if b"\n" in buf else None
                        conn.close()
                        conn = None
                        if ping is None:
                            buf = b""
        if call is None and p.poll() is not None:
            call = time.time() - t0
        if ready is not None and call is not None and ping is not None:
            break
        time.sleep(POLL)
    if conn is not None:
        conn.close()
    if call is None:
        try:
            os.killpg(p.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    out, err = p.communicate()
    return {"call": call, "ready": ready, "ping": ping, "status": p.returncode, "stdout": h.decode(out).strip()[-300:], "stderr": h.decode(err).strip()[-300:], "pid": pid}


def rss_kb(side):
    lk = side.lock()
    if isinstance(lk, dict) and isinstance(lk.get("pid"), int):
        r = h.rss_of(lk["pid"])
        if r:
            return r.get("rss"), r.get("peak")
    return None, None


def timed(side, argv, stdin_text=None, timeout=300):
    """One command given to a service that answers (`harness.run_command`: a wait for a ping first and a new call when the reference's client says there is no service while its
    process lives); -> the result of the call that counts, with `busy` (the seconds waited for a ping before the call) and `retries` (how many calls did not run). The seconds are those
    of the call alone."""
    step = h.run_command(side, argv, timeout, stdin_text, 120)
    r = dict(step["res"])
    r["busy"] = step["busy"]
    r["retries"] = len(step["retries"])
    return r


def start_checked(eng, side, timeout):
    h.assert_isolated(side, eng.world, ())
    r = timed_launch(side, ["service", "start"], timeout)
    if r["ready"] is None:
        raise h.Failure("the service of %s did not become ready in %s s: %s %s" % (eng.name, timeout, r["stdout"], r["stderr"]))
    h.verify_ours(side, r["pid"], eng.world)
    return r


def stop_checked(eng, side):
    t = time.time()
    info = h.stop_side(side, eng.world, 60)
    info["seconds"] = round(time.time() - t, 3)
    if not info.get("stopped") or info.get("left") or info.get("unverified"):
        raise h.Failure("the service of %s did not stop cleanly: %s" % (eng.name, info))
    return info


def save_log(eng, side, name):
    log = os.path.join(side.run_dir, "service.log")
    dst = os.path.join(eng.out, "logs")
    os.makedirs(dst, exist_ok=True)
    if os.path.isfile(log):
        shutil.copy2(log, os.path.join(dst, "%s.%s.service.log" % (eng.name, name)))


# ---------------------------------------------------------------------------------------------------------------- the series

def series_starts(eng, n, log, timeout):
    rows = []
    for i in range(1, n + 1):
        side = eng.fresh("starts-%s-%02d" % (eng.name, i))
        row = {"i": i, "loadBefore": load1()}
        try:
            r = start_checked(eng, side, timeout)
            row.update({"call": r["call"], "ready": r["ready"], "ping": r["ping"], "startStatus": r["status"], "startErr": (r["stdout"] + " " + r["stderr"]).strip()[-160:]})
            row["rssAtPing"], row["peakAtPing"] = rss_kb(side)
            s1 = timed(side, ["show", SHOW_ID])
            s2 = timed(side, ["show", SHOW_ID])
            row.update({"show1": s1["seconds"], "show1Status": s1["status"], "show1Busy": s1["busy"], "show2": s2["seconds"], "show2Status": s2["status"]})
            row["rssAfterShow"], _ = rss_kb(side)
            f = timed(side, ["flush"])
            row.update({"flush": f["seconds"], "flushStatus": f["status"], "flushBusy": f["busy"], "flushRetries": f["retries"]})
            row["rssAfterFlush"], row["peakAfterFlush"] = rss_kb(side)
            c = timed(side, ["check-links"])
            row.update({"checkLinks": c["seconds"], "checkLinksStatus": c["status"], "checkLinksOut": c["stdout"].strip()[-100:]})
            row["loadAfter"] = load1()
        finally:
            row["stop"] = stop_checked(eng, side)
            save_log(eng, side, "starts-%02d" % i)
            shutil.rmtree(os.path.join(eng.out, "runs", "starts-%s-%02d" % (eng.name, i)), ignore_errors=True)
        log("starts %s %d/%d: ready %.2f call %.2f ping %.2f show1 %.2f show2 %.2f flush %.2f rss %s load %.2f" % (eng.name, i, n, row["ready"], row["call"] or -1, row["ping"] or -1, row["show1"], row["show2"], row["flush"], row["rssAtPing"], row["loadBefore"]))
        rows.append(row)
    return rows


def series_dump(eng, n, log, timeout):
    side = eng.fresh("dump-%s" % eng.name)
    rows = {"update_flush": [], "flush_clobber": []}
    try:
        start_checked(eng, side, timeout)
        idle = h.wait_answering(side, 60)
        time.sleep(3)
        for i in range(1, n + 1):
            lb = load1()
            u = timed(side, ["update", SHOW_ID, "--text-only"], "**An invalid id and a non-canonical integer**: the engine refuses an id that fails the grammar (figure %d).\n" % i)
            f = timed(side, ["flush"])
            rows["update_flush"].append({"i": i, "update": u["seconds"], "updateStatus": u["status"], "flush": f["seconds"], "flushStatus": f["status"], "busyBeforeFlush": f["busy"], "retries": u["retries"] + f["retries"], "load": lb, "err": (u["stderr"] + f["stderr"]).strip()[-120:]})
            log("dump %s update+flush %d: update %.2f flush %.2f (%s/%s)" % (eng.name, i, u["seconds"], f["seconds"], u["status"], f["status"]))
        for i in range(1, n + 1):
            lb = load1()
            f = timed(side, ["flush", "--clobber"])
            rows["flush_clobber"].append({"i": i, "flush": f["seconds"], "flushStatus": f["status"], "busyBefore": f["busy"], "retries": f["retries"], "load": lb, "err": f["stderr"].strip()[-120:]})
            log("dump %s flush --clobber %d: %.2f (%s)" % (eng.name, i, f["seconds"], f["status"]))
        rows["rssEnd"] = rss_kb(side)
    finally:
        stop_checked(eng, side)
        save_log(eng, side, "dump")
        shutil.rmtree(os.path.join(eng.out, "runs", "dump-%s" % eng.name), ignore_errors=True)
    return rows


def parse_id(text):
    import re
    m = re.search(r"BlockNode:[0-9A-Za-z]+", text)
    return m.group(0) if m else None


def series_write(eng, n, log, timeout):
    side = eng.fresh("write-%s" % eng.name)
    rows = {"floor_show": [], "insert_flush": [], "insert_noflush": []}
    try:
        start_checked(eng, side, timeout)
        h.wait_answering(side, 60)
        time.sleep(3)
        for i in range(1, n + 1):
            s = timed(side, ["show", SHOW_ID])
            rows["floor_show"].append({"i": i, "show": s["seconds"], "status": s["status"], "load": load1()})
        for key, flags in (("insert_flush", ["--flush"]), ("insert_noflush", [])):
            for i in range(1, n + 1):
                lb = load1()
                text = "- a short list item of figure %s %d\n" % (key, i)
                r = timed(side, ["insert", INSERT_PARENT] + flags, text)
                t_reply = time.time()
                nid = parse_id(r["stdout"])
                ping = ping_until(side, 60, t_reply)
                s = timed(side, ["show", nid]) if nid else {"seconds": None, "status": None, "stdout": ""}
                total = time.time() - t_reply
                rows.setdefault("rssAfter" + key, rss_kb(side)[0]) if i == n else None
                rows[key].append({"i": i, "insert": r["seconds"], "status": r["status"], "id": nid, "pingAfterReply": ping, "showNext": s["seconds"], "showTotal": total, "retries": r["retries"] + s.get("retries", 0), "showStatus": s["status"], "showOk": bool(nid and nid in s.get("stdout", "")), "load": lb,
                                  "err": r["stderr"].strip()[-120:], "out": r["stdout"].strip()[-120:] if not nid else None})
                log("write %s %s %d: insert %.2f ping+%.2f show %.2f (%s/%s)" % (eng.name, key, i, r["seconds"], ping if ping is not None else -1, s["seconds"] or -1, r["status"], s["status"]))
    finally:
        stop_checked(eng, side)
        save_log(eng, side, "write")
        shutil.rmtree(os.path.join(eng.out, "runs", "write-%s" % eng.name), ignore_errors=True)
    return rows


def series_lifecycle(eng, n, log, timeout):
    side = eng.fresh("life-%s" % eng.name)
    rows = {"reload": [], "restart": []}
    try:
        r0 = start_checked(eng, side, timeout)
        h.wait_answering(side, 60)
        time.sleep(3)
        for i in range(1, n + 1):
            lb = load1()
            r = timed(side, ["reload"])
            t_reply = time.time()
            ping = ping_until(side, 120, t_reply)
            rows["reload"].append({"i": i, "reload": r["seconds"], "status": r["status"], "pingAfterReply": ping, "load": lb, "rss": rss_kb(side)[0], "err": r["stderr"].strip()[-120:]})
            log("lifecycle %s reload %d: %.2f ping+%.2f rss %s (%s)" % (eng.name, i, r["seconds"], ping if ping is not None else -1, rows["reload"][-1]["rss"], r["status"]))
        pid = side.lock().get("pid") if isinstance(side.lock(), dict) else None
        for i in range(1, n + 1):
            lb = load1()
            r = timed_launch(side, ["service", "restart"], timeout, old_pid=pid)
            if r["ready"] is None:
                raise h.Failure("restart %d on %s did not become ready: %s %s" % (i, eng.name, r["stdout"], r["stderr"]))
            pid = r["pid"]
            rows["restart"].append({"i": i, "call": r["call"], "ready": r["ready"], "ping": r["ping"], "status": r["status"], "load": lb, "rss": rss_kb(side)[0], "err": (r["stdout"] + " " + r["stderr"]).strip()[-120:]})
            log("lifecycle %s restart %d: call %.2f ready %.2f ping %.2f rss %s (%s)" % (eng.name, i, r["call"] or -1, r["ready"], r["ping"] or -1, rows["restart"][-1]["rss"], r["status"]))
            time.sleep(1)
    finally:
        stop_checked(eng, side)
        save_log(eng, side, "lifecycle")
        shutil.rmtree(os.path.join(eng.out, "runs", "life-%s" % eng.name), ignore_errors=True)
    return rows


# ---------------------------------------------------------------------------------------------------------------- the tables

def col(rows, key):
    return [r.get(key) for r in rows]


def fmt(s):
    if not s.get("n"):
        return "n=0"
    return "n=%d  median %s  range %s to %s" % (s["n"], s["median"], s["min"], s["max"])


def status_counts(rows):
    """{key: number of rows whose key (ending in `tatus`) is not 0}, for the keys that have any."""
    out = {}
    for r in rows:
        for k, v in r.items():
            if k.lower().endswith("tatus") and v not in (0, None):
                out[k] = out.get(k, 0) + 1
            if k == "retries" and v:
                out["retries"] = out.get("retries", 0) + v
            if k.lower().endswith("tatus") and v is None:
                out[k + "=None"] = out.get(k + "=None", 0) + 1
    return out


def tables(results):
    lines = []
    add = lines.append
    for eng in ("ref", "new"):
        st = results.get("starts", {}).get(eng)
        if st:
            rows = st["rows"]
            add("== starts, %s (series load: %s)" % (eng, st["gate"]["loadavg"]))
            for key, label, scale in (("ready", "call to lock `ready` (s)", 1), ("call", "end of the `service start` call (s)", 1), ("ping", "call to first answered ping (s)", 1), ("show1", "first `show` (s)", 1), ("show2", "second `show` (s)", 1),
                                      ("flush", "`flush` after the first requests (s)", 1), ("rssAtPing", "rss at first ping (kB)", 1), ("rssAfterShow", "rss after 2 shows (kB)", 1), ("rssAfterFlush", "rss after one flush (kB)", 1), ("peakAfterFlush", "peak rss (kB)", 1), ("checkLinks", "`check-links` on the idle service (s)", 1)):
                add("  %-44s %s" % (label, fmt(stats(col(rows, key)))))
            under = [r["ready"] < 5.0 for r in rows if r.get("ready") is not None]
            add("  ready under 5.000 s: %d of %d starts" % (sum(under), len(under)))
            add("  loads at the start of each start: %s" % [round(r["loadBefore"], 2) for r in rows])
            add("  non-zero statuses / retries: %s" % status_counts(rows))
        for name, sect, keys in (("dump", "dump", (("update_flush", "flush", "flush after one update (s)"), ("update_flush", "update", "the update (no flush) (s)"), ("flush_clobber", "flush", "flush --clobber (s)"))),
                                 ("write", "write", (("floor_show", "show", "floor: show on idle (s)"), ("insert_flush", "insert", "insert --flush, to the reply (s)"), ("insert_flush", "pingAfterReply", "insert --flush, reply to answered ping (s)"),
                                                     ("insert_flush", "showTotal", "insert --flush, reply to the answer of the next show (s)"), ("insert_noflush", "insert", "insert, no flush, to the reply (s)"),
                                                     ("insert_noflush", "pingAfterReply", "insert, no flush, reply to answered ping (s)"), ("insert_noflush", "showTotal", "insert, no flush, reply to the answer of the next show (s)"))),
                                 ("lifecycle", "lifecycle", (("reload", "reload", "reload, to the reply (s)"), ("reload", "pingAfterReply", "reload, reply to answered ping (s)"), ("restart", "call", "service restart, end of the call (s)"),
                                                             ("restart", "ready", "service restart, call to `ready` (s)"), ("restart", "ping", "service restart, call to first ping (s)")))):
            d = results.get(name, {}).get(eng)
            if d:
                add("== %s, %s (series load: %s)" % (name, eng, d["gate"]["loadavg"]))
                for sub, key, label in keys:
                    add("  %-50s %s" % (label, fmt(stats(col(d["rows"][sub], key)))))
                for sub in d["rows"]:
                    if not isinstance(d["rows"][sub], list):
                        add("  %s (kB, peak): %s" % (sub, d["rows"][sub]))
                    if isinstance(d["rows"][sub], list):
                        add("  non-zero statuses / retries, %s: %s" % (sub, status_counts(d["rows"][sub])))
    return "\n".join(lines)


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--out", required=True)
    p.add_argument("--ports", required=True)
    p.add_argument("--snapshot", default="/home/will/scratch/p5/real-snap")
    p.add_argument("--raw", default="/home/will/scratch/p5/real-raw")
    p.add_argument("--reference-code", default=h.DEFAULT_REFERENCE)
    p.add_argument("--new-code", default=h.MONOREPO)
    p.add_argument("--tools", default=h.SCRIPTS)
    p.add_argument("--n", type=int, default=10)
    p.add_argument("--series", default="starts,dump,write,lifecycle")
    p.add_argument("--engines", default="ref,new")
    p.add_argument("--timeout", type=float, default=300)
    a = p.parse_args(argv)
    out = os.path.abspath(a.out)
    ports = [int(x) for x in a.ports.split(",")]
    if os.path.exists(out) and os.listdir(out):
        print("the output directory %s is not empty" % out)
        return 2
    os.makedirs(out, exist_ok=True)
    world = h.World(os.path.join(out, "runs"))
    logfile = open(os.path.join(out, "figures.log"), "w")

    def log(text):
        line = "%s  load %.2f  %s" % (time.strftime("%H:%M:%S"), load1(), text)
        print(line, flush=True)
        logfile.write(line + "\n")
        logfile.flush()

    engines = {"ref": Engine("ref", os.path.abspath(a.reference_code), a.raw, out, ports[0], world, []),
               "new": Engine("new", os.path.abspath(a.new_code), a.snapshot, out, ports[1], world, [])}
    results = {"startedAt": time.strftime("%Y-%m-%d %H:%M:%S"), "n": a.n, "working": {"pids": sorted(world.pids()), "ports": sorted(world.ports())}, "problems": []}
    code = 0
    try:
        for name in a.engines.split(","):
            engines[name].prepare(a.tools, log)
        results["digests"] = {k: e.digest for k, e in engines.items() if hasattr(e, "digest")}
        for sname, fn in (("starts", series_starts), ("dump", series_dump), ("write", series_write), ("lifecycle", series_lifecycle)):
            if sname not in a.series.split(","):
                continue
            for name in a.engines.split(","):
                gate = quiet_gate(log, "%s/%s" % (sname, name))
                t = time.time()
                rows = fn(engines[name], a.n, log, a.timeout)
                gate_end = {"loadavgAtEnd": uptime_text(), "seconds": round(time.time() - t, 1)}
                results.setdefault(sname, {})[name] = {"gate": dict(gate, **gate_end), "rows": rows} if sname == "starts" else {"gate": dict(gate, **gate_end), "rows": rows}
                if sname == "starts":
                    results[sname][name]["rows"] = rows
                log("series %s/%s done in %.1f s; loadavg %s" % (sname, name, time.time() - t, uptime_text()))
                with open(os.path.join(out, "figures.json"), "w") as f:
                    json.dump(results, f, indent=1, default=str)
    except (h.Failure, h.Refusal) as e:
        results["problems"].append(str(e))
        log("FAILED: %s" % e)
        code = 1
    finally:
        left = []
        for e in engines.values():
            if e.side:
                left += h.processes_with_env(e.side.needles())
        results["processesLeft"] = left
        results["working"]["untouched"] = world.untouched(results["working"]["pids"])   # no working pid was signalled by the harness
        with open(os.path.join(out, "figures.json"), "w") as f:
            json.dump(results, f, indent=1, default=str)
        text = tables(results)
        with open(os.path.join(out, "figures.txt"), "w") as f:
            f.write(text + "\n")
        print(text)
        log("processes left: %s; working service untouched (no working pid was signalled by the harness): %s" % (left, results["working"]["untouched"]))
    return code if not left else 1


if __name__ == "__main__":
    sys.exit(main())
