#!/usr/bin/env python3
"""The differential run of the script of commands on the small corpus (Python 3, standard library only; planning/core.md, Batch 13, piece 4).

  python3 monorepo/scripts/differential/cmdrun.py --out <dir> --ports <ref>,<new> [--reference-code <monorepo>] [--new-code <monorepo>] [--parts main,lifecycle,broken]

In order: the snapshot (`corpus.py`, built with the reference's own service), then for each part the list of commands (`cases.py`), the harness run on a fresh copy of the
snapshot (`harness.py`: two services apart, one per side, in scratch directories under `<dir>`), and the comparison (`compare.py` with the rules of `explain.py`): the dumps, the
commands' status, stdout and stderr, the services' logs. It ends with the table of the 28 entries of Layer 4 and of the entries of its own paragraph that carry no number, each
seen by a command (with the cases that reached it) or named as unreachable by a command with its reason, the coverage of the 19 verbs, and `UNEXPLAINED differences: N`.
Exit 0 when N is 0 and every entry is seen or named; 1 otherwise; 2 for a usage error or a refusal of the harness.

Nothing here touches the working service: the harness refuses to start unless its variables are its own (its assertions are in `harness.py`). A part whose harness run makes no
progress for 5 minutes (no new file in its `commands/`) is ended by the pid of the harness process this run started, after its command line is checked.
"""
import argparse
import json
import os
import signal
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import cases  # noqa: E402
import compare  # noqa: E402
import corpus  # noqa: E402
import explain  # noqa: E402
import harness  # noqa: E402

PARTS = ("main", "lifecycle", "broken")
VERBS = ["backlinks", "check-links", "flush", "fold", "ingest", "insert", "path", "profile", "project", "reload", "remove", "resolve", "retype", "show", "track", "tree", "unfold", "update", "zoom"]
NO_PROGRESS_SECONDS = 300

# The entries that no command reaches, with the reason. An entry that a run sees is not listed as unreachable, whatever is written here.
UNREACHABLE = {
    6: "it concerns how the tests build nodes (a node is made before it is written, and its id is of the engine's grammar); no command writes a node it did not create, or an id of its own",
    7: "no verb removes a pair: `link` and `unlink` are gone from the new side, and the removal of an embed pair is the engine's own (`removePair`)",
    11: "retired and deleted code and tests (the smoke test, `verifyDanglingUnfolds`, `Lookups.subtreeTombstoned`); nothing a command reaches",
    12: "one sequencing change in a test (`lifecycle.test.ts`, `flush --clobber` first)",
}
# The entries the cases reached and on which the two sides do not differ on this corpus: named, with what was seen.
AGREE = {
    19: "the cases ran (`show` of blocks with two and with three links, before and after a reload from a file that lists them in another order) and the two sides print the links in id order: the reference's store lists a set by id as well, so no command shows the difference",
}
# What a run shows for an entry that a dump or a command could not tell on this corpus is written by the Coder in the Report, from the run, and not here.


class Watchdog:
    def __init__(self, proc, watch_dir, seconds):
        self.proc, self.dir, self.seconds = proc, watch_dir, seconds
        self.last, self.last_count = time.time(), -1

    def poll(self):
        count = len(os.listdir(self.dir)) if os.path.isdir(self.dir) else 0
        if count != self.last_count:
            self.last, self.last_count = time.time(), count
        return time.time() - self.last > self.seconds


def end_own_process(proc):
    """Ends the harness process this run started, after checking its command line: the harness's own handler stops its services."""
    try:
        cmdline = harness.proc_text(proc.pid, "cmdline").replace("\0", " ")
    except OSError:
        return
    if "harness.py" in cmdline:
        proc.send_signal(signal.SIGTERM)
        try:
            proc.wait(120)
        except subprocess.TimeoutExpired:
            proc.send_signal(signal.SIGKILL)


