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
  only once the answer is yes, and with it `aperas-orchestrator` — the session talking with the
  user is the orchestrator; graph work and code work go to the `aperas-grapher` and
  `aperas-coder` subagents. Aperas is this project's external memory: a knowledge graph, worked
  through the `aperas` CLI, holding what has been decided, tried, found and planned, and the
  medium the three roles communicate through.
---

# aperas

Status: **v3.1** — the base every role loads: four levels, Philosophy through Mechanics, each item explaining a consequence of the one above it. What each role does with it lives in its role skill — `aperas-orchestrator`, `aperas-grapher`, `aperas-coder`. Only current, verified items appear here; superseded material, unverified hypotheses and version-by-version rationale live in `discussion/aperas-skill.md`'s snapshot and deltas. Concern docs: `AperasKG/artifacts/{design,issues,planning,history,discussion}/aperas-skill.md`.

> **Aperas-repo insiders**: `aperas` ships as a real published package (`npm install -g aperas`) as of `0.2.2`, but this repo still develops it from source — running the bare `aperas <verb> ...` commands below here would invoke whatever's globally installed, not your local changes. Run them as `npm run aperas -- <verb> ...` from `Aperas/monorepo/` instead.

## How to read this

Four levels, each following from the one above:

1. **Philosophy** — what the graph *is*. Everything else is a consequence.
2. **Orientation** — what reading and writing *mean* here.
3. **Discipline** — how to behave once oriented, and how the three roles work together through the graph.
4. **Mechanics** — how to type it.

Read top-down. Stopping after Orientation should already leave you acting correctly in the ordinary case; starting at Mechanics gives you a list of gotchas with nothing to hang them on. An item sits at the level that explains *why* it is true, not the level where it was first noticed.

Everything here is current and confirmed live. A rule whose cause has since been removed, and one identified but not yet verified, both belong in `discussion/aperas-skill.md` rather than here — a caution you cannot act on costs the reader and buys nothing.

### Scope

This skill owns *working the graph*, which every role does. Your role skill owns *what you do with it*: which parts of the graph you write, when you hand off, and how. `kg-doc-ingest` owns *getting existing text into the graph* — the grapher's, when it comes up. Anything that is a fact about this project rather than about the tooling belongs in a concern doc under `AperasKG/artifacts/`, which this skill only points at.

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

This is separate from the fixed hand-off views a subagent already owns (*Hand-offs*, below), which are re-rooted onto an Ask or a Report every turn and aren't meant for free browsing. A subagent that needs to look around a whole task — to write a finishing turn, say — sets up one of these for itself the same way. `TreeView` names are globally unique, so name it `${profile}-${topic-or-task}`, not a bare topic name: the orchestrator's own personal views are bare (`kg-cleanup`, `core-redesign`), and a subagent using the same bare name for the same topic would collide with one that already exists.

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

### Three roles, one graph

All work here is done by one of three roles, and each writes only where its role says:

| Role | Runs as | Writes |
|---|---|---|
| **Orchestrator** | the session talking with the user | `discussion` freeflow recording the conversation; its own **Ask** nodes in the subagent threads |
| **Grapher** | subagent | everything else in the graph — deep read, deep write, every promotion, each thread's lifecycle |
| **Coder** | subagent | source code; its own nodes in `.threads/coder.md` |

A write outside your role's column is a hand-off you skipped. Route it to the role that owns it — in your Report or your Ask — rather than making it yourself: the steps an agent drops are precisely the ones inside work it absorbed from another role.

If you were started as a subagent, your agent definition names your role, profile and views. Otherwise you are the orchestrator, and `aperas-orchestrator` is loaded alongside this skill. Profiles are fixed, per platform `<p>` (`claude`, `antigravity`): `<p>`, `<p>-grapher`, `<p>-coder`. Never create another one for your own views.

### The task loop

Every task runs the same sequence of turns. Each role skill details its own turns; the whole sequence lives here, so every role knows what comes before and after its part:

1. **Grapher survey.** The graph for the task: the governing design, open issues, planned items, prior history, and any drift between them. Source code is touched only to pinpoint an entry into the graph (*Entering the corpus*), never to map how the code behaves.
2. **Coder survey.** No code changes: map where the behavior lives, starting from the grapher's survey, and report where the code disagrees with it.
3. **Grapher files** the coder's survey, so the change starts from a recorded picture rather than one in the coder's context.
4. **Coder change**, starting from the filed survey.
5. **Orchestrator verifies** the diff and the tests itself.
6. **Grapher files** the result.
7. **Repeat 4–6** as the task needs, then the **grapher's finishing turn**.

