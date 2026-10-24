#!/usr/bin/env python3
"""What the differential run's commands and logs may differ in, and why (Python 3, standard library only; planning/core.md, Batch 13, piece 4).

`compare.py` (piece 3) explains the differences of two dumps. This module explains the differences of what the commands printed and of what the two services logged,
and adds the few differences of a dump that only a command makes. Every explanation is a rule that names its entry of Layer 4 (`1` to `31`, the keys of
`compare.MATCHERS`), or one of the differences that Layer 4's own paragraph lists without a number (`H1` to `H10`), or an observation that Layer 4 records as not a
difference (`N1` to `N3`), or a decision of the user that is not a numbered entry (`D1`), or a difference proposed to the grapher (`P1`, `P2` ... when there is one): `EXTRA` names them all. A rule rewrites the reference's text into what the new engine prints
when the difference is the deliberate one, and a rule's entry is claimed only when the rewrite makes the two texts equal: a text that is not equal after every rule is a finding,
with what is left of it.

  explain(argv, ref, new, ctx) -> (claims, ref', new')   one command: `ref` and `new` are {"status", "stdout", "stderr"} of normalised texts
  explain_logs(ref_text, new_text) -> (claims, findings) the services' logs, line by line
  EXTRA_DUMP                                              [(key, function(diff, context))] for the differences of a dump that a command makes
"""
import difflib
import json
import re

# --------------------------------------------------------------------------------------------------------------------- the entries that are not numbered

EXTRA = {
    "H1": ("Layer 4 (migration)", "no `predicate` on a Link: `show` prints none, and `tree`, `unfold` and the render tree print a link without it"),
    "H2": ("Layer 4 (migration)", "`dinhlx` is given `kind: human`"),
    "H3": ("Layer 4 (migration)", "the six `README.md` artifacts and their paragraphs are deleted"),
    "H4": ("Layer 4 (migration)", "the `unfolds` entries whose target is not defined are stripped"),
    "H5": ("Layer 4", "the order of ids is by code point where `localeCompare` ordered them"),
    "H6": ("Layer 4", "the `children` order and the `parent` rule of the load"),
    "H7": ("Layer 4", "the rejection of a repeated `@id`"),
    "H8": ("Layer 4", "the empty tombstone: a removed node keeps no `parent`, `props`, `links` or `children`"),
    "H9": ("Layer 4", "the migration strips the tombstones from the tree"),
    "H10": ("Layer 4", "the removal of `aperas link` and `aperas unlink` (manual links are dropped)"),
    "N1": ("Layer 4 (noted, not a difference)", "the set fields (`links`, `props`, `unfolds`) read in the engine's insertion order"),
    "N2": ("an observation", "a content hash (`fileHash`, `ingestedHash`, `projectedHash`) taken over a text that holds ids minted in the run"),
    "N3": ("an observation", "the reference's client decodes each chunk of a response (64 KiB) on its own, so a character cut between two chunks is printed as 2 to 4 U+FFFD"),
    "N4": ("a decision of the harness", "the new side's scratch config sets a long flush interval for the content graph, and its service warns that the graphs table has an entry named `tree`"),
    "D1": ("a decision", "a start waits for the service to be ready: the reference's client gives up after 5 s with `did not become ready in time` while its service goes on loading"),
}

FFFD = "\ufffd"
NOT_READY = "[aperas] Failed: ApeironNgn service did not become ready in time"
LINK_LINE = re.compile(r"\[Link\]")
VERB_LINE = re.compile(r"^  (\S+)\s+(.*)$")
REMOVED_VERBS = {"link": "H10", "unlink": "H10", "migrate-frontmatter": 29}


def cut_character(x, y):
    """True when the line `x` is the line `y` with each run of U+FFFD standing for one character of `y`: a run of 2 to 4 for one character of at least as many bytes as the run is long (a run of 2
    stands for a character of 2 to 4 bytes, of 3 for one of 3 or 4, of 4 for one of 4)."""
    parts = re.split("(" + FFFD + "+)", x)
    rx = "".join(re.escape(p) if i % 2 == 0 else "(.)" for i, p in enumerate(parts))
    m = re.fullmatch(rx, y)
    if not m:
        return False
    runs = [p for i, p in enumerate(parts) if i % 2 == 1]
    return all(2 <= len(r) <= 4 and len(c.encode("utf-8")) >= len(r) for r, c in zip(runs, m.groups()))


def verb_of(argv):
    return argv[0] if argv else ""


def flags_of(argv):
    return {a for a in argv[1:] if a.startswith("--")}


def lines_of(text):
    return text.split("\n")


def join(lines):
    return "\n".join(lines)


def sort_runs(text, pred):
    """The text with every run of consecutive lines for which `pred` holds put in sorted order."""
    out, run = [], []
    for line in lines_of(text):
        if pred(line):
            run.append(line)
            continue
        out += sorted(run)
        run = []
        out.append(line)
    out += sorted(run)
    return join(out)


def depth_of(line):
    return len(line) - len(line.lstrip("│ "))


def mask_json(x, key):
    if isinstance(x, list):
        return [mask_json(e, key) for e in x]
    if isinstance(x, dict):
        return {k: ("<text at a position>" if k == key else mask_json(v, key)) for k, v in x.items()}
    return x


def sort_json_lists(x):
    """A parsed document with every list of objects sorted by its own text."""
    if isinstance(x, list):
        items = [sort_json_lists(e) for e in x]
        return sorted(items, key=lambda e: json.dumps(e, sort_keys=True)) if all(isinstance(e, dict) for e in items) else items
    if isinstance(x, dict):
        return {k: sort_json_lists(v) for k, v in x.items()}
    return x


def drop_key(x, key):
    if isinstance(x, list):
        return [drop_key(e, key) for e in x]
    if isinstance(x, dict):
        return {k: drop_key(v, key) for k, v in x.items() if k != key}
    return x


def sort_blocks(text, head):
    """The text with every run of consecutive blocks sorted; a block is a line that matches `head` and the lines after it that do not."""
    out, run, cur = [], [], None
    for line in lines_of(text):
        if re.match(head, line):
            if cur is not None:
                run.append(cur)
            cur = [line]
        elif cur is not None and line.startswith(" "):
            cur.append(line)
        else:
            if cur is not None:
                run.append(cur)
                cur = None
            for blk in sorted(run, key=tuple):
                out += blk
            run = []
            out.append(line)
    if cur is not None:
        run.append(cur)
    for blk in sorted(run, key=tuple):
        out += blk
    return join(out)


def link_units(text):
    """The lines of a tree as a list of items: a link line with the deeper lines under it is one item (a list of lines), any other line is a string."""
    items, lines, i = [], lines_of(text), 0
    while i < len(lines):
        m = re.match(r"^[│ ]*(\S+)  \[Link\]", lines[i])
        if not m:
            items.append(lines[i])
            i += 1
            continue
        unit, d, i = [lines[i]], depth_of(lines[i]), i + 1
        while i < len(lines) and depth_of(lines[i]) > d and lines[i].strip():
            unit.append(lines[i])
            i += 1
        items.append(unit)
    return items


def unit_id(unit):
    return re.match(r"^[│ ]*(\S+)  \[Link\]", unit[0]).group(1)


