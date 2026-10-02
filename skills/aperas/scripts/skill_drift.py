#!/usr/bin/env python3
"""Detect drift between the skill file and what the graph has recorded about it.

`SKILL.md` is a *generative* projection of the `aperas-skill` concern, not a
mechanical one: no command serializes design into it, so unlike an
`aperas project` artifact it can drift from its source silently. The graph's
record of it is a verbatim snapshot at each major version plus a delta of
additions at each minor one. This compares the two.

  skill_drift.py                 both checks
  skill_drift.py --added         sections in the file the graph never recorded
  skill_drift.py --dropped       recorded items no longer present in the file

Read-only by construction: it opens the file and the mirror and prints.

A third check runs in every mode: each skill's `Status:` line must carry the
same version as the newest recorded delta (or the snapshot, when there are no
deltas). The versions compare as tuples with trailing zeros trimmed, so v4 equals
v4.0; a `Status:` line ahead of the graph's record is a finding as well as one
behind it. Only the four skill files the checker already receives are read, and
only a line that begins `Status: **vN**`.

Exit status: nonzero (1) when any check in the modes that ran has a finding — a
Status mismatch, an ADDED-but-unrecorded unit, or a DROPPED-unaccounted item. The
"superseded, accounted for" list is informational and never affects the exit
status.

Two directions, two different defects:

  *added*   — a section was written into the skill and never recorded as a
              snapshot or delta entry. Caught live three times in one session,
              each time only by a human noticing.
  *dropped* — a recorded item is no longer in the file. This is how v1 silently
              lost one of v0 item 18's three triggers; nothing flagged it, and
              it took a cross-version read to find months later.

Known limitation: the delta format records *additions*, not *supersessions*.
When a minor version rewrites an existing item (v1.1's edit-loop step 5, say)
the delta stores the new text but nothing marks which snapshot item it replaced
— so that item shows up under *dropped* even though it was deliberately
superseded. Those need a human read until the delta format carries a
"supersedes" pointer.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

SNAPSHOT_RE = re.compile(r"^##\s+v[\d.]+\s+SKILL\.md\s+\(verbatim", re.I)
DELTA_RE = re.compile(r"^##\s+v[\d.]+\s+additions", re.I)
FINGERPRINT_CHARS = 120  # dropped-side only; the added side compares in full
SUPERSEDES_RE = re.compile(r"^\s*Supersedes:\s*(.+)$", re.M)
ID_RE = re.compile(r"#id/(BlockNode:[0-9A-Z]+)")
STATUS_RE = re.compile(r"^Status:\s+\*\*v(\d+(?:\.\d+)*)\*\*", re.M)


def find_graph_dir() -> Path:
    for base in [Path.cwd(), *Path.cwd().parents, Path(__file__).resolve().parents[3]]:
        cand = base / "AperasKG" / "Apeiron"
        if cand.is_dir():
            return cand
    sys.exit("could not locate AperasKG/Apeiron")


def find_skill_files() -> list[Path]:
    """The base skill plus every role skill (v3's multi-agent split) — one shared graph record
    covers all four, so drift is checked against their combined text, not file by file."""
    skills_dir = Path(__file__).resolve().parents[2]
    files = [skills_dir / "aperas" / "SKILL.md"]
    files += sorted(skills_dir.glob("aperas-*/SKILL.md"))
    missing = [f for f in files if not f.is_file()]
    if missing:
        sys.exit(f"missing skill file(s): {', '.join(str(f) for f in missing)}")
    return files


def norm(text: str) -> str:
    """Collapse whitespace so formatting differences don't read as drift."""
    return re.sub(r"\s+", " ", text or "").strip()


def load_blocks(graph_dir: Path) -> dict[str, dict]:
    raw = json.loads((graph_dir / "BlockNode.jsonld").read_text())
    nodes = raw if isinstance(raw, list) else raw.get("@graph", raw)
    return {n["@id"]: n for n in nodes if isinstance(n, dict) and "@id" in n}


def subtree_texts(root_id: str, blocks: dict[str, dict]) -> list[tuple[str, str]]:
    """Every live (id, normalized text) under root, root included."""
    out: list[tuple[str, str]] = []

    def walk(nid: str) -> None:
        node = blocks.get(nid)
        if not node or node.get("tombstonedAt"):
            return
        # The root's own text is commentary *about* the snapshot or delta —
        # why it was taken, how to read it — not skill content, so it is not
        # something the file should be expected to contain.
        body = "" if nid == root_id else norm(node.get("text") or "")
        # A fenced block stores its own ``` markers; the file's frontmatter
        # carries none, so strip them before comparing. Strip embedded code fences as well.
        body = norm(re.sub(r"```\w*", "", body))
        # A Supersedes: marker is delta bookkeeping, not skill text — it is
        # never expected to appear in the file, so it must not read as dropped.
        body = norm(SUPERSEDES_RE.sub("", body))
        if body:
            out.append((nid, body))
        for kid in node.get("children") or []:
            walk(kid)

    walk(root_id)
    return out


def superseded_ids(blocks: dict[str, dict], roots: list[tuple[str, str]]) -> dict[str, str]:
    """Snapshot ids a delta entry explicitly claims to replace.

    The delta format records additions; without a marker, an item that a minor
    version deliberately rewrote is indistinguishable from one silently lost —
    which is the exact judgement this check exists to make, so the convention is
    a `Supersedes: [title](#id/BlockNode:...)` line in the superseding entry.
    """
    out: dict[str, str] = {}
    for rid, label in roots:
        if not label.startswith("delta"):
            continue
        stack = [rid]
        while stack:
            nid = stack.pop()
            node = blocks.get(nid)
            if not node or node.get("tombstonedAt"):
                continue
            for claim in SUPERSEDES_RE.findall(node.get("text") or ""):
                for target in ID_RE.findall(claim):
                    out[target] = nid
            stack.extend(node.get("children") or [])
    return out


def version_of(title: str) -> tuple[int, ...]:
    m = re.search(r"\bv(\d+(?:\.\d+)*)", title)
    return tuple(int(x) for x in m.group(1).split(".")) if m else (-1,)


def recorded_roots(blocks: dict[str, dict]) -> list[tuple[str, str]]:
    """The *current* baseline: the latest snapshot plus every delta above it.

    Older snapshots are history, not a baseline — v1 restructuring v0 wholesale
    is the point of a major version, not drift, so comparing against v0 would
    report the entire rewrite as drops.
    """
    snaps, deltas = [], []
    for nid, node in blocks.items():
        if node.get("tombstonedAt"):
            continue
        title = node.get("title") or ""
        if SNAPSHOT_RE.match(title):
            snaps.append((version_of(title), nid, f"snapshot: {title}"))
        elif DELTA_RE.match(title):
            deltas.append((version_of(title), nid, f"delta: {title}"))
    if not snaps:
        return []
    base = max(snaps)
    roots = [(base[1], base[2])]
    roots += [(nid, label) for ver, nid, label in sorted(deltas) if ver >= base[0]]
    return roots


def trimmed(ver: tuple[int, ...]) -> tuple[int, ...]:
    """Drop trailing zeros so (4,) and (4, 0) compare equal."""
    out = list(ver)
    while out and out[-1] == 0:
        out.pop()
    return tuple(out)


def status_findings(skills: list[Path], roots: list[tuple[str, str]]) -> tuple[tuple[int, ...], list[str]]:
    """The newest recorded version and one message per skill whose `Status:` line differs from it.

    A line ahead of the graph's record differs just as one behind it does.
    """
    newest = max(version_of(label) for _, label in roots)
    found: list[str] = []
    for s in skills:
        m = STATUS_RE.search(s.read_text())
        if not m:
            found.append(f"{s.parent.name}: no `Status: **vN**` line")
            continue
        ver = tuple(int(x) for x in m.group(1).split("."))
        if trimmed(ver) != trimmed(newest):
            side = "ahead of" if trimmed(ver) > trimmed(newest) else "behind"
            found.append(f"{s.parent.name}: Status v{m.group(1)} is {side} the newest recorded v{'.'.join(map(str, newest))}")
    return newest, found


def file_units(path: Path) -> list[tuple[str, str]]:
    """(heading, paragraph) per paragraph, which is the granularity that matters.

    Section-level fingerprints only catch whole new sections; an addition made
    *inside* an existing section keeps that section's opening text and so reads
    as unchanged. Checking each paragraph catches both.

    A paragraph ends at a blank line or at a lone `---` line. The separator rule
    matters after a list item: with no blank line between them, a `---` would
    otherwise fold into that item's unit and the unit would never match the
    graph's text for the item.
    """
    units = []
    for heading, body in _sections(path):
        for para in re.split(r"\n\s*\n|^[ \t]*---[ \t]*$", body, flags=re.M):
          # One unit per list item, not per paragraph block. Once any single
          # item has been superseded, the list as a whole no longer appears
          # contiguously in any one record, so comparing a whole list must
          # fail — and would fail as a false positive, not a real finding.
          for para in re.split(r"\n(?=\s*(?:[-*+]|\d+\.)\s)", para):
            # Strip list bullet markers and optional task list checkbox markers ([ ] / [x])
            # so items compare directly to the AST-parsed text property in the graph.
            para = re.sub(r"^\s*(?:[-*+]|\d+\.)\s+(?:\[[ xX]?\]\s+)?", "", para, flags=re.M)
            para = norm(re.sub(r"```\w*", "", para))  # fences match the stripped graph side
            if len(para) > 40:  # skip stubs: headings-only, one-liners, fence edges
                units.append((f"{path.parent.name}: {heading}", para))
    return units


def _sections(path: Path) -> list[tuple[str, str]]:
    """(heading, raw body) per section, fenced code left intact."""
    lines, sections, heading, buf, fenced = path.read_text().split("\n"), [], "(top matter)", [], False
    for line in lines:
        if line.startswith("```"):
            fenced = not fenced
        if not fenced and re.match(r"^#{2,4}\s+\S", line):
            sections.append((heading, "\n".join(buf)))
            heading, buf = line.strip("# ").strip(), []
        else:
            # A list marker is structure, not content: the parser lifts it into
            # props, so the graph stores "**Philosophy** — ..." where the file
            # has "1. **Philosophy** — ...". Strip it so the two compare.
            buf.append(line)
    sections.append((heading, "\n".join(buf)))
    return [(h, b) for h, b in sections if b.strip()]


def main() -> None:
    ap = argparse.ArgumentParser(description="Drift between SKILL.md and its graph record.")
    ap.add_argument("--added", action="store_true", help="only sections the graph never recorded")
    ap.add_argument("--dropped", action="store_true", help="only recorded items absent from the file")
    args = ap.parse_args()
    both = not (args.added or args.dropped)

    blocks = load_blocks(find_graph_dir())
    skills = find_skill_files()

    roots = recorded_roots(blocks)
    if not roots:
        sys.exit("no snapshot or delta sections found in the graph — nothing to compare against")

    newest, status_bad = status_findings(skills, roots)
    findings = len(status_bad)

    recorded: list[tuple[str, str, str]] = []
    for rid, label in roots:
        for nid, body in subtree_texts(rid, blocks):
            recorded.append((nid, body, label))

    print(f"comparing {len(skills)} skill file(s) against {len(roots)} recorded section(s):")
    for s in skills:
        print(f"  {s}")
    for _, label in roots:
        print(f"  {label}")
    print()

    print(f"STATUS vs newest recorded v{'.'.join(map(str, newest))} — {len(status_bad)}")
    for msg in status_bad:
        print(f"  - {msg}")
    if not status_bad:
        print("  (none — every Status line matches the newest recorded version)")
    print()

    if both or args.added:
        haystack = " ".join(b for _, b, _ in recorded)
        missing = [
            (h, b) for s in skills for h, b in file_units(s)
            if b not in haystack
        ]
        print(f"ADDED but unrecorded — {len(missing)}")
        for h, b in missing:
            print(f"  - {h}\n      {b[:100]}…")
        if not missing:
            print("  (none — every section traces to a snapshot or delta)")
        print()
        findings += len(missing)

    if both or args.dropped:
        filetext = norm(" ".join(s.read_text() for s in skills))
        gone = [
            (nid, b, label) for nid, b, label in recorded
            if b[:FINGERPRINT_CHARS] not in filetext
        ]
        sup = superseded_ids(blocks, roots)
        accounted = [(n, b, l) for n, b, l in gone if n in sup]
        unaccounted = [(n, b, l) for n, b, l in gone if n not in sup]

        print(f"DROPPED, unaccounted — {len(unaccounted)}  (in the graph's record, gone from")
        print("  the file, and no delta entry claims to supersede them)")
        for nid, b, _ in unaccounted:
            print(f"  - {nid}\n      {b[:100]}…")
        if not unaccounted:
            print("  (none)")
        findings += len(unaccounted)

        if accounted:
            print()
            print(f"superseded, accounted for — {len(accounted)}")
            for nid, b, _ in accounted:
                print(f"  - {nid}  ← superseded by {sup[nid]}\n      {b[:80]}…")

    if findings:
        print()
        print(f"{findings} finding(s) — exit 1")
        sys.exit(1)


if __name__ == "__main__":
    main()
