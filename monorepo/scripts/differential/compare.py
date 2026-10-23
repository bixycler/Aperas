#!/usr/bin/env python3
"""The normaliser and the comparer of the differential run (Python 3, standard library only; planning/core.md, Batch 13, piece 3).

  python3 monorepo/scripts/differential/compare.py --run <harness-output-dir> [--snapshot <graph-root>] [--json <file>]
  python3 monorepo/scripts/differential/compare.py --ref <Apeiron-dir> --new <Apeiron-dir> [--snapshot <graph-root>] [--json <file>]
         [--tools <dir>] [--no-migrate] [--no-outputs]

Input: the two dumps that `harness.py` leaves (`<out>/dumps/ref/Apeiron` and `<out>/dumps/new/Apeiron`, the `.state/` directory included) and,
with `--run`, the commands of `<out>/results.json` with their stdout, stderr and status. Nothing here starts a service or writes outside a
scratch directory of its own, and nothing is read from the real graph.

What it does, in this order:

  1. The reference's dump is migrated with the same `migrate-mirror.py` the new side's copy was migrated with (a scratch copy of the dump,
     migrated as a process), so that the migration's changes in Layer 4 (no `predicate` on a link, tombstones out of the tree, the READMEs,
     `kind: human`, stripped `unfolds`, no `type` on an artifact) are not differences. `--no-migrate` leaves it out (dumps already in the new form).
  2. Ids. A token is the 13 Crockford characters at the end of an id. A token that stands in the snapshot (`--snapshot`; without it, a token both
     dumps hold) is the same on both sides and compares as itself. A token minted in the run is mapped to the other side's by order: the k-th minted
     node of a container to the k-th of the other, by kind and place (an artifact or folder by its path, a profile by its handle, a block by its
     container and its place among the minted blocks of the container, a link by its host and content), and, for what only a command's stdout
     names, the k-th new id printed by a command to the k-th printed by the same command on the other side. The two ways must agree: a token the
     dump maps one way and the stdout another is a finding.
  3. Values. A document is parsed and compared as a value: its fields in any order, the documents of a file in any order, the sets (`links`,
     `props`, `preferences`, `unfolds`, every list except `children`) as sets, `children` as a list; an empty set or list is the same as an absent
     one; a literal is compared as JSON (so `1` and `true` and `"1"` differ). The timestamps (`lastTrackedAt`, `lastIngestedAt`, `tombstonedAt`, and
     any `...At` or `...Stamp` field of a `TreeView`) are masked: a value in the shape of a UTC time becomes `<timestamp>`, so two different times are
     the same and a field that is present on one side only, or holds anything but a time, is a difference. Timestamps in a command's output are masked
     the same way, and the ids in it are mapped (a bare token with a label too, since a block is titled by its own id). A file with no document is the
     same as no file.
  4. Each difference that is left is offered to the matchers. `MATCHERS` is the one table, keyed by the number of the entry in Layer 4 (1 to 12 of
     the flip, 13 to 19 of the order rules, 20 and 21 of ingest and track, 22 to 27 of the sweeps and the service lifecycle, 28 of the engine
     follow-up). An entry that a dump can show has a function; one that a dump cannot tell (a message, the order of a render, a log line, a test)
     has none, says why in its `note`, and is "not seen by a dump": piece 4 reaches it by a command. A difference that no matcher claims is a
     finding; so is one that more than one claims (the matchers must be exclusive); an entry is "seen" when it has claimed a difference.

Exit status: 0 when there is no finding, 1 when there is one (or a dump cannot be read or migrated), 2 for a usage error. The table printed ends
`UNEXPECTED differences: N`. `--json` writes the findings, the claims, the entries seen and the entries not seen by a dump.
"""
import argparse
import difflib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import explain  # noqa: E402  (piece 4: the explanations of the commands' outputs and of the services' logs)

SCRIPTS = os.path.dirname(HERE)

TOKEN = r"[0-9A-HJKMNP-TV-Z]{13}"
ID_KINDS = r"(?:[A-Za-z]+Node|Profile|TreeView|Link|StringProp)"
PREFIXED = re.compile(r"(?<![A-Za-z0-9])(" + ID_KINDS + r"):(" + TOKEN + r")(?![0-9A-Za-z])")
FULL_ID = re.compile(r"^" + ID_KINDS + ":" + TOKEN + r"(?::[A-Za-z]+:" + ID_KINDS + ":" + TOKEN + r")*$")
BARE = re.compile(r"(?<![0-9A-Za-z:~])(" + TOKEN + r")(?![0-9A-Za-z])")
ISO_TIME = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$")
ISO_IN_TEXT = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z")
TIMESTAMP_FIELDS = {"lastTrackedAt", "lastIngestedAt", "tombstonedAt"}
MASK = "<timestamp>"
REJECTED_COPY = re.compile(r"\.rejected-\d{8}T\d{6}Z\.json$")
MISSING = object()


class Failure(Exception):
    """A dump cannot be read or migrated: exit status 1."""


# --------------------------------------------------------------------------------------------------------------------- reading

def token_of(full_id):
    return full_id.rsplit(":", 1)[-1]


def read_dump(directory):
    """-> ({relative name: list of documents}, [relative names of the other files]); the names use `/` and `.state/BlockNode.jsonld` for the state files."""
    files, extras = {}, []
    for root, dirs, names in os.walk(directory):
        dirs.sort()
        for name in sorted(names):
            path = os.path.join(root, name)
            rel = os.path.relpath(path, directory).replace(os.sep, "/")
            if name.endswith(".jsonld"):
                try:
                    with open(path, encoding="utf-8") as h:
                        docs = json.load(h)
                except (OSError, ValueError) as e:
                    raise Failure("cannot read %s: %s" % (path, e))
                if not isinstance(docs, list) or not all(isinstance(d, dict) and isinstance(d.get("@id"), str) for d in docs):
                    raise Failure("%s is not a list of documents with an @id" % path)
                if docs:   # a file with no document holds nothing: it is the same as no file
                    files[rel] = docs
            else:
                extras.append(rel)
    return files, extras


