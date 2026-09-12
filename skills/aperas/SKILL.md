---
name: aperas
description: Working directly with the Apeiron knowledge graph via the `aperas` CLI — the graph is the source and the `.md` files under `artifacts/` are projections of it, so every change goes through the CLI rather than a file edit. Covers traversal-first reading (deep read/deep write/dense linking), the edit loop, citation direction, staging, wikilink and anchor syntax, renaming, and the current tool gaps. Use this whenever work touches the AperasKG graph in any way — editing/updating/inserting/removing/renaming a node, adding a wikilink, or any mention of `aperas`/`kg:` commands in this project — even if the user doesn't name the skill. Read this before `kg-doc-ingest`, which covers getting existing text *into* the graph.
---

# aperas

Status: **v1** — restructured from a flat, incident-ordered list of eighteen items into four levels, abstract to concrete. Content is unchanged except where marked superseded; the arrangement was the defect. Concern docs: `AperasKG/artifacts/{design,issues,planning,history,discussion}/aperas-skill.md`.

> **Aperas-repo insiders**: `aperas` isn't published yet. Every command below (`aperas <verb> ...`) actually runs today as `npm run aperas -- <verb> ...` from `Aperas/monorepo/`. **Delete this note once `aperas` ships as a real installed binary** (see `AperasKG/artifacts/issues/packaging.md`'s Pending Tasks — the `bin` build).

## How to read this

Four levels, each following from the one above:

1. **Philosophy** — what the graph *is*. Everything else is a consequence.
2. **Orientation** — what reading and writing *mean* here.
3. **Discipline** — how to behave once oriented.
4. **Mechanics** — how to type it.

Read top-down. Stopping after Orientation should already leave you acting correctly in the ordinary case; starting at Mechanics gives you a list of gotchas with nothing to hang them on. An item sits at the level that explains *why* it is true, not the level where it was first noticed.

