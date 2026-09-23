---
name: aperas
description: >-
  Before anything else in this project — first turn, every session, whatever the task looks like,
  including when it looks unrelated, trivial, read-only, or like one quick lookup — check memory
  for a standing decision on whether Aperas manages this session. Do this without loading this
  skill, and never ask permission to do it or offer it as an option; just do it. If a decision
  is recorded, follow it. If none is, ask with AskUserQuestion using exactly these choices —
  Never / Not now / Yes, this session only / Yes, all sessions — and record only 'all sessions'
  or 'never' durably, so a session-scoped answer is asked again next session. Load this skill
  only once the answer is yes; it then governs the work — orient in the graph before acting,
  change it through the CLI rather than by editing files, put back what the work turns up.
  Aperas is this project's external memory: a knowledge graph, worked through the `aperas` CLI,
  holding what has been decided, tried, found and planned. For first-time ingest of existing
  documents, `kg-doc-ingest` covers that; this one first.
---

# aperas

Status: **v2.10** — four levels, Philosophy through Mechanics, each item explaining a consequence of the one above it. Only current, verified items appear here; superseded material, unverified hypotheses and version-by-version rationale live in `discussion/aperas-skill.md`'s snapshot and deltas. Concern docs: `AperasKG/artifacts/{design,issues,planning,history,discussion}/aperas-skill.md`.

> **Aperas-repo insiders**: `aperas` isn't published yet. Every command below (`aperas <verb> ...`) actually runs today as `npm run aperas -- <verb> ...` from `Aperas/monorepo/`. **Delete this note once `aperas` ships as a real installed binary** (see `AperasKG/artifacts/issues/packaging.md`'s Pending Tasks — the `bin` build).

## How to read this

Four levels, each following from the one above:

1. **Philosophy** — what the graph *is*. Everything else is a consequence.
2. **Orientation** — what reading and writing *mean* here.
3. **Discipline** — how to behave once oriented.
4. **Mechanics** — how to type it.

Read top-down. Stopping after Orientation should already leave you acting correctly in the ordinary case; starting at Mechanics gives you a list of gotchas with nothing to hang them on. An item sits at the level that explains *why* it is true, not the level where it was first noticed.

Everything here is current and confirmed live. A rule whose cause has since been removed, and one identified but not yet verified, both belong in `discussion/aperas-skill.md` rather than here — a caution you cannot act on costs the reader and buys nothing.

### Scope

This skill owns *working the graph*. `kg-doc-ingest` owns *getting existing text into it* — tracking, ingesting, round-trip verification. Anything that is a fact about this project rather than about the tooling belongs in a concern doc under `AperasKG/artifacts/`, which this skill only points at.

Note the boundary is by subject, not by timing: a genuinely new document needs no disk authoring at all (see *Sketching a structure*, Mechanics). What is ruled out is authoring a *finished* document on disk and reconciling it back in.

---

## 1. Philosophy

**The Apeiron is the source; the `.md` files under `artifacts/` are shadows it casts.**

A projection can be regenerated from the graph at any time. It is never where a change is made, and never where a question is answered. Both failures look identical from outside — the file reads right — which is why neither announces itself.

Change it and you have mistaken the shadow for the thing casting it: the file looks correct afterwards, while the source is untouched or gets reconciled back into a shape nobody chose. Read it and you get a block's words and none of its place — not what cites it, not what it rests on, not whether it is still live — and the loss is invisible precisely because the words really are the same. Ask it about *structure* and you get nothing at all, since links exist only in the source.

The graph's substance is nodes *and the links between them*. A node's meaning is not carried by its own text alone; it is constituted by what it links to, what links back, and where it sits among its siblings and its thread.

Every rule below is downstream of this. "Graph-first, always" is its first consequence, not an independent instruction.

**Aperas is an evidence-based documentation system: a claim and its provenance are one object.** This follows directly from the sentence above. If a node's meaning is constituted by what it links to and what links back, then a claim whose source is not reachable from it is not a weaker entry — it is a different kind of thing, an assertion wearing the costume of a record. It reads as complete from its own side, passes every mechanical check the tooling can run, and fails the only question the graph exists to answer: *how do you know?*

`archive/Aperas-design.md` builds its whole read side on this, defining deep read as provenance projection — "every rendered element retains provenance anchors and backlinks, allowing readers to drill down into the supporting evidence subgraph." The link may sit at either end: a forward citation where *Citation direction* (Discipline) permits one, a backlink from the source where it does not. One of the two must exist before the claim is left in place, not after.

**That substance matures; it does not merely accumulate.** Both axes run the same direction — Apeiron toward Peras, unbounded toward bounded. On the **content** axis, prose hardens from formless discussion into typed design, issues, planning, history. On the **topology** axis, a relationship first exists *indirectly*, mediated by a discussion node that cites both ends and carries the judgment in its own text; once it proves load-bearing it crystallizes into a *direct* citation, and the mediating node's job is done. Link density is the residue of that lifecycle, which is why it reads as maturity from outside rather than as tidiness — and why `discussion` is where the cost of it gets paid.

**Nobody working this graph will remember.** Not the human across weeks, not the agent across a context window. So the graph is not only where things are kept — it is what *notices*: the structural gaps and the emergent alignments between nodes, neither of which anyone will spot by holding the corpus in their head. A record that has to be consulted to be useful protects nothing, because being asked is the part that fails: the moment you would know to check is the moment you have already forgotten. What earns its place is what interrupts unbidden — a check reporting an omission, a backlink appearing where none was expected, a query coming back zero. Storage is the easy half and the projections already do it; recall is the half that costs something to build and the half that works.