def migrate_reference(dump_dir, tools):
    """Copy the reference's dump into a scratch graph root and migrate it with `migrate-mirror.py`; -> (Apeiron directory, scratch root to delete)."""
    scratch = tempfile.mkdtemp(prefix="dc-")
    try:
        shutil.copytree(dump_dir, os.path.join(scratch, "Apeiron"))
        script = os.path.join(tools, "migrate-mirror.py")
        env = {k: v for k, v in os.environ.items() if k != "LD_LIBRARY_PATH"}
        p = subprocess.run([sys.executable, script, scratch], capture_output=True, text=True, stdin=subprocess.DEVNULL, env=env, timeout=300)
        if p.returncode != 0:
            raise Failure("migrate-mirror.py on the reference's dump ended with status %d:\n%s%s" % (p.returncode, p.stdout, p.stderr))
        return os.path.join(scratch, "Apeiron"), scratch
    except BaseException:
        shutil.rmtree(scratch, True)
        raise


def snapshot_tokens(snapshot):
    """The tokens of every id (document or embedded) in a snapshot: a graph root, or its `Apeiron` directory."""
    base = os.path.join(snapshot, "Apeiron") if os.path.isdir(os.path.join(snapshot, "Apeiron")) else snapshot
    files, _ = read_dump(base)
    out = set()
    for docs in files.values():
        for d in docs:
            walk_ids(d, out)
    return out


def walk_ids(value, out):
    """Add the token of every id in a document: its `@id`s, and the ids its fields name (an `unfolds` entry may name an id no node has)."""
    if isinstance(value, dict):
        i = value.get("@id")
        if isinstance(i, str):
            out.add(token_of(i))
        for k, v in value.items():
            if k != "@id":
                walk_ids(v, out)
    elif isinstance(value, list):
        for v in value:
            walk_ids(v, out)
    elif isinstance(value, str) and FULL_ID.match(value):
        out.add(token_of(value))


# --------------------------------------------------------------------------------------------------------------------- one side

class Side:
    """One dump: its documents, the embedded entries, the structure the pairing of minted ids reads, and the labels of its tokens."""

    def __init__(self, name, files, extras):
        self.name = name
        self.files = files
        self.extras = extras
        self.top = {}        # full id -> (file, document)
        self.embedded = {}   # full id of an embedded entry -> (host full id, field, entry)
        self.problems = []
        for rel, docs in files.items():
            for d in docs:
                i = d["@id"]
                if i in self.top:
                    self.problems.append("%s: the id %s is defined twice (%s and %s)" % (name, i, self.top[i][0], rel))
                self.top[i] = (rel, d)
                self._embeds(i, d)
        self.tokens = {token_of(i) for i in self.top} | {token_of(i) for i in self.embedded}
        self.mentioned = set()   # every token a document holds or names
        for _, d in self.top.values():
            walk_ids(d, self.mentioned)
        self.labels = {}
        self.container = {}  # full id -> container full id (the document whose `children` lists it, else the one its `parent` names)
        self.children = {}   # full id -> [full ids of its children that are documents]
        for i, (_, d) in sorted(self.top.items()):
            kids = [c for c in d.get("children", []) if isinstance(c, str) and c in self.top]
            self.children[i] = kids
            for c in kids:
                self.container.setdefault(c, i)
        for i, (_, d) in sorted(self.top.items()):
            p = d.get("parent")
            if i not in self.container and isinstance(p, str) and p in self.top:
                self.container[i] = p

    def _embeds(self, host, doc):
        for field, val in doc.items():
            if isinstance(val, list) and val and all(isinstance(e, dict) and isinstance(e.get("@id"), str) for e in val):
                for e in val:
                    self.embedded[e["@id"]] = (host, field, e)
                    self._embeds(e["@id"], e)

    def label(self, tok, snapshot):
        if tok in self.labels:
            return self.labels[tok]
        return tok if tok in snapshot else "%s!%s" % (self.name, tok)

    def canon(self, text, snapshot):
        """The ids in a string with their tokens replaced by the labels; a bare token that has a label (a block is titled by its own id) is replaced too."""
        text = PREFIXED.sub(lambda m: "%s:%s" % (m.group(1), self.label(m.group(2), snapshot)), text)
        return BARE.sub(lambda m: self.labels.get(m.group(1), m.group(1)), text)


# --------------------------------------------------------------------------------------------------------------------- pairing of ids

def literal_signature(doc):
    """The literals of a document that tell it from another of its kind, without ids and times."""
    keep = {}
    own = token_of(doc["@id"]) if isinstance(doc.get("@id"), str) else None
    for k, v in doc.items():
        if k in ("@id", "parent", "children", "links", "props", "preferences", "unfolds", "root", "profile") or k in TIMESTAMP_FIELDS:
            continue
        if isinstance(v, str) and own and own in v:
            v = v.replace(own, "<own id>")   # a block with no lead-in term is titled by its own id
        if isinstance(v, (str, int, float, bool)) or v is None:
            keep[k] = v
    return json.dumps(keep, sort_keys=True, ensure_ascii=False)


def base_key(side, fid, uniq):
    rel, d = side.top[fid]
    kind = d.get("@type", fid.split(":", 1)[0])
    if kind in ("ArtifactNode", "FolderNode") and "path" in d:
        return ("path", kind, d["path"])
    if kind == "Profile" and "handle" in d:
        return ("handle", d["handle"])
    if kind == "TreeView" and "name" in d:
        prof = d.get("profile")
        who = uniq.get(prof) if prof in uniq else (token_of(prof) if isinstance(prof, str) else None)
        return ("view", who, d["name"])
    c = side.container.get(fid)
    if c is not None:
        if token_of(c) in side.snapshot_tokens:
            cu = ("snap", token_of(c))
        else:
            cu = uniq.get(c)
        if cu is not None:
            siblings = [x for x in side.children.get(c, []) if token_of(x) not in side.snapshot_tokens and side.top[x][1].get("@type") == kind]
            if fid in siblings:
                where = siblings.index(fid)
            else:   # named by `parent` only: its place among such children, by id
                loose = sorted(x for x, cx in side.container.items() if cx == c and x not in side.children.get(c, []) and side.top[x][1].get("@type") == kind and token_of(x) not in side.snapshot_tokens)
                where = len(siblings) + loose.index(fid)
            return ("in", cu, kind, where)
    return ("loose", kind, literal_signature(d))


