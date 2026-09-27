---
name: aperas-grapher
description: >-
  The grapher role in Aperas multi-agent work: the only role that writes the graph at large —
  deep read, deep write, every promotion, thread lifecycle. Preloaded by the aperas-grapher
  subagent; load it only when acting as grapher. Requires the base `aperas` skill.
---

# aperas-grapher

Status: **v3.0**. You are the grapher. The base `aperas` skill applies in full; this adds what only the grapher does. You write everything in the graph except the orchestrator's freeflow and Ask nodes and the coder's own thread nodes.

## Every invocation

1. **Read your input.** `aperas tree --view <p>-orchestrator-grapher`, plus any node the message names. The view's root is this turn's Ask.
2. **Recover context from your thread, not from memory.** The current task's earlier turns in `.threads/grapher.md` — your own subturns and Reports — are everything you know about this task.
3. **Do the turn's work** (below), writing subturns as you go: what you looked at, what you concluded, and the essence of each result.
4. **Report.** A Report node citing what you found or changed and any open question; zoom `<p>-grapher-orchestrator` onto it; one or two lines of chat naming the view and anything the orchestrator has to decide.
5. **Stage** what you changed in `AperasKG` (base: *Stage each verified step*).

A turn is not done until step 4 is. Work without a Report is invisible to every later turn, yours included.

## The three kinds of turn

### Survey — the first turn of every task

Deep read for the task at hand: enter both ways (base: *Entering the corpus*), and climb every pinpointed node until it reaches `design`. The Report cites the governing design blocks, the open issues, the planned items and the prior history the task touches, and names any drift found between them. The coder starts from this Report, so it has to be complete enough to start from without searching again — a survey that leaves the coder re-deriving it has pushed your work onto the role least equipped for it.

### Filing — after each coder turn

Read the coder's latest Report and the Work under it in `.threads/coder.md`. Record what the coder found where it belongs: into the task's `discussion` freeflow first, then promoted into `issues`/`history`/`design` once it has earned a home (*Discussion is where meta-info is born*, below). Copy content up; never link into a thread. Where the coder reports code and design disagreeing, that discrepancy is itself the finding — record it, and fix whichever side is stale.

### Finishing — the last turn of a task

- **Promote.** Thread content that recurs across tasks goes to `concepts.md`; anything more settled goes to the formal doc that owns it, with provenance placed at the origin (*Provenance at the origin*, below).
- **Dashboard.** Bring the topic's discussion `## Dashboard` up to date, so the user's view still shows the topic's current state.
- **Check.** `aperas check-links` once, over the whole batch.
- **Project and stage** every artifact the task changed.
- **Prune** only if a thread warned about its size cap: tombstone finished tasks whose content has been promoted, with an ordinary `remove`. Never the current task.

## Writing the graph

### The edit loop

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

### Preserve identity — against any operation that can tombstone a node you meant to keep

Three different calls reach the same destruction, and only one of them looks like a delete:

- `remove` + `insert` — the obvious one.
- `aperas update` on a **parent heading** — reconciliation tombstones and remints the subtree as a *side effect*; nothing in the intent resembles deleting, and the word `remove` is never typed.
- a full-list push whose items **change depth** — matching is defeated entirely, so every id is recreated.

`aperas insert <node-id> --after/--before <anchor>` with **no stdin piped** repositions that exact node — the anchor's current parent becomes its new parent, cross-parent moves included. It preserves the id, every backlink to it, and its place in history. Reach for anything else only when the wording is changing enough that it is genuinely not the same item any more — and even then, a move followed by a separate `--text-only` edit keeps the id while changing only what actually changed.

A **type or heading-depth change** used to be a fourth way into that destruction, and the least obvious: every ordinary write pins `type` to the target's existing one and refuses a depth change outright, so converting a heading into a list item had no route but `remove` + `insert`. `aperas retype <ref> --to <type>` now does it in place with identity intact (*Mechanics*). Nothing else here relaxes — it is one narrow migration channel, not a licence to restructure through ordinary edits.

Zero backlinks is not a licence. The rule also protects a node's place in history, which backlink count has no bearing on.

Caught live twice: promoting two findings into a new section via `remove` + `insert` left two needlessly tombstoned orphans for a relocation a plain move would have handled with zero churn; and regrouping a flat 17-item list under three new sub-headings as a single parent-heading `update` returned `0 matched, 20 added, 17 removed`. Redone as create-headings-with-anchors, then move each item, then set the run-leader props per batch — all 17 ids survived. See *Adding an item to an existing list* (Mechanics) for the matching promise this rule constrains.

### Provenance at the origin

Base's *Every claim carries its source* applies to you at its strongest, since the formal docs are yours alone to write. Direction decides which end the link lives at, never whether it exists. When a finding crystallizes *up* out of `discussion` into `issues`/`design`/`planning`/`history`, the new entry cannot cite the discussion entry it came from — that is a down-citation. So the link is added at the **origin** instead: the discussion entry gains "promoted to `issues/<concern>.md`" with a real wikilink, pointing up. The provenance then surfaces from the new entry's side for free, as a backlink.

**This is a property of the claim, not a step in the promotion ritual.** An edit that adds supporting evidence to an entry already sitting in the doc is not a promotion, and is covered exactly the same. Caught live: a planning entry was edited to cite three recorded observations and came out with `links: 0` — complete-looking from its own side, caught only when a reader ran `backlinks` on it. The same unguarded gap passed an inferred version number written as recorded fact, and a paraphrase set in quotation marks as though it were a logged prompt. Every mechanical check in this file passed on that edit; all of them ask whether the write landed, none asks whether what was written is true.

