#!/usr/bin/env python3
"""Read raw node state straight out of the AperasKG JSON-LD mirror.

The `aperas` CLI only ever shows a *rendered preview* (title plus truncated,
anchor-stripped abstract), so fields like `props`, `tombstonedAt` and a block's
exact stored `text` are invisible through it. This covers that gap until an
`aperas show <ref>` verb exists (issues/treeview.md).

Read-only by construction: it opens the mirror and prints. It never writes.

  show_node.py 00CE95MVP8008                 full record(s), pretty-printed
  show_node.py --text 00CE95MVP8008          exact stored text, undecorated
  show_node.py --children 00CEA56A0G001      direct children, tombstones marked
  show_node.py --grep 'task-list'            full-text search across all blocks
  show_node.py --artifact 00CE95MVP8008      which artifact a block lives in

`--text` is the one to use before pushing an edit: redirect it to a file, edit
that, and `cat` it back into `aperas update`, so the untouched part of a block
is byte-identical rather than retyped from a rendered preview.

Refs may be bare snowflakes or full ids (`BlockNode:00CE...`).
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path


def find_graph_dir(explicit: str | None) -> Path:
    if explicit:
        d = Path(explicit).expanduser()
        if not d.is_dir():
            sys.exit(f"not a directory: {d}")
        return d
    # Walk up from cwd, then fall back to this script's own repo checkout.
    for base in [Path.cwd(), *Path.cwd().parents, Path(__file__).resolve().parents[3]]:
        cand = base / "AperasKG" / "Apeiron"
        if cand.is_dir():
            return cand
    sys.exit("could not locate AperasKG/Apeiron — pass --graph")


def load(graph_dir: Path) -> tuple[dict[str, dict], dict[str, dict]]:
    def read(name: str) -> dict[str, dict]:
        path = graph_dir / name
        if not path.is_file():
            return {}
        with path.open() as fh:
            raw = json.load(fh)
        nodes = raw if isinstance(raw, list) else raw.get("@graph", raw)
        return {n["@id"]: n for n in nodes if isinstance(n, dict) and "@id" in n}

    return read("BlockNode.jsonld"), read("ArtifactNode.jsonld")


def resolve(ref: str, blocks: dict[str, dict], artifacts: dict[str, dict]) -> str:
    if ref in blocks or ref in artifacts:
        return ref
    for prefix in ("BlockNode:", "ArtifactNode:"):
        if (cand := prefix + ref) in blocks or cand in artifacts:
            return cand
    sys.exit(f"no such node: {ref}")


def enclosing_artifact(
    nid: str, blocks: dict[str, dict], artifacts: dict[str, dict]
) -> tuple[str, str] | None:
    """Walk parent pointers up to the owning ArtifactNode. Returns (id, path)."""
    seen: set[str] = set()
    cur: str | None = nid
    while cur and cur not in seen:
        seen.add(cur)
        if cur in artifacts:
            return cur, artifacts[cur].get("path", "?")
        node = blocks.get(cur) or artifacts.get(cur)
        if not node:
            return None
        cur = node.get("parent")
    return None


def preview(node: dict, width: int = 90) -> str:
    text = (node.get("text") or node.get("title") or "").replace("\n", " ")
    text = re.sub(r"\s+", " ", text).strip()
    return text[:width] + ("…" if len(text) > width else "")


def mark(node: dict) -> str:
    return "  (tombstoned)" if node.get("tombstonedAt") else ""


def main() -> None:
    ap = argparse.ArgumentParser(
        description="Inspect raw AperasKG node state (read-only).",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("refs", nargs="*", help="node refs (bare snowflake or full id)")
    ap.add_argument("--text", action="store_true", help="print exact stored text only")
    ap.add_argument("--children", action="store_true", help="list direct children")
    ap.add_argument("--artifact", action="store_true", help="show the owning artifact")
    ap.add_argument("--grep", metavar="PATTERN", help="regex search over block text/title")
    ap.add_argument("-i", "--ignore-case", action="store_true", help="case-insensitive --grep")
    ap.add_argument("--graph", metavar="DIR", help="path to AperasKG/Apeiron")
    args = ap.parse_args()

    blocks, artifacts = load(find_graph_dir(args.graph))

    if args.grep:
        pattern = re.compile(args.grep, re.IGNORECASE if args.ignore_case else 0)
        hits = 0
        for nid, node in blocks.items():
            haystack = f"{node.get('title') or ''}\n{node.get('text') or ''}"
            if not pattern.search(haystack):
                continue
            hits += 1
            owner = enclosing_artifact(nid, blocks, artifacts)
            where = owner[1] if owner else "(unparented)"
            print(f"{nid}  [{node.get('type','?')}]  {where}{mark(node)}")
            print(f"    {preview(node)}")
        print(f"\n{hits} block(s) matched.", file=sys.stderr)
        return

    if not args.refs:
        ap.error("give at least one ref, or use --grep")

    for ref in args.refs:
        nid = resolve(ref, blocks, artifacts)
        node = blocks.get(nid) or artifacts[nid]

        if args.text:
            # Undecorated on purpose: this is meant to be redirected to a file.
            sys.stdout.write(node.get("text") or "")
            if node.get("text") and not node["text"].endswith("\n"):
                sys.stdout.write("\n")
            continue

        if args.artifact:
            owner = enclosing_artifact(nid, blocks, artifacts)
            print(f"{nid} → {owner[0]}  {owner[1]}" if owner else f"{nid} → (unparented)")
            continue

        if args.children:
            kids = node.get("children") or []
            print(f"{nid}  [{node.get('type','?')}]  {len(kids)} child(ren){mark(node)}")
            for kid in kids:
                child = blocks.get(kid)
                if not child:
                    print(f"  {kid}  (MISSING from mirror)")
                    continue
                print(f"  {kid}  [{child.get('type','?')}]{mark(child)}")
                print(f"      {preview(child)}")
            continue

        print(json.dumps(node, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