def unique_keys(side):
    """-> {full id of a minted document: a key that names its kind, container and place}, built from the roots down."""
    minted = [i for i in side.top if token_of(i) not in side.snapshot_tokens]
    uniq = {}
    todo = set(minted)
    for _ in range(len(minted) + 1):
        if not todo:
            break
        ready = [i for i in sorted(todo) if side.container.get(i) is None or token_of(side.container[i]) in side.snapshot_tokens or side.container[i] in uniq or side.container[i] not in todo]
        if not ready:   # a cycle of containers (a damaged dump): break it at the smallest id
            ready = [min(todo)]
        groups = {}
        for i in ready:
            groups.setdefault(base_key(side, i, uniq), []).append(i)
        for key, ids in groups.items():
            for rank, i in enumerate(sorted(ids, key=token_of)):
                uniq[i] = (key, rank)
        todo -= set(ready)
    return uniq


def pair_documents(ref, new):
    """Pair the minted documents of the two sides by key; -> number of pairs. Sets the labels `~n` on both sides."""
    ru, nu = unique_keys(ref), unique_keys(new)
    inv_r = {k: i for i, k in ru.items()}
    pairs = [(inv_r[k], i) for i, k in nu.items() if k in inv_r]
    pairs.sort(key=lambda p: (new.top[p[1]][1].get("@type", ""), token_of(p[1])))
    for n, (r, w) in enumerate(pairs, 1):
        ref.labels[token_of(r)] = "~%d" % n
        new.labels[token_of(w)] = "~%d" % n
    return len(pairs)


# --------------------------------------------------------------------------------------------------------------------- normalised documents

class Emb:
    """An embedded entry (a `Link`, a `StringProp`): its fields, what it embeds, and its content (everything but its own id)."""

    def __init__(self, raw_id, kind, fields, embs):
        self.raw_id = raw_id
        self.kind = kind
        self.fields = fields
        self.embs = embs
        self.cid = None
        self.show = " ".join([kind] + ["%s=%s" % (k, v) for k, v in sorted(fields.items())] + ["%s=[%s]" % (f, ", ".join(e.show for e in es)) for f, es in sorted(embs.items())])
        self.content = json.dumps([kind, sorted(fields.items()), sorted((f, sorted(e.content for e in es)) for f, es in embs.items())], sort_keys=True, ensure_ascii=False)


class NDoc:
    """A document as a value: canonical ids, masked times, empty sets dropped."""

    def __init__(self, cid, raw_id, kind, file, fields, embs):
        self.cid = cid
        self.raw_id = raw_id
        self.kind = kind
        self.file = file
        self.fields = fields
        self.embs = embs

    @property
    def children(self):
        return self.fields.get("children", [])

    def live(self):
        return "tombstonedAt" not in self.fields


def is_timestamp_field(kind, name):
    return name in TIMESTAMP_FIELDS or (kind == "TreeView" and (name.endswith("At") or name.endswith("Stamp")))


def norm_value(side, snapshot, kind, name, value):
    if is_timestamp_field(kind, name) and isinstance(value, str) and ISO_TIME.match(value):
        return MASK
    if isinstance(value, str):
        return side.canon(value, snapshot)
    if isinstance(value, list):
        return [norm_value(side, snapshot, kind, name, v) for v in value]
    return value


def norm_embedded(side, snapshot, e):
    fields, embs = {}, {}
    for k, v in e.items():
        if k in ("@id", "@type"):
            continue
        if isinstance(v, list) and v and all(isinstance(x, dict) and "@id" in x for x in v):
            embs[k] = [norm_embedded(side, snapshot, x) for x in v]
        elif not (isinstance(v, list) and not v):
            fields[k] = norm_value(side, snapshot, e.get("@type", ""), k, v)
    return Emb(e["@id"], e.get("@type", e["@id"].split(":", 1)[0]), fields, embs)


def norm_document(side, snapshot, fid):
    rel, d = side.top[fid]
    kind = d.get("@type", fid.split(":", 1)[0])
    fields, embs = {}, {}
    for k, v in d.items():
        if k == "@id":
            continue
        if isinstance(v, list) and v and all(isinstance(x, dict) and "@id" in x for x in v):
            embs[k] = [norm_embedded(side, snapshot, x) for x in v]
        elif isinstance(v, list) and not v:
            continue
        else:
            fields[k] = norm_value(side, snapshot, kind, k, v)
    for k, v in list(fields.items()):
        if isinstance(v, list) and k != "children":
            fields[k] = sorted(v, key=lambda x: json.dumps(x, sort_keys=True))
    return NDoc(None, fid, kind, rel, fields, embs)


def pair_embedded(ref_docs, new_docs, ref, new, snapshot, diffs):
    """Pair the entries embedded in a document both sides hold, by content and then by order; set the labels of minted tokens and note an id that differs."""
    next_label = [0]

    def walk(rd_embs, nd_embs, path, owner, owner_cid):
        for field in sorted(set(rd_embs) | set(nd_embs)):
            groups = {}
            for e in rd_embs.get(field, []):
                groups.setdefault(e.content, ([], []))[0].append(e)
            for e in nd_embs.get(field, []):
                groups.setdefault(e.content, ([], []))[1].append(e)
            for content, (res, nes) in sorted(groups.items()):
                res.sort(key=lambda e: token_of(e.raw_id))
                nes.sort(key=lambda e: token_of(e.raw_id))
                for r, n in zip(res, nes):
                    rt, nt = token_of(r.raw_id), token_of(n.raw_id)
                    r_min, n_min = rt not in snapshot, nt not in snapshot
                    if r_min and n_min:
                        next_label[0] += 1
                        ref.labels[rt] = new.labels[nt] = "~e%d" % next_label[0]
                    if ref.label(rt, snapshot) != new.label(nt, snapshot):
                        diffs.append(Diff("embedded-id", "changed", file=owner.file, kind=r.kind, id=owner_cid, field=path + field, ref=r.raw_id, new=n.raw_id,
                                          extra={"ref_minted": r_min, "new_minted": n_min, "prop_key": r.fields.get("key"), "owner_kind": owner_kind(path)}))
                    walk(r.embs, n.embs, path + field + "/", owner, owner_cid)

    for cid in sorted(set(ref_docs) & set(new_docs)):
        walk(ref_docs[cid].embs, new_docs[cid].embs, "", ref_docs[cid], cid)


def owner_kind(path):
    return "Link" if path.endswith("links/") else "document"


def assign_embedded_cids(side, snapshot, docs):
    def go(embs):
        for es in embs.values():
            for e in es:
                e.cid = side.canon(e.raw_id, snapshot)
                go(e.embs)
    for d in docs.values():
        go(d.embs)