This is why a rule of the form "look it up instead of trusting your memory" is only half a discipline here. It can tell you what the graph says; it can never tell you the graph is *missing* something, because doing the work and recording the work are two separate acts and only the second one is visible from inside. Catching an omission takes a comparison against the world outside the graph. Confirmed live, three times in one session: each unrecorded edit was invisible from every side that could be consulted, and was caught by a reader noticing or by a check diffing the file against the record — never by looking something up.

**Worked example — the same task, both ways.** Asked whether two docs cross-referenced each other, one session reached for `grep` over the projected `.md` files plus a raw `BlockNode.jsonld` read. It took several steps, produced an answer, and still had to be redone — because the question was about link structure, which exists in the source and only *appears* in the shadow. Redone properly it was one command:

```bash
aperas backlinks BlockNode:00CE1GW638007 --text
# → "No backlinks found."
```

That is the whole answer, from the source, in one call. Read a concern through `aperas unfold`, not through the file that renders it.

---

## 2. Orientation

**Traversal is the primary mode of work, not a check appended to it.** Reading means following links; writing means placing them.

`archive/Aperas-design.md`'s Multi-Agent Projection Pattern names these as the architecture's own capabilities. They are crystallized practice rather than theory — but the practice predates this system, coming from years of real knowledge-graph work in Logseq and carried in as design instead of being rediscovered here. That this system has barely exercised them yet is a fact about its infancy, not their standing.

**An `artifacts/**.md` path in your hand is a node reference, not a file path.** This is the one mechanical test the skill has: if a path under `artifacts/` is about to become an argument to `Read`, `grep`, `find` or `cat`, the call is already wrong, and `aperas unfold <ref>` is what it meant. It holds for *reading*, not only for writing, and most of all when you are "just checking one thing" — which is how an entire investigation goes through the shadows without any single step feeling like a decision. Two things are deliberately not over the line: `Apeiron/*.jsonld` is the graph's own on-disk mirror, so grepping it is reading the source (see *Full-text search*, Mechanics), and source code is not in the graph at all.

### Deep read and deep write run along the same three directions

They answer different questions, and the tool surface already carves them apart:

- **Forward and downward — deeper *content*.** A block's children and its outgoing links: what it is made of and what it refers to. This is what an ordinary read wants, and it is why `aperas unfold <ref>` previews children *and* forward links together — both are content, in the same sense.
- **Upward — surrounding *context*.** A block's ancestors: the heading it sits under, the thread it belongs to. This is the cheapest move in the graph and the one most often skipped, because the pull it answers is the pull toward opening the whole artifact "for context" — and it almost never takes the whole artifact. For a node at `discussion/a.md/h1/freeflow/a/aa/aaa`, unfolding `discussion/a.md/h1/freeflow/a` is usually already enough. Climb a level at a time and stop once the block's meaning stops changing.
- **Backward — deeper *context*: dependents and sources.** `aperas backlinks <id> --text` stands alone as a command because it is the other axis, and two distinct relationships arrive through it. *Dependents* — what relies on this block, what breaks if it changes. *Sources* — what the block rests on, which is what makes a claim checkable; provenance surfaces here rather than among forward links whenever citation direction forbids the forward form, so a node with no backlinks may be not merely under-linked but unsupported. `archive/Aperas-design.md` keeps the two apart by operation instead, giving provenance to deep read and impact traversal to deep write.

Deep read takes the first two as a matter of course, and the third when the decision is harder than reading: editing, or an investigation whose scope has widened. **Deep write is inherently backward** — what a change breaks is only answerable from the citing side, so updating a block means checking its backlinks and forward links and updating what the change has made stale, not leaving them to rot.

**Dense linking is the precondition for both.** Everything related gets linked, directly (A references B) or indirectly (a discussion node that talks about both). A sparsely linked graph gives deep read nothing to descend into and deep write nothing to follow. Linking is constitutive here, not tidiness.

**A link is placed at the maturity the relationship has earned.** Writing means placing links, but not all of them direct and not all at once. A relationship that still needs judgment to state goes into a mediating discussion node citing both ends; one that has proven load-bearing becomes a direct citation between them. Reaching for a direct link too early asserts a dependency nobody has tested; leaving one mediated forever makes every traversal pay for the hop.

### Entering the corpus — two directions, and the gap is where they meet

The three directions above move *from* a node. Acquiring the first one is its own decision, and the corpus has a gradient of its own to move along: the concern docs run `design` most abstract and `discussion` least, with `issues`, `planning` and `history` between. Both directions along it are legitimate, and they do different jobs.

- **Top-down — frame, then zoom in.** `design/<concern>.md` for the settled shape, then `issues`/`history` for what is open and what already landed, then `discussion` for the reasoning trail, and only then the code. It narrows like a binary search, and what it buys is the frame: what the corpus *claims* about this area, and which facet you are actually in.
- **Bottom-up — pinpoint, then zoom out.** A concrete identifier — a source filename, a symbol, an error string — grepped against the store lands you on the exact node in one step, where a top-down descent would still be choosing among forty Freeflow items. Then climb by following that node's own **forward links**, which usually run up the gradient: a lower block cites the higher one it realizes, while a higher block points down only where it speaks normatively. So a downward link met on the way up is the higher tier governing the lower, not a route further down. **Backlinks** are that same relation from the other end — what cites *this* node — and are how a design block's realizers below are found. Ancestors climb within one artifact only: they recover the surrounding thread, not the statement that governs it.

