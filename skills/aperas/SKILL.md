---
name: aperas
description: >-
  Before anything else in this project — first turn, every session, whatever the task looks like, including when it looks unrelated, trivial, read-only, or like one quick lookup — check memory/rules for a standing decision on whether Aperas manages this session (`.agents/rules/aperas.md` or harness memory). Do this without loading this skill, and never ask permission to do it or offer it as an option; just do it. If a decision is recorded, follow it. If none is, ask with AskUserQuestion using exactly these choices — Never / Not now / Yes, this session only / Yes, all sessions — and record only 'all sessions' or 'never' durably (into `.agents/rules/aperas.md` or harness memory), so a session-scoped answer is asked again next session. Load this skill only once the answer is yes, and with it `aperas-orchestrator` if you are the main agent, or the appropriate subagent skill (e.g. `aperas-grapher` or `aperas-coder`) if not. 
  Aperas is this project's external memory: a knowledge graph, worked through the `aperas` CLI, holding what has been decided, tried, found and planned, and the medium the three roles communicate through.
---

# aperas

Status: **v4** — Base skill for all Aperas roles.

Aperas is an evidence-based knowledge-graph documentation system. This skill establishes the common mental model, traversal discipline, multi-agent protocol, and CLI mechanics used across all roles (`aperas-orchestrator`, `aperas-grapher`, `aperas-coder`).

> **Aperas-repo insiders**: `aperas` is published as a package (`npm install -g aperas`), but this repo develops it from source. Running bare `aperas <verb>` invokes whatever is globally installed, not your local changes. Run commands from `Aperas/monorepo/` as:
> ```bash
> npm run aperas -- <verb> ...
> ```
> In normal projects using the published tool, run bare `aperas <verb> ...`.

---

## Table of Contents