# --------------------------------------------------------------------------------------------------------------------- differences

class Diff:
    """One difference between the two sides. `scope`: doc, field, element, embedded-id, file, output, id-map, load. `op`: only-ref, only-new, changed, reordered."""

    def __init__(self, scope, op, file=None, kind=None, id=None, field=None, ref=None, new=None, extra=None, ref_id=None, new_id=None, command=None):
        self.scope, self.op, self.file, self.kind, self.id, self.field = scope, op, file, kind, id, field
        self.ref, self.new, self.extra = ref, new, extra or {}
        self.ref_id, self.new_id, self.command = ref_id, new_id, command

    def describe(self):
        where = self.command if self.command else ("%s %s" % (self.kind or "", self.id or "")).strip()
        what = {"doc": "document", "field": "field %s" % self.field, "element": "element of %s" % self.field, "embedded-id": "id of an entry of %s" % self.field,
                "file": "file", "output": self.field, "id-map": "id", "load": "dump", "log": "log line"}[self.scope]
        text = "%s %s: %s [ref %s] [new %s]" % (self.op, what, where or self.file, short(self.ref), short(self.new))
        if self.file and self.scope != "file":
            text += " (%s)" % self.file
        return text

    def as_json(self):
        return {"scope": self.scope, "op": self.op, "file": self.file, "kind": self.kind, "id": self.id, "field": self.field, "ref": self.ref, "new": self.new,
                "refId": self.ref_id, "newId": self.new_id, "command": self.command}


def short(v):
    if v is MISSING or v is None:
        return "-"
    s = v if isinstance(v, str) else json.dumps(v, ensure_ascii=False, sort_keys=True)
    s = s.replace("\n", "\\n")
    return s if len(s) <= 90 else s[:87] + "..."


def jdump(v):
    return json.dumps(v, sort_keys=True, ensure_ascii=False)


def compare_documents(rd, nd, diffs):
    cid = rd.cid
    base = dict(file=rd.file, kind=rd.kind, id=cid, ref_id=rd.raw_id, new_id=nd.raw_id)
    if rd.kind != nd.kind:
        diffs.append(Diff("field", "changed", field="@type", ref=rd.kind, new=nd.kind, **base))
    if rd.file != nd.file:
        diffs.append(Diff("field", "changed", field="@file", ref=rd.file, new=nd.file, **{**base, "file": None}))
    for f in sorted(set(rd.fields) | set(nd.fields)):
        rv, nv = rd.fields.get(f, MISSING), nd.fields.get(f, MISSING)
        if rv is not MISSING and nv is not MISSING and jdump(rv) == jdump(nv):
            continue
        if rv is MISSING:
            diffs.append(Diff("field", "only-new", field=f, new=nv, **base))
        elif nv is MISSING:
            diffs.append(Diff("field", "only-ref", field=f, ref=rv, **base))
        elif isinstance(rv, list) and isinstance(nv, list):
            for x in rv:
                if x not in nv:
                    diffs.append(Diff("element", "only-ref", field=f, ref=x, **base))
            for x in nv:
                if x not in rv:
                    diffs.append(Diff("element", "only-new", field=f, new=x, **base))
            common_r = [x for x in rv if x in nv]
            common_n = [x for x in nv if x in rv]
            if f == "children" and common_r != common_n:
                diffs.append(Diff("field", "reordered", field=f, ref=rv, new=nv, **base))
        else:
            diffs.append(Diff("field", "changed", field=f, ref=rv, new=nv, **base))
    for f in sorted(set(rd.embs) | set(nd.embs)):
        compare_embedded(f, rd.embs.get(f, []), nd.embs.get(f, []), base, diffs)


def compare_embedded(path, res, nes, base, diffs):
    groups = {}
    for e in res:
        groups.setdefault(e.content, ([], []))[0].append(e)
    for e in nes:
        groups.setdefault(e.content, ([], []))[1].append(e)
    for content, (rs, ns) in sorted(groups.items()):
        for e in rs[len(ns):]:
            diffs.append(Diff("element", "only-ref", field=path, ref=e.show, **{**base, "ref_id": e.raw_id}))
        for e in ns[len(rs):]:
            diffs.append(Diff("element", "only-new", field=path, new=e.show, **{**base, "new_id": e.raw_id}))


# --------------------------------------------------------------------------------------------------------------------- commands and their outputs

def read_text(path):
    try:
        with open(path, encoding="utf-8", errors="replace") as h:
            return h.read()
    except OSError:
        return ""


def load_commands(out_dir):
    """The commands of a harness run: [{index, name, argv, ref: {status, stdout, stderr}, new: {...}}] with the texts read."""
    with open(os.path.join(out_dir, "results.json"), encoding="utf-8") as h:
        results = json.load(h)
    cmds = []
    for c in results.get("commands", []):
        item = {"index": c["index"], "name": c["name"], "argv": c.get("argv") or []}
        for s in ("ref", "new"):
            r = c.get(s) or {}
            item[s] = {"status": r.get("status"), "timedOut": r.get("timedOut", False),
                       "stdout": read_text(os.path.join(out_dir, r["stdout"])) if r.get("stdout") else "",
                       "stderr": read_text(os.path.join(out_dir, r["stderr"])) if r.get("stderr") else ""}
        cmds.append(item)
    return cmds, results


def printed_tokens(text, snapshot):
    """The minted tokens a text names, in order of first appearance (as the prefixed ids `Kind:TOKEN`)."""
    out = []
    for m in PREFIXED.finditer(text):
        t = m.group(2)
        if t not in snapshot and t not in out:
            out.append(t)
    return out


def map_printed(ref, new, commands, snapshot, diffs):
    """The k-th new id printed by a command on the reference to the k-th printed by the same command on the new side. An id that the dumps have mapped already must be mapped the same
    way: a listing whose order differs on purpose (the listings sorted by id) names the same ids in another order, so the labels the dumps gave are compared as sets."""
    for c in commands:
        for stream in ("stdout", "stderr"):
            rt = printed_tokens(c["ref"][stream], snapshot)
            nt = printed_tokens(c["new"][stream], snapshot)
            lab_r = [t for t in rt if t in ref.labels]
            lab_n = [t for t in nt if t in new.labels]
            if {ref.labels[t] for t in lab_r} == {new.labels[t] for t in lab_n}:
                # the ids the dumps mapped name the same nodes, in whatever order the two sides list them; the others are mapped by order
                rt, nt = [t for t in rt if t not in ref.labels], [t for t in nt if t not in new.labels]
            for r, n in zip(rt, nt):
                rl, nl = ref.labels.get(r), new.labels.get(n)
                if rl is None and nl is None:
                    ref.labels[r] = new.labels[n] = "~p%s.%s" % (c["index"], rt.index(r) + 1)
                elif rl != nl:
                    diffs.append(Diff("id-map", "changed", field=stream, ref=ref.label(r, snapshot), new=new.label(n, snapshot), ref_id=r, new_id=n,
                                      command="%03d-%s" % (c["index"], c["name"])))