Neither is a fallback for the other, and neither alone can find drift. **Drift is an absence as often as a contradiction — the design silent where the code has a rule, or asserting a rule the code has since replaced — and in both forms it is indistinguishable from agreement until both directions have been run and compared.** Descend only and you confirm the design; ascend only and you confirm the code, which is why a bottom-up fix is so often correct and still leaves the design a version behind. The finding is the discrepancy at the point the two meet, so a pinpointed node is not oriented until the climb has reached the tier that should govern it: for a code-shaped entry, upward does not stop when the block's meaning stabilizes — it stops at `design`.

Confirmed live, once in each direction. A lead-in-term title-extraction fix traced cold out of `astParser.ts` worked correctly and revealed nothing, while `design/linking.md`'s own Lead-In Term Detection — documenting two checks where the code has three — was stale in exactly the clause the fix depended on. In the same session the reverse: `design/aperas-skill.md`'s Citation direction, read top-down, asserted a rule its own projection had replaced thirteen versions earlier, and was quoted back as current.

```bash
grep -n 'astParser.ts' AperasKG/Apeiron/BlockNode.jsonld  # pinpoint → candidate ids
# a planning-tier hit cites the tier above it:
#   "see [Lead-In Term Detection](../design/linking.md#id/BlockNode:00CDBYV4TG000)"
aperas unfold BlockNode:00CDBYV4TG000                     # follow it up to design
# two checks documented, three in the code — that difference is the finding
```

### Keep an active view, and keep it current

Set one up once:

```bash
aperas profile create <handle> --name "<Display Name>"
aperas profile create-view <name> --profile <handle>
```

Then `aperas unfold <path> --view <name> --flush` whatever you are working on *as* you start it, `aperas tree --view <name>` to render that lens, `aperas fold` to collapse a subtree again, and plain `aperas tree --depth <n>` (no `--view`) for a skeletal title-only map of the whole corpus.

A view created early and never touched again still answers `aperas tree --view <name>`, showing whatever was unfolded during a previous task, with nothing warning you it is stale — worse than no view, because it looks current without being current.

### Worked example — a traversal, start to finish

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

### The loop

This is the shape of nearly every real task, not only the ones that reach an edit. **Three things put you in the loop:**

- **About to read a concern.** Traversal, not `Read`.
- **About to read or change source code this graph carries a concern about.** See *Source the graph already has a concern about*, below.
- **About to change the graph.** The steps below, in full.

The opening is the same in all three cases; only the tail differs. A traversal-only task ends after step 1, a source change ends by recording what it found, and a graph change runs the whole thing.

1. **Orient before touching anything — content first, context when the decision is hard.** Start with `aperas unfold <ref>` for children and forward links. Escalate to `aperas backlinks <id> --text` for context. Editing always qualifies, because step 5 cannot work without it.
2. **Locate the smallest block that actually changed.** Not the artifact, not the enclosing heading: the leaf whose content is wrong. `aperas update`/`aperas insert` work at any level, and targeting something larger means hand-reconstructing every unchanged sibling exactly — where one transcription slip silently tombstones that block and mints a fresh id in its place. **Never reconstruct by copying from an already-*projected* file**: it has anchor tags spliced in that are a projection artifact, not content, and piping them back bakes them into the block's stored text as prose.
3. **Edit graph-first.** Pipe replacement content to `aperas update <id>`; `aperas insert` for genuinely new content; a stdin-less `insert` to *move* a node rather than recreate it. Never a direct edit of the file on disk followed by re-ingesting — that is `kg-doc-ingest`'s disk-first direction, correct only for text not yet in the graph. (Caught live by direct user callout: doing this once for a wikilink fix, then having to redo it through `aperas update` to actually fix the workflow.)
4. **Verify by traversal, not by the summary line.** A reconcile count reports what the command *believes* it did. Proof is a backlink that actually resolves, or `aperas project <path> --dry-run` where the content is actually visible. A push can silently match new content onto an already-tombstoned node's id without reviving it, so it stays invisible while the summary reports it as added — caught live when a Resolved section rendered one fewer bullet than was pushed. Links are the sharpest instance of this, not a special case: a write whose text carries a real citation can report `"N resolved"` and still leave `.links` empty afterward, with nothing else — not the summary, not a plain preview, not the projected file — showing any sign of it. Confirmed live twice in one session, by two unrelated mechanisms: a graph-wide staleness sweep found 9 nodes whose links had silently never resolved at all, and a separate incident later the same session watched four freshly-`"resolved"` links vanish from nodes that had just been moved and re-texted. Treat a link-bearing write as unverified until `aperas show <id>` (or `aperas backlinks <id> --text` from the other end) actually shows the `Link`, the same way step 6 already treats a plain content write as unverified until traversal confirms it. See `issues/linking.md` for the open, still-uninvestigated half of this.
5. **Deep write — follow what the change made stale, and link what was never linked.** Check backlinks and forward links; update what now disagrees — and add the citation where the change has just made a relationship real. Closing an issue that a design or a fix resolves means linking the two to each other before moving on, in both directions, not only the one that happened to get written first. This is the per-edit instance of dense linking, and the only moment it is cheap: you are already standing where the missing link is visible.
6. **Project, then stage.** `aperas project <path> --flush`, then `git add` immediately.

### Source the graph already has a concern about

A task framed as "fix this bug in `reconcile.ts`" is not outside this skill. The graph very likely already holds issues, design, planning and history for that exact file, written by someone who will not be there to tell you. The obligation runs at **both** ends, not just the front.

**Before**, and before reading the source rather than after forming a theory about it:

```bash
grep -n 'reconcile.ts' AperasKG/Apeiron/BlockNode.jsonld   # candidate ids
aperas unfold <id> --view <task>                           # then work them in the graph
aperas unfold <design-block>                               # keep climbing — stop at design, not here
```

What turns up changes the work: a root cause already identified, a fix already ordered, an approach already tried and rejected for a reason nobody is going to repeat to you.

The third line is the half that gets dropped. A keyword lands you wherever it happens to match, which for a concrete identifier is nearly always `discussion` — the tier where concrete identifiers live. Stopping there gives you the reasoning trail and none of the settled rule, so whatever the code does reads as correct by default. Follow the landed node's forward links up until you reach `design`, and compare what it states against what the code does: that comparison is the only thing that can tell a gap from agreement (*Entering the corpus*, Orientation).

**After**, record what the work found. A fix that lands with nothing written is invisible from every side that can be consulted, because doing the work and recording it are two separate acts and only the second is visible from inside (Philosophy, above).

Confirmed live three times: two sessions investigated `reconcile.ts`/`node.ts` by plain file reads with no traversal and no skill load at all; a third loaded the skill on turn one, consented to it, and still read the entire task out of the projections before editing code. The first two were a trigger failure and are fixed; the third is why this section exists.

### Stage each verified step

After a step lands clean, `git add` it — in both the code repo and `AperasKG/`. The index becomes a running checkpoint: if a later step goes wrong, `git restore`/`git diff` against it recovers cleanly. **Staging only, never committing** — `git commit` stays the user's call. Pass `--flush` on the mutating call you are about to stage, not just at the end of a sequence; the service's own flush timer can otherwise land *after* a `git add`, leaving the index holding stale content.

This is not bookkeeping. Recovering a live incident that tombstoned real content was only possible because the prior step had actually been staged.

**At the end of a batch — not after each step — run `aperas check-links` once before handing back.** The per-write check the service runs on its own only sweeps the artifact that was written; this is the pass that catches the damage that lands *elsewhere* — an edit in artifact A breaking a citation that lives in artifact B, which nothing scoped to A can see. It costs about 0.6s against the whole corpus, so the reason to run it once per batch rather than per edit is noise, not expense.

The other two link checks need nothing from you, and that is the point — the two recorded losses were both found by a human happening to look, never by a check that fired. The service now sweeps the written artifact after every `update`/`insert`/`remove` and reports anything that write resolved but failed to persist, right under the write's own `Links: N resolved…` line; and it sweeps the whole corpus at startup and on `reload`, carrying any finding on *every* later response until it clears. When either one speaks up, it is describing a link that already looks fine everywhere else — treat it as real and re-run the write (which has fixed it before) or `aperas check-links --repair`.

### Write discussion before executing, not after

Once a plan is settled — even just agreed in chat, even a "yes, do it" — write it into the relevant `discussion` doc *before* starting, for any nontrivial multi-step change. The conversation a plan lives in can be compacted or cut off at any point, and a plan that only ever existed as chat turns is gone the moment that happens, with no way to resume or hand it off from what is on disk. Caught live once: a 3-way workspace split authorized in chat with nothing written down.

Treat the discussion doc as a scratchpad, not something to write only once resolved. Freeflow raw investigation notes into it as you go — inventory findings, open questions, a "not yet decided" list. That is what protects the work if context is lost mid-*investigation*, not just mid-plan.

### Preserve identity — against any operation that can tombstone a node you meant to keep

Three different calls reach the same destruction, and only one of them looks like a delete:

- `remove` + `insert` — the obvious one.
- `aperas update` on a **parent heading** — reconciliation tombstones and remints the subtree as a *side effect*; nothing in the intent resembles deleting, and the word `remove` is never typed.
- a full-list push whose items **change depth** — matching is defeated entirely, so every id is recreated.

`aperas insert <node-id> --after/--before <anchor>` with **no stdin piped** repositions that exact node — the anchor's current parent becomes its new parent, cross-parent moves included. It preserves the id, every backlink to it, and its place in history. Reach for anything else only when the wording is changing enough that it is genuinely not the same item any more — and even then, a move followed by a separate `--text-only` edit keeps the id while changing only what actually changed.

A **type or heading-depth change** used to be a fourth way into that destruction, and the least obvious: every ordinary write pins `type` to the target's existing one and refuses a depth change outright, so converting a heading into a list item had no route but `remove` + `insert`. `aperas retype <ref> --to <type>` now does it in place with identity intact (*Mechanics*). Nothing else here relaxes — it is one narrow migration channel, not a licence to restructure through ordinary edits.

Zero backlinks is not a licence. The rule also protects a node's place in history, which backlink count has no bearing on.

Caught live twice: promoting two findings into a new section via `remove` + `insert` left two needlessly tombstoned orphans for a relocation a plain move would have handled with zero churn; and regrouping a flat 17-item list under three new sub-headings as a single parent-heading `update` returned `0 matched, 20 added, 17 removed`. Redone as create-headings-with-anchors, then move each item, then set the run-leader props per batch — all 17 ids survived. See *Adding an item to an existing list* (Mechanics) for the matching promise this rule constrains.

### Citation direction

The concerns form an abstraction gradient — `design` most abstract, `discussion` least, `issues`/`planning`/`history` between. A citation may point **up** the gradient or **sideways** freely. It may not point **down**: a design block does not reference a discussion block, for the same reason a node carries a parent pointer rather than a list of children.