def sort_link_units(text):
    """The tree with every run of consecutive links (each with what is expanded under it) sorted by the id of the link."""
    out, run = [], []
    for item in link_units(text):
        if isinstance(item, list):
            run.append(item)
            continue
        for u in sorted(run, key=unit_id):
            out += u
        run = []
        out.append(item)
    for u in sorted(run, key=unit_id):
        out += u
    return join(out)


def parse_json(text):
    try:
        return json.loads(text)
    except ValueError:
        return None


# --------------------------------------------------------------------------------------------------------------------- one command

class Rules:
    """The rules, in the order they apply; each is a method `r_<name>(argv, ref, new, ctx)` that edits `ref` and `new` (dicts of status, stdout, stderr) and returns the
    list of entries it applied. A rule applies only to the verbs it names."""

    # ---- the verbs only the reference has, and the list of verbs
    def r_removed_verbs(self, argv, ref, new, ctx):
        v = verb_of(argv)
        applied = []
        if v in REMOVED_VERBS and re.search(r"Unknown command '%s'" % re.escape(v), new["stderr"]) and "Unknown command" not in ref["stderr"]:
            for d in (ref, new):
                d["status"], d["stdout"], d["stderr"] = "<removed verb>", "<removed verb>", "<removed verb>"
            applied.append(REMOVED_VERBS[v])
        elif "Verbs:" in ref["stdout"] and "Verbs:" in new["stdout"]:
            keep = []
            for line in lines_of(ref["stdout"]):
                m = VERB_LINE.match(line)
                if m and m.group(1) in REMOVED_VERBS:
                    applied.append(REMOVED_VERBS[m.group(1)])
                    continue
                keep.append(line)
            ref["stdout"] = join(keep)
            for d in (ref, new):
                d["stdout"] = join(re.sub(r"^  (\S+)\s+", r"  \1 ", l) for l in lines_of(d["stdout"]))
        return applied

    # ---- the migration's changes that the outputs show
    def r_predicate(self, argv, ref, new, ctx):
        t = ref["stdout"]
        a, b = parse_json(t), parse_json(new["stdout"])
        if isinstance(a, dict) and isinstance(b, dict) and '"predicate"' in t:
            ref["stdout"] = json.dumps(drop_key(a, "predicate"), indent=2, ensure_ascii=False)
            new["stdout"] = json.dumps(b, indent=2, ensure_ascii=False)
            return ["H1"]
        t2 = re.sub(r'^[ ]*"predicate": "[^"]*",?\n', "", t, flags=re.M)
        t2 = re.sub(r"\[Link\]  \[\[[A-Za-z]+\]\] → ", "[Link]  → ", t2)
        if t2 == t:
            return []
        ref["stdout"] = t2
        return ["H1"]

    def r_type_root(self, argv, ref, new, ctx):
        t = ref["stdout"]
        if '"@type": "ArtifactNode"' not in t:
            return []
        t2 = re.sub(r'^  "type": "[^"]*",\n', "", t, flags=re.M, count=1)
        if t2 == t or re.search(r'^  "type":', new["stdout"], flags=re.M):
            return []
        ref["stdout"] = t2
        return [8]

    def r_kind_human(self, argv, ref, new, ctx):
        if verb_of(argv) != "profile":
            return []
        t = re.sub(r"^(dinhlx  )\[-\]", r"\1[human]", ref["stdout"], flags=re.M)
        if t == ref["stdout"] or "dinhlx  [human]" not in new["stdout"]:
            return []
        ref["stdout"] = t
        return ["H2"]

    # ---- a refusal's words
    def r_path_message(self, argv, ref, new, ctx):
        if verb_of(argv) != "path":
            return []
        a, b = ref["stderr"], new["stderr"]
        applied = []
        if "toPath is not a function" in a and re.search(r"is a \w+, which has no path: only a tracked artifact, folder or block does\.", b):
            ref["stderr"] = new["stderr"] = "<a node that has no path is refused>"
            applied.append(17)
        elif "has no walkable parent chain" in a and "has no walkable parent chain" in b:
            strip = lambda s: re.sub(r"has no walkable parent chain — .*", "has no walkable parent chain", s)
            if a != b and strip(a) == strip(b):
                ref["stderr"], new["stderr"] = strip(a), strip(b)
                applied.append(17)
        return applied

    # ---- a load that is not whole (Flip 10), the repeated id and the refused document (Follow-up 1), the option that accepts it (Sweeps 4)
    def r_load_refusals(self, argv, ref, new, ctx):
        v = verb_of(argv)
        nerr = new["stderr"]
        keys = lambda: [10] + (["H7"] if "carried by more than one document" in nerr else []) + ([28] if "the engine refused" in nerr else [])
        failed = new["status"] not in (0, "timed out") and new["status"] is not None
        if v == "reload" and ref["status"] == 0 and failed and "Refusing to reload: the mirror was not read in full" in nerr:
            for d in (ref, new):
                d["status"], d["stdout"], d["stderr"] = "<a reload of a mirror not read in full>", "", ""
            return keys()
        gave_up = ref["status"] == 1 and ref["stderr"].strip() == NOT_READY   # the reference's client gives up after 5 s on a mirror its service takes in anyway (D1)
        if v == "service" and argv[1:2] in (["start"], ["restart"]) and (ref["status"] == 0 or gave_up) and failed and "REFUSING TO START: the mirror was not read in full" in nerr:
            for d in (ref, new):
                d["status"], d["stdout"], d["stderr"] = "<a start of a mirror not read in full>", "", ""
            return keys() + [24] + (["D1"] if gave_up else [])
        if v == "service" and "--start-anyway" in argv and "Already running" in ref["stdout"] and "Started" in new["stdout"] and ref["status"] == new["status"] == 0:
            ref["stdout"] = new["stdout"] = "<started anyway>"
            return [25]
        return []

    def r_skipped_nodes(self, argv, ref, new, ctx):
        """The documents that the new side's load skipped (they are in its `.rejected-` copies) are not nodes there: a `show` of one is refused, and a `tree` prints `<not found>` where
        the reference prints the node."""
        if ctx is None or not ctx.rejected:
            return []
        v = verb_of(argv)
        applied = []
        key = lambda tok: 10 if ctx.rejected[tok] >= 2 else 28
        if v == "show" and ref["status"] == 0 and new["status"] not in (0, "timed out", None) and "not found" in new["stderr"]:
            doc = parse_json(ref["stdout"])
            tok = token(doc.get("@id")) if isinstance(doc, dict) else None
            if tok in ctx.rejected:
                for d in (ref, new):
                    d["status"], d["stdout"], d["stderr"] = "<a node the load skipped>", "", ""
                applied.append(key(tok))
        if v in ("tree", "unfold", "zoom"):
            by_id = {}
            for line in lines_of(ref["stdout"]):
                m = re.match(r"^([│ ]*)(\S+)  \[", line)
                if m:
                    by_id[m.group(2)] = line
            out = []
            for line in lines_of(new["stdout"]):
                m = re.match(r"^([│ ]*)(\S+)  \[\?\]  <not found>$", line)
                if m and token(m.group(2)) in ctx.rejected and m.group(2) in by_id:
                    out.append(by_id[m.group(2)])
                    applied.append(key(token(m.group(2))))
                else:
                    out.append(line)
            new["stdout"] = join(out)
        return applied

    # ---- a character cut between two chunks of a response by the reference's client
    def r_split_character(self, argv, ref, new, ctx):
        """N3: the reference's client decodes each chunk of a response on its own, so a character of 2 to 4 bytes that falls on the boundary of two chunks is printed as 2 to 4 U+FFFD
        (the cut leaves a lone lead byte, one U+FFFD, and one U+FFFD for each byte after the cut); the new side's client decodes whole. Only a line of the reference that holds U+FFFD, where the new
        side's line in the same place is the same text with each run of U+FFFD replaced by one character of that many bytes or more (`cut_character`), is rewritten."""
        applied = []
        for stream in ("stdout", "stderr"):
            a, b = ref[stream], new[stream]
            if FFFD not in a or a == b:
                continue
            la, lb = lines_of(a), lines_of(b)
            out, hit = list(la), False
            for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(None, la, lb, autojunk=False).get_opcodes():
                if tag == "replace" and i2 - i1 == j2 - j1:
                    for k in range(i2 - i1):
                        x, y = la[i1 + k], lb[j1 + k]
                        if FFFD in x and FFFD not in y and cut_character(x, y):
                            out[i1 + k] = y
                            hit = True
            if hit:
                ref[stream] = join(out)
                applied.append("N3")
        return applied

    # ---- a refused command leaves nothing behind (entry 31)
    def r_refused_leaves_nothing(self, argv, ref, new, ctx):
        """Entry 31: the reference leaves the blocks a refused command made live and parentless, and the new side takes them out, so a count of live blocks in `check-links` is one higher per such
        block on the reference's side. Rewritten when the gap, less the blocks that the refused commands before this one left (`ctx.leftovers_before`), is one that the rules for the README
        paragraphs (H3) and the emptied containers (entry 3) explain or none: any other gap is left to be a finding."""
        if ctx is None or verb_of(argv) != "check-links" or not hasattr(ctx, "leftovers_before"):
            return []
        k = ctx.leftovers_before(self.index)
        if k <= 0:
            return []
        facts = getattr(ctx, "facts", None)
        p = facts.readme_paragraphs if facts is not None else 0
        e = len(ctx.emptied_ids())
        applied = []
        for pat in (r"(Scanned )(\d+)( live blocks)", r'("totalLiveBlocks": )(\d+)()'):
            ma, mb = re.search(pat, ref["stdout"]), re.search(pat, new["stdout"])
            if ma and mb:
                gap = int(ma.group(2)) - int(mb.group(2))
                if gap - k in {0, e, p, p + e}:
                    ref["stdout"] = ref["stdout"].replace(ma.group(0), ma.group(1) + str(int(ma.group(2)) - k) + ma.group(3), 1)
                    applied.append(31)
        return applied

    # ---- the six README documents (H3)
    def r_readme(self, argv, ref, new, ctx):
        """H3: the migration deleted the six `README.md` artifacts and their six paragraphs from the reference's copy of the mirror, where the reference's own store (the run starts it on the
        unmigrated copy) still holds them. They are listed by the sweeps of `track` and `ingest` as paths with no file on disk and as removed, and counted as live blocks by `check-links`.
        Only the six paths the snapshot holds as those artifacts, only in the reference's lists, and only the counts that differ by exactly their number are rewritten."""
        facts = getattr(ctx, "facts", None)
        if facts is None or not facts.readme_paths:
            return []
        v = verb_of(argv)
        applied = []
        paths = set(facts.readme_paths)
        if v in ("track", "ingest"):
            lines = lines_of(ref["stdout"])
            keep, dropped = [], 0
            new_has = set(lines_of(new["stdout"]))
            for line in lines:
                m = re.match(r"^  '(.+)'(?: \(untracked from disk\))?$", line)
                if m and m.group(1) in paths and line not in new_has:
                    dropped += 1
                    continue
                keep.append(line)
            if dropped:
                ref["stdout"] = join(keep)
                applied.append("H3")
                if v == "track":
                    pat = re.compile(r"(Tracked \d+ artifact\(s\), skipped \d+ unchanged, \d+ renamed, )(\d+)( removed\.)")
                    ma, mb = pat.search(ref["stdout"]), pat.search(new["stdout"])
                    if ma and mb and int(ma.group(2)) - int(mb.group(2)) == dropped:
                        ref["stdout"] = ref["stdout"].replace(ma.group(0), ma.group(1) + mb.group(2) + ma.group(3))
        if v == "check-links":
            p = facts.readme_paragraphs
            emptied = len(ctx.emptied_ids()) if hasattr(ctx, "emptied_ids") else 0
            for stream, pat in (("stdout", r"(Scanned )(\d+)( live blocks)"), ("stdout", r'("totalLiveBlocks": )(\d+)()')):
                ma, mb = re.search(pat, ref[stream]), re.search(pat, new[stream])
                if ma and mb and p > 0:
                    gap = int(ma.group(2)) - int(mb.group(2))
                    if gap >= p and gap - p in {0, emptied}:
                        ref[stream] = ref[stream].replace(ma.group(0), ma.group(1) + str(gap - p + int(mb.group(2))) + ma.group(3), 1)
                        applied.append("H3")
        return applied

    # ---- the tombstones the reference still lists (H9)
    def r_tombstones_listed(self, argv, ref, new, ctx):
        """H9: the migration strips the tombstones from the tree, and the new engine's first boot prunes them; the reference keeps all of them listed in their containers until its own sweep.
        Four shapes, each for a node the snapshot holds as a tombstone and the new side's dump does not hold: the line `<id>  [?]  <not found>` of `tree`/`unfold`/`zoom`; the tombstoned artifact in
        the "Removed in-graph but still on disk" list of `track --reverse`; the blocks of an artifact's tree that `ingest` lists as removed and counts (and the links they hosted, as changed);
        the `unfolds` of a view that name such a tombstone, in the counts of `profile list-view`."""
        facts = getattr(ctx, "facts", None)
        if facts is None:
            return []
        v = verb_of(argv)
        applied = []
        gone = lambda cid: cid in facts.tomb and not ctx.new_has(cid)
        if v in ("tree", "unfold", "zoom"):
            have = lines_of(new["stdout"])
            keep, dropped = [], 0
            for line in lines_of(ref["stdout"]):
                m = re.match(r"^[│ ]*(\S+)  \[\?\]  <not found>$", line)
                if m and gone(m.group(1)) and line not in have:
                    dropped += 1
                    continue
                keep.append(line)
            if dropped:
                ref["stdout"] = join(keep)
                applied.append("H9")
        if v == "track" and "--reverse" in argv:
            lines = lines_of(ref["stdout"])
            have = set(lines_of(new["stdout"]))
            keep, dropped = [], 0
            for line in lines:
                m = re.match(r"^  '(.+)'$", line)
                if m and m.group(1) in facts.tombstoned_artifacts and gone(facts.tombstoned_artifacts[m.group(1)]) and line not in have:
                    dropped += 1
                    continue
                keep.append(line)
            if dropped:
                # a list left with no entry is a heading that the new side does not print
                out = []
                for i, line in enumerate(keep):
                    if line.startswith("[aperas track --reverse] Removed in-graph but still on disk") and not (i + 1 < len(keep) and keep[i + 1].startswith("  ")) and line not in have:
                        continue
                    out.append(line)
                ref["stdout"] = join(out)
                applied.append("H9")
        if v == "ingest":
            applied += self._ingest_tombstones(ref, new, facts, gone)
        if v == "profile" and argv[1:2] == ["list-view"]:
            view = re.compile(r"^(\S+)  profile: (\S+)  \((\d+) unfold\(s\)\)  (TreeView:\S+)$")
            news = {}
            for line in lines_of(new["stdout"]):
                m = view.match(line)
                if m:
                    news[m.group(4)] = m
            out, hit = [], False
            for line in lines_of(ref["stdout"]):
                m = view.match(line)
                n = news.get(m.group(4)) if m else None
                if m and n:
                    k = len([u for u in facts.tomb_unfolds(m.group(4)) if gone(u)])
                    if k and int(m.group(3)) - int(n.group(3)) == k:
                        line = "%s  profile: %s  (%s unfold(s))  %s" % (m.group(1), m.group(2), n.group(3), m.group(4))
                        hit = True
                out.append(line)
            if hit:
                ref["stdout"] = join(out)
                applied.append(2)
        return applied

    def _ingest_tombstones(self, ref, new, facts, gone):
        """The artifact trees that `ingest` lists as removed: the tombstoned blocks of the artifact's tree that the reference still holds make its total larger by exactly their number. The ten
        lines it prints are a sample of the list, in the store's order for the reference and in id order for the new side, so they are compared as far as a line of the reference's is not one of those
        tombstones (by type and title) and the two totals as counted; and the counts of `Ingested ...` (removed, and changed links up to the number of links those blocks hosted)."""
        applied = []
        head = re.compile(r"^  '(.+)':$")
        sample = re.compile(r"^    - \[(\S+)\] (.*)$")
        more = re.compile(r"^    \.\.\.and (\d+) more$")

        def blocks(text):
            lines, i, out = lines_of(text), 0, []
            while i < len(lines):
                m = head.match(lines[i])
                if not m:
                    i += 1
                    continue
                j, items, extra = i + 1, [], 0
                while j < len(lines) and (sample.match(lines[j]) or more.match(lines[j])):
                    sm, mm = sample.match(lines[j]), more.match(lines[j])
                    if sm:
                        items.append((sm.group(1), sm.group(2)))
                    else:
                        extra = int(mm.group(1))
                    j += 1
                out.append((m.group(1), i, j, items, extra))
                i = j
            return out
        rb, nb = {b[0]: b for b in blocks(ref["stdout"])}, {b[0]: b for b in blocks(new["stdout"])}
        r_lines, n_lines = lines_of(ref["stdout"]), lines_of(new["stdout"])
        tombs = {}
        for path, (_, ri, rj, ritems, rextra) in rb.items():
            if path not in nb:
                continue
            _, ni, nj, nitems, nextra = nb[path]
            held_gone = [(t, ti) for i, t, ti in facts.tomb_blocks(path) if gone(i)]
            k = len(held_gone)
            total_r, total_n = len(ritems) + rextra, len(nitems) + nextra
            if not k or total_r - total_n != k:
                continue
            rest, pool = [], list(held_gone)
            for it in ritems:
                if it in pool:
                    pool.remove(it)
                else:
                    rest.append(it)
            if any(it not in nitems for it in rest):
                continue
            tombs[path] = k
            label = "  '%s': %d block(s), sample not compared" % (path, total_n)
            for lines, i, j in ((r_lines, ri, rj), (n_lines, ni, nj)):
                lines[i:j] = [label] + [None] * (j - i - 1)
        if tombs:
            ref["stdout"] = join([x for x in r_lines if x is not None])
            new["stdout"] = join([x for x in n_lines if x is not None])
            applied.append("H9")
        pat = re.compile(r"Ingested '(.+?)' fractal tree \((\d+) blocks\) \(reconciled: (\d+) matched, (\d+) moved, (\d+) changed, (\d+) added, (\d+) removed\)\.\n(\[aperas ingest\]   Links: (\d+) resolved, (\d+) dangling, )(\d+)( changed\.)")
        rm, nm = {m.group(1): m for m in pat.finditer(ref["stdout"])}, {m.group(1): m for m in pat.finditer(new["stdout"])}
        text = ref["stdout"]
        for path, m in rm.items():
            n = nm.get(path)
            if n is None:
                continue
            k = len([1 for i, _, _ in facts.tomb_blocks(path) if gone(i)])
            hosted = facts.tomb_links(path)
            same = [m.group(i) == n.group(i) for i in (2, 3, 4, 5, 6, 9, 10)]
            if k and int(m.group(7)) - int(n.group(7)) == k and all(same) and 0 <= int(m.group(11)) - int(n.group(11)) <= hosted:
                text = text.replace(m.group(0), n.group(0), 1)
        if text != ref["stdout"]:
            ref["stdout"] = text
            applied.append("H9")
        return applied

    # ---- a link of one graph to a tombstone of another (entry 30)
    def r_dangling_to_pruned(self, argv, ref, new, ctx):
        """Entry 30: a stored link of one graph to a tombstone of another is not kept alive, so the first boot of the new side prunes the tombstone and `check-links` warns of the link, where the
        reference's single-store mark phase keeps the tombstone and prints a clean pass. A warned link is taken out of the new side's output when its host is a node of the thread graph and its target a
        tombstone of the content graph (both as the snapshot holds them) that the new side's dump no longer holds; the count in the warning follows, and a warning left with no link is the
        reference's clean pass (the new side prints no clean pass line when it warns)."""
        facts = getattr(ctx, "facts", None)
        if facts is None or verb_of(argv) != "check-links":
            return []
        applied = []

        def pruned(host, target):
            return facts.graph_of(host) == "state" and target in facts.tomb and facts.graph_of(target) == "mirror" and not ctx.new_has(target)
        text = new["stderr"]
        head = re.compile(r"^(\[ApeironNgn check-links\] WARNING: Found )(\d+)( stored link\(s\) whose target names no node.*)$")
        lines = lines_of(text)
        idx = next((i for i, l in enumerate(lines) if head.match(l)), None)
        if idx is not None:
            m = head.match(lines[idx])
            out, i, removed, left = lines[:idx], idx + 1, 0, 0
            while i < len(lines) and lines[i].startswith("  • Node "):
                blk = lines[i:i + 3]
                host = re.match(r"^  • Node (\S+) \(.*\): id-names-no-node$", blk[0])
                tgt = re.match(r"^    Target: (\S+)$", blk[2]) if len(blk) == 3 else None
                if host and tgt and blk[1].startswith("    Link: ") and pruned(host.group(1), tgt.group(1)):
                    removed += 1
                else:
                    out += blk
                    left += 1
                i += 3
            if removed and removed <= int(m.group(2)) and i - idx - 1 == 3 * int(m.group(2)):
                rest = lines[i:]
                if left:
                    out.insert(idx, "%s%d%s" % (m.group(1), left, m.group(3)))
                    new["stderr"] = join(out + rest)
                else:
                    new["stderr"] = join(out + rest)
                    cp = "[ApeironNgn check-links] Clean pass: 0 link integrity discrepancies found."
                    if cp in lines_of(ref["stdout"]) and cp not in lines_of(new["stdout"]):
                        ref["stdout"] = join([l for l in lines_of(ref["stdout"]) if l != cp])
                applied.append(30)
        a, b = parse_json(ref["stdout"]), parse_json(new["stdout"])
        if isinstance(a, dict) and isinstance(b, dict) and isinstance(b.get("unresolvedTargets"), list):
            keep = [u for u in b["unresolvedTargets"] if not (isinstance(u, dict) and pruned(u.get("blockId"), u.get("targetId")))]
            if len(keep) != len(b["unresolvedTargets"]):
                b["unresolvedTargets"] = keep
                new["stdout"] = json.dumps(b, indent=2, ensure_ascii=False)
                if a.get("unresolvedTargets") is not None:
                    ref["stdout"] = json.dumps(a, indent=2, ensure_ascii=False)
                applied.append(30)
        return applied

    # ---- the wait of a start (D1)
    def r_start_wait(self, argv, ref, new, ctx):
        """D1: the reference's client gives up a start or restart after 5 s with status 1 and `ApeironNgn service did not become ready in time`, while its service goes on loading (15 to 21 s
        on the real copy); the new side waits and answers 0 with `Started` or `Restarted`. Rewritten only for that exact pair: the reference's whole stderr is the one message and nothing else of
        its output differs from the new side's but the closing line."""
        if verb_of(argv) != "service" or argv[1:2] not in (["start"], ["restart"]):
            return []
        if not (ref["status"] == 1 and ref["stderr"].strip() == NOT_READY and new["status"] == 0 and new["stderr"] == ""):
            return []
        closing = re.compile(r"^\[aperas service\] (Started|Restarted) — .*bound to graph: .*$")
        nl = lines_of(new["stdout"])
        tail = [i for i, l in enumerate(nl) if closing.match(l)]
        if len(tail) != 1:
            return []
        rest = [l for i, l in enumerate(nl) if i != tail[0]]
        if join(rest).rstrip("\n") != ref["stdout"].rstrip("\n"):
            return []
        for d in (ref, new):
            d["status"], d["stdout"], d["stderr"] = "<a start that waited for the service>", "", ""
        return ["D1"]

    # ---- a move into the node's own subtree
    def r_move_into_own_subtree(self, argv, ref, new, ctx):
        if verb_of(argv) != "insert" or ref["status"] != "timed out":
            return []
        if re.search(r"cannot be moved into its own subtree", new["stderr"]) and new["status"] not in (0, "timed out"):
            for d in (ref, new):
                d["status"], d["stdout"], d["stderr"] = "<a move into the own subtree>", "", ""
            return [5]
        return []

    # ---- the ghost folder in a list
    def r_ghost(self, argv, ref, new, ctx):
        if verb_of(argv) != "track" or "--reverse" not in argv:
            return []
        keep = [l for l in lines_of(ref["stdout"]) if l.strip() != "[FolderNode] 'undefined'"]
        if len(keep) == len(lines_of(ref["stdout"])) or "'undefined'" in new["stdout"]:
            return []
        ref["stdout"] = join(keep)
        return [20]

    # ---- tombstones
    def r_tombstone_listing(self, argv, ref, new, ctx):
        """Flip 1: a tombstone leaves the list of its container, so `tree` and `unfold` with `--tombstoned` show nothing in place of a removed child, and a removed node shown
        by its id has no breadcrumb, no `parent` (the empty tombstone, H8) and no place in a path (so a path that only a tombstone held names nothing)."""
        v = verb_of(argv)
        applied = []
        if v in ("tree", "unfold") and "--tombstoned" in argv:
            lines = lines_of(ref["stdout"])
            keep, skip_depth = [], None
            have = set(lines_of(new["stdout"]))
            for line in lines:
                depth = len(line) - len(line.lstrip("│ "))
                if skip_depth is not None and depth > skip_depth:
                    continue
                skip_depth = None
                if "(tombstoned)" in line and line not in have:
                    skip_depth = depth
                    applied.append(1)
                    continue
                keep.append(line)
            ref["stdout"] = join(keep)
            # `unfold <id> --tombstoned` of a removed node: the reference prints the breadcrumb of the path it still has
            r = lines_of(ref["stdout"])
            n = lines_of(new["stdout"])
            if r and r[0].startswith("aperas://tree/") and (not n or not n[0].startswith("aperas://tree/")) and v == "unfold" and any("(tombstoned)" in l for l in r[1:2]):
                ref["stdout"] = join(r[1:])
                applied.append(1)
        if v == "show":
            a, b = parse_json(ref["stdout"]), parse_json(new["stdout"])
            if isinstance(a, dict) and isinstance(b, dict) and "tombstonedAt" in b:
                dropped = ("parent", "props", "links", "children")
                a2 = {k: x for k, x in a.items() if k not in dropped}
                b2 = {k: x for k, x in b.items() if k not in dropped}
                if "tombstonedAt" in a:
                    if a2 == b2 and a != b:
                        ref["stdout"] = json.dumps(b, indent=2, ensure_ascii=False)
                        new["stdout"] = ref["stdout"]
                        applied.append("H8")
                elif ctx is not None and ctx.is_emptied(a.get("@id")):
                    a3 = {k: x for k, x in a2.items() if k != "tombstonedAt"}
                    b3 = {k: x for k, x in b2.items() if k != "tombstonedAt"}
                    if a3 == b3:
                        ref["stdout"] = new["stdout"] = json.dumps(b, indent=2, ensure_ascii=False)
                        applied += [3, "H8"]
        if v == "resolve" and ref["status"] == 0 and new["status"] != 0 and ctx is not None:
            m = re.match(r"aperas://id/(\S+)", ref["stdout"])
            if m and ctx.is_dead_in_ref(m.group(1)) and "isn't a tracked artifact/folder path" in new["stderr"]:
                for d in (ref, new):
                    d["status"], d["stdout"], d["stderr"] = "<a path that only a tombstone held>", "", ""
                applied += [4, 1]
        return applied

    def r_emptied_container(self, argv, ref, new, ctx):
        """Flip 3: a removal tombstones the container it empties in the same write, so the reference shows it live until the next sweep: in a tree, in a count of live blocks,
        and in the words of the sweep (`N vacuous container(s) tombstoned`)."""
        if ctx is None or not ctx.emptied_ids():
            return []
        v = verb_of(argv)
        applied = []
        if v in ("tree", "unfold", "zoom"):
            have = set(lines_of(new["stdout"]))
            keep, skip_depth = [], None
            for line in lines_of(ref["stdout"]):
                depth = len(line) - len(line.lstrip("│ "))
                if skip_depth is not None and depth > skip_depth:
                    continue
                skip_depth = None
                m = re.match(r"^[│ ]*(\S+)  \[", line)
                if line not in have and m and ctx.is_emptied(m.group(1)):
                    skip_depth = depth
                    applied.append(3)
                    continue
                keep.append(line)
            ref["stdout"] = join(keep)
        if v == "check-links":
            m1 = re.search(r"Scanned (\d+) live blocks", ref["stdout"])
            m2 = re.search(r"Scanned (\d+) live blocks", new["stdout"])
            if m1 and m2 and int(m1.group(1)) - int(m2.group(1)) == len(ctx.emptied_ids()) > 0:
                ref["stdout"] = ref["stdout"].replace(m1.group(0), m2.group(0))
                applied.append(3)
        return applied

    # ---- the words of the sweeps and of the load
    def r_sweep_words(self, argv, ref, new, ctx):
        v = verb_of(argv)
        applied = []
        if v == "reload":
            a, b = ref["stdout"], new["stdout"]
            ma = re.search(r"Reloaded \d+ quad\(s\), \d+ node\(s\)\.", a)
            mb = re.search(r"Reloaded \d+ record\(s\), \d+ document\(s\)\.", b)
            if ma and mb:
                ref["stdout"] = a.replace(ma.group(0), "Reloaded <count> <count>.")
                new["stdout"] = b.replace(mb.group(0), "Reloaded <count> <count>.")
                applied.append(9)
                gc = re.search(r" GC: \d+ stale unfold\(s\) cleared\.", ref["stdout"])
                if gc:
                    ref["stdout"] = ref["stdout"].replace(gc.group(0), "")
                    applied.append(23)
        if v == "flush" and "--clobber" in argv:
            a, b = ref["stdout"], new["stdout"]
            ra = re.search(r"clobbered — (\d+) unreachable tombstone\(s\) pruned(, (\d+) vacuous container\(s\) tombstoned)?\)", a)
            rb = re.search(r"clobbered — (\d+) unreachable tombstone\(s\) pruned\)", b)
            if ra and rb:
                if ra.group(3) and int(ra.group(3)) > 0 and (ctx is None or ctx.emptied_ids()):
                    applied.append(3)
                if ra.group(1) != rb.group(1):
                    applied.append(2)
                ref["stdout"] = a.replace(ra.group(0), "clobbered — <n> unreachable tombstone(s) pruned)")
                new["stdout"] = b.replace(rb.group(0), "clobbered — <n> unreachable tombstone(s) pruned)")
        if v == "service" and "Usage: aperas service {start|stop|restart} [--start-anyway]" in new["stderr"] and "Usage: aperas service {start|stop|restart}" in ref["stderr"] and "[--start-anyway]" not in ref["stderr"]:
            ref["stderr"] = ref["stderr"].replace("{start|stop|restart}", "{start|stop|restart} [--start-anyway]")
            applied.append(25)
        return applied

    # ---- the ids of the position props of a reused link
    def r_position_prop_ids(self, argv, ref, new, ctx):
        """Ingest 2: a reused link keeps the ids of its `position` props in the new side, and the reference mints them again, so `show` prints other ids for the same props."""
        pat = re.compile(r"(:props:StringProp:)[^\"\s,\]]+")
        a, b = ref["stdout"], new["stdout"]
        if ":props:StringProp:" not in a or not any(m.group(0).split(":")[-1].startswith(("ref!", "~")) for m in pat.finditer(a)):
            return []
        a2, b2 = pat.sub(r"\1<id>", a), pat.sub(r"\1<id>", b)
        ref["stdout"], new["stdout"] = a2, b2
        return [21]

    # ---- the canonical place of a node reached through several unfolded links
    def r_canonical_place(self, argv, ref, new, ctx):
        """Order 2: the node is expanded under one link and the other links point to it; the new side's place is the first link by id, the reference's the first in its store's order.
        Both texts are brought to one form in which every such link says only that it is a place; the entry is claimed if the two sides chose different links."""
        v = verb_of(argv)
        if v not in ("tree", "unfold", "zoom", "fold"):
            return []
        if "--format" in argv:
            a, b = parse_json(ref["stdout"]), parse_json(new["stdout"])
            if a is None or b is None:
                return []
            ca, cb = [], []
            na, nb = sort_link_children(strip_places_json(a, ca)), sort_link_children(strip_places_json(b, cb))
            if na == nb and a != b and sorted(ca) != sorted(cb):
                ref["stdout"] = new["stdout"] = json.dumps(nb, indent=2, ensure_ascii=False)
                return [14]
            return []
        a, ca, ea = strip_places(ref["stdout"])
        b, cb, eb = strip_places(new["stdout"])
        if (a != ref["stdout"] or b != new["stdout"]) and sorted(ca) != sorted(cb) and ea == eb:
            ref["stdout"], new["stdout"] = a, b
            return [14]
        return []

    # ---- the text at the position of a link whose target names no node
    def r_dangling_text(self, argv, ref, new, ctx):
        """Order 6: a stored link with several positions reads the text at its smallest position in the new side, at the first listed in the reference's. The listing of the
        unresolved targets is also sorted by id in the new side (Order 3), so the blocks are compared in one order."""
        if verb_of(argv) != "check-links":
            return []
        applied = []
        mask = lambda s: re.sub(r'("linkText": )"[^"]*"', r'\1"<text at a position>"', re.sub(r'(Link: \S+ )"[^"]*"', r'\1"<text at a position>"', s))
        texts = lambda s: sorted(re.findall(r'(?:Link: \S+ |"linkText": )"([^"]*)"', s))
        a, b = parse_json(ref["stdout"]), parse_json(new["stdout"])
        if isinstance(a, dict) and isinstance(b, dict) and "unresolvedTargets" in a:
            ma, mb = mask_json(a, "linkText"), mask_json(b, "linkText")
            sa, sb = sort_json_lists(ma), sort_json_lists(mb)
            if sa == sb and a != b:
                if texts(ref["stdout"]) != texts(new["stdout"]):
                    applied.append(18)
                if ma != mb:
                    applied.append(15)
                ref["stdout"] = new["stdout"] = json.dumps(sb, indent=2, ensure_ascii=False)
            return applied
        head = r"^  • Node "

        def actual_sorted(t):
            def one(m):
                try:
                    return m.group(1) + json.dumps(sorted(json.loads(m.group(2)), key=lambda e: str(e.get("id"))), separators=(",", ":"), ensure_ascii=False)
                except (ValueError, AttributeError, TypeError):
                    return m.group(0)
            return re.sub(r"^(    Actual links: )(\[.*\])$", one, t, flags=re.M)
        for stream in ("stdout", "stderr"):
            fa, fb = mask(actual_sorted(ref[stream])), mask(actual_sorted(new[stream]))
            sa, sb = sort_blocks(fa, head), sort_blocks(fb, head)
            if sa == sb and ref[stream] != new[stream]:
                if texts(ref[stream]) != texts(new[stream]):
                    applied.append(18)
                if mask(ref[stream]) != mask(new[stream]):
                    applied.append(15)
                ref[stream], new[stream] = sa, sb
        return applied

    # ---- orders
    def r_order(self, argv, ref, new, ctx):
        v = verb_of(argv)
        applied = []
        if v == "retype":
            f = lambda s: re.sub(r"(dropped listItem-only prop\(s\): )([^\n]*)", lambda m: m.group(1) + ", ".join(sorted(m.group(2).split(", "))), s)
            a, b = f(ref["stdout"]), f(new["stdout"])
            if a != ref["stdout"] or b != new["stdout"]:
                ref["stdout"], new["stdout"] = a, b
                applied.append("N1")
        if v == "show":
            a, b = parse_json(ref["stdout"]), parse_json(new["stdout"])
            if isinstance(a, dict) and isinstance(b, dict) and a != b:
                def norm(x, keys):
                    x = json.loads(json.dumps(x))
                    for k in keys:
                        if isinstance(x.get(k), list):
                            x[k] = sorted(x[k], key=lambda e: json.dumps(e, sort_keys=True) if not isinstance(e, dict) else str(e.get("@id")))
                    return x
                if norm(a, ["links"]) == norm(b, ["links"]):
                    ref["stdout"], new["stdout"] = (json.dumps(norm(b, ["links"]), indent=2, ensure_ascii=False),) * 2
                    applied.append(19)
                elif norm(a, ["links", "props", "unfolds"]) == norm(b, ["links", "props", "unfolds"]):
                    ref["stdout"], new["stdout"] = (json.dumps(norm(b, ["links", "props", "unfolds"]), indent=2, ensure_ascii=False),) * 2
                    applied.append("N1")
        if v in ("tree", "unfold", "zoom", "fold") and "--format" not in argv:
            a, b = sort_link_units(ref["stdout"]), sort_link_units(new["stdout"])
            if (a != ref["stdout"] or b != new["stdout"]) and a == b:
                if ctx is not None and last_link_has_no_position(ref["stdout"], new["stdout"], ctx):
                    applied.append(16)
                ref["stdout"], new["stdout"] = a, b
                applied.append(13)
        if v == "tree" and "--format" in argv:
            a, b = parse_json(ref["stdout"]), parse_json(new["stdout"])
            if a is not None and b is not None:
                na, nb = sort_link_children(a), sort_link_children(b)
                if na == nb and a != b:
                    ref["stdout"] = new["stdout"] = json.dumps(nb, indent=2, ensure_ascii=False)
                    applied.append(13)
        if (v == "backlinks") or (v == "profile" and len(argv) > 1 and argv[1] in ("list", "list-view")):
            pred = lambda l: bool(l.strip())
            a, b = sort_runs(ref["stdout"], pred), sort_runs(new["stdout"], pred)
            if (a != ref["stdout"] or b != new["stdout"]) and a == b:
                ref["stdout"], new["stdout"] = a, b
                applied.append(15)
        if v == "check-links":
            head = r"^  • Node "
            changed = False
            for stream in ("stdout", "stderr"):
                a, b = sort_blocks(ref[stream], head), sort_blocks(new[stream], head)
                if (a != ref[stream] or b != new[stream]) and a == b:
                    ref[stream], new[stream] = a, b
                    changed = True
            if changed:
                applied.append(15)
        if v == "ingest":
            # the artifacts whose links were re-resolved are listed in the store's order by the reference and in order by the new side (Order 3)
            pat = re.compile(r"(Re-resolved links in \d+ artifact\(s\) whose own text didn't change but a target they reference just did: )(.+)\.$", re.M)
            ma, mb = pat.search(ref["stdout"]), pat.search(new["stdout"])
            if ma and mb and ma.group(0) != mb.group(0) and sorted(ma.group(2).split(", ")) == sorted(mb.group(2).split(", ")):
                ref["stdout"] = ref["stdout"].replace(ma.group(0), mb.group(0), 1)
                applied.append(15)
        if v == "track":
            pred = lambda l: l.startswith("  ")
            a, b = sort_runs(ref["stdout"], pred), sort_runs(new["stdout"], pred)
            if (a != ref["stdout"] or b != new["stdout"]) and a == b:
                ref["stdout"], new["stdout"] = a, b
                applied.append(15)
        return applied