An Ask asks only for its receiver's kind of work. A grapher Ask that says "find the source" or "map the behavior" has folded the coder's survey into the grapher's turn, and the coder then starts its change from a code map nobody filed.

### Threads — where a subagent's context lives

Each subagent has one thread, `.threads/grapher.md` or `.threads/coder.md`. Nothing carries a subagent from one invocation to the next that it can rely on except its thread and its views — which is not a weaker substitute for chat history but a stronger one, because it is structured, linked, and readable by the other roles. A thread is a tree:

```markdown
# Grapher thread
## <topic>                                   ← named by the user
### <task>                                   ← set by the orchestrator
#### Turn <n>                                ← one exchange with the orchestrator
- **Ask**: <what is wanted, in a sentence>   ← orchestrator; root of <p>-orchestrator-grapher
  - [<argument>](../design/x.md#id/BlockNode:…) — why it matters here
- **Work**: <the approach, in a line>        ← subagent; subturns nested under it
  - <subturn>
- **Report**: <the outcome, in a sentence>   ← subagent; root of <p>-grapher-orchestrator
  - [<changed or found node>](…) — what changed, or what it shows
  - **Question**: <whatever the Ask left unsettled — see below>
  - **Tool gap — <what>**: <a workaround built, a call that failed or hung — see below>
  - **Tool gap — <what else>**: <a second one, if the turn hit more than one>
```

More than one **Tool gap** in a Report needs a distinct lead-in for each — `<what>`, not a bare repeat of the word "Tool gap" — since sibling slugs are derived from the lead-in term, and two identical ones collide outright: the write is rejected in full, nothing written, before either one lands.

A follow-up is a new turn, not an edit to an old one.

**Every turn has subturns: at least one per batch of tool calls.** The Work line holds the approach in one line; the results belong in subturns, and no turn with more than one call can fold them into that line. For each batch, a subturn records the progress, the reasoning, and the *essence of each tool result* a later turn will need — the failing assertion's line, the id that came back, the count, the file that turned out to own the behavior — not "ran the tests". Write them as you go or at the end of the turn, but before the turn ends: a result that is not in the thread is gone for every later turn, since the next invocation starts from the thread, not from this one's context.

**Record the friction, not only the results.** A subturn also records every place the tools got in the way: a workaround you built (a script, a loop over a command, a detour through another verb), a call that failed, hung or had to be stopped, each retry and what changed in it, an error you routed around, a write that did something you didn't intend. Give the command and what happened, even once you got past it — especially then, because a problem you solved leaves no trace in the results, and nobody will remember it after the turn. The Report lists each one as a **Tool gap**, so the grapher can file it. A gap that is not in the thread is one the graph can never notice.

**Ask back instead of guessing.** An ordinary subagent runs to completion on whatever it was handed and returns its best guess at the gaps. Here a subagent stops when it meets something the Ask doesn't settle — an ambiguous requirement, two plausible approaches with different costs, code or graph contradicting what the Ask assumed, a change turning out larger than the Ask implied — and asks. The question goes in the Report as **Question**, with what raised it and the options you see; the turn ends there, and the orchestrator answers in a new turn. A wrong guess costs a whole round of work plus unwinding it; a question costs one turn. Guessing is what a subagent does by default, so asking has to be done deliberately — it is as much a part of every turn as recording the subturns.

Threads are the lowest tier of the gradient (*Citation direction*, below), so a thread cites upward freely, and threads cite each other sideways — an Ask citing the other subagent's Report is the ordinary case. **Nothing above the threads tier links into one**: no formal doc, `concepts.md` entry or discussion node. What a thread finds reaches the rest of the graph by the grapher copying it up, never by citation.

When a write to a thread reports its size cap reached, say so in your Report; the grapher prunes finished tasks at its next turn.

### Hand-offs — the view carries the data, the chat carries the control

A hand-off message is a call. The view is `this` — the shared context the call runs against — and the message may still name further arguments: a node to look at first, the one question that decides the turn. What a hand-off must never do is carry the work itself in chat: chat tracks *progress*, the view tracks the *state* of the work, and only the second survives into the next turn.

Sending, every turn:

1. Write only what changed — new nodes, new links. Reuse everything else by citing it.
2. Write your root node — **Ask** or **Report** — citing both what you just wrote and the existing content the receiver needs.
3. Zoom your view onto that root.
4. Send a short message naming the view and any specific arguments.

Receiving, before anything else: `aperas tree --view <sender's view>`. That is your input; the message only points into it.

The root moves every turn while the content under it mostly stays put, the way a commit is new while most of its tree is shared. Rebuilding the content inside the new root instead of citing it is the same mistake as retyping a block instead of linking it.

| View | Owned by | Faces | Rooted on |
|---|---|---|---|
| `<p>-<topic>` | orchestrator | the user | the topic discussion's `## Dashboard` |
| `<p>-orchestrator-grapher` | orchestrator | grapher | the current Ask in `.threads/grapher.md` |
| `<p>-orchestrator-coder` | orchestrator | coder | the current Ask in `.threads/coder.md` |
| `<p>-grapher-orchestrator` | grapher | orchestrator | the current Report in `.threads/grapher.md` |
| `<p>-coder-orchestrator` | coder | orchestrator | the current Report in `.threads/coder.md` |

### Every claim carries its source

Philosophy's evidence rule, as something every role does, not only whoever ends up writing the formal docs. Before leaving a claim in place — a freeflow finding, a thread's Report, a formal-doc entry, whatever you are writing and wherever — check that it can be traced: provenance first, and every other relationship it carries alongside it, each reified as a real link rather than described in prose. A claim resting on nothing is not a lesser entry; it is incomplete, whichever role wrote it and whatever it was written into.

Where you check depends on where you wrote it. A thread or freeflow entry cites forward, since nothing above the threads tier links into a thread and freeflow is not itself a citation target (base *Citation direction*, below) — so the check there is simply: does this entry's own text name what it rests on? A formal-doc entry can be checked from the other side, and more strongly: run `aperas backlinks <id> --text` on **what you just wrote**, not only on what you were about to read. A node whose claims rest on nothing returns nothing, and that silence is the entire signal. The mechanics of applying this to a formal-doc promotion — where the link goes when citation direction forbids the obvious direction — belong to the grapher, the only role that writes one (`aperas-grapher`'s *Provenance at the origin*).

### Citation direction

The concerns form an abstraction gradient — `design` most abstract, then `issues`/`planning`/`history`, then the shared `concepts.md` map, then `discussion`, and an agent's own thread least. A citation may point **up** the gradient or **sideways** freely. It may not point **down**: a design block does not reference a discussion block, for the same reason a node carries a parent pointer rather than a list of children.

The sanctioned exception is a **normative, singular** pointer — one whose target is the block's whole referent rather than one of many possible mentions. A design doc's own `# Context` section is the familiar instance (one link per facet, a fixed set), but it is the *property* that is sanctioned, not that location: a history milestone announcing one snapshot, or a design block naming *the* canonical exemplar, qualify the same way.

The test is whether removing the link leaves the block **incomplete**. A milestone whose content is "this snapshot was taken" no longer says what it exists to say once its pointer is gone; "here is a discussion that also touched on this" loses only enrichment, and stays forbidden. What the rule is actually against is a *list of children* — unbounded, discretionary, accumulating — so cardinality is the real criterion and direction is only its usual symptom.

### A view is per-task, not per-session

Orientation's rule is that a view left pointing at last session's work is worse than no view. The practice that follows: re-unfold as the task's scope moves, and treat any view you did not open yourself as unknown until checked. `aperas tree --view <name>` renders whatever was unfolded whenever, with nothing marking age, so an inherited view looks identical to one built for the question actually in front of you.

Cheapest discipline is a named view per task rather than one long-lived default — creating one is a single call, and a view scoped to the task documents its own contents. `unfold` now refuses a ref with no quads at all at write time, and an explicit sweep (`aperas reload`, service shutdown) strips any `unfolds` entry that's gone stale since — but a tombstoned-yet-present target is left alone by both, since it's a legitimate, revealable-via-`--tombstoned` entry, not a stale one.

A view's root is its current zoom, and zooming it is part of every hand-off (*Hand-offs*, above): a view whose root still sits on last turn's node is the same stale lens this rule is about, one level down.

### Stage each verified step

After a step lands clean, `git add` it — in both the code repo and `AperasKG/`. The index becomes a running checkpoint: if a later step goes wrong, `git restore`/`git diff` against it recovers cleanly. **Staging only, never committing** — `git commit` stays the user's call. Pass `--flush` on the mutating call you are about to stage, not just at the end of a sequence; the service's own flush timer can otherwise land *after* a `git add`, leaving the index holding stale content.