The sanctioned exception is a **normative, singular** pointer — one whose target is the block's whole referent rather than one of many possible mentions. A design doc's own `# Context` section is the familiar instance (one link per facet, a fixed set), but it is the *property* that is sanctioned, not that location: a history milestone announcing one snapshot, or a design block naming *the* canonical exemplar, qualify the same way.

The test is whether removing the link leaves the block **incomplete**. A milestone whose content is "this snapshot was taken" no longer says what it exists to say once its pointer is gone; "here is a discussion that also touched on this" loses only enrichment, and stays forbidden. What the rule is actually against is a *list of children* — unbounded, discretionary, accumulating — so cardinality is the real criterion and direction is only its usual symptom.

### Every claim carries its source

Philosophy's evidence rule, as something to do. Before leaving any text in a formal doc — `issues`, `design`, `planning`, `history` — check that each claim in it can be traced: provenance first, and every other relationship the text carries alongside it, each reified as a real link rather than described in prose. Then run `aperas backlinks <id> --text` on **what you just wrote**, not only on what you are about to read. A node whose claims rest on nothing returns nothing, and that silence is the entire signal.

Direction decides which end the link lives at, never whether it exists. When a finding crystallizes *up* out of `discussion` into `issues`/`design`/`planning`/`history`, the new entry cannot cite the discussion entry it came from — that is a down-citation. So the link is added at the **origin** instead: the discussion entry gains "promoted to `issues/<concern>.md`" with a real wikilink, pointing up. The provenance then surfaces from the new entry's side for free, as a backlink.

**This is a property of the claim, not a step in the promotion ritual.** An edit that adds supporting evidence to an entry already sitting in the doc is not a promotion, and is covered exactly the same. Caught live: a planning entry was edited to cite three recorded observations and came out with `links: 0` — complete-looking from its own side, caught only when a reader ran `backlinks` on it. The same unguarded gap passed an inferred version number written as recorded fact, and a paraphrase set in quotation marks as though it were a logged prompt. Every mechanical check in this file passed on that edit; all of them ask whether the write landed, none asks whether what was written is true.

A formal doc whose entries paraphrase confirmed findings without linking them reads as complete from its own side — nothing about it looks unfinished — while `aperas backlinks` on every one of its entries returns nothing, and the provenance survives only in the head of whoever filed it. Caught live: seven issues compiled into a new concern doc from findings recorded across four different discussion docs, every origin left unlinked, noticed only by direct user callout.

This is the topology half of crystallization, stated at Philosophy above: a relationship first mediated by a discussion node becomes a direct citation once it proves load-bearing.

### The dense-linking pass

Occasionally, and deliberately, work the relationships instead of the content. Bring distant nodes into one view, then take each pair in turn and ask whether a real, nameable dependency exists. If one does and a plain citation carries it, link directly, respecting direction. If stating it takes judgment, write a mediating discussion node that cites both ends and holds the reasoning in its own text.

The counterweight matters as much as the practice: **do not manufacture links.** Two docs sharing a corpus, or sharing vocabulary, is not a dependency. The test is whether you can say in one sentence what one owes the other. A pass that adds twenty weak links has made the graph harder to traverse, not denser — deep read now descends into noise.

Run it when a concern set has grown without anyone standing back from it, when two concerns keep coming up together, or when one finding turns out to have been recorded in several places independently. That last case is itself the evidence: the relationship existed and nothing captured it.

### A view is per-task, not per-session

Orientation's rule is that a view left pointing at last session's work is worse than no view. The practice that follows: re-unfold as the task's scope moves, and treat any view you did not open yourself as unknown until checked. `aperas tree --view <name>` renders whatever was unfolded whenever, with nothing marking age, so an inherited view looks identical to one built for the question actually in front of you.

Cheapest discipline is a named view per task rather than one long-lived default — creating one is a single call, and a view scoped to the task documents its own contents. `unfold` now refuses a ref with no quads at all at write time, and an explicit sweep (`aperas reload`, service shutdown) strips any `unfolds` entry that's gone stale since — but a tombstoned-yet-present target is left alone by both, since it's a legitimate, revealable-via-`--tombstoned` entry, not a stale one.

### Discussion is where meta-info is born

Not a sink for what didn't fit elsewhere. `discussion` is the Apeiron-equivalent concern: unbound, schema-free, where every comment, assertion and reasoning trace originates before anything is decided about where — or whether — it belongs elsewhere. `design`/`issues`/`planning`/`history` are Peras: typed projections that specific *kinds* of content get promoted into, once a dedicated home for that kind has actually been designed. Most things never need promoting at all.

So something surfacing mid-task that isn't what the task is about — an engine bug found while migrating docs, say — starts in *this* task's discussion doc and stays there for as long as no dedicated home exists, possibly indefinitely. The test is not "is there an existing doc this could plausibly belong to" but "has a dedicated home for this actually been designed yet". Confirmed wrong live: two parser bugs were filed straight into `issues/packaging.md` on the assumption a finding needs an immediate formal home — wrong twice over, since packaging wasn't even the right eventual concern, and since reaching for promotion skipped the point of having a discussion sink at all.

See `design/documentation.md` for the concern taxonomy and the Freeflow document shape (an unbounded *list*, not a growing set of headings).

---

## 4. Mechanics

This section describes the usage of the `aperas` CLI. For detailed syntax, see `aperas --help` and `aperas <verb> --help`.

### Paths

Paths passed to `aperas project`/`ingest`/etc. resolve relative to the graph's `artifacts` root defined in `aperas.config.json`, e.g., `discussion/foo.md` relative to `AperasKG/artifacts/`, **not** the repo-relative `AperasKG/artifacts/discussion/foo.md` that `git status` and `find` print. The repo-relative form fails with "No ingested ArtifactNode or FolderNode found".

