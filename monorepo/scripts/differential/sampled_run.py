#!/usr/bin/env python3
"""The script of piece 4 (`cmdrun.py`) with `svc_sampler.py` on each service it starts (Python 3, standard library only; planning/core.md, Batch 13, piece 7).

  python3 monorepo/scripts/differential/sampled_run.py --out <dir> --ports <ref>,<new> --snapshot <graph-root> [any other option of cmdrun.py]
         [--sampler-out <dir>] [--interval S]

Runs `cmdrun.py` with the options it is given, unchanged, as a child; watches the run directories it makes (`<dir>/<part>/{ref,new}/run/aperas/apeironngn.lock`) and, as soon as the lock of
a side says `ready`, starts `packages/cli/diagnostics/svc_sampler.py` on that lock (one per service, writing `<sampler-out>/<part>-<side>.csv`; default `<dir>.samples/`); when the part is over
(`<dir>/<part>.harness.txt` exists) it ends that part's samplers with SIGINT. The sampler is given a lock only after the lock says `ready`, because without a lock it looks for any service
process of the machine, the working service's included; a row whose pid is not one that the lock of the side named is counted and left out of the summary. When the child has ended it
prints `svc_sampler.py --report` for every file. It signals only the processes it started. The exit status is the child's.
"""
import argparse
import csv
import glob
import json
import os
import signal
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
MONOREPO = os.path.dirname(os.path.dirname(HERE))
SAMPLER = os.path.join(MONOREPO, "packages", "cli", "diagnostics", "svc_sampler.py")
PARTS = ("main", "lifecycle", "broken")
SIDES = ("ref", "new")


def lock_info(path):
    try:
        with open(path, encoding="utf-8") as h:
            return json.load(h)
    except (OSError, ValueError):
        return None


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--sampler-out")
    p.add_argument("--interval", type=float, default=1.0)
    a, rest = p.parse_known_args(argv)
    q = argparse.ArgumentParser(add_help=False)
    q.add_argument("--out", required=True)
    known, _ = q.parse_known_args(rest)
    out = os.path.abspath(known.out)
    sdir = os.path.abspath(a.sampler_out or out + ".samples")
    os.makedirs(sdir, exist_ok=True)
    env = {k: v for k, v in os.environ.items() if k != "LD_LIBRARY_PATH"}
    child = subprocess.Popen([sys.executable, os.path.join(HERE, "cmdrun.py")] + rest, stdin=subprocess.DEVNULL, env=env)
    samplers = {}     # (part, side) -> Popen
    pids = {}         # (part, side) -> set of pids the lock named
    started_at = {}
    while True:
        done = child.poll() is not None
        for part in PARTS:
            ended = os.path.exists(os.path.join(out, part + ".harness.txt"))
            for side in SIDES:
                key = (part, side)
                lock_path = os.path.join(out, part, side, "run", "aperas", "apeironngn.lock")
                lk = lock_info(lock_path)
                if isinstance(lk, dict) and isinstance(lk.get("pid"), int) and lk.get("status") == "ready":
                    pids.setdefault(key, set()).add(lk["pid"])
                    if key not in samplers and not ended:
                        csv_path = os.path.join(sdir, "%s-%s.csv" % (part, side))
                        samplers[key] = subprocess.Popen([sys.executable, SAMPLER, "--lock", lock_path, "--out", csv_path, "--interval", str(a.interval)], stdin=subprocess.DEVNULL,
                                                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env, start_new_session=True)
                        started_at[key] = time.strftime("%H:%M:%S")
                if ended and key in samplers and samplers[key].poll() is None:
                    samplers[key].send_signal(signal.SIGINT)
        if done:
            break
        time.sleep(1)
    for key, s in samplers.items():
        if s.poll() is None:
            s.send_signal(signal.SIGINT)
    for key, s in samplers.items():
        try:
            s.wait(timeout=10)
        except subprocess.TimeoutExpired:
            s.kill()
    print("\nsamplers: %s" % {"%s-%s" % k: started_at[k] for k in samplers})
    for f in sorted(glob.glob(os.path.join(sdir, "*.csv"))):
        part, side = os.path.basename(f)[:-4].split("-")
        ours = pids.get((part, side), set())
        with open(f, newline="") as h:
            rows = list(csv.DictReader(h))
        foreign = [r for r in rows if r.get("pid") and int(r["pid"]) not in ours]
        print("\n===== %s (%d rows; pids named by the lock: %s; rows with another pid: %d)" % (os.path.basename(f), len(rows), sorted(ours), len(foreign)))
        sys.stdout.flush()
        subprocess.run([sys.executable, SAMPLER, "--report", f], env=env, stdin=subprocess.DEVNULL)
    return child.returncode


if __name__ == "__main__":
    sys.exit(main())