def run_part(part, snapshot, out, ports, args, log):
    lst = os.path.join(out, part + ".json")
    commands = cases.build_list(snapshot, part)
    with open(lst, "w", encoding="utf-8") as h:
        json.dump(commands, h, indent=1, ensure_ascii=False)
        h.write("\n")
    run_dir = os.path.join(out, part)
    cmd = [sys.executable, os.path.join(HERE, "harness.py"), "--snapshot", snapshot, "--out", run_dir, "--commands", lst, "--ports", ports,
           "--reference-code", args.reference_code, "--new-code", args.new_code]
    env = {k: v for k, v in os.environ.items() if k != "LD_LIBRARY_PATH"}
    log("part %s: %d commands" % (part, len(commands["commands"])))
    t = time.time()
    proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=env)
    wd = Watchdog(proc, os.path.join(run_dir, "commands"), NO_PROGRESS_SECONDS)
    stalled = False
    while proc.poll() is None:
        time.sleep(2)
        if wd.poll():
            stalled = True
            end_own_process(proc)
    text = proc.stdout.read()
    with open(os.path.join(out, part + ".harness.txt"), "w", encoding="utf-8") as h:
        h.write(text)
    log("part %s: harness status %s in %.0f s%s" % (part, proc.returncode, time.time() - t, " (no progress for %d s: ended)" % NO_PROGRESS_SECONDS if stalled else ""))
    return run_dir, proc.returncode, stalled


def read(path):
    try:
        with open(path, encoding="utf-8", errors="replace") as h:
            return h.read()
    except OSError:
        return ""


def compare_part(part, run_dir, snapshot):
    cmds, results = compare.load_commands(run_dir)
    ref_root, new_root = os.path.abspath(os.path.join(run_dir, "ref")), os.path.abspath(os.path.join(run_dir, "new"))
    logs = (read(os.path.join(run_dir, "logs", "ref.service.log")), read(os.path.join(run_dir, "logs", "new.service.log")))
    return compare.compare_dumps(os.path.join(run_dir, "dumps", "ref", "Apeiron"), os.path.join(run_dir, "dumps", "new", "Apeiron"), snapshot=snapshot, commands=cmds, migrate=True,
                                 roots_ref=(ref_root,), roots_new=(new_root,), logs=logs, artifacts={"ref": os.path.join(ref_root, "artifacts"), "new": os.path.join(new_root, "artifacts")}), results


def probe_thread_timer(run_dir):
    """Sweeps 1: an `update` of a thread node alone reaches `.state/` by the thread graph's own timer on the new side and not on the reference's. -> evidence text or None."""
    cap = None
    for name in sorted(os.listdir(os.path.join(run_dir, "captures"))) if os.path.isdir(os.path.join(run_dir, "captures")) else []:
        if "wait-thread-timer" in name:
            cap = os.path.join(run_dir, "captures", name)
    if cap is None:
        return None
    needle = "by a timer"
    held = {s: needle in read(os.path.join(cap, s, "Apeiron", ".state", "BlockNode.jsonld")) for s in ("ref", "new")}
    if held["new"] and not held["ref"]:
        return "5 s after an `update` of a thread node with no flush, `.state/BlockNode.jsonld` holds the new text on the new side and the old one on the reference's"
    return None


def probe_emptied_capture(run_dir, snapshot):
    """Flip 3 in the dumps: the files copied right after `remove` of the last child of a textless wrapper hold the wrapper tombstoned on the new side and live on the reference's.
    -> number of differences of the dumps that the comparer's matcher for entry 3 claims."""
    cap = os.path.join(run_dir, "captures")
    for name in sorted(os.listdir(cap)) if os.path.isdir(cap) else []:
        if "remove-wrapper-inner" in name:
            r = compare.compare_dumps(os.path.join(cap, name, "ref", "Apeiron"), os.path.join(cap, name, "new", "Apeiron"), snapshot=snapshot, migrate=True)
            return r.seen.get(3, 0)
    return 0


