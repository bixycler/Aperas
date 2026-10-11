#!/usr/bin/env python3
"""Sample the ApeironNgn service (and the machine) so a stall can be matched to a clock time afterwards.

Linux only, Python standard library only. Read-only: reads /proc and the mirror files' metadata, and
sends the service a `{"op":"ping"}` over its unix socket once a second, exactly as a client does.
It changes nothing and writes only its own CSV. Not part of the CLI bundle (it lives outside `src/`).

  npm run svc:sample -- --out samples.csv                  # from monorepo/, runs until Ctrl-C
  npm run svc:sample -- --report samples.csv               # summary: stalls, memory slope, flushes, spins
  python3 svc_sampler.py --lock /run/user/1000/aperas/apeironngn.lock --ping-timeout 5

One CSV row per tick (default 1 s). Columns:
  ts, epoch                     local time, and unix seconds (float) at the start of the tick
  pid                           service pid (from the lock file, else found by command line)
  ping_ok, connect_ms, ping_ms  did `ping` get a reply; time to connect; time to the full reply
  ping_err                      failure text: no lock / socket missing / refused / "no reply in N s
                                (connected after X ms)" / bad reply -- kept, never reduced to a flag
  client_would_fail             1 when the reply took longer than --client-timeout-ms (the real
                                client's 300 ms bound, `PING_TIMEOUT_MS`) or failed: the CLI would
                                have printed "No ApeironNgn service running" at that instant
  rss_mb, hwm_mb, anon_mb, swap_mb          resident, resident high-water (VmHWM), anonymous, swapped-out
  minflt_d, majflt_d            page faults since the last tick
  cpu_pct                       process CPU over the tick, all threads summed (100 = one core)
  top1_*/top2_pct               busiest thread: id, name, share, kernel state, kernel wait channel; second share
  nthreads, ctx_vol_d, ctx_inv_d  threads; voluntary / involuntary context switches since the last tick
  rchar_kb_d, wchar_kb_d        bytes passed to read()/write() since the last tick, in KiB (/proc/<pid>/io)
  rbytes_kb_d, wbytes_kb_d      bytes the storage layer actually read/wrote since the last tick, in KiB
  blk_kb, blk_mtime             content mirror BlockNode.jsonld: size and mtime (a changed mtime is a flush)
  stblk_kb, stblk_mtime         .state/BlockNode.jsonld, same
  sttv_mtime                    .state/TreeView.jsonld mtime
  avail_mb, act_anon_mb, inact_anon_mb, act_file_mb, inact_file_mb, swap_used_mb   machine-wide
  psi_some10                    memory pressure, % of time some task stalled on memory (10 s average)
  clients                       short-lived `aperas` client node processes running right now
  probe_ok, probe_ms            only with --probe-every > 0: did `aperas show <--probe-node>` answer (off by default)
"""
from __future__ import annotations

import argparse
import csv
import glob
import json
import math
import os
import re
import signal
import socket
import subprocess
import sys
import tempfile
import time
from datetime import datetime

CLK = os.sysconf("SC_CLK_TCK")
CLIENT_PING_TIMEOUT_MS = 300  # serviceClient.ts#PING_TIMEOUT_MS
COLS = ["ts", "epoch", "pid", "ping_ok", "connect_ms", "ping_ms", "ping_err", "client_would_fail",
        "rss_mb", "hwm_mb", "anon_mb", "swap_mb", "minflt_d", "majflt_d", "cpu_pct",
        "top1_tid", "top1_name", "top1_pct", "top1_state", "top1_wchan", "top2_pct", "nthreads",
        "ctx_vol_d", "ctx_inv_d", "rchar_kb_d", "wchar_kb_d", "rbytes_kb_d", "wbytes_kb_d",
        "blk_kb", "blk_mtime", "stblk_kb", "stblk_mtime", "sttv_mtime",
        "avail_mb", "act_anon_mb", "inact_anon_mb", "act_file_mb", "inact_file_mb", "swap_used_mb",
        "psi_some10", "clients", "probe_ok", "probe_ms"]


# --- paths ------------------------------------------------------------------------------------

def default_run_dir() -> str:
    """Mirrors serviceLock.ts#getRunDir: $XDG_RUNTIME_DIR/aperas, else <tmpdir>/aperas-<uid>."""
    xdg = os.environ.get("XDG_RUNTIME_DIR")
    if xdg:
        return os.path.join(xdg, "aperas")
    return os.path.join(tempfile.gettempdir(), f"aperas-{os.getuid()}")