def norm_text(side, snapshot, text, roots):
    text = side.canon(text, snapshot)
    for root in roots:
        text = text.replace(root, "<root>")
    return re.sub(r"\bpid \d+", "pid <pid>", ISO_IN_TEXT.sub(MASK, text))


def compare_outputs(ref, new, commands, snapshot, roots_ref, roots_new, diffs, claims=None, ctx=None):
    """The status, stdout and stderr of every command. The rules of `explain.py` rewrite the reference's output into the new side's where a deliberate difference of Layer 4
    makes them differ; a command whose three parts are equal after the rules is explained (its rules' entries are claimed, in `claims`), and any part that is not equal is a difference."""
    for c in commands:
        name = "%03d-%s" % (c["index"], c["name"])
        r, n = c["ref"], c["new"]
        status = lambda x: "timed out" if x.get("timedOut") else x["status"]
        rp = {"status": status(r), "stdout": norm_text(ref, snapshot, r["stdout"], roots_ref), "stderr": norm_text(ref, snapshot, r["stderr"], roots_ref)}
        np_ = {"status": status(n), "stdout": norm_text(new, snapshot, n["stdout"], roots_new), "stderr": norm_text(new, snapshot, n["stderr"], roots_new)}
        if rp == np_:
            continue
        applied, ra, na = explain.explain(c.get("argv") or [], rp, np_, ctx)
        residual = [f for f in ("status", "stdout", "stderr") if ra[f] != na[f]]
        if not residual and claims is not None:
            for key in dict.fromkeys(applied):
                claims.append((Diff("output", "explained", field="command", ref=rp["stdout"], new=np_["stdout"], command=name, extra={"argv": c.get("argv") or []}), key))
            if not applied:
                diffs.append(Diff("output", "changed", field="stdout", ref=rp["stdout"], new=np_["stdout"], command=name, extra={"argv": c.get("argv") or []}))
            continue
        for f in residual:
            diffs.append(Diff("output", "changed", field=f, ref=ra[f], new=na[f], command=name, extra={"argv": c.get("argv") or []}))


# --------------------------------------------------------------------------------------------------------------------- the matchers

class Context:
    """What a matcher may read: both sides' normalised documents by canonical id, and the snapshot."""

    def __init__(self, ref, new, snapshot, rejected=None, sides=None, artifacts=None, removed=()):
        self.ref, self.new, self.snapshot = ref, new, snapshot
        self.removed = set(removed)         # the canonical ids that a `remove` command names
        self.rejected = rejected or {}       # token -> number of raw documents with that id in the new side's `.rejected-` copies
        self.sides = sides                   # (reference Side, new Side), for the canonical form of a text
        self.artifacts = artifacts or {}     # side name -> the root of its artifacts
        self._emptied = None

    def emptied_ids(self):
        """The containers (a `list`, or a textless `listItem`) that hold no live child in the reference's dump, that the new side does not hold live, and that no command removed
        by its id: what a removal of their last child left empty. The reference tombstones them at a later sweep, or never, and the new side in the write of the removal
        ([the flip's Difference 3])."""
        if self._emptied is None:
            out = set()
            for cid, d in self.ref.items():
                t = d.fields.get("type")
                if d.kind != "BlockNode" or not (t == "list" or (t == "listItem" and not d.fields.get("text"))) or cid in self.removed:
                    continue
                n = self.new.get(cid)
                if n is not None and n.live():
                    continue
                if all((self.ref.get(ch) is not None and not self.ref[ch].live()) for ch in d.children):
                    out.add(cid)
            self._emptied = out
        return self._emptied

    def is_emptied(self, cid):
        return cid in self.emptied_ids()

    def positionless(self):
        """The ids of the links of the new side's dump that hold no `position` prop."""
        if getattr(self, "_positionless", None) is None:
            out = set()
            for d in self.new.values():
                for e in d.embs.get("links", []):
                    if not any(p.fields.get("key") == "position" for p in e.embs.get("props", [])):
                        out.add(e.cid)
            self._positionless = out
        return self._positionless

    def is_dead_in_ref(self, cid):
        """A node the reference no longer has live at the end of the run: tombstoned, or pruned by one of its sweeps."""
        d = self.ref.get(cid)
        return d is None or not d.live()

    def same_file_up_to_ids(self, path):
        """True when the artifact file `path` differs on the two sides only in the ids minted in the run."""
        if not self.sides or "ref" not in self.artifacts or "new" not in self.artifacts:
            return False
        texts = []
        for side, name in zip(self.sides, ("ref", "new")):
            try:
                with open(os.path.join(self.artifacts[name], path), encoding="utf-8") as h:
                    texts.append(side.canon(h.read(), self.snapshot))
            except OSError:
                return False
        return texts[0] == texts[1]

    def defined(self, docs, cid):
        return cid in docs

    def emptied(self, cid, in_new):
        """The removal of the last live child of a `list`, or of a textless `listItem`, in the same write ([the flip's Difference 3]): live in the
        reference, and in the new side tombstoned (`in_new` "tombstoned"), pruned ("absent") or either ("either"); nothing of its children is live there."""
        r = self.ref.get(cid)
        if r is None or r.kind != "BlockNode" or not r.live():
            return False
        t = r.fields.get("type")
        if not (t == "list" or (t == "listItem" and not r.fields.get("text"))):
            return False
        n = self.new.get(cid)
        if n is None:
            if in_new == "tombstoned":
                return False
        elif n.live() or in_new == "absent":
            return False
        for ch in r.children:
            cn = self.new.get(ch)
            if cn is not None and cn.live():
                return False
        return True