- [1. Philosophy](#1-philosophy) — Foundational principles (Apeiron as source, substance maturity, provenance)
- [2. Orientation](#2-orientation) — Initial gates, view triage, entering the corpus, traversal directions
- [3. Discipline](#3-discipline) — Three roles, 9-step task loop, thread structure, zooming, citation gradients
- [4. Mechanics](#4-mechanics) — Command references, CLI piping recipes, node editing, service lifecycle, link checks
- [5. Reference](#5-reference) — Canonical specifications and open tool gaps

---

## 1. Philosophy

### The Apeiron is the source; `.md` files under `artifacts/` are shadows it casts
- **Node reference, not file path**: Any `.md` mentioned in Aperas skills or given to you is a node reference, not a file path. Any attempt to access, list, or inspect it with filesystem tools (`view_file`, `cat`, `ls`) mistakes the shadow for the source.
- Projections can be regenerated from the graph at any time.
- A projected markdown file is never where a change is made, and never where a question is answered.
- Modifying a projection mistakes the shadow for the source. Reading it gives text stripped of links, backlinks, and graph position.
- Projections on disk can be **unprojected or stale**. Graph truth lives only in Apeiron.
- **Native harness artifacts are for human communication only**: Harness-native artifacts (e.g. Antigravity artifacts) exist solely for presenting proposals, alternatives, or visual designs to the human user. They are never a substrate for task planning, execution tracking, or agent coordination; all task state, implementation tracking, and working memory live exclusively in Apeiron and thread files.

### A claim and its provenance are one object
- A claim without a link to its source/evidence is incomplete.
- Readers must be able to drill down into the supporting evidence subgraph via forward links or backlinks. One of the two must exist before a claim is left in place.

### Substance matures
- **Content Axis**: Formless prose hardens from `discussion` Freeflow into typed concerns (`design`, `issues`, `planning`, `history`).
- **Topology Axis**: Relationships begin mediated by discussion nodes citing both ends; as they prove load-bearing, they crystallize into direct citations.

### System memory over human memory
- Nobody working this graph will remember across weeks or context windows.
- The graph is not just a passive repository; it actively notices structural gaps and omissions unbidden (via queries, checks, and backlinks).

---

## 2. Orientation

### Mandatory Initial Gate
> [!CRITICAL]
> **NEVER START WITH** file-reading tools (`view_file`, `cat`, `head`, `grep_search`) on any path under `artifacts/` before inspecting the graph via `aperas`.
> An `artifacts/**.md` path in your hand is a **node reference**, not a file path.

> [!IMPORTANT]
> **Always begin with View Triage.** Before any inspection or file access, render the structured lens of active views (see [View Triage & Management](#view-triage--management)).

### View Triage & Management
- **Triage active views**:
  ```bash
  aperas profile list <profile>   # e.g. antigravity or claude
  aperas tree --view <view-name>
  ```
- **Manage views**:
  ```bash
  aperas profile create-view <name> --profile <handle>
  aperas unfold <ref> --view <name> --flush
  aperas fold <ref> --view <name> --flush
  ```
- Keep views scoped per task. A view left pointing at last session's work is worse than no view.

### Entering the Corpus
Choose an entry strategy based on your starting point:

- **Top-Down (Frame, then zoom in)**:
  - Start at `design/<concern>.md` for settled architecture.
  - Move through `issues/` and `history/` for open and landed items.
  - Check `discussion/` for reasoning trails before looking at code.
- **Bottom-Up (Pinpoint, then zoom out)**:
  - Grep a concrete symbol, filename, or error string in the raw store:
    ```bash
    grep -n -C3 '<identifier>' AperasKG/Apeiron/BlockNode.jsonld
    ```
    `-C3` context is essential to capture the `@id` line and surrounding fields (which vary in position).
    > [!WARNING]
    > **Grep on symlinks (`git grep` and `grep -r` skip `AperasKG`)**:
    > `git grep` and standard `grep -r` (lowercase `-r`) do **not** follow symlinks and will silently skip `AperasKG` when run from the code repo root! Always use `grep -R` (uppercase `-R`) to follow symlinks when searching across repos, or target `AperasKG/Apeiron/BlockNode.jsonld` directly. When running commands from `monorepo/`, target `../AperasKG/Apeiron/BlockNode.jsonld`.
  - Unfold the matching candidate node: `aperas unfold <id>`.
  - Climb upward via its forward links until you reach `design`.
- **Finding Drift**: Drift is the discrepancy where top-down design and bottom-up code/findings meet. Run both directions to confirm alignment.

### Three Traversal Directions
Every graph traversal moves along three distinct axes:

1. **Forward & Downward (Deeper Content)**:
   - A block's children and outgoing links: what it is made of and what it refers to.
   - Command: `aperas unfold <ref>`
2. **Upward (Surrounding Context)**:
   - Ancestors: the heading it sits under, the thread it belongs to.
   - Climb a level at a time and stop once the block's meaning stabilizes.
3. **Backward (Deeper Context: Dependents & Sources)**:
   - What relies on this block (impact) and what it rests on (provenance).
   - Command: `aperas backlinks <id> --text`
   - Deep read follows sources; **deep write is inherently backward** (you must inspect what a change breaks or makes stale).

---

## 3. Discipline

### Three Roles, One Graph

| Role | Runs As | Writes | Reads |
|---|---|---|---|
| **Orchestrator** | Active session | `discussion` Freeflow, thread `**Ask**` nodes | Graph, threads, **and source code/diffs/tests during Verification** |
| **Grapher** | Subagent | Everything else in graph (deep read/write, promotions, thread lifecycle) | Graph, thread reports |
| **Coder** | Subagent | Source code, `.threads/coder.md` | Source code, graph context |

> [!CRITICAL]
> **Orchestrator Role Gate**:
> **NEVER START WITH** surveying or modifying source code when a task begins. Always delegate initial graph and code surveys to the Grapher and Coder subagents.
> The Orchestrator inspects source code, git diffs, and test outputs **ONLY at the Verification stage** (Step 7 of the task loop).

### The Task Loop (9 Steps)

1. **Open Task**: Orchestrator creates `## <topic>` and `### <task>` in `.threads/grapher.md` and `.threads/coder.md` via graph CLI recipes (see [Step 1 Thread Initialization CLI Recipes](#step-1-thread-initialization-cli-recipes)). Never inspect or touch `.threads/` with filesystem tools.
2. **Grapher Survey**: Grapher surveys graph context (design, issues, drift), writes Report in `.threads/grapher.md`.
3. **Orchestrator Review**: Orchestrator reads Grapher Report (`aperas tree --view <p>-grapher-orchestrator`).
4. **Coder Survey**: Orchestrator asks Coder to map code behavior (no code edits). Coder reports in `.threads/coder.md`.
5. **Grapher Files Survey**: Grapher records Coder findings into graph.
6. **Coder Change**: Coder applies fix and runs tests, reporting diff and results.
7. **Orchestrator Verification**: Orchestrator verifies diff and test output directly (`npm run verify` for code/engine changes; for skill-only tasks, strictly run `python3 skills/aperas/scripts/skill_drift.py` and `npm run aperas -- check-links` — never run `npm run verify` on skill tasks).
8. **Grapher Files Result**: Grapher promotes findings, marks issues resolved.
9. **Finishing Turn**: Repeat steps 6–8 as needed, then Grapher executes the finishing turn.

### Thread Structure (`.threads/{grapher,coder}.md`)

> [!IMPORTANT]
> **`.threads/` is a graph path, not a local directory**:
> `.threads/` is a graph node path rooted under `artifacts/.threads/` in `AperasKG/`. Projections under `artifacts/.threads/` are Git-ignored in `AperasKG`.
> There is no `.threads/` directory in the `Aperas/` code repository. Never run `ls .threads/` or `cat .threads/...`. Access threads strictly through graph commands (`npm run aperas -- tree .threads/grapher.md`, `npm run aperas -- show .threads/grapher.md`).

A thread represents the complete working memory of a subagent across turns. When starting a fresh thread or continuing an existing one, use this tree structure:

```markdown
# Grapher thread                              ← H1: role thread root (in fresh thread)
## <topic>                                   ← H2: named by the user
### <task>                                   ← H3: set by the orchestrator
#### Turn <n>                                ← H4: one exchange with the orchestrator
- **Ask**: <what is wanted, in a sentence>   ← orchestrator; root of <p>-orchestrator-grapher
  - [<argument>](../design/x.md#id/BlockNode:…) — why it matters here
- **Work**: <the approach, in a line>        ← subagent; subturns nested under it
  - <subturn 1: batch progress and exact tool results>
  - <subturn 2: files inspected, lines, failure output>
- **Report**: <the outcome, in a sentence>   ← subagent; root of <p>-grapher-orchestrator
  - [<changed or found node>](…) — what changed, or what it shows
  - **Question**: <whatever the Ask left unsettled>
  - **Tool gap — <what>**: <a workaround built, a call that failed or hung>
  - **Tool gap — <what else>**: <a second one, if the turn hit more than one>
```

#### Step 1 Thread Initialization CLI Recipes
When opening a task in Step 1 of the task loop, use these graph CLI commands without touching the disk:

```bash
# 1. Inspect existing thread tree to locate the topic or root ID:
npm run aperas -- tree .threads/grapher.md
# (To resolve the ArtifactNode ID if starting fresh: npm run aperas -- show .threads/grapher.md)

# 2. Insert ## <topic> heading if it does not yet exist:
echo "## <topic-name>" | npm run aperas -- insert <thread-root-id> --flush

# 3. Insert ### <task> heading under the topic:
echo "### <task-name>" | npm run aperas -- insert <topic-heading-id> --flush

# 4. Insert #### Turn 1 heading under the task:
echo "#### Turn 1" | npm run aperas -- insert <task-heading-id> --flush

# 5. Insert initial **Ask** with Freeflow citation under the turn heading:
cat << 'EOF' | npm run aperas -- insert <turn-heading-id> --flush
- **Ask**: <what is wanted, in a sentence>
  - [<Freeflow decision>](../discussion/<topic>.md#id/BlockNode:<ID>) — why it matters here
EOF

# 6. Repeat for .threads/coder.md when opening coder turns.
```

#### Core Thread Disciplines
- **A follow-up is a new turn, not an edit to an old one**: Never mutate prior turns to add follow-up work.
- **Every turn has subturns**: At least one per batch of tool calls. Record the essence of each tool result (failing line numbers, node IDs, counts, filenames) — not just "ran tests".
- **Record friction**: Record workarounds, retries, and tool failures under distinct `**Tool gap — <topic>**` lead-ins (identical lead-ins collide on slug generation).
- **Ask back instead of guessing**: Not only against the Ask, but for **anything unsure during execution** — unexpected code behaviors, conflicting requirements or evidence, missing schemas/dependencies, architectural trade-offs, or unexpected tool failures — the subagent **must stop and ask back** via a `**Question**` in its Report rather than making speculative assumptions. Guessing wastes full round trips and creates technical debt.

### Hand-Off Views & Zooming

The view carries the graph state (`this`); the chat message carries only control and pointers.

| View Name | Owner | Faces | Rooted On |
|---|---|---|---|
| `<p>-<topic>` | Orchestrator | User | `discussion/<topic>.md` `## Dashboard` |
| `<p>-orchestrator-grapher` | Orchestrator | Grapher | Current Ask in `.threads/grapher.md` |
| `<p>-orchestrator-coder` | Orchestrator | Coder | Current Ask in `.threads/coder.md` |
| `<p>-grapher-orchestrator` | Grapher | Orchestrator | Current Report in `.threads/grapher.md` |
| `<p>-coder-orchestrator` | Coder | Orchestrator | Current Report in `.threads/coder.md` |

**Zooming Rule**: On every hand-off, zoom the view onto the current turn's root (`**Ask**` or `**Report**`):
```bash
aperas zoom <turn-node-id> --view <view-name> --flush
```
The receiver always reads `aperas tree --view <sender-view>` before doing any work.

### Every Claim Carries Its Source
Before leaving a claim in place (a freeflow finding, thread report, or formal doc entry), confirm its provenance:
- Threads and freeflow cite forward to what they rest on.
- Formal doc entries are checked via `aperas backlinks <id> --text` to confirm supporting links exist.

### Citation Direction & Gradients
The concern taxonomy forms a strict abstraction gradient:
```
design (most abstract)
  ↑
issues / planning / history
  ↑
concepts.md
  ↑
discussion
  ↑
threads (least abstract — Git-ignored)
```
- Citations may point **UP** or **SIDEWAYS**.
- Citations must **NEVER point DOWN** (except normative singular references, such as a doc's `# Context` section).
- Nothing above the thread tier may link into `.threads/`. Content reaches the graph from threads by the Grapher copying it up, never by citation.

### Stage Each Verified Step
- After each verified mutation, stage changes immediately with `git add`:
  - Code changes in the code repo.
  - Graph mutations in `AperasKG/`.
- **Important Rationale**: Staging creates a running checkpoint for **your own recovery when an operation goes wrong (usually!)**. If a subsequent command misreconciles or corrupts state, `git restore` / `git diff` against the staged index recovers cleanly.
- **Staging only, never commit** (`git commit` is reserved for the user).

---

## 4. Mechanics

### Quick Syntax & Command Reference

| Operation | Command Pattern | Key Rule / Note |
|---|---|---|
| **Peek Node** | `aperas unfold <ref>` | Read-only peek; does not mutate view |
| **Unfold into View** | `aperas unfold <ref> --view <name> --flush` | Adds `<ref>` to view's unfolds set |
| **Inspect Backlinks** | `aperas backlinks <id> --text` | Inspects dependents and provenance |
| **Render View Tree** | `aperas tree --view <name>` | Renders structured lens of the view |
| **Raw Stored Text** | `aperas show <ref> --text` | Exact stored text undecorated (safe for editing) |
| **Full Node State** | `aperas show <ref>` | Inspects props, tombstonedAt, links, parent, children |
| **Insert Turn Node** | `cat turn.md \| aperas insert <turn-id> --after <ask-id> --flush` | Pipes markdown subtree; appends or positions `--after` anchor |
| **Zoom View** | `aperas zoom <node-id> --view <name> --flush` | Re-roots view onto current Ask or Report |
| **Retitle Heading** | `echo "## Title" \| aperas update <id> --text-only --flush` | **Must use `--text-only`** to preserve child blocks |
| **Update List Item** | `echo "text" \| aperas update <id> --text-only --flush` | Bare text updates text/title while **preserving children** |
| **Replace List Item** | `echo "text" \| aperas update <id> --flush` | Bare text replaces text and **tombstones unstated children** |
| **Clear Checkbox** | `echo "- text" \| aperas update <id> --flush` | Bare bullet `- ` removes checkbox entirely |
| **Insert List Item** | `echo "- text" \| aperas insert <parent> --after <sibling> --flush` | Unordered items **must include bullet `- `** |
| **Reposition Node** | `aperas insert <node-id> --after <anchor-id> --flush` | **No stdin piped** moves node without reminting ID |
| **Retype Block** | `aperas retype <ref> --to <type>` | In-place kind change (`h1`..`h6`, `listItem`, etc.) |
| **Sweep Links** | `aperas check-links` (or `--repair`) | Verifies internal wikilink integrity |
| **Restart Service** | `aperas service restart` | Flushes and restarts daemon from disk |
| **Reload Disk State** | `aperas reload -- --discard` | Clears memory orphans after failed insert |

### Common Command Patterns

```bash
# 1. Traversal & Inspection
aperas unfold <ref>                           # Read-only peek
aperas unfold <ref> --view <name> --flush     # Unfold into view
aperas backlinks <id> --text                  # Inspect backlinks and provenance
aperas tree --view <name>                     # Render view tree
aperas show <ref> --text                      # Stored text only (undecorated)

# 2. Turns & Hand-Off Zooming
cat turn.md | aperas insert <turn-id> --after <ask-id> --flush # Insert Work + Report tree after Ask
aperas zoom <node-id> --view <name> --flush   # Re-root view onto node

# 3. Safe Edits
echo "## New Title" | aperas update <heading-id> --text-only --flush   # Heading update (preserves children)
echo "Updated text" | aperas update <item-id> --text-only --flush      # List item update (preserves children)
echo "Replaced item" | aperas update <item-id> --flush                 # Replaces text AND tombstones children
echo "- New child" | aperas insert <parent-id> --after <sibling-id> --flush # List item insert

# 4. Service & Integrity
aperas check-links                            # Sweep internal link integrity
aperas check-links --repair                   # Re-resolve and persist repairs
aperas service restart                        # Flush and restart service daemon
aperas reload -- --discard                    # Discard memory state and re-read disk
```

### Path Resolution & Two-Repo Architecture
The Aperas workspace is split across two sibling git repositories:
- `Aperas/`: The code repository containing `monorepo/`, packages, and skills.
- `AperasKG/`: The knowledge graph repository containing `Apeiron/` (the raw store mirror) and `artifacts/` (projected markdown docs).

Within `Aperas/`, a tracked symlink points to the graph repository:
```
Aperas/AperasKG -> ../AperasKG
```

**Resolution Rule**:
Paths passed to the `aperas` CLI always resolve relative to the graph's `artifacts` root defined in `aperas.config.json` (i.e. `AperasKG/artifacts/`), **never** against the filesystem `$CWD` or code repository root.
- **CORRECT**: `npm run aperas -- project discussion/foo.md`
- **CORRECT**: `npm run aperas -- tree .threads/coder.md`
- **INCORRECT**: `npm run aperas -- project AperasKG/artifacts/discussion/foo.md` (fails with "No ingested ArtifactNode or FolderNode found").
- **INCORRECT**: Resolving `.threads/` against `$CWD` (`Aperas/.threads/` does not exist on disk).

### Wikilink & Link Syntax
The link resolver recognizes:
- **Bare relative paths** (`./file.md` or `../folder/file.md`): Resolve directly to the whole target `ArtifactNode` or `FolderNode`. No fragment needed when citing an entire document or folder.
- **Fragment links** (`path#id/BlockNode:<ID>` or `path#anchor`): Required when linking to a specific block or heading *within* an artifact.
  - Direct node ID: `[Title](../folder/file.md#id/BlockNode:<ID>)` (unambiguous, preferred).
  - Anchor match: `[Title](../folder/file.md#heading-title)` (matches `name='...' class='aperas-anchor'`).
- **Scheme prefixes**: `[[code]]`, `aperas://tree/<path>`, or `aperas://id/<ID>`.

*Note*: An internal block link without `#id/...` or `#anchor` resolves to the whole document, not the specific block. Always verify block-level links with `aperas backlinks BlockNode:<ID> --text` on the target block.

### Anchor Placement — The Bold-Colon Rule
In list items, the lead-in colon must sit **outside** the bold span:
- `**Term**: text` (CORRECT)
- `**Term:** text` (INCORRECT — rejected by lead-in detector; anchor gets spliced into random text).

### Sketching a Structure
Build new headings or subtrees directly in the graph with zero disk-first authoring:
1. Create placeholder node:
   ```bash
   aperas resolve --create-holder <path> --titles "<Heading Title>"
   ```
2. Populate content using `aperas update` and `aperas insert`.

### Multi-Node Tree Piping and `--after` Anchors
Markdown piped into `aperas insert <parent-id> [--after <anchor-id>]` parses into an AST and inserts the entire subtree:
- **Multi-node piping**: You can pipe multiple top-level list items or paragraphs in a single command (e.g. piping `- **Work**: ...` and `- **Report**: ...` together). All piped root items are inserted as direct children under `<parent-id>`.
- **Hierarchical nesting**: Nested sub-bullets beneath piped items parse into child BlockNodes cleanly attached to their parent items.
- **Anchor positioning**: The `--after <anchor-id>` flag positions the inserted batch directly after the specified anchor child (e.g. inserting Work and Report after the turn's `**Ask**` node).
- **Anchor constraint**: The anchor node must be a **direct child** of `<parent-id>`, not a descendant. Check tree structure first via `aperas tree` or `aperas show <parent-id>`. If an anchor is invalid, the insert fails after hydrating nodes into memory, leaving live orphans. Recover by running `aperas reload -- --discard`.

### Inserting into Lists

- **Unordered Lists**:
  - Pipe bare text **with its bullet marker**:
    ```bash
    echo "- new item" | aperas insert <parent-id> --after <sibling-id> --flush
    ```
  - **Never pipe plain text without a bullet**: it parses as a paragraph, breaking the list run.

- **Ordered Lists**:
  - Appending at the end is safe when the numbering continues (`n. new item`).
  - Inserting in the middle requires renumbering everything after it. Target the **parent heading** (`aperas update <heading-id>`) and pipe the heading line plus the *complete* list verbatim with the new item included.

### Updating an Existing List Item (`aperas update <item-id>`)

- **Preserving Children with `--text-only`**:
  ```bash
  echo "updated text" | aperas update <item-id> --text-only --flush
  ```
  `--text-only` updates the item's `.text` (and `.title` if a lead-in exists) while leaving all existing child blocks completely untouched.
- **Ordinary text change without `--text-only`**:
  Pipe bare text with **no bullet marker**:
  ```bash
  echo "updated text" | aperas update <item-id> --flush
  ```
  *Note*: Without `--text-only`, this replaces the item's text **and reconciles its children** (tombstoning any unstated child blocks).
- **Checkboxes**:
  - Marker `- [x]` or `- [ ]` sets checkbox state.
  - Bare `- ` with text (marker-less bullet) **removes an existing checkbox entirely**.
- **Ordered List Items**:
  - Use `n.` marker when updating an ordered item (e.g. `echo "1. updated text" | aperas update <item-id> --flush`).
  - Updating an item never changes its position in the list (ordered or unordered, its sequence position is preserved). To reorder or renumber, update the parent heading with the complete list.
- **Deliberately blank text**: A bare `- ` (bullet with nothing after it) clears the item's text while allowing children to be attached.
- **Title Tracking**: The title updates if text has a bold lead-in (`**Term**: ...`). Without one, title falls back to the item's ID.
- **Symmetry Rule**: Whichever piece you do not restate without `--text-only` is wiped. If you pipe only text with no children and no `--text-only`, existing children are tombstoned. Restate whichever side you are not modifying, or use `--text-only`.

### Updating a Heading (`--text-only`)
- Calling `aperas update <heading-id>` without `--text-only` reconciles children against piped input. Piping just `## Title` tombstones all existing child blocks!
- **Always use `--text-only`** when retitling headings:
  ```bash
  echo "## Corrected Heading" | aperas update <heading-id> --text-only --flush
  ```
  `--text-only` updates `.title` and `.text` while leaving child blocks completely untouched.

### Changing Block Types (`aperas retype`)
Convert a block's type in place while preserving ID, links, parent, and position:
```bash
aperas retype <ref> --to <type>   # h1..h6, paragraph, listItem, code, blockquote, table
```
- Heading → non-heading folds title into text as `**Title**: <body>`.
- Non-heading → heading cuts lead-in term back into the heading line.

### Renaming Artifacts
- **Single Artifact**:
  ```bash
  git mv old.md new.md
  aperas ingest <new-path> --track --flush
  ```
  Rename detection matches by abstract-text equality against tracked nodes whose old path vanished.
- **Cross-Referencing Docs**: Complete all internal content/heading/path updates first while files remain at old names; verify with `check-links`, then execute `git mv`.

### Shell Quoting Gotcha
A piped `echo "..."` silently drops nested double quotes in bash (`"foo "bar" baz"` becomes `foo bar baz`).
- For content with quotes, write to a temporary file first and pipe via `cat`:
  ```bash
  cat /tmp/content.md | aperas update <id> --flush
  ```

### Service State & Recovery
- Flush and restart daemon from disk mirror:
  ```bash
  aperas service restart
  ```
- Discard uncommitted in-memory mutations and reload disk state:
  ```bash
  aperas reload -- --discard
  ```

### Raw Node State Inspection
Preview commands (`tree`, `unfold`, `backlinks`) display truncated abstracts. To inspect exact stored state:
```bash
aperas show <ref>          # Full record: props, tombstonedAt, parent, children, links, text
aperas show <ref> --text   # Exact stored text only, undecorated
```
To edit safely: dump `aperas show <ref> --text > edit.txt`, modify what is needed, and `cat edit.txt | aperas update <ref> --flush`.

### `aperas unfold` — Bare vs. `--view`
- Bare `aperas unfold <ref>`: Read-only peek; does not mutate any view.
- `aperas unfold <ref> --view <name> --flush`: Adds `<ref>` to `<name>`'s `unfolds` set for persistent rendering in `aperas tree --view <name>`.

### Tombstoned Nodes
Tombstoned nodes and their subtrees are hidden everywhere by default:
- `aperas tree` and `aperas unfold` omit them unless `--tombstoned` is passed.
- `aperas unfold <tombstoned-id>` errors out without `--tombstoned`.

### Full-Text Search via Raw Store
Grep the JSON-LD mirror directly for fast, untruncated content search:
```bash
grep -n -C3 '<pattern>' AperasKG/Apeiron/BlockNode.jsonld
```
Matches are candidate IDs. Always inspect live status via `aperas show <id>`.

> [!WARNING]
> `git grep` and `grep -r` skip symlinked directories like `AperasKG -> ../AperasKG`. Always use `grep -R` to follow symlinks, or specify the path directly (e.g. `grep -n -C3 '<pattern>' AperasKG/Apeiron/BlockNode.jsonld` from repo root, or `../AperasKG/Apeiron/BlockNode.jsonld` from `monorepo/`).

### Comparing Distant Docs (View as a Lens)
Use `--view` to bring distant parts of the tree together side by side:
```bash
for doc in issues/a.md discussion/b.md design/c.md; do
  aperas unfold "$doc" --view comparison-lens --flush
done
aperas tree --view comparison-lens
```

### Breadcrumbs in `aperas tree`
The first line of an `aperas tree` render is a breadcrumb: `aperas://tree/<path>`.
- Represents the walkable path of the starting apex, directly reusable as a `<ref>`.
- Appears once at the top; child lines are implicitly relative to it.
- When an unfolded link escapes into an external viewcone, an indented breadcrumb marks the jump.

### Link Integrity Sweeps
```bash
aperas check-links           # Sweep corpus for unresolved internal wikilinks
aperas check-links --repair  # Re-resolve and persist repairs to store
```

### Verification Scope — Code vs. Skills
- **Code/Engine changes**: Run `npm run verify` (from `monorepo/`) to execute build, lint, and engine tests.
- **Skill-only changes**: Strictly **NEVER** run `npm run verify`! Running full test suites on skill edits causes unnecessary hangs, compute waste, and test timeouts. For skill-only changes, verify using:
  ```bash
  python3 skills/aperas/scripts/skill_drift.py
  npm run aperas -- check-links
  ```

---

## 5. Reference

- `AperasKG/artifacts/design/linking.md` — Canonical spec for addressing, anchors, and wikilink syntax.
- `AperasKG/artifacts/design/documentation.md` — Concern taxonomy and Freeflow document structures.
- `AperasKG/artifacts/design/aperas-skill.md` — The four-level architecture, citation directions, and promotion lifecycle.
- `archive/Aperas-design.md` — Founding philosophy: Apeiron / Aperas / Peras.

### Open Tool Gaps

Tracked in the graph rather than accumulating here:
- `aperas resolve`'s title-ambiguity check does not filter tombstoned candidates: a dead holder can still make a live path read as ambiguous (`discussion/core.md`'s Freeflow). Workaround: resolve the live node by ID directly.
- The link-integrity drift check is built and live (`aperas check-links`, see *Mechanics* — `issues/linking.md`).
- The `verify.ts` id-anchor emission idempotency failure is fixed and passing (`discussion/core.md`).