def link_runs(text):
    runs, run = [], []
    for item in link_units(text):
        if isinstance(item, list):
            run.append(unit_id(item))
            continue
        if run:
            runs.append(run)
            run = []
    if run:
        runs.append(run)
    return runs


def last_link_has_no_position(ref_text, new_text, ctx):
    """True when a run of links ends, in the new side, with a link that has no `position` and does not end the reference's run (Order 4: an id with no key comes last)."""
    rr, nr = link_runs(ref_text), link_runs(new_text)
    for r, n in zip(rr, nr):
        if n and sorted(r) == sorted(n) and n[-1] in ctx.positionless() and r[-1] != n[-1]:
            return True
    return False


def strip_places(text):
    """-> (text with each link that is a place of a shared node reduced to `[*]` and its expansion dropped, ids of the links that are the expanded place)."""
    out, expanded, skip, current, expansions = [], [], None, None, []
    for line in lines_of(text):
        depth = len(line) - len(line.lstrip("│ "))
        if skip is not None and depth > skip:
            current.append(line[skip:])   # what is expanded under the link, from the link's own depth
            continue
        skip = None
        m = re.match(r"^[│ ]*(\S+)  \[Link\]", line)
        if m and line.endswith("[*]"):
            expanded.append(m.group(1))
            expansions.append([])
            current = expansions[-1]
            current.append(re.sub(r"^[│ ]*\S+  \[Link\]  ", "", line))
            line = re.sub(r"  ║  .*  \[\*\]$", "  [*]", line)
            skip = depth
        elif m and re.search(r"\[\*see \S+ \(link\)\]$", line):
            line = re.sub(r"\[\*see \S+ \(link\)\]$", "[*]", line)
        out.append(line)
    return join(out), expanded, sorted(tuple(e) for e in expansions)