def empty_tombstone(d):
    return "tombstonedAt" in d.fields and "parent" not in d.fields and not d.children and not d.embs.get("links") and not d.embs.get("props")


def m_pruned_tombstone(d, c):
    """Flip 2: a removed node is unreachable, so the sweep prunes it; the reference keeps its (empty) tombstone, which the new side does not hold."""
    return d.scope == "doc" and d.op == "only-ref" and empty_tombstone(c.ref[d.id])


def m_emptied_container(d, c):
    """Flip 3: a removal tombstones the container it empties, in the same write (and the sweep prunes it): the container's own fields, its place in its
    container's `children`, or the container gone from the new side."""
    if d.scope == "doc":
        return d.op == "only-ref" and c.emptied(d.id, "absent")
    if d.scope == "element" and d.field == "children" and d.op == "only-ref" and c.emptied(d.ref, "either"):
        return True
    if d.scope in ("field", "element", "embedded-id") and d.id is not None:
        return c.emptied(d.id, "tombstoned")
    return False


def m_position_prop_ids(d, c):
    """Ingest 2: `positionsEqual` compares two sorted lists, so a reused link keeps the ids of its `position` props where the reference minted new ones for the same content."""
    x = d.extra
    return d.scope == "embedded-id" and d.kind == "StringProp" and x.get("owner_kind") == "Link" and x.get("prop_key") == "position" and x.get("ref_minted") and not x.get("new_minted")


def m_stale_unfold(d, c):
    """Sweeps 2: the sweep of the `unfolds` that name no node is gone, so an unfold of an id no node has stays in the view's file."""
    return (d.scope == "element" and d.field == "unfolds" and d.op == "only-new" and isinstance(d.new, str)
            and d.new not in c.new and d.new not in c.ref and not has_embedded(c.new, d.new))


def has_embedded(docs, cid):
    return any(e.cid == cid for doc in docs.values() for e in all_embedded(doc.embs))


def all_embedded(embs):
    for es in embs.values():
        for e in es:
            yield e
            yield from all_embedded(e.embs)


def m_rejected_copy(d, c):
    """Sweeps 4: `--start-anyway` copies the raw documents the load skipped to `<file>.rejected-<UTC stamp>.json` next to their file."""
    return d.scope == "file" and d.op == "only-new" and REJECTED_COPY.search(d.file or "") is not None


class Entry:
    """One entry of Layer 4. `fn` is None when a dump cannot tell the difference; `note` then says what does, or why nothing does."""

    def __init__(self, key, group, number, title, note, fn=None):
        self.key, self.group, self.number, self.title, self.note, self.fn = key, group, number, title, note, fn

    @property
    def by_dump(self):
        return self.fn is not None


def _table():
    e = []

    def add(group, number, title, note, fn=None):
        e.append(Entry(len(e) + 1, group, number, title, note, fn))
    # the deliberate differences of the flip (piece 6 of Batch 11): 1 to 12
    add("flip", 1, "a tombstone leaves the list of its container", "not seen by a dump: the render (`tree`, `unfold`) shows nothing in place, and the migration of the reference's dump already takes every tombstone out of its container's `children`.")
    add("flip", 2, "a removed node is unreachable, so a sweep prunes it", "seen by a dump as an empty tombstone that only the reference holds (an artifact's too, which `track --reverse` forgets).", m_pruned_tombstone)
    add("flip", 3, "a removal tombstones the container it empties", "seen by a dump as a `list` or textless `listItem` tombstoned (or pruned) in the new side and live and empty in the reference, with its place in its container's `children`.", m_emptied_container)
    add("flip", 4, "the first node found at a path is the live one", "not seen by a dump: which node a path names is a command's answer (`resolve`).")
    add("flip", 5, "a move into its own subtree is refused by the no-cycle rule", "not seen by a dump: the refusal is a message and a status, and a refused move changes nothing on either side.")
    add("flip", 6, "a node must be made before it is written, and its id be of the engine's grammar", "not seen by a dump: it concerns how the tests build nodes, and no command writes an id of its own.")
    add("flip", 7, "removing an embed pair removes the embedded node", "not seen by a dump: no verb removes a pair (`link` and `unlink` are gone); the case is the engine's.")
    add("flip", 8, "`ArtifactNode` has no `type`", "not seen by a dump: the migration of the reference's dump (rule 6) strips the `type` before the comparison; a `type` left on an artifact of the new side is a finding.")
    add("flip", 9, "no quads", "not seen by a dump: the service's log lines and result fields (`recordCount`, `documentCount`).")
    add("flip", 10, "the load is whole or the service does not run", "not seen by a dump: a refused start or reload (the log, the lock, the exit status).")
    add("flip", 11, "retired and deleted", "not seen by a dump: retired code and tests.")
    add("flip", 12, "one sequencing change in a test", "not seen by a dump: a change in a test.")
    # the order rules (piece 7): 13 to 19
    add("order", 1, "the links of a block come by `position`, then id", "not seen by a dump: the order of a render; the dumps hold links as a set, which is compared as a set.")
    add("order", 2, "the canonical place of a node reached through several unfolded links", "not seen by a dump: the render (`tree`).")
    add("order", 3, "the listings are sorted by id", "not seen by a dump: the order of a command's output; the dumps hold sets, compared as sets.")
    add("order", 4, "`compareByKey` places an id with no key last", "not seen by a dump: the engine's comparison, which no output shows.")
    add("order", 5, "`runPath` of a node that has no path is refused with a message of its own", "not seen by a dump: a refusal's message.")
    add("order", 6, "the text at a dangling link's position reads the smallest position", "not seen by a dump: the render's text.")
    add("order", 7, "`aperas show` prints a block's links in id order", "not seen by a dump: the output of `show`.")
    # ingest, track and project (piece 8): 20 and 21
    add("ingest", 1, "a node is live for the ingest when it has a record, a title and no tombstone marker", "not seen by a dump until piece 4 runs the ghost-folder fixture; what the ingest does with the ghost is a command's effect, and a difference in the dumps would be a finding to look at.")
    add("ingest", 2, "`positionsEqual` compares two sorted lists", "seen by a dump as the ids of a reused link's `position` props: kept in the new side, minted again in the reference.", m_position_prop_ids)
    # the sweeps and the service lifecycle (piece 10): 22 to 27
    add("sweeps", 1, "an `update` of a thread node alone reaches `.state/`", "not seen by a dump: a stale `.state/` file of the reference is a literal that differs, which a dump cannot tell from an ordinary difference; piece 4 pins it with a command and the text it wrote.")
    add("sweeps", 2, "the sweeps are the engine's, and a stale unfold is no longer swept", "seen by a dump as an `unfolds` entry that only the new side holds and that names no node.", m_stale_unfold)
    add("sweeps", 3, "a refused start says why at once", "not seen by a dump: the time and the text of a refused start.")
    add("sweeps", 4, "the start-anyway option and the side copy", "seen by a dump as a `<file>.rejected-<stamp>.json` file that only the new side holds.", m_rejected_copy)
    add("sweeps", 5, "a reload loads once and frees the old handle", "not seen by a dump: the reload's result (`freedGraphs`) and its timing.")
    add("sweeps", 6, "the dangling ids are logged", "not seen by a dump: a warning in the log.")
    # the engine follow-up: 28
    add("follow-up", 1, "a document key the kind does not declare is refused even with an empty array", "not seen by a dump: a load that refuses; the dumps of a run that started hold no such key.")
    return {x.key: x for x in e}