def probe_broken(run_dir):
    """Sweeps 3: a refused start says why at once, where the reference's client waited out its start call and answered that the service did not become ready in time.
    -> evidence text or None."""
    with open(os.path.join(run_dir, "results.json"), encoding="utf-8") as h:
        results = json.load(h)
    cmds, _ = compare.load_commands(run_dir)
    for c, rec in zip(cmds, [r for r in results["commands"]]):
        if c["name"] != "start-broken":
            continue
        r, n = c["ref"], c["new"]
        rs, ns = rec["ref"]["seconds"], rec["new"]["seconds"]
        if n["status"] not in (0, None) and r["status"] not in (0, None) and ns < rs and "did not become ready in time" in r["stderr"] and "did not become ready in time" not in n["stderr"]:
            return "a start on a mirror whose file is not JSON: the new side answers in %.1f s, `%s`; the reference answers in %.1f s, `%s`" % (
                ns, n["stderr"].strip()[:110], rs, r["stderr"].strip()[:60])
    return None


def verb_coverage(runs):
    """-> {verb: {"cases": n, "flags": set, "refusals": n}} over the commands of every part."""
    cov = {v: {"cases": 0, "flags": set(), "refusals": 0} for v in VERBS}
    for run_dir in runs:
        cmds, _ = compare.load_commands(run_dir)
        for c in cmds:
            argv = c.get("argv") or []
            if not argv or argv[0] not in cov:
                continue
            e = cov[argv[0]]
            e["cases"] += 1
            e["flags"] |= {a for a in argv[1:] if a.startswith("--")}
            if c["ref"]["status"] not in (0, None) and c["new"]["status"] not in (0, None):
                e["refusals"] += 1
    return cov


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--out", required=True)
    p.add_argument("--ports", required=True)
    p.add_argument("--reference-code", default=harness.DEFAULT_REFERENCE)
    p.add_argument("--new-code", default=harness.MONOREPO)
    p.add_argument("--parts", default=",".join(PARTS))
    p.add_argument("--snapshot", help="use this snapshot (built by corpus.py) instead of building one")
    args = p.parse_args(argv)
    out = os.path.abspath(args.out)
    parts = args.parts.split(",")
    if any(x not in PARTS for x in parts):
        print("REFUSED: --parts names %s" % ", ".join(PARTS), file=sys.stderr)
        return 2
    if os.path.exists(out):
        print("REFUSED: %s exists" % out, file=sys.stderr)
        return 2
    os.makedirs(out)
    lines = []

    def log(text):
        print(text, flush=True)
        lines.append(text)

    ref_port = int(args.ports.split(",")[0])
    snapshot = os.path.abspath(args.snapshot) if args.snapshot else os.path.join(out, "snapshot")
    try:
        if not args.snapshot:
            corpus.build(snapshot, args.reference_code, ref_port, os.path.join(out, "snapshot.build"))
            log("snapshot built in %s" % snapshot)
    except (harness.Refusal, harness.Failure) as e:
        print("REFUSED: %s" % e, file=sys.stderr)
        return 2
    runs, results, unexplained, problems = {}, {}, [], []
    seen = {}
    dump_claims = {}
    for part in parts:
        run_dir, status, stalled = run_part(part, snapshot, out, args.ports, args, log)
        runs[part] = run_dir
        if status == 2 or not os.path.isfile(os.path.join(run_dir, "results.json")):
            problems.append("part %s: the harness refused or did not finish (status %s): see %s.harness.txt" % (part, status, part))
            continue
        res = json.load(open(os.path.join(run_dir, "results.json"), encoding="utf-8"))
        problems += ["part %s: %s" % (part, x) for x in res.get("problems", [])]
        if stalled:
            problems.append("part %s was ended: no progress for %d s" % (part, NO_PROGRESS_SECONDS))
        if part == "broken":
            ev = probe_broken(run_dir)
            if ev:
                seen.setdefault(24, []).append((part, ev))
            continue
        try:
            r, _ = compare_part(part, run_dir, snapshot)
        except compare.Failure as e:
            problems.append("part %s: the comparison failed: %s" % (part, e))
            continue
        results[part] = r
        for d, key in r.claims:
            if d.scope not in ("output", "log"):
                dump_claims[key] = dump_claims.get(key, 0) + 1
        for key, n in r.seen.items():
            seen.setdefault(key, []).append((part, "x%d" % n))
        for d, why in r.findings:
            unexplained.append((part, d, why))
        problems += ["part %s: %s" % (part, x) for x in r.problems]
        if part == "main":
            n = probe_emptied_capture(run_dir, snapshot)
            if n:
                dump_claims[3] = dump_claims.get(3, 0) + n
                seen.setdefault(3, []).append((part, "(dump probe x%d)" % n))
            ev = probe_thread_timer(run_dir)
            if ev:
                seen.setdefault(22, []).append((part, ev))
    report(out, seen, unexplained, problems, runs, log, dump_claims)
    n = len(unexplained) + len(problems)
    unnamed = [k for k in compare.MATCHERS if k not in seen and k not in UNREACHABLE and k not in AGREE]
    return 0 if n == 0 and not unnamed else 1