def strip_places_json(x, expanded):
    if isinstance(x, list):
        return [strip_places_json(e, expanded) for e in x]
    if isinstance(x, dict):
        if x.get("kind") == "link" and (x.get("mode") == "pointer" or x.get("starred")):
            if x.get("starred"):
                expanded.append(x.get("id"))
            return {k: x[k] for k in ("kind", "id", "depth", "targetId", "targetTitle", "targetDisplayLabel") if k in x} | {"mode": "place"}
        return {k: strip_places_json(v, expanded) for k, v in x.items()}
    return x


def sort_link_children(x):
    """A render tree with every run of consecutive `link` entries of a `children` list sorted by id."""
    if isinstance(x, list):
        items = [sort_link_children(e) for e in x]
        out, run = [], []
        for e in items:
            if isinstance(e, dict) and e.get("kind") == "link":
                run.append(e)
                continue
            out += sorted(run, key=lambda e: str(e.get("id")))
            run = []
            out.append(e)
        out += sorted(run, key=lambda e: str(e.get("id")))
        return out
    if isinstance(x, dict):
        return {k: sort_link_children(v) for k, v in x.items()}
    return x


RULES = [getattr(Rules, n) for n in sorted(dir(Rules)) if n.startswith("r_")]
# the rules apply in the order of this list, which is the order of the table above and not the alphabet
RULE_ORDER = ["r_split_character", "r_removed_verbs", "r_predicate", "r_type_root", "r_kind_human", "r_path_message", "r_load_refusals", "r_skipped_nodes", "r_move_into_own_subtree", "r_ghost", "r_tombstone_listing", "r_refused_leaves_nothing", "r_readme", "r_tombstones_listed", "r_start_wait", "r_emptied_container", "r_sweep_words", "r_position_prop_ids", "r_canonical_place", "r_dangling_to_pruned", "r_dangling_text", "r_order"]