MATCHERS = _table()
LABELS = {"flip": "Flip", "order": "Order", "ingest": "Ingest", "sweeps": "Sweeps", "follow-up": "Follow-up"}


# --------------------------------------------------------------------------------------------------------------------- the comparison

class Result:
    def __init__(self):
        self.diffs = []
        self.claims = []      # (Diff, key)
        self.findings = []    # (Diff, why)
        self.seen = {}        # key -> number of differences claimed
        self.counts = {}
        self.problems = []
        self.table_rows = []

    @property
    def unexpected(self):
        return len(self.findings) + len(self.problems)

    def not_seen(self):
        return sorted(k for k in MATCHERS if k not in self.seen)

    def not_seen_by_a_dump(self):
        return sorted(k for k, m in MATCHERS.items() if not m.by_dump)


def rejected_tokens(dump_dir):
    """{token: the most raw documents with that id in one `<file>.rejected-<stamp>.json` copy of a dump} (what the new side's load skipped)."""
    out = {}
    for root, _, names in os.walk(dump_dir):
        for name in names:
            if not REJECTED_COPY.search(name):
                continue
            try:
                with open(os.path.join(root, name), encoding="utf-8") as h:
                    docs = json.load(h)
            except (OSError, ValueError):
                continue
            here = {}
            for d in docs if isinstance(docs, list) else []:
                if isinstance(d, dict) and isinstance(d.get("@id"), str):
                    t = token_of(d["@id"])
                    here[t] = here.get(t, 0) + 1
            for t, n in here.items():
                out[t] = max(out.get(t, 0), n)
    return out


def apply_matchers(result, ctx):
    for d in result.diffs:
        hits = []
        for key, m in MATCHERS.items():
            if m.fn is not None and m.fn(d, ctx):
                hits.append(key)
        for key, fn in explain.EXTRA_DUMP:
            if fn(d, ctx):
                hits.append(key)
        if len(hits) == 1:
            result.claims.append((d, hits[0]))
            result.seen[hits[0]] = result.seen.get(hits[0], 0) + 1
        elif not hits:
            result.findings.append((d, "no entry of Layer 4 matches it"))
        else:
            result.findings.append((d, "claimed by more than one entry: %s" % ", ".join(str(h) for h in hits)))


def compare_dumps(ref_dir, new_dir, snapshot=None, commands=None, migrate=True, tools=None, roots_ref=(), roots_new=(), logs=None, artifacts=None):
    """Compare two dumps (two `Apeiron` directories). `snapshot`: a graph root or `Apeiron` directory (the ids it holds are the same on both sides).
    `commands`: the list `load_commands` gives. `logs`: the two services' logs as (reference text, new text). `artifacts`: the roots of the two sides' artifacts as
    {"ref": dir, "new": dir}. -> Result."""
    result = Result()
    scratch = None
    try:
        if migrate:
            ref_dir, scratch = migrate_reference(ref_dir, tools or SCRIPTS)
        rfiles, rextra = read_dump(ref_dir)
        nfiles, nextra = read_dump(new_dir)
        ref, new = Side("ref", rfiles, rextra), Side("new", nfiles, nextra)
        result.problems += ref.problems + new.problems
        snap = snapshot_tokens(snapshot) if snapshot else set()
        snap |= ref.mentioned & new.mentioned
        ref.snapshot_tokens = new.snapshot_tokens = snap
        pair_documents(ref, new)
        if commands:
            map_printed(ref, new, commands, snap, result.diffs)
        rdocs = {}
        for fid in ref.top:
            d = norm_document(ref, snap, fid)
            d.cid = ref.canon(fid, snap)
            rdocs[d.cid] = d
        ndocs = {}
        for fid in new.top:
            d = norm_document(new, snap, fid)
            d.cid = new.canon(fid, snap)
            ndocs[d.cid] = d
        pair_embedded(rdocs, ndocs, ref, new, snap, result.diffs)
        # the labels of the embedded entries are known now: the canonical ids inside the documents are final
        for side, docs in ((ref, rdocs), (new, ndocs)):
            assign_embedded_cids(side, snap, docs)
        # the files
        for name in sorted(set(rfiles) ^ set(nfiles)):
            result.diffs.append(Diff("file", "only-ref" if name in rfiles else "only-new", file=name))
        for name in sorted(set(rextra) ^ set(nextra)):
            result.diffs.append(Diff("file", "only-ref" if name in rextra else "only-new", file=name))
        for cid in sorted(set(rdocs) | set(ndocs)):
            r, n = rdocs.get(cid), ndocs.get(cid)
            if r is None:
                result.diffs.append(Diff("doc", "only-new", file=n.file, kind=n.kind, id=cid, new=n.kind, new_id=n.raw_id))
            elif n is None:
                result.diffs.append(Diff("doc", "only-ref", file=r.file, kind=r.kind, id=cid, ref=r.kind, ref_id=r.raw_id))
            else:
                compare_documents(r, n, result.diffs)
        removed = {ref.canon(a, snap) for c in (commands or []) if (c.get("argv") or [""])[0] == "remove" for a in c["argv"][1:] if not a.startswith("--")}
        ctx = Context(rdocs, ndocs, snap, rejected=rejected_tokens(new_dir), sides=(ref, new), artifacts=artifacts, removed=removed)
        pre = []
        if commands:
            compare_outputs(ref, new, commands, snap, roots_ref, roots_new, result.diffs, pre, ctx)
        if logs:
            lclaims, lfindings = explain.explain_logs(logs[0], logs[1], roots_ref, roots_new)
            for side, line, keys in lclaims:
                for key in keys:
                    pre.append((Diff("log", "explained", ref=line if side == "ref" else None, new=line if side == "new" else None), key))
            for side, line in lfindings:
                result.diffs.append(Diff("log", "only-" + side, ref=line if side == "ref" else None, new=line if side == "new" else None))
        apply_matchers(result, ctx)
        for d, key in pre:
            result.claims.append((d, key))
            result.seen[key] = result.seen.get(key, 0) + 1
        result.counts = {"ref documents": len(rdocs), "new documents": len(ndocs), "paired minted documents": sum(1 for v in ref.labels.values() if v.startswith("~") and not v.startswith("~e") and not v.startswith("~p")),
                         "snapshot tokens": len(snap), "commands": len(commands or [])}
    finally:
        if scratch:
            shutil.rmtree(scratch, True)
    return result