def read(path: str) -> str:
    try:
        with open(path) as f:
            return f.read()
    except OSError:
        return ""


def read_lock(lock: str) -> dict:
    try:
        return json.loads(read(lock) or "{}")
    except json.JSONDecodeError:
        return {}


def service_pid(lock: str) -> int | None:
    try:
        pid = int(read_lock(lock).get("pid", 0))
        if pid and os.path.exists(f"/proc/{pid}"):
            return pid
    except (TypeError, ValueError):
        pass
    found: dict[int, int] = {}  # pid -> parent pid, for every node process running service.ts
    for p in glob.glob("/proc/[0-9]*/cmdline"):
        cmd = read(p).replace("\0", " ")
        if "apeironNgn/service.ts" in cmd and "tsx" in cmd and read(p.replace("cmdline", "comm")).strip() == "node":
            pid = int(p.split("/")[2])
            m = re.match(r"\d+ \(.*\) \S (\d+)", read(f"/proc/{pid}/stat"), re.S)
            found[pid] = int(m.group(1)) if m else 0
    # the `tsx` wrapper spawns the real service as a child; the child is the one that holds the memory
    leaves = [pid for pid in found if pid not in found.values()]
    return max(leaves) if leaves else None


# --- the ping ---------------------------------------------------------------------------------

def ping(sock_path: str, timeout_s: float) -> dict:
    """One `{"op":"ping"}` round trip over the unix socket, as serviceClient.ts#sendRaw does it.
    Returns ok, connect_ms, ping_ms and err (the failure text, empty on success)."""
    out = {"ok": 0, "connect_ms": "", "ping_ms": "", "err": ""}
    if not os.path.exists(sock_path):
        out["err"] = f"socket missing: {sock_path}"
        return out
    t0 = time.monotonic()
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(timeout_s)
    connected_ms = None
    try:
        s.connect(sock_path)
        connected_ms = (time.monotonic() - t0) * 1000
        out["connect_ms"] = round(connected_ms, 1)
        s.sendall(b'{"op":"ping"}\n')
        buf = b""
        while b"\n" not in buf:
            left = timeout_s - (time.monotonic() - t0)
            if left <= 0:
                raise socket.timeout()
            s.settimeout(left)
            chunk = s.recv(65536)
            if not chunk:
                out["err"] = f"closed without a reply after {round((time.monotonic() - t0) * 1000)} ms"
                return out
            buf += chunk
        out["ping_ms"] = round((time.monotonic() - t0) * 1000, 1)
        try:
            reply = json.loads(buf.split(b"\n", 1)[0])
        except json.JSONDecodeError as e:
            out["err"] = f"bad reply: {e}"
            return out
        if reply.get("ok") is True:
            out["ok"] = 1
        else:
            out["err"] = f"reply not ok: {str(reply.get('error', reply))[:200]}"
    except socket.timeout:
        if connected_ms is None:
            out["err"] = f"no connect in {timeout_s:g} s"
        else:
            out["err"] = f"no reply in {timeout_s:g} s (connected after {round(connected_ms)} ms)"
    except OSError as e:
        out["err"] = f"{type(e).__name__}: {e.strerror or e}"
    finally:
        s.close()
    return out


# --- /proc ------------------------------------------------------------------------------------

def kb_field(text: str, key: str) -> int:
    m = re.search(rf"^{key}:\s+(\d+)", text, re.M)
    return int(m.group(1)) if m else 0


def thread_stats(pid: int) -> dict[int, tuple[int, str, str]]:
    """tid -> (cpu ticks, name, state)."""
    out = {}
    for t in glob.glob(f"/proc/{pid}/task/[0-9]*"):
        tid = int(t.rsplit("/", 1)[1])
        m = re.match(r"\d+ \((.*)\) (\S) (.*)", read(f"{t}/stat"), re.S)
        if not m:
            continue
        f = m.group(3).split()
        out[tid] = (int(f[10]) + int(f[11]), m.group(1), m.group(2))  # utime + stime
    return out