def explain(argv, ref, new, ctx=None, index=None):
    """-> (claims, ref', new'): the entries whose rule was needed, and the two outputs after every rule has been applied (equal when everything was explained). `index`: the index of the command
    in the run, for the rules that depend on what ran before it (`None`: after every command)."""
    ref, new = dict(ref), dict(new)
    rules = Rules()
    rules.index = index
    claims = []
    for name in RULE_ORDER:
        claims += getattr(rules, name)(argv, ref, new, ctx)
    return claims, ref, new


# --------------------------------------------------------------------------------------------------------------------- the services' logs

TS = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z \[[^\]]*\] ")

# (side, regular expression of a normalised line, entries). A line of a log must match one rule, or it is a finding.
LOG_RULES = [
    ("ref", r"^Rehydrated <n> quad\(s\) from <root>\.?$", [9]),
    ("new", r"^Loaded <n> record\(s\) from <root>\.?$", [9]),
    ("ref", r"^Reloaded <n> quad\(s\), <n> node\(s\)\.$", [9]),
    ("ref", r"^Reloaded <n> quad\(s\), <n> node\(s\)\. GC: <n> stale unfold\(s\) cleared\.$", [9, 23]),
    ("new", r"^Reloaded <n> record\(s\), <n> document\(s\); <n> graph\(s\) of the old store freed\.$", [9, 26]),
    ("ref", r"^Timed flush: Refusing to flush: .*$", [22]),
    ("new", r"^Timed flush of (tree|threads\.tree|treeviews): Refusing to flush: .*$", [22]),
    ("new", r"^Flush intervals: tree <n> ms, threads\.tree <n> ms, treeviews <n> ms\.$", [22]),
    ("new", r"^WARNING: <root> the graphs table has an entry named tree; .*$", ["N4"]),
    ("new", r"^WARNING: <n> id\(s\) referenced and never defined: .*$", [27]),
    ("ref", r"^WARNING: <n> duplicate @id\(s\) in the mirror — quads from every occurrence merged onto one subject, so at most one document per id survives the next dehydrate: .*$", ["H7"]),
    ("new", r"^WARNING: the id \S+ is carried <n> times \(.*\): every document that carries it is rejected$", ["H7", 10]),
    ("new", r"^Reload refused, the graph in memory is kept: the mirror was not read in full.*$", [10]),
    ("new", r"^REFUSING TO START: the mirror was not read in full.*$", [10, 24]),
    ("new", r"^START-ANYWAY: the mirror was not read in full.*$", [25]),
    ("new", r"^The documents the load skipped are copied to <root>.*$", [25]),
    ("both", r"^Startup GC: cleaned <n> unreachable tombstone\(s\), <n> vacuous container\(s\)(, <n> stale unfold\(s\))?\.$", [2, 3, 23]),
]
REFUSED_BY_KIND = re.compile(r"document(?:\(s\)|s)? the engine refused")


