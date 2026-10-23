#!/usr/bin/env python3
"""What the differential run's commands and logs may differ in, and why (Python 3, standard library only; planning/core.md, Batch 13, piece 4).

`compare.py` (piece 3) explains the differences of two dumps. This module explains the differences of what the commands printed and of what the two services logged,
and adds the few differences of a dump that only a command makes. Every explanation is a rule that names its entry of Layer 4 (`1` to `28`, the keys of
`compare.MATCHERS`), or one of the differences that Layer 4's own paragraph lists without a number (`H1` to `H10`), or an observation that Layer 4 records as not a
difference (`N1`, `N2`), or a difference proposed to the grapher (`P1`, `P2`): `EXTRA` names them all. A rule rewrites the reference's text into what the new engine prints
when the difference is the deliberate one, and a rule's entry is claimed only when the rewrite makes the two texts equal: a text that is not equal after every rule is a finding,
with what is left of it.

  explain(argv, ref, new, ctx) -> (claims, ref', new')   one command: `ref` and `new` are {"status", "stdout", "stderr"} of normalised texts
  explain_logs(ref_text, new_text) -> (claims, findings) the services' logs, line by line
  EXTRA_DUMP                                              [(key, function(diff, context))] for the differences of a dump that a command makes
"""
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
    "P1": ("proposed to the grapher", "the verb `migrate-frontmatter` is gone from the new side (Layer 4 lists `link` and `unlink` only)"),
}

LINK_LINE = re.compile(r"\[Link\]")
VERB_LINE = re.compile(r"^  (\S+)\s+(.*)$")
REMOVED_VERBS = {"link": "H10", "unlink": "H10", "migrate-frontmatter": "P1"}


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
        if v == "service" and argv[1:2] in (["start"], ["restart"]) and ref["status"] == 0 and failed and "REFUSING TO START: the mirror was not read in full" in nerr:
            for d in (ref, new):
                d["status"], d["stdout"], d["stderr"] = "<a start of a mirror not read in full>", "", ""
            return keys() + [24]
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
        if v == "track" and "--reverse" in argv:
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
RULE_ORDER = ["r_removed_verbs", "r_predicate", "r_type_root", "r_kind_human", "r_path_message", "r_load_refusals", "r_skipped_nodes", "r_move_into_own_subtree", "r_ghost", "r_tombstone_listing", "r_emptied_container", "r_sweep_words", "r_position_prop_ids", "r_canonical_place", "r_dangling_text", "r_order"]


def explain(argv, ref, new, ctx=None):
    """-> (claims, ref', new'): the entries whose rule was needed, and the two outputs after every rule has been applied (equal when everything was explained)."""
    ref, new = dict(ref), dict(new)
    rules = Rules()
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


EXTRA_DUMP = [
    (20, m_ghost_document),
    (10, m_repeated_id_rejected),
    (28, m_refused_document),
    ("N2", m_hash_of_minted_ids),
]