def proc_counters(pid: int) -> tuple[int, int, int, int]:
    f = re.match(r"\d+ \(.*\) \S (.*)", read(f"/proc/{pid}/stat"), re.S)
    fl = f.group(1).split() if f else ["0"] * 12
    st = read(f"/proc/{pid}/status")
    return int(fl[6]), int(fl[8]), kb_field(st, "voluntary_ctxt_switches"), kb_field(st, "nonvoluntary_ctxt_switches")


def proc_io(pid: int) -> dict[str, int]:
    out = {}
    for line in read(f"/proc/{pid}/io").splitlines():
        k, _, v = line.partition(":")
        if v.strip().isdigit():
            out[k] = int(v)
    return out


def client_count() -> int:
    n = 0
    for p in glob.glob("/proc/[0-9]*/cmdline"):
        c = read(p).replace("\0", " ")
        if "aperas.ts" in c and "service.ts" not in c and read(p.replace("cmdline", "comm")).strip() == "node":
            n += 1
    return n


def file_meta(path: str) -> tuple[str, str]:
    try:
        st = os.stat(path)
        return str(st.st_size // 1024), datetime.fromtimestamp(st.st_mtime).strftime("%H:%M:%S")
    except OSError:
        return "", ""


def probe(node: str) -> tuple[str, str]:
    t0 = time.time()
    try:
        r = subprocess.run(["aperas", "show", node], capture_output=True, text=True, timeout=20)
        ok = '"@id"' in r.stdout
    except (subprocess.TimeoutExpired, OSError):
        ok = False
    return ("1" if ok else "0"), str(int((time.time() - t0) * 1000))


def sample(prev: dict, a: argparse.Namespace, do_probe: bool) -> tuple[dict, dict]:
    now = time.time()
    row = {c: "" for c in COLS}
    row.update(ts=datetime.fromtimestamp(now).strftime("%Y-%m-%d %H:%M:%S"), epoch=f"{now:.3f}")
    lock = read_lock(a.lock)
    pid = service_pid(a.lock)
    row["pid"] = pid or ""
    if not os.path.exists(a.lock):
        p = {"ok": 0, "connect_ms": "", "ping_ms": "", "err": f"no lock file: {a.lock}"}
    else:
        p = ping(a.socket or lock.get("socketPath") or os.path.join(os.path.dirname(a.lock), "apeironngn.sock"),
                 a.ping_timeout)
    row.update(ping_ok=p["ok"], connect_ms=p["connect_ms"], ping_ms=p["ping_ms"], ping_err=p["err"])
    row["client_would_fail"] = 1 if (not p["ok"] or (p["ping_ms"] != "" and p["ping_ms"] > a.client_timeout_ms)) else 0

    mi = read("/proc/meminfo")
    psi = re.search(r"some avg10=([\d.]+)", read("/proc/pressure/memory"))
    row.update(avail_mb=kb_field(mi, "MemAvailable") // 1024,
               act_anon_mb=kb_field(mi, "Active\\(anon\\)") // 1024, inact_anon_mb=kb_field(mi, "Inactive\\(anon\\)") // 1024,
               act_file_mb=kb_field(mi, "Active\\(file\\)") // 1024, inact_file_mb=kb_field(mi, "Inactive\\(file\\)") // 1024,
               swap_used_mb=(kb_field(mi, "SwapTotal") - kb_field(mi, "SwapFree")) // 1024,
               psi_some10=psi.group(1) if psi else "", clients=client_count())

    root = a.mirror_dir or lock.get("apeironRoot") or ""
    if root:
        row["blk_kb"], row["blk_mtime"] = file_meta(os.path.join(root, "BlockNode.jsonld"))
        row["stblk_kb"], row["stblk_mtime"] = file_meta(os.path.join(root, ".state", "BlockNode.jsonld"))
        row["sttv_mtime"] = file_meta(os.path.join(root, ".state", "TreeView.jsonld"))[1]

    state = {"t": now, "pid": pid}
    if pid:
        st = read(f"/proc/{pid}/status")
        sm = read(f"/proc/{pid}/smaps_rollup")
        row.update(rss_mb=kb_field(st, "VmRSS") // 1024, hwm_mb=kb_field(st, "VmHWM") // 1024,
                   swap_mb=kb_field(st, "VmSwap") // 1024, anon_mb=kb_field(sm, "Anonymous") // 1024,
                   nthreads=kb_field(st, "Threads"))
        threads = thread_stats(pid)
        minf, majf, vol, inv = proc_counters(pid)
        io = proc_io(pid)
        state.update(threads=threads, minf=minf, majf=majf, vol=vol, inv=inv, io=io)
        if prev.get("pid") == pid and "threads" in prev:
            dt = max(now - prev["t"], 0.001)
            share = sorted(((threads[t][0] - prev["threads"].get(t, (threads[t][0],))[0]) / CLK / dt * 100, t)
                           for t in threads)[::-1]
            row.update(cpu_pct=round(sum(s for s, _ in share)),
                       minflt_d=minf - prev["minf"], majflt_d=majf - prev["majf"],
                       ctx_vol_d=vol - prev["vol"], ctx_inv_d=inv - prev["inv"])
            for col, key in (("rchar_kb_d", "rchar"), ("wchar_kb_d", "wchar"),
                             ("rbytes_kb_d", "read_bytes"), ("wbytes_kb_d", "write_bytes")):
                if key in io and key in prev.get("io", {}):
                    row[col] = (io[key] - prev["io"][key]) // 1024
            if share:
                s1, t1 = share[0]
                row.update(top1_tid=t1, top1_name=threads[t1][1], top1_pct=round(s1), top1_state=threads[t1][2],
                           top1_wchan=read(f"/proc/{pid}/task/{t1}/wchan").strip() or "-",
                           top2_pct=round(share[1][0]) if len(share) > 1 else 0)
    if do_probe:
        row["probe_ok"], row["probe_ms"] = probe(a.probe_node)
    return row, state


def run(a: argparse.Namespace) -> None:
    stop = False

    def _stop(*_):
        nonlocal stop
        stop = True

    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)
    new = not os.path.exists(a.out) or os.path.getsize(a.out) == 0
    if not new:
        with open(a.out, newline="") as f:
            header = next(csv.reader(f), [])
        if header != COLS:
            sys.exit(f"{a.out} has a different column set; pick another --out.")
    print(f"sampling every {a.interval:g}s into {a.out} (lock {a.lock}); Ctrl-C to stop", file=sys.stderr)
    prev: dict = {}
    last_probe = 0.0
    with open(a.out, "a", newline="") as f:
        w = csv.DictWriter(f, COLS)
        if new:
            w.writeheader()
        while not stop:
            t0 = time.time()
            do_probe = a.probe_every > 0 and t0 - last_probe >= a.probe_every
            if do_probe:
                last_probe = t0
            row, prev = sample(prev, a, do_probe)
            w.writerow(row)
            f.flush()
            time.sleep(max(0.0, a.interval - (time.time() - t0)))