def norm_log_line(line, roots):
    line = TS.sub("", line)
    for r in roots:
        line = line.replace(r, "<root>")
    line = re.sub(r"<root>[^\s,;)]*", "<root>", line)
    return re.sub(r"\d+", "<n>", re.sub(r"\b[A-Za-z]+Node:[0-9A-Z]{13}\b", "<id>", line))


def explain_logs(ref_text, new_text, roots_ref=(), roots_new=()):
    """-> (claims, findings): `claims` are (side, line, entries); `findings` are (side, line) of the lines no rule accounts for."""
    claims, findings = [], []
    norm = {"ref": [norm_log_line(r, roots_ref) for r in ref_text.split("\n") if r.strip()], "new": [norm_log_line(r, roots_new) for r in new_text.split("\n") if r.strip()]}
    shared = {}
    for line in set(norm["ref"]) & set(norm["new"]):
        shared[line] = min(norm["ref"].count(line), norm["new"].count(line))
    seen_shared = {"ref": {}, "new": {}}
    for side, text, roots in (("ref", ref_text, roots_ref), ("new", new_text, roots_new)):
        for raw in text.split("\n"):
            if not raw.strip():
                continue
            line = norm_log_line(raw, roots)
            hit = [(s, rx, keys) for s, rx, keys in LOG_RULES if s in (side, "both") and re.match(rx, line)]
            if not hit:
                used = seen_shared[side].get(line, 0)
                if used < shared.get(line, 0):
                    seen_shared[side][line] = used + 1   # the same line in both logs: equal, nothing to explain
                    continue
                findings.append((side, raw))
                continue
            keys = list(hit[0][2])
            if side == "new" and REFUSED_BY_KIND.search(raw) and 28 not in keys:
                keys.append(28)
            claims.append((side, raw, keys))
    return claims, findings