This is not bookkeeping. Recovering a live incident that tombstoned real content was only possible because the prior step had actually been staged.

Every role stages what it writes, in the repo it wrote to: the orchestrator and the grapher stage `AperasKG/`, the coder stages the code repo. The checkpoint exists for the writer's own recovery, so it is never left to another role's next turn.

---

## 4. Mechanics

This section describes the usage of the `aperas` CLI. For detailed syntax, see `aperas --help` and `aperas <verb> --help`.

### Threads, turns and zooming

Thread paths resolve like any other artifact: `.threads/grapher.md`, `.threads/coder.md`. `.threads/` sits directly under `artifacts/` like the concern folders, so a citation from a thread uses the same relative form, `[title](../design/x.md#id/BlockNode:<ID>)`.

```bash
cat ask.md | aperas insert <turn-heading-id> --flush
# → aperas://id/BlockNode:…  [listItem]  **Ask**  (created)   ← this id is the new root
aperas zoom BlockNode:… --view claude-orchestrator-grapher --flush
aperas tree --view claude-orchestrator-grapher                 # what the receiver reads first
```

Keep the id each `insert` prints: it is the node you zoom onto and the node the next turn cites. A root node is an ordinary list item, so the list rules below apply to it — pipe it with its bullet marker, lead-in colon outside the bold.

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
- **For an ordinary text change, pipe bare text with no bullet marker** (e.g. `updated text`, not `- updated text`). This replaces the item's children too, not just its text — see the last point below for what that costs if you don't restate them. See the next point for the cases that need a marker instead.
- **A marker is needed only for a checkbox, an ordered item's position, or text that's deliberately blank.** Use whatever you'd normally write: `- [x]`/`- [ ]` for a checkbox, `n.` for an ordered item, or a bare `- ` (nothing after it) if you want the item's own text to end up empty while still giving it children:
  ```
  - 
    - child
  ```
- **A bare `- ` with real text but no `[x]`/`[ ]` removes an existing checkbox entirely** (e.g. `- updated text`, not `updated text`). Choosing list syntax at all is what signals "this edit addresses the checkbox" — a marker-less bullet clears it, while bare text (no bullet at all, the first point above) never touches it either way.
- **Updating an item never changes where it sits in the list.** Whether it's ordered or unordered, and its position in the numbering, stays exactly as it was, no matter which marker you use to update it. To actually reorder or renumber, use the parent-plus-complete-list technique above — not a single-item update.
- **The title always tracks your current text, never the old one.** If your new text has a bold lead-in term (`**Like this**: ...`), the title updates to match it. If it doesn't, the title falls back to the item's own id — the same fallback any untitled node gets — rather than keeping whatever the title used to say about text that's now gone.
- **The rule runs both ways: whichever piece you don't restate is wiped, not left alone.** Piping only new children (a list, with no text of its own before it) clears the item's own text — unlike the title, nothing here is left alone by default. Piping only text with no children after it tombstones any existing children the same way, since the call reconciles them against what was piped, which was none. Confirmed live: fixing a lead-in term by piping the item's corrected text alone, with no children, cost it two children that had to be reinserted. Restate whichever side you're not touching.

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

### `aperas unfold` — bare vs `--view`

A bare `aperas unfold <ref>` (no `--view` flag at all) is a read-only peek: it resolves and previews `<ref>` without touching any `TreeView` state, matching `aperas tree`'s own no-`--view` default. `--view <name>` (a name actually given) still bootstraps that view — minting the `"default"` one and its owning `Profile` on first use — and adds `<ref>` to its `unfolds` set, which is what a later `aperas tree --view <name>` actually renders. `--view` supplied with no name following it behaves the same bootstrap-and-mutate way as naming `"default"` explicitly; only the flag's outright absence peeks.

### Tombstoned nodes are hidden by default, everywhere

`aperas tree` and `aperas unfold` both hide a tombstoned node — and its whole subtree, since there is nothing live left under it to reveal — from their default output, tagging it `(tombstoned)` only once `--tombstoned` is passed. `aperas unfold` additionally refuses to unfold a tombstoned node directly without the flag, with a clear error, rather than returning something that looks like an empty success. A node reached only through a still-live `Link` elsewhere is exactly as hidden as one reached structurally — the flag controls visibility, not the traversal path that found it.

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