# --- --report ---------------------------------------------------------------------------------

def _num(r: dict, k: str) -> float | None:
    v = r.get(k, "")
    try:
        return float(v) if v not in ("", None) else None
    except ValueError:
        return None


def row_epochs(rows: list[dict]) -> list[float]:
    """Per-row unix seconds: the `epoch` column when present, else (older files) the HH:MM:SS `ts`,
    made monotonic across midnight."""
    if rows and rows[0].get("epoch"):
        return [float(r["epoch"]) for r in rows]
    out, day, last = [], 0, -1.0
    for r in rows:
        h, m, s = (int(x) for x in r["ts"].split(":"))
        sec = h * 3600 + m * 60 + s
        if sec < last:
            day += 1
        last = sec
        out.append(day * 86400 + sec)
    return out


def stalls(rows: list[dict], epochs: list[float], slow_ms: float) -> list[dict]:
    """Runs of consecutive ticks where the ping failed or took longer than slow_ms. A run's duration
    runs from its first bad tick to the next good tick (or the end of the file); `worst_ms` is the
    longest single reply time seen and `errors` the distinct failure texts."""
    out: list[dict] = []
    cur: dict | None = None
    for i, r in enumerate(rows):
        ok = r.get("ping_ok") == "1"
        ms = _num(r, "ping_ms")
        bad = (not ok) or (ms is not None and ms > slow_ms)
        if bad:
            if cur is None:
                cur = {"start": r["ts"], "t0": epochs[i], "t1": epochs[i], "ticks": 0, "worst_ms": 0.0, "errors": set(),
                       "rss0": r.get("rss_mb", ""), "clients": set()}
            cur["ticks"] += 1
            cur["t1"] = epochs[i]
            cur["worst_ms"] = max(cur["worst_ms"], ms or 0.0)
            if r.get("ping_err"):
                cur["errors"].add(r["ping_err"])
            cur["clients"].add(r.get("clients", ""))
        elif cur is not None:
            cur["end"] = r["ts"]
            cur["duration_s"] = max(epochs[i] - cur["t0"], cur["t1"] - cur["t0"])
            out.append(cur)
            cur = None
    if cur is not None:
        cur["end"] = rows[-1]["ts"]
        cur["duration_s"] = cur["t1"] - cur["t0"]
        cur["open"] = True
        out.append(cur)
    return out