# --------------------------------------------------------------------------------------------------------------------- dumps that a command changes

HASH_FIELDS = ("fileHash", "ingestedHash", "projectedHash")


def token(full_id):
    return full_id.rsplit(":", 1)[-1] if isinstance(full_id, str) else None


def m_ghost_document(d, c):
    """Ingest 1: a ghost (a `children` entry with no document) has a record in the reference's store, which writes it out as a document of a `parent` and nothing else;
    with the engine it has no record at all, so it is in no list and in no file."""
    if d.scope != "doc" or d.op != "only-ref" or d.kind != "FolderNode":
        return False
    doc = c.ref.get(d.id)
    return doc is not None and set(doc.fields) <= {"@type", "parent"} and not doc.embs and d.id not in c.new


def m_repeated_id_rejected(d, c):
    """Layer 4 (the repeated `@id`) and Flip 10: an id carried by more than one document is rejected whole by the new side's load: no document of it is in the new side's dumps, and
    the raw documents are in a `.rejected-` copy."""
    return d.scope == "doc" and d.op == "only-ref" and c.rejected.get(token(d.ref_id), 0) >= 2


def m_refused_document(d, c):
    """Follow-up 1: a document with a key its kind does not declare is refused by the load, and is in a `.rejected-` copy and not in the new side's dumps."""
    return d.scope == "doc" and d.op == "only-ref" and c.rejected.get(token(d.ref_id), 0) == 1


def m_hash_of_minted_ids(d, c):
    """A content hash of an artifact whose file holds ids minted in the run (the anchors of its blocks): the two files differ only in those ids, so the hashes do."""
    if d.scope != "field" or d.field not in HASH_FIELDS or d.kind != "ArtifactNode":
        return False
    doc = c.ref.get(d.id)
    path = doc.fields.get("path") if doc is not None else None
    return bool(path) and c.same_file_up_to_ids(path)


def m_refused_leftover(d, c):
    """Entry 31: a block that a refused command left live and parentless on the reference, where the new side's write layer took it out. Only the reference holds it; it is minted in the run, has no
    `parent` and no container, and there is a refused `insert` or `update` for it (the same status and text on both sides): `ctx.leftovers`."""
    return d.scope == "doc" and d.op == "only-ref" and d.kind == "BlockNode" and d.id in c.leftovers()


EXTRA_DUMP = [
    (20, m_ghost_document),
    (31, m_refused_leftover),
    (10, m_repeated_id_rejected),
    (28, m_refused_document),
    ("N2", m_hash_of_minted_ids),
]