### Wikilink syntax

The resolver only recognizes a URL that is `[[code]]`, starts with `aperas://tree/` or `aperas://id/`, or contains a bare `#fragment`/`path#fragment`. A plain `../folder/file.md/Slug` reference (no `#`) renders fine as prose but is **not** a graph `Link` — `aperas backlinks` on it comes back empty. Use `[title](../folder/file.md#id/BlockNode:<ID>)`.

Verify with `aperas backlinks BlockNode:<ID> --text` against the specific target block, not the whole-document path. Do not trust a command's own reported link-resolution count; a real backlink appearing is the proof. A link written without a `#fragment` silently creates nothing at all, and the ingest summary will not mention it.

### Anchor placement — the bold-colon rule

A list item's lead-in colon must sit *outside* any bold span: `**Term**:`, never `**Term:**`. A bold-wrapped colon is rejected by the lead-in detector, so anchor insertion falls through to the next plain-text colon it finds — which can splice an anchor into the middle of unrelated text, such as a link's own title.

### Sketching a structure

A new heading or subtree can be built directly in the graph, with no disk authoring: create a placeholder node with `aperas resolve --create-holder <path> --titles <title> [<title>...]`, then *fill* the real content in with `aperas update` and `aperas insert`. This is why a genuinely new document never requires the disk-first path.

### `--after`/`--before` anchors

The anchor must be a **direct child** of `<path>`, not a descendant. `aperas insert <path> --after <anchor>` fails with "anchor is not a child of X" otherwise. A heading's own text and its nested list are two different levels. Check the real structure first — `aperas tree --depth <n>`, or `scripts/show_node.py --children <ref>` — rather than guessing.

Be aware this failure is not clean: the new nodes are hydrated into the store *before* the anchor is validated, so a rejected insert leaves live orphans in memory that can collide with your retry. `aperas reload -- --discard` clears them.

### Inserting an item into an existing list

For an **unordered** list, the safest and cleanest route is to insert the new item directly as a sibling of an existing one: `aperas insert <parent> --after <existing-item>`.
- **The input rule**: Pipe the bare item text **with its bullet marker** (e.g. `- new item`).
- **Never pipe plain text** with no bullet: it parses as a `paragraph`, which breaks a contiguous list run in two.
- Should you meet an item nested inside a wrapper list, promote it out with `aperas insert <item-id> --after <existing-direct-child-of-the-list>` and `aperas remove` the emptied wrapper.

For an **ordered** list, direct insertion is riskier because a freshly inserted item becomes its own run-leader and can restart the numbering rather than continuing it.
- **Appending at the end is safe when the number is right.** For a list numbered `1, 2, …, n-1`, piping `n. new item` after the last one is accepted. Piping any other number is rejected outright, naming the number it expected instead.
- **A middle-of-the-list insertion still needs the full renumbering route** — the fix above only covers appending at the end, since inserting in the middle genuinely requires renumbering everything after it. The safer route there is to target the list's **parent heading** (`aperas update <heading-id>`) and pipe the heading line plus the *complete* list (every existing item verbatim plus the new one).
  - Exact-key matching reuses every unchanged item's id, **but only while every item keeps its parent and depth**. A push that changes item depth (e.g. regrouping under sub-headings) recreates everything; use `aperas insert` (moves) for that instead.
  - **This only works if the piped content is genuinely complete.** Piping the heading plus *only* the new item reconciles the existing ones away as removed, tombstoning real content.

### Updating an existing list item

To update the text of an *existing* list item without changing its identity, use `aperas update <item-id>`.
- **For an ordinary text change, pipe bare text with no bullet marker** (e.g. `updated text`, not `- updated text`). This also updates any nested children in the same call, if you include them — see the next point for the cases that need a marker instead.
- **A marker is needed only for a checkbox, an ordered item's position, or text that's deliberately blank.** Use whatever you'd normally write: `- [x]`/`- [ ]` for a checkbox, `n.` for an ordered item, or a bare `- ` (nothing after it) if you want the item's own text to end up empty while still giving it children:
  ```
  - 
    - child
  ```
- **A bare `- ` with real text but no `[x]`/`[ ]` removes an existing checkbox entirely** (e.g. `- updated text`, not `updated text`). Choosing list syntax at all is what signals "this edit addresses the checkbox" — a marker-less bullet clears it, while bare text (no bullet at all, the first point above) never touches it either way.
- **Updating an item never changes where it sits in the list.** Whether it's ordered or unordered, and its position in the numbering, stays exactly as it was, no matter which marker you use to update it. To actually reorder or renumber, use the parent-plus-complete-list technique above — not a single-item update.
- **The title always tracks your current text, never the old one.** If your new text has a bold lead-in term (`**Like this**: ...`), the title updates to match it. If it doesn't, the title falls back to the item's own id — the same fallback any untitled node gets — rather than keeping whatever the title used to say about text that's now gone.
- **The text itself works differently: leaving it out clears it.** If you only pipe new children (a list, with no text of its own before it), the item's own text becomes empty — unlike the title, nothing here is left alone by default. Restate the existing text if you don't want it wiped.

### Updating a heading — `--text-only`

A heading-target `update` **without** `--text-only` reconciles children too, even from an empty body: piping just `## Pending Tasks` with no body reconciles 0 piped children against N existing ones as *all removed*, tombstoning real content. `--text-only` overwrites just `.text`/`.title` and skips reconciliation entirely — that is what makes a retitle safe.