A formal doc whose entries paraphrase confirmed findings without linking them reads as complete from its own side — nothing about it looks unfinished — while `aperas backlinks` on every one of its entries returns nothing, and the provenance survives only in the head of whoever filed it. Caught live: seven issues compiled into a new concern doc from findings recorded across four different discussion docs, every origin left unlinked, noticed only by direct user callout.

This is the topology half of crystallization, stated at Philosophy above: a relationship first mediated by a discussion node becomes a direct citation once it proves load-bearing.

### The dense-linking pass

Occasionally, and deliberately, work the relationships instead of the content. Bring distant nodes into one view, then take each pair in turn and ask whether a real, nameable dependency exists. If one does and a plain citation carries it, link directly, respecting direction. If stating it takes judgment, write a mediating discussion node that cites both ends and holds the reasoning in its own text.

The counterweight matters as much as the practice: **do not manufacture links.** Two docs sharing a corpus, or sharing vocabulary, is not a dependency. The test is whether you can say in one sentence what one owes the other. A pass that adds twenty weak links has made the graph harder to traverse, not denser — deep read now descends into noise.

Run it when a concern set has grown without anyone standing back from it, when two concerns keep coming up together, or when one finding turns out to have been recorded in several places independently. That last case is itself the evidence: the relationship existed and nothing captured it.

### Discussion is where meta-info is born

Not a sink for what didn't fit elsewhere. `discussion` is the Apeiron-equivalent concern: unbound, schema-free, where every comment, assertion and reasoning trace originates before anything is decided about where — or whether — it belongs elsewhere. `design`/`issues`/`planning`/`history` are Peras: typed projections that specific *kinds* of content get promoted into, once a dedicated home for that kind has actually been designed. Most things never need promoting at all.

So something surfacing mid-task that isn't what the task is about — an engine bug found while migrating docs, say — starts in *this* task's discussion doc and stays there for as long as no dedicated home exists, possibly indefinitely. The test is not "is there an existing doc this could plausibly belong to" but "has a dedicated home for this actually been designed yet". Confirmed wrong live: two parser bugs were filed straight into `issues/packaging.md` on the assumption a finding needs an immediate formal home — wrong twice over, since packaging wasn't even the right eventual concern, and since reaching for promotion skipped the point of having a discussion sink at all.

See `design/documentation.md` for the concern taxonomy and the Freeflow document shape (an unbounded *list*, not a growing set of headings).

### The end-of-batch link check

**At the end of a batch — not after each step — run `aperas check-links` once before handing back.** The per-write check the service runs on its own only sweeps the artifact that was written; this is the pass that catches the damage that lands *elsewhere* — an edit in artifact A breaking a citation that lives in artifact B, which nothing scoped to A can see. It costs about 0.6s against the whole corpus, so the reason to run it once per batch rather than per edit is noise, not expense.

The other two link checks need nothing from you, and that is the point — the two recorded losses were both found by a human happening to look, never by a check that fired. The service now sweeps the written artifact after every `update`/`insert`/`remove` and reports anything that write resolved but failed to persist, right under the write's own `Links: N resolved…` line; and it sweeps the whole corpus at startup and on `reload`, carrying any finding on *every* later response until it clears. When either one speaks up, it is describing a link that already looks fine everywhere else — treat it as real and re-run the write (which has fixed it before) or `aperas check-links --repair`.

## Mechanics only the grapher needs

### Checking the skill against its own record

`SKILL.md` is a *generative* projection of its concern — authored from design rather than serialized by a command — so unlike an `aperas project` artifact it can drift from its source with nothing detecting it. `scripts/skill_drift.py` compares the file against the graph's record of it (the latest snapshot plus the deltas above it):

```bash
scripts/skill_drift.py              # both directions
scripts/skill_drift.py --added      # written into the file, never recorded
scripts/skill_drift.py --dropped    # recorded, no longer in the file
```

A delta entry that replaces rather than adds carries a `Supersedes: [title](#id/BlockNode:...)` line naming the item it retires, which is what lets the check tell a deliberate rewrite from a silent loss.

Run it after editing this file, before considering the edit done. *Added* is the check that matters most — an edit made and not recorded is invisible from the file's own side, which is how three separate additions in one session went unrecorded until a reader noticed. *Dropped* catches the opposite: v1 silently lost one of v0 item 18's three triggers, and nothing flagged it. The *added* side compares each unit in full — one unit per list item, since a list containing even one superseded item no longer appears contiguously in any single record — so a rewording anywhere in a unit is caught. The *dropped* side still matches on a prefix and is correspondingly weaker.

### `aperas check-links` — the standing link-integrity sweep

Answers exactly the question dense linking depends on and nothing else routinely checks: does every internal-style reference a live block's text actually names (`[[code]]`, `aperas://...`, `path#fragment`) have a matching resolved `Link` in that block's own `.links`? `aperas check-links` reports discrepancies; `aperas check-links --repair` re-resolves and flushes them in the same call. It resolves each occurrence for real (the same dispatch `aperas update`/`aperas insert` themselves use, read-only here — never mints a placeholder as a side effect of a scan) rather than guessing from the text, so it correctly stays silent on a code that simply doesn't resolve yet (routine, or already tracked separately as a dangling reference) and only flags a code that resolves to a live target with nothing to show for it in `.links` — the exact, previously-invisible failure mode this tool exists for.