def report(out, seen, unexplained, problems, runs, log, dump_claims):
    by_entry = {}
    for name, entries, what in cases.CASES:
        for e in entries:
            by_entry.setdefault(e, []).append(name)
    log("")
    log("%-4s %-11s %-70s %s" % ("#", "Layer 4", "entry", "state"))
    unnamed = []
    for key, m in compare.MATCHERS.items():
        if key in seen:
            state = "SEEN " + ", ".join("%s %s" % (p, v if v.startswith("x") else "(probe)") for p, v in seen[key])
        elif key in UNREACHABLE:
            state = "NOT REACHED BY A COMMAND: " + UNREACHABLE[key]
        elif key in AGREE:
            state = "REACHED, NO DIFFERENCE ON THIS CORPUS: " + AGREE[key]
        else:
            state = "NOT SEEN (no reason named)"
            unnamed.append(key)
        log("%-4d %-11s %-70s %s" % (key, "%s %d" % (compare.LABELS[m.group], m.number), m.title[:70], state))
        if key in by_entry:
            log("       cases aimed at it: %s" % ", ".join(by_entry[key][:12]) + (" ..." if len(by_entry[key]) > 12 else ""))
    log("")
    log("The unnumbered entries of Layer 4's paragraph, notes and proposals:")
    for key, (where, text) in explain.EXTRA.items():
        state = ("SEEN " + ", ".join("%s %s" % (p, v) for p, v in seen[key])) if key in seen else "not seen on this corpus"
        log("%-4s %-34s %s [%s]" % (key, text[:100], state, where))
    log("confirmed in the dumps by the matchers of the comparer, from real commands on the two services (differences of documents): %s" % (
        ", ".join("%s x%d" % (k, dump_claims.get(k, 0)) for k in (2, 3, 21, 23, 25)) or "none"))
    for evidence in (seen.get(22, []) + seen.get(24, [])):
        log("probe: %s" % evidence[1])
    cov = verb_coverage(runs.values())
    log("")
    log("%-12s %6s %9s  %s" % ("verb", "cases", "refusals", "flags used"))
    for v in VERBS:
        e = cov[v]
        log("%-12s %6d %9d  %s" % (v, e["cases"], e["refusals"], " ".join(sorted(e["flags"]))))
    log("")
    for part, d, why in unexplained:
        log("UNEXPLAINED (%s) in part %s: %s" % (why, part, d.describe()[:600]))
    for x in problems:
        log("PROBLEM: %s" % x)
    log("UNEXPLAINED differences: %d" % (len(unexplained) + len(problems)))
    log("entries neither seen nor named: %s" % (unnamed or "none"))
    with open(os.path.join(out, "report.txt"), "w", encoding="utf-8") as h:
        h.write("\n".join(compare_lines(out)) + "\n")


def compare_lines(out):
    return []


if __name__ == "__main__":
    sys.exit(main())