### `aperas retype` — changing a block's type without losing it

`aperas retype <ref> --to <type>` converts a live block in place: `h1`..`h6` (a heading's depth is part of its type, so `h2` → `h3` is an ordinary retype), or `paragraph`/`listItem`/`code`/`blockquote`/`html`/`table`/`thematicBreak`. Id, `links`, children, parent and position all survive; type-specific props belonging to the type being left behind (a heading's `treeAnchor`, a `listItem`'s `orderedList`/`startIndex`/`checked`) are dropped rather than carried forward stale. Refactoring/migration only.

Crossing the heading/non-heading boundary migrates the title too, because the two store it in different places — a heading's own field versus a lead-in term folded into `.text`. Heading → non-heading folds the heading's words into the text as a `**words**: <body>` lead-in and derives the new title from that; non-heading → heading cuts the existing lead-in back out into the heading line, leaving the rest as its body. The two directions round-trip exactly on that canonical shape. A depth-only change, or one between two non-heading types, never touches `.text` at all. Nothing to fold or cut — no lead-in, or one that is not a single fully-bold span — degrades to an id-fallback title with `.text` untouched, and says so rather than guessing.

### Renaming

**One artifact**: `git mv old.md new.md`, then `aperas ingest <new-path> --track --flush` scoped to that concern set — not a full path-less sweep, which walks the entire `artifacts/` tree including `archive/` and can hit collisions in never-swept legacy content. Rename detection matches by exact abstract-text equality against tracked ArtifactNodes whose recorded path vanished. Don't trust the "N renamed" summary; confirm the ids actually survived at the new path.

A file rename touches no content. If the H1 needs retitling too, that is a separate `aperas update` on the H1 with `--text-only`.

**A set of cross-referencing docs**: do every content fix first — H1 retitles, cross-reference paths — *while the files are still at their old names*, verify, then `git mv` each. That way every call in the content-fixing phase resolves against paths that still exist, and the rename becomes a purely mechanical last step.

### Shell quoting

A piped `echo "..."` silently drops nested double quotes — that is bash, not `aperas`. Bash closes the outer string at the first inner `"` and reopens after it, dropping both marks with no error from anything. Caught live: `not merely "wherever convenient"` had silently become `not merely wherever convenient`. Write content containing double quotes to a file first and `cat` it in.

### Service state

`aperas service restart` flushes and reloads from the on-disk mirror — the clean way to confirm what you think landed actually did. `aperas reload -- --discard` throws away in-memory state and re-reads disk, which is the recovery when a failed call has left orphans behind.

If the service has died, an unflushed mutation is gone. Flushing per step (above) is what makes this survivable.

### Inspecting raw node state

`aperas tree`/`backlinks --text`/`unfold` all show a *rendered preview* — title plus truncated, anchor-stripped abstract. For a field they never show (`props`, `tombstonedAt`) or for a block's exact stored text, `aperas show <ref>` goes through the live service, so — unlike a raw-file reader — it always reflects the current in-memory state, not the last flush:

```bash
aperas show <ref>            # full record, exactly as stored: props, tombstonedAt, parent, children, links, title, text
aperas show <ref> --text     # exact stored text only, undecorated
```

`--text` is the one that matters before an edit: redirect it to a file, change only what needs changing, and `cat` that back into `aperas update`. That keeps the untouched part of a block byte-identical instead of retyped from a preview — which is what step 2 of the edit loop warns about, since a transcription slip silently tombstones the block and mints a new id.

`scripts/show_node.py` still covers what `aperas show` doesn't — `--grep PATTERN` (full-text search; there is still no `aperas search`) and `--artifact <ref>` (which artifact a block lives in). It reads the **on-disk mirror**, so after an unflushed mutation it reports pre-flush state while `aperas show`/`unfold`/`tree` report the live service's. Flush first, or ask the CLI, when checking something you just changed. Caught live once, before `aperas show` existed: a move and a tombstone were both invisible to the script, producing a confident and wrong conclusion that the move had gone backwards.

### Checking the skill against its own record

`SKILL.md` is a *generative* projection of its concern — authored from design rather than serialized by a command — so unlike an `aperas project` artifact it can drift from its source with nothing detecting it. `scripts/skill_drift.py` compares the file against the graph's record of it (the latest snapshot plus the deltas above it):

```bash
scripts/skill_drift.py              # both directions
scripts/skill_drift.py --added      # written into the file, never recorded
scripts/skill_drift.py --dropped    # recorded, no longer in the file
```

A delta entry that replaces rather than adds carries a `Supersedes: [title](#id/BlockNode:...)` line naming the item it retires, which is what lets the check tell a deliberate rewrite from a silent loss.

Run it after editing this file, before considering the edit done. *Added* is the check that matters most — an edit made and not recorded is invisible from the file's own side, which is how three separate additions in one session went unrecorded until a reader noticed. *Dropped* catches the opposite: v1 silently lost one of v0 item 18's three triggers, and nothing flagged it. The *added* side compares each unit in full — one unit per list item, since a list containing even one superseded item no longer appears contiguously in any single record — so a rewording anywhere in a unit is caught. The *dropped* side still matches on a prefix and is correspondingly weaker.

### `aperas unfold` — bare vs `--view`

A bare `aperas unfold <ref>` (no `--view` flag at all) is a read-only peek: it resolves and previews `<ref>` without touching any `TreeView` state, matching `aperas tree`'s own no-`--view` default. `--view <name>` (a name actually given) still bootstraps that view — minting the `"default"` one and its owning `Profile` on first use — and adds `<ref>` to its `unfolds` set, which is what a later `aperas tree --view <name>` actually renders. `--view` supplied with no name following it behaves the same bootstrap-and-mutate way as naming `"default"` explicitly; only the flag's outright absence peeks.

### Tombstoned nodes are hidden by default, everywhere

`aperas tree` and `aperas unfold` both hide a tombstoned node — and its whole subtree, since there is nothing live left under it to reveal — from their default output, tagging it `(tombstoned)` only once `--tombstoned` is passed. `aperas unfold` additionally refuses to unfold a tombstoned node directly without the flag, with a clear error, rather than returning something that looks like an empty success. A node reached only through a still-live `Link` elsewhere is exactly as hidden as one reached structurally — the flag controls visibility, not the traversal path that found it.

### `aperas check-links` — the standing link-integrity sweep

Answers exactly the question dense linking depends on and nothing else routinely checks: does every internal-style reference a live block's text actually names (`[[code]]`, `aperas://...`, `path#fragment`) have a matching resolved `Link` in that block's own `.links`? `aperas check-links` reports discrepancies; `aperas check-links --repair` re-resolves and flushes them in the same call. It resolves each occurrence for real (the same dispatch `kg:update`/`kg:insert` themselves use, read-only here — never mints a placeholder as a side effect of a scan) rather than guessing from the text, so it correctly stays silent on a code that simply doesn't resolve yet (routine, or already tracked separately as a dangling reference) and only flags a code that resolves to a live target with nothing to show for it in `.links` — the exact, previously-invisible failure mode this tool exists for.

### Full-text search — grep the raw store directly

`show_node.py --grep` works, but a plain `grep -n -C3 '<pattern>' AperasKG/Apeiron/BlockNode.jsonld` is faster and shows more: one command, the complete untruncated `text` (the script's own preview caps at 90 chars), and it also works over `ArtifactNode.jsonld` for an artifact's own title/abstract — which `--grep` never scans, since it only iterates blocks. This is not the shadow-grepping mistake the Philosophy example warns about: `Apeiron/*.jsonld` is the on-disk mirror of the graph itself, not the rendered `artifacts/*.md` projection, so grepping it is reading the source, not the shadow.

A hit is a candidate id, not proof of anything. Confirmed live: a node's field order is `@id, @type, [props], [tombstonedAt], title, text, parent, type, children`, and `props` is variable-length — so `tombstonedAt`'s distance from a `text` match shifts per node, and no fixed `-C<n>` window can be trusted to surface it. Treat every match as an id to hand to `aperas` (`unfold`/`tree`/`backlinks --text`) for the actual live/tombstoned status, parent, and links: grep finds the nodes, `aperas` deals with them.

### Comparing distant docs — the view as a lens

`--view` is not a bookmark list; it is the mechanism for putting nodes that sit far apart in the tree next to each other. Unfold every doc being compared into one view, then render it once:

```bash
for f in issues/a.md discussion/b.md design/c.md; do
  aperas unfold "$f" --view <name> --flush
done
aperas tree --view <name>
```

Run `aperas backlinks <id> --text` on a target before adding a link to it — working across several docs at once makes it easy to add a citation that already exists. And note that a link resolves by its `id/` fragment: the leading relative path is for the human reader, so a stale path still resolves correctly while misleading anyone who reads it. Observed live renaming a concern — every fragment kept working, every path string had to be fixed by hand.

### `aperas tree` names the node it started from, once — not every line

The first line of any `aperas tree` render is a breadcrumb, `aperas://tree/<path>` — the walkable path of the node the command was actually pointed at (`.` if none given), directly reusable as a `<ref>` elsewhere with no separate `aperas path` call. It appears exactly once, at the top: every line under it is already relative to that node by construction (that is what a tree render is), so repeating the prefix on each one would say nothing new. Omitted, not shown broken, when the node's own path can't be walked.

`--view` reuses the same idea at a second place it's actually needed: when a link escapes its owner's own viewcone into a nested one (Aperas-treeview-design.md §13 — the target is unfolded independently, and the link, not the target's own structural position, wins canonical placement), everything under that link is now relative to *it*, not to the render's original apex. That position gets its own one-time breadcrumb too, indented to match, for the same reason the apex gets one. An ordinary in-cone link (target already reachable from the apex the normal way) or a "this is superseded, see elsewhere" pointer line needs neither — nothing changes what "here" means at those positions.

---

## Reference

- `AperasKG/artifacts/design/linking.md` — canonical spec for addressing, anchors and wikilink syntax. Read it when a link isn't resolving and the reason isn't obvious.
- `AperasKG/artifacts/design/documentation.md` — the concern taxonomy and the Freeflow document shape.
- `AperasKG/artifacts/design/aperas-skill.md` — this skill's own design: the four levels, citation direction, and how items enter (incident → freeflow → confirmed → promoted to the level that explains it).
- `archive/Aperas-design.md` — the founding philosophy: Apeiron/Aperas/Peras, deep read and deep write, Meta-Aperas.

### Open tool gaps

Tracked in the graph rather than accumulating here: `aperas resolve`'s title-ambiguity check not filtering tombstoned candidates, so a dead holder can still make a live path read as ambiguous (`discussion/core.md`'s Freeflow). The link-integrity drift check this list used to name as missing is built and live (`aperas check-links`, see *Mechanics* — `issues/linking.md`); the `verify.ts` id-anchor emission idempotency failure this list used to name as unreproduced is also fixed and passing (`discussion/core.md`).