def slope_mb_per_min(points: list[tuple[float, float]]) -> float | None:
    """Least-squares slope of (epoch seconds, MB), in MB per minute; None below 3 points."""
    if len(points) < 3:
        return None
    n = len(points)
    mx = sum(t for t, _ in points) / n
    my = sum(v for _, v in points) / n
    den = sum((t - mx) ** 2 for t, _ in points)
    if den == 0:
        return None
    return sum((t - mx) * (v - my) for t, v in points) / den * 60


def memory_slopes(rows: list[dict], epochs: list[float]) -> list[dict]:
    """Per service pid (a restart resets memory): first/last time, and slope of rss and anon."""
    by_pid: dict[str, list[int]] = {}
    for i, r in enumerate(rows):
        if r.get("pid"):
            by_pid.setdefault(r["pid"], []).append(i)
    out = []
    for pid, idx in by_pid.items():
        rss = [(epochs[i], _num(rows[i], "rss_mb")) for i in idx if _num(rows[i], "rss_mb") is not None]
        anon = [(epochs[i], _num(rows[i], "anon_mb")) for i in idx if _num(rows[i], "anon_mb") is not None]
        out.append({"pid": pid, "first": rows[idx[0]]["ts"], "last": rows[idx[-1]]["ts"], "samples": len(idx),
                    "span_min": (epochs[idx[-1]] - epochs[idx[0]]) / 60,
                    "rss_first": rss[0][1] if rss else None, "rss_last": rss[-1][1] if rss else None,
                    "rss_slope": slope_mb_per_min(rss), "anon_slope": slope_mb_per_min(anon),
                    "hwm_last": _num(rows[idx[-1]], "hwm_mb")})
    return out


def mtime_changes(rows: list[dict], col: str) -> int:
    seen = [r[col] for r in rows if r.get(col)]
    return sum(1 for a, b in zip(seen, seen[1:]) if a != b)