Each item is marked **[current]**, **[superseded]** (the cause has since been removed — kept so the old advice isn't re-derived), or **[unverified]** (described, not yet confirmed live).

### Scope

This skill owns *working the graph*. `kg-doc-ingest` owns *getting existing text into it* — tracking, ingesting, round-trip verification. Anything that is a fact about this project rather than about the tooling belongs in a concern doc under `AperasKG/artifacts/`, which this skill only points at.

Note the boundary is by subject, not by timing: a genuinely new document needs no disk authoring at all (see *Sketching a structure*, Mechanics). What is ruled out is authoring a *finished* document on disk and reconciling it back in.

---

## 1. Philosophy

**The Apeiron is the source; the `.md` files under `artifacts/` are shadows it casts.** [current]

A projection can be regenerated from the graph at any time. It is never the place a change is made. Editing a projection to change the graph is mistaking the shadow for the thing casting it — and it can appear to work, because the file looks right afterwards, while the source is untouched or gets reconciled back into a shape nobody chose.

The graph's substance is nodes *and the links between them*. A node's meaning is not carried by its own text alone; it is constituted by what it links to, what links back, and where it sits among its siblings and its thread.

Every rule below is downstream of this. "Graph-first, always" is its first consequence, not an independent instruction.

**Worked example — the same task, both ways.** Asked whether two docs cross-referenced each other, one session reached for `grep` over the projected `.md` files plus a raw `BlockNode.jsonld` read. It took several steps, produced an answer, and still had to be redone — because the question was about link structure, which exists in the source and only *appears* in the shadow. Redone properly it was one command:

```bash
aperas backlinks BlockNode:00CE1GW638007 --text
# → "No backlinks found."
```

That is the whole answer, from the source, in one call. Searching projections for structure that only exists in the graph is the same category error as editing them — one level down.

---

## 2. Orientation

**Traversal is the primary mode of work, not a check appended to it.** [current] Reading means following links; writing means placing them.

`archive/Aperas-design.md`'s Multi-Agent Projection Pattern names these as the architecture's own capabilities. They are crystallized practice rather than theory — but the practice predates this system, coming from years of real knowledge-graph work in Logseq and carried in as design instead of being rediscovered here. That this system has barely exercised them yet is a fact about its infancy, not their standing.

### Deep read runs in two directions

They answer different questions, and the tool surface already carves them apart:

- **Forward and downward — deeper *content*.** A block's children and its outgoing links: what it is made of and what it refers to. This is what an ordinary read wants, and it is why `aperas unfold <ref>` previews children *and* forward links together — both are content, in the same sense.
- **Backward — deeper *context*.** Who depends on this block, who cites it, what surrounds it. `aperas backlinks <id> --text` stands alone as a command because it is the other axis. Reach for it when the decision is harder than reading: editing, or an investigation whose scope has widened.

**Deep write is inherently backward.** [current] What a change breaks is only answerable from the citing side. Updating a block means checking its backlinks and forward links and updating what the change has made stale — not leaving them to rot.

**Dense linking is the precondition for both.** [current] Everything related gets linked, directly (A references B) or indirectly (a discussion node that talks about both). A sparsely linked graph gives deep read nothing to descend into and deep write nothing to follow. Linking is constitutive here, not tidiness.

**Keep an active view, and keep it current.** [current] Set one up once:

```bash
aperas profile create <handle> --name "<Display Name>"
aperas profile create-view <name> --profile <handle>
```

Then `aperas unfold <path> --view <name> --flush` whatever you are working on *as* you start it, `aperas tree --view <name>` to render that lens, `aperas fold` to collapse a subtree again, and plain `aperas tree --depth <n>` (no `--view`) for a skeletal title-only map of the whole corpus.

A view created early and never touched again still answers `aperas tree --view <name>`, showing whatever was unfolded during a previous task, with nothing warning you it is stale — worse than no view, because it looks current without being current.

**Worked example — a traversal, start to finish.**

```bash
aperas unfold BlockNode:00CE0HD0HG007 --view my-view --flush
# → the block's own text, plus each forward link previewed:
#   │ ...Link... [[wikilink]] → BlockNode:00CE1GW638002  ## Open Issues  [+6]
aperas unfold BlockNode:00CE1GW638002 --view my-view --flush
# → that heading's children, one of which is the block actually being looked for
```

Two commands, each one hop. The content axis, followed until it arrives.

---

## 3. Discipline

### The edit loop

The shape of nearly every real task:

1. **Orient before touching anything — content first, context when the decision is hard.** Start with `aperas unfold <ref>` for children and forward links. Escalate to `aperas backlinks <id> --text` for context. Editing always qualifies, because step 5 cannot work without it.
2. **Locate the smallest block that actually changed.** [current] Not the artifact, not the enclosing heading: the leaf whose content is wrong. `aperas update`/`aperas insert` work at any level, and targeting something larger means hand-reconstructing every unchanged sibling exactly — where one transcription slip silently tombstones that block and mints a fresh id in its place. **Never reconstruct by copying from an already-*projected* file**: it has anchor tags spliced in that are a projection artifact, not content, and piping them back bakes them into the block's stored text as prose.
3. **Edit graph-first.** [current] Pipe replacement content to `aperas update <id>`; `aperas insert` for genuinely new content; a stdin-less `insert` to *move* a node rather than recreate it. Never a direct edit of the file on disk followed by re-ingesting — that is `kg-doc-ingest`'s disk-first direction, correct only for text not yet in the graph. (Caught live by direct user callout: doing this once for a wikilink fix, then having to redo it through `aperas update` to actually fix the workflow.)
4. **Verify by traversal, not by the summary line.** [current] A reconcile count reports what the command *believes* it did. Proof is a backlink that actually resolves, or `aperas project <path> --dry-run` where the content is actually visible. A push can silently match new content onto an already-tombstoned node's id without reviving it, so it stays invisible while the summary reports it as added — caught live when a Resolved section rendered one fewer bullet than was pushed.
5. **Deep write — follow what the change made stale.** Check backlinks and forward links; update what now disagrees.
6. **Project, then stage.** `aperas project <path> --flush`, then `git add` immediately.

### Stage each verified step

[current] After a step lands clean, `git add` it — in both the code repo and `AperasKG/`. The index becomes a running checkpoint: if a later step goes wrong, `git restore`/`git diff` against it recovers cleanly. **Staging only, never committing** — `git commit` stays the user's call. Pass `--flush` on the mutating call you are about to stage, not just at the end of a sequence; the service's own flush timer can otherwise land *after* a `git add`, leaving the index holding stale content.

This is not bookkeeping. Recovering a live incident that tombstoned real content was only possible because the prior step had actually been staged.

### Write discussion before executing, not after

[current] Once a plan is settled — even just agreed in chat, even a "yes, do it" — write it into the relevant `discussion` doc *before* starting, for any nontrivial multi-step change. The conversation a plan lives in can be compacted or cut off at any point, and a plan that only ever existed as chat turns is gone the moment that happens, with no way to resume or hand it off from what is on disk. Caught live once: a 3-way workspace split authorized in chat with nothing written down.

Treat the discussion doc as a scratchpad, not something to write only once resolved. Freeflow raw investigation notes into it as you go — inventory findings, open questions, a "not yet decided" list. That is what protects the work if context is lost mid-*investigation*, not just mid-plan.

### Move a node; don't remove and recreate it

[current] `aperas insert <node-id> --after/--before <anchor>` with **no stdin piped** repositions that exact node — the anchor's current parent becomes its new parent, cross-parent moves included. It preserves the id, every backlink to it, and its place in history.

Reach for remove+insert only when the wording is changing enough that it is genuinely not the same item any more — and even then, a move followed by a separate `--text-only` edit keeps the id while changing only what actually changed. Caught live getting this backwards: promoting two findings into a new section via `remove` + `insert` left two needlessly tombstoned orphans behind, for a relocation a plain move would have handled with zero churn.

### Citation direction

[current] The concerns form an abstraction gradient — `design` most abstract, `discussion` least, `issues`/`planning`/`history` between. A citation may point **up** the gradient or **sideways** freely. It may not point **down**: a design block does not reference a discussion block, for the same reason a node carries a parent pointer rather than a list of children.

The one sanctioned exception is a designated index — a design doc's own `# Context` section, which exists precisely to index its concern's other facets, one link each. That is a single structurally-privileged reference, not citations scattered through the body.

### Discussion is where meta-info is born

[current] Not a sink for what didn't fit elsewhere. `discussion` is the Apeiron-equivalent concern: unbound, schema-free, where every comment, assertion and reasoning trace originates before anything is decided about where — or whether — it belongs elsewhere. `design`/`issues`/`planning`/`history` are Peras: typed projections that specific *kinds* of content get promoted into, once a dedicated home for that kind has actually been designed. Most things never need promoting at all.

So something surfacing mid-task that isn't what the task is about — an engine bug found while migrating docs, say — starts in *this* task's discussion doc and stays there for as long as no dedicated home exists, possibly indefinitely. The test is not "is there an existing doc this could plausibly belong to" but "has a dedicated home for this actually been designed yet". Confirmed wrong live: two parser bugs were filed straight into `issues/packaging.md` on the assumption a finding needs an immediate formal home — wrong twice over, since packaging wasn't even the right eventual concern, and since reaching for promotion skipped the point of having a discussion sink at all.

See `design/documentation.md` for the concern taxonomy and the Freeflow document shape (an unbounded *list*, not a growing set of headings).

---

## 4. Mechanics

This section describes the usage of the `aperas` CLI. For detailed syntax, see `aperas --help` and `aperas <verb> --help`.

### Paths

[current] Paths passed to `aperas project`/`ingest`/etc. resolve relative to the graph's `artifacts` root defined in `aperas.config.json`, e.g., `discussion/foo.md` relative to `AperasKG/artifacts/`, **not** the repo-relative `AperasKG/artifacts/discussion/foo.md` that `git status` and `find` print. The repo-relative form fails with "No ingested ArtifactNode or FolderNode found".

### Wikilink syntax

[current] The resolver only recognizes a URL that is `[[code]]`, starts with `aperas://tree/` or `aperas://id/`, or contains a bare `#fragment`/`path#fragment`. A plain `../folder/file.md/Slug` reference (no `#`) renders fine as prose but is **not** a graph `Link` — `aperas backlinks` on it comes back empty. Use `[title](../folder/file.md#id/BlockNode:<ID>)`.

Verify with `aperas backlinks BlockNode:<ID> --text` against the specific target block, not the whole-document path. Do not trust a command's own reported link-resolution count; a real backlink appearing is the proof. A link written without a `#fragment` silently creates nothing at all, and the ingest summary will not mention it.

### Anchor placement — the bold-colon rule

[current] A list item's lead-in colon must sit *outside* any bold span: `**Term**:`, never `**Term:**`. A bold-wrapped colon is rejected by the lead-in detector, so anchor insertion falls through to the next plain-text colon it finds — which can splice an anchor into the middle of unrelated text, such as a link's own title.

### Sketching a structure

[current] A new heading or subtree can be built directly in the graph, with no disk authoring: create a placeholder node with `aperas resolve --create-holder <path> --titles <title> [<title>...]`, then *fill* the real content in with `aperas update` and `aperas insert`. This is why a genuinely new document never requires the disk-first path.

### `--after`/`--before` anchors

[current] The anchor must be a **direct child** of `<path>`, not a descendant. `aperas insert <path> --after <anchor>` fails with "anchor is not a child of X" otherwise. A heading's own text and its nested list are two different levels. Check the real structure first — `aperas tree --depth <n>`, or `scripts/show_node.py --children <ref>` — rather than guessing.

Be aware this failure is not clean: the new nodes are hydrated into the store *before* the anchor is validated, so a rejected insert leaves live orphans in memory that can collide with your retry. `aperas reload -- --discard` clears them.

### Updating a heading — `--text-only`

[current] A heading-target `update` **without** `--text-only` reconciles children too, even from an empty body: piping just `## Pending Tasks` with no body reconciles 0 piped children against N existing ones as *all removed*, tombstoning real content. `--text-only` overwrites just `.text`/`.title` and skips reconciliation entirely — that is what makes a retitle safe.

### Adding an item to an existing list

[current] Target the list's **parent heading** — `aperas update <heading-id>` — and pipe the heading line plus the *complete* corrected list, every existing item verbatim plus the new one. Exact-key matching reuses every unchanged item's id (`N matched`, only the new one `added`).

**This only works if the piped content is genuinely complete.** Piping the heading plus *only* the new item reconciles the existing ones away as removed. Hit live on a 4-link Dashboard expecting a one-line addition: the actual summary was `0 matched, 0 added, 5 removed`.

For an **ordered** list this is the only safe route, because a freshly inserted item becomes its own run-leader and can restart the numbering rather than continuing it.

For an unordered list, `aperas insert <parent> --after <existing-item>` piping a bare `- item` line is safe. [superseded — was previously unsafe] It used to create a nested list-in-list; the list-consumption migration removed every live `list`-typed node, so there is no longer a list node to mistakenly target. The old create-and-promote recovery dance — `aperas insert <item-id> --after <existing-direct-child-of-the-list>` to promote the real item out, then `aperas remove` the emptied wrapper — is therefore only needed for pre-existing warts, not new work.

Two input rules still apply: pipe the bare content, **never** the ordinal marker (a leading `3.` alone makes the parser read it as a fresh list), and **never** plain text with no bullet marker (it parses as a `paragraph`, breaking a contiguous run in two).

Known cosmetic consequence: a freshly inserted item carries its own explicit `orderedList`/`startIndex`, marking it a run-leader and rendering a spurious blank line before it. Not corruption — see `issues/list-consumption.md`.

### Renaming

[current] **One artifact**: `git mv old.md new.md`, then `aperas ingest <new-path> --track --flush` scoped to that concern set — not a full path-less sweep, which walks the entire `artifacts/` tree including `archive/` and can hit collisions in never-swept legacy content. Rename detection matches by exact abstract-text equality against tracked ArtifactNodes whose recorded path vanished. Don't trust the "N renamed" summary; confirm the ids actually survived at the new path.

A file rename touches no content. If the H1 needs retitling too, that is a separate `aperas update` on the H1 with `--text-only`.

**A set of cross-referencing docs**: do every content fix first — H1 retitles, cross-reference paths — *while the files are still at their old names*, verify, then `git mv` each. That way every call in the content-fixing phase resolves against paths that still exist, and the rename becomes a purely mechanical last step.

### Shell quoting

[current] A piped `echo "..."` silently drops nested double quotes — that is bash, not `aperas`. Bash closes the outer string at the first inner `"` and reopens after it, dropping both marks with no error from anything. Caught live: `not merely "wherever convenient"` had silently become `not merely wherever convenient`. Write content containing double quotes to a file first and `cat` it in.

### Service state

[current] `aperas service restart` flushes and reloads from the on-disk mirror — the clean way to confirm what you think landed actually did. `aperas reload -- --discard` throws away in-memory state and re-reads disk, which is the recovery when a failed call has left orphans behind.

If the service has died, an unflushed mutation is gone. Flushing per step (above) is what makes this survivable.

### Inspecting raw node state

[current] `aperas tree`/`backlinks --text`/`unfold` all show a *rendered preview* — title plus truncated, anchor-stripped abstract. For a field they never show (`props`, `tombstonedAt`) or for a block's exact stored text, use the bundled reader rather than writing another one:

```bash
scripts/show_node.py <ref>                 # full record: props, tombstonedAt, parent, children, links
scripts/show_node.py --text <ref>          # exact stored text, undecorated
scripts/show_node.py --children <ref>      # direct children, tombstoned ones marked
scripts/show_node.py --grep PATTERN [-i]   # full-text search — there is no `aperas search`
scripts/show_node.py --artifact <ref>      # which artifact a block lives in
```

Refs take a bare snowflake or a full id. It is read-only, and it locates `AperasKG/Apeiron/` itself.

`--text` is the one that matters before an edit: redirect it to a file, change only what needs changing, and `cat` that back into `aperas update`. That keeps the untouched part of a block byte-identical instead of retyped from a preview — which is what step 2 of the edit loop warns about, since a transcription slip silently tombstones the block and mints a new id.

This is a staging area, not the fix: the real gap is tracked in `issues/treeview.md` ("No raw single-node inspection command"), whose proposed resolution is an `aperas show <ref>` verb. `--children` marking tombstones is likewise standing in for `unfold`'s missing marker.

Specifically, **`unfold` does not mark tombstoned children** while `tree --view` appends `(tombstoned)`, so a tombstoned leftover can read as live data under `unfold`. Tracked in `issues/treeview.md`.

### Full-text search — grep the raw store directly

[current] `show_node.py --grep` works, but a plain `grep -n -C3 '<pattern>' AperasKG/Apeiron/BlockNode.jsonld` is faster and shows more: one command, the complete untruncated `text` (the script's own preview caps at 90 chars), and it also works over `ArtifactNode.jsonld` for an artifact's own title/abstract — which `--grep` never scans, since it only iterates blocks. This is not the shadow-grepping mistake the Philosophy example warns about: `Apeiron/*.jsonld` is the on-disk mirror of the graph itself, not the rendered `artifacts/*.md` projection, so grepping it is reading the source, not the shadow.

A hit is a candidate id, not proof of anything. Confirmed live: a node's field order is `@id, @type, [props], [tombstonedAt], title, text, parent, type, children`, and `props` is variable-length — so `tombstonedAt`'s distance from a `text` match shifts per node, and no fixed `-C<n>` window can be trusted to surface it. Treat every match as an id to hand to `aperas` (`unfold`/`tree`/`backlinks --text`) for the actual live/tombstoned status, parent, and links: grep finds the nodes, `aperas` deals with them.

---

## Reference

- `AperasKG/artifacts/design/linking.md` — canonical spec for addressing, anchors and wikilink syntax. Read it when a link isn't resolving and the reason isn't obvious.
- `AperasKG/artifacts/design/documentation.md` — the concern taxonomy and the Freeflow document shape.
- `AperasKG/artifacts/design/aperas-skill.md` — this skill's own design: the four levels, citation direction, and how items enter (incident → freeflow → confirmed → promoted to the level that explains it).
- `archive/Aperas-design.md` — the founding philosophy: Apeiron/Aperas/Peras, deep read and deep write, Meta-Aperas.

### Open tool gaps

Tracked in the graph rather than accumulating here: raw single-node inspection and `unfold`'s missing tombstone marker (`issues/treeview.md`); non-transactional writes leaving in-memory orphans, and `extractAnchorNames` treating a quoted example anchor as a real name claim (`discussion/aperas-skill.md`).