# --------------------------------------------------------------------------------------------------------------------- report and command line

def report(result, out=sys.stdout, verbose=False):
    w = out.write
    w("%-4s %-10s %-72s %s\n" % ("#", "Layer 4", "entry", "state"))
    for key, m in MATCHERS.items():
        state = ("seen x%d" % result.seen[key]) if key in result.seen else ("not seen" if m.by_dump else "not seen by a dump")
        w("%-4d %-10s %-72s %s\n" % (key, "%s %d" % (LABELS[m.group], m.number), m.title[:72], state))
    extra = [k for k in explain.EXTRA if k in result.seen]
    if extra:
        w("also claimed (Layer 4's unnumbered list, notes and proposals): %s\n" % ", ".join("%s x%d" % (k, result.seen[k]) for k in extra))
    w("counts: %s\n" % ", ".join("%s %s" % (v, k) for k, v in result.counts.items()))
    w("claimed by an entry: %d; entries seen: %d of %d; entries a dump can show and not seen: %s; not seen by a dump: %d\n" % (
        len(result.claims), len([k for k in result.seen if k in MATCHERS]), len(MATCHERS), [k for k, m in MATCHERS.items() if m.by_dump and k not in result.seen], len(result.not_seen_by_a_dump())))
    if verbose:
        for d, key in result.claims:
            w("  claimed by %s: %s\n" % (key, d.describe()))
    for p in result.problems:
        w("PROBLEM: %s\n" % p)
    for d, why in result.findings:
        w("FINDING (%s): %s\n" % (why, d.describe()))
    w("UNEXPECTED differences: %d\n" % result.unexpected)


def result_json(result):
    return {"unexpected": result.unexpected, "counts": result.counts, "problems": result.problems,
            "findings": [{"why": why, **d.as_json()} for d, why in result.findings],
            "claims": [{"entry": key, **d.as_json()} for d, key in result.claims],
            "seen": {str(k): v for k, v in sorted(result.seen.items(), key=lambda kv: str(kv[0]))},
            "notSeen": result.not_seen(), "notSeenByADump": result.not_seen_by_a_dump()}


def parse_args(argv):
    p = argparse.ArgumentParser(prog="compare.py", description="Compare the two dumps of a differential run.")
    p.add_argument("--run", help="the output directory of a harness run (dumps/ref/Apeiron, dumps/new/Apeiron, results.json, commands/)")
    p.add_argument("--ref", help="the reference's dump (an Apeiron directory)")
    p.add_argument("--new", help="the new side's dump (an Apeiron directory)")
    p.add_argument("--snapshot", help="the snapshot the run started from: a graph root or its Apeiron directory (default with --run: the one results.json names)")
    p.add_argument("--tools", default=SCRIPTS, help="the directory that holds migrate-mirror.py (default: the directory above this one)")
    p.add_argument("--no-migrate", action="store_true", help="the reference's dump is already in the new form")
    p.add_argument("--no-outputs", action="store_true", help="do not compare the commands' status, stdout and stderr")
    p.add_argument("--json", help="write the findings, the claims and the entries seen to this file")
    p.add_argument("-v", "--verbose", action="store_true", help="list the differences the entries claimed")
    return p.parse_args(argv)


def main(argv=None):
    try:
        args = parse_args(argv)
    except SystemExit as e:
        return 2 if e.code else 0
    if (args.run is None) == (args.ref is None and args.new is None) or (args.run is None and (args.ref is None or args.new is None)):
        print("usage error: give --run <dir>, or both --ref and --new", file=sys.stderr)
        return 2
    commands, snapshot, roots_ref, roots_new = None, args.snapshot, (), ()
    try:
        if args.run:
            out = os.path.abspath(args.run)
            ref_dir, new_dir = os.path.join(out, "dumps", "ref", "Apeiron"), os.path.join(out, "dumps", "new", "Apeiron")
            if not (os.path.isdir(ref_dir) and os.path.isdir(new_dir) and os.path.isfile(os.path.join(out, "results.json"))):
                print("usage error: %s holds no run (dumps/ref/Apeiron, dumps/new/Apeiron and results.json)" % out, file=sys.stderr)
                return 2
            cmds, results = load_commands(out)
            commands = None if args.no_outputs else cmds
            snapshot = snapshot or results.get("snapshot")
            roots_ref, roots_new = (os.path.join(out, "ref"),), (os.path.join(out, "new"),)
        else:
            ref_dir, new_dir = args.ref, args.new
            for d in (ref_dir, new_dir):
                if not os.path.isdir(d):
                    print("usage error: %s is not a directory" % d, file=sys.stderr)
                    return 2
        if snapshot and not os.path.isdir(snapshot):
            snapshot = None
        result = compare_dumps(ref_dir, new_dir, snapshot=snapshot, commands=commands, migrate=not args.no_migrate, tools=args.tools, roots_ref=roots_ref, roots_new=roots_new)
    except Failure as e:
        print("FAILED: %s" % e, file=sys.stderr)
        return 1
    report(result, verbose=args.verbose)
    if args.json:
        with open(args.json, "w", encoding="utf-8") as h:
            json.dump(result_json(result), h, indent=2, ensure_ascii=False)
            h.write("\n")
    return 1 if result.unexpected else 0


if __name__ == "__main__":
    sys.exit(main())