def report(path: str, slow_ms: float = 1000.0) -> None:
    with open(path, newline="") as f:
        rows = list(csv.DictReader(f))
    if not rows:
        print("no rows")
        return
    epochs = row_epochs(rows)
    span = (epochs[-1] - epochs[0]) / 60
    print(f"{len(rows)} samples, {rows[0]['ts']} to {rows[-1]['ts']} ({span:.1f} min)")
    print("pids seen:", sorted({r["pid"] for r in rows if r["pid"]}))

    if "ping_ok" in rows[0]:
        pinged = [r for r in rows if r["ping_ok"] in ("0", "1")]
        failed = [r for r in pinged if r["ping_ok"] == "0"]
        print(f"\npings: {len(pinged)}  failed: {len(failed)}  "
              f"client would have failed (>300 ms or error): {sum(1 for r in pinged if r.get('client_would_fail') == '1')}")
        errs: dict[str, int] = {}
        for r in failed:
            errs[r["ping_err"] or "(no text)"] = errs.get(r["ping_err"] or "(no text)", 0) + 1
        for e, n in sorted(errs.items(), key=lambda x: -x[1]):
            print(f"  {n:5d} x {e}")
        st = stalls(rows, epochs, slow_ms)
        print(f"\nstalls (ping failed or slower than {slow_ms:g} ms): {len(st)}")
        for s in st:
            print(f"  {s['start']} -> {s['end']}{' (still going at end of file)' if s.get('open') else ''}  "
                  f"{s['duration_s']:.1f} s  ticks={s['ticks']}  worst reply={s['worst_ms']:.0f} ms  "
                  f"rss at start={s['rss0']}MB  clients={','.join(sorted(s['clients']))}  errors={'; '.join(sorted(s['errors'])) or '-'}")
        if st:
            print(f"  longest {max(s['duration_s'] for s in st):.1f} s, total {sum(s['duration_s'] for s in st):.1f} s")
    else:
        bad = [r for r in rows if r.get("probe_ok") == "0"]
        print(f"\nlegacy file (no ping columns): probes failed {len(bad)}, ok {sum(1 for r in rows if r.get('probe_ok') == '1')}")
        for r in bad[:10]:
            print(f"  {r['ts']} FAIL  rss={r['rss_mb']}MB cpu={r['cpu_pct']}% clients={r['clients']}")

    print("\nmemory by service pid (slope = least squares, MB per minute):")
    for m in memory_slopes(rows, epochs):
        f = lambda v: "n/a" if v is None else f"{v:+.2f}"
        print(f"  pid {m['pid']}: {m['first']} -> {m['last']} ({m['span_min']:.1f} min, {m['samples']} rows)  "
              f"rss {m['rss_first']:.0f} -> {m['rss_last']:.0f} MB  rss slope {f(m['rss_slope'])}  anon slope {f(m['anon_slope'])}"
              + (f"  VmHWM {m['hwm_last']:.0f} MB" if m["hwm_last"] is not None else "")
              if m["rss_first"] is not None else f"  pid {m['pid']}: no rss data")

    if "blk_mtime" in rows[0]:
        print(f"\nmirror writes seen (mtime changes): BlockNode.jsonld {mtime_changes(rows, 'blk_mtime')}, "
              f".state/BlockNode.jsonld {mtime_changes(rows, 'stblk_mtime')}, .state/TreeView.jsonld {mtime_changes(rows, 'sttv_mtime')}")

    print("\nspin candidates (cpu >= 90%, few new pages, flat resident size):")
    any_spin = False
    for a, b in zip(rows, rows[1:]):
        if _num(b, "cpu_pct") and _num(b, "cpu_pct") >= 90 and _num(b, "minflt_d") is not None and _num(b, "minflt_d") < 2000 \
                and _num(a, "rss_mb") is not None and _num(b, "rss_mb") is not None and abs(_num(b, "rss_mb") - _num(a, "rss_mb")) < 20:
            any_spin = True
            print(f"  {b['ts']} cpu={b['cpu_pct']}% top1={b['top1_name']}:{b['top1_pct']}%({b['top1_state']},{b['top1_wchan']}) "
                  f"minflt_d={b['minflt_d']} ctx_inv_d={b['ctx_inv_d']}")
    if not any_spin:
        print("  none")
    print("\nrss trend (about 12 rows):")
    for r in rows[:: max(1, len(rows) // 12)]:
        print(f"  {r['ts']} rss={r['rss_mb']}MB anon={r['anon_mb']}MB avail={r['avail_mb']}MB cpu={r['cpu_pct']}% clients={r['clients']}")


def main(argv: list[str] | None = None) -> None:
    run_dir = default_run_dir()
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--out", default=os.path.join(tempfile.gettempdir(), "svc_samples.csv"), help="CSV to append to")
    ap.add_argument("--interval", type=float, default=1.0, help="seconds between ticks (default 1)")
    ap.add_argument("--lock", default=os.path.join(run_dir, "apeironngn.lock"), help="service lock file (default mirrors serviceLock.ts)")
    ap.add_argument("--socket", default="", help="service socket (default: socketPath from the lock, else beside it)")
    ap.add_argument("--mirror-dir", default="", help="Apeiron mirror dir (default: apeironRoot from the lock)")
    ap.add_argument("--ping-timeout", type=float, default=5.0, help="seconds to wait for a ping reply before recording a failure")
    ap.add_argument("--client-timeout-ms", type=float, default=CLIENT_PING_TIMEOUT_MS, help="reply time past which the real CLI client gives up")
    ap.add_argument("--probe-every", type=float, default=0.0, help="seconds between `aperas show` client probes; 0 (default) disables")
    ap.add_argument("--probe-node", default="BlockNode:00CE8XWZK0000", help="node the optional client probe shows")
    ap.add_argument("--report", metavar="CSV", help="summarize a CSV instead of sampling")
    ap.add_argument("--stall-ms", type=float, default=1000.0, help="--report: reply time that counts as a stall (default 1000)")
    a = ap.parse_args(argv)
    if a.report:
        report(a.report, a.stall_ms)
    else:
        run(a)


if __name__ == "__main__":
    main()
