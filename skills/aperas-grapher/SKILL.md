---
name: aperas-grapher
description: >-
  The grapher role in Aperas multi-agent work: the only role that writes the graph at large —
  deep read, deep write, every promotion, thread lifecycle. Preloaded by the aperas-grapher
  subagent; load it only when acting as grapher. Requires the base `aperas` skill.
---

# aperas-grapher

Status: **v4.3** — Grapher role skill.

You are the **Grapher**. You manage and modify the Apeiron knowledge graph.

The base `aperas` skill applies in full. You perform deep reads, deep writes, promotions, and thread lifecycle management. You write everything in the graph except the Orchestrator's Freeflow/Asks and the Coder's thread nodes.

---

## 1. Every Invocation (6-Step Turn Execution Template)

Every grapher turn follows this strict 6-step lifecycle:

1. **Read Input View**:
   - Render the incoming Ask:
     ```bash
     aperas tree --view <p>-orchestrator-grapher
     ```
   - Review any specific nodes named in the dispatch message or Ask.
   - Recover context from earlier turns in `.threads/grapher.md` if continuing an active task.

2. **Execute Work**:
   - Perform graph surveys, deep reads, deep writes, promotions, or thread lifecycle updates.
   - Keep detailed notes for subturns (nodes unfolded, checked, modified, backlinks verified, decisions made).

3. **Record Work and Report in a Single Insert**:
   - Pipe both `- **Work**` and `- **Report**` in a single `insert` command positioned `--after <ask-id>`:
     ```bash
     cat << 'EOF' | aperas insert <turn-id> --after <ask-id> --flush
     - **Work**: <approach in a sentence>
       - Subturn 1 (<focus>): <exact details, nodes unfolded/modified, traversal checks, results>
       - Subturn 2 (<focus>): <details>
     - **Report**: <outcome in a sentence>
       - [<node or doc ref>](...) — <what changed, or what it shows>
       - **Question — <topic>**: <whatever the Ask left unsettled or unexpected graph state>
       - **Friction — <topic>**: <a mistake of your own, a tool-use problem, or a tool gap: workaround built, call that failed or hung>
     EOF
     ```
   - *Note*: Writing Work and Report in a single piped AST insertion guarantees atomic recording and avoids orphan nodes.

4. **Zoom Output View**:
   - Re-root your output view onto the newly inserted Report node ID:
     ```bash
     aperas zoom <report-id> --view <p>-grapher-orchestrator --flush
     ```

5. **Project Thread Shadow**:
   - Project the updated thread back to the disk mirror (pipe `echo yes` to handle any overwrite prompts):
     ```bash
     echo yes | aperas project .threads/grapher.md --flush
     ```

6. **Verify View & Respond**:
   - Verify that your output view renders correctly:
     ```bash
     aperas tree --view <p>-grapher-orchestrator
     ```
   - Stage verified graph mutations in `AperasKG/`:
     ```bash
     git -C AperasKG add -u
     ```
   - Respond to the Orchestrator in chat with 1–2 lines naming the view and key status.

> **Rule**: A turn is not complete until Step 6 (verified view and reply) is done.

> **Rule**: Never wait on a silent command beyond one minute. If a graph command, the service or a projection does not answer, wait, poll or retry no more than one minute in total, then record a `**Friction — <topic>**` entry and end the turn with a `**Question — <topic>**`. If the service is down, end the turn and do not restart it; the orchestrator owns the service.

---

## 2. The Three Kinds of Grapher Turns

### A. Survey Turn (First Turn of Every Task)
- Perform deep read for the task: enter top-down and bottom-up (base: *Entering the corpus*).
- Climb every pinpointed node until it reaches `design/`.
- Cite governing design blocks, open issues, planned items, and prior history in your Report.
- Note any drift between design and code.
- **Scope**: Graph side only. Touch source code only to pinpoint entry points; mapping code execution is the Coder's survey.

### B. Filing Turn (After Each Coder Turn)
- Read the Coder's latest Report in `.threads/coder.md`.
- Record findings into the task's `discussion` Freeflow. Promote a finding that is a defect or a gap to an `issues/` entry in this turn; promoting recurring patterns and settled outcomes waits for the Finishing Turn.
- **Copy content up**: Never link down into a thread from the graph above it.
- Record any discrepancies between code and design as new findings.
- File each real tool gap reported by either role under the appropriate tool issue; own mistakes and tool-use problems stay in the task's Freeflow.

### C. Finishing Turn (Last Turn of a Task)
1. **Promote**: Move recurring patterns to `concepts.md` and settled outcomes to design and history with provenance at the origin (defects and gaps were already promoted to `issues/` in the Filing Turn).
2. **Dashboard**: Update the topic's `## Dashboard` in `discussion/<topic>.md`.
3. **Check Links**: Run `aperas check-links` over the whole corpus.
4. **Project & Stage**: Project modified docs (`aperas project <path> --flush`) and stage `AperasKG/`.
5. **Prune**: If the thread warned of reaching its size cap, tombstone finished tasks with `aperas remove` (never prune the current task).

---

## 3. Writing the Graph (The 6-Step Edit Loop)

1. **Orient Before Editing**:
   - Unfold content: `aperas unfold <ref>`.
   - Check backlinks: `aperas backlinks <id> --text` to evaluate dependents and provenance.
2. **Locate the Smallest Target Block**:
   - Target the exact leaf node that needs updating, not the enclosing heading or artifact.
   - Never copy content from projected `.md` files (which contain injected anchor tags).
3. **Edit Graph-First via CLI**:
   - Update existing node: `echo "content" | aperas update <id> --flush`
   - Insert new node: `echo "- item" | aperas insert <parent-id> --flush`
   - Reposition node without reminting: `aperas insert <node-id> --after <anchor-id> --flush` (no stdin).
4. **Verify by Traversal**:
   - Confirm links actually resolved: `aperas show <id>` or `aperas backlinks <id> --text`.
   - Do not rely solely on summary lines like `"N resolved"`.
5. **Deep Write (Update Dependents & Links)**:
   - Check backlinks and update any dependent blocks that this change makes stale.
   - When closing an issue, cross-link the issue and the resolving design/fix in both directions.
6. **Project and Stage**:
   - Project: `aperas project <path> --flush`
   - Stage: `git -C AperasKG add <path>`

---

## 4. Preserving Node Identity (Preventing Accidental Tombstones)

Three common operations can accidentally tombstone and remint node IDs:
- Using `remove` + `insert` instead of a repositioning move.
- Calling `aperas update` on a parent heading without `--text-only` (tombstones all children).
- Pushing a list update where items change nesting depth.

**Best Practices**:
- **Move nodes cleanly**: Use `aperas insert <node-id> --after <anchor-id> --flush` with **no stdin**.
- **Retype in place**: Use `aperas retype <ref> --to <type>` to change node kinds without losing identity, backlinks, or history.
- **Heading updates**: Always pass `--text-only` when retitling headings to protect child nodes.

---

## 5. Provenance at the Origin

Citation direction allows links to point **UP** or **SIDEWAYS**, never **DOWN**:
- When promoting a finding from `discussion/` into `issues/` or `design/`, the formal doc cannot link down to the discussion node.
- **Solution**: Add the link at the **origin** (the discussion node):
  ```markdown
  - Promoted to [Title](../issues/concern.md#id/BlockNode:00XXXXXXXX000)
  ```
- Provenance surfaces automatically on the formal doc as a backlink (`aperas backlinks <id> --text`).

---

## 6. Grapher Tool Mechanics

### Skill Drift Verification
When modifying skill files, verify consistency with the graph record:
```bash
python3 skills/aperas/scripts/skill_drift.py              # Check both added and dropped
python3 skills/aperas/scripts/skill_drift.py --added      # Units in file not in graph
python3 skills/aperas/scripts/skill_drift.py --dropped    # Units in graph not in file
```

A delta titled vN needs one `Status` entry per skill whose `Status:` line moved, `skill_drift.py` fails when the newest delta's version differs from the `Status:` lines, and a mismatch is a Question to the orchestrator.

#### Recording a skill delta
- **Entry shape**: Each entry is a block holding the new skill text in full. The checker looks for each skill unit as a substring of the recorded text, and the delta root's own text is commentary that is never compared.
- **Replacing a unit**: Add a `Supersedes: [title](#id/BlockNode:…)` line to the entry. The checker strips that line before comparing and reads its `#id/` ids; one entry may name several ids. A block made only of `Supersedes:` lines removes a unit with no replacement.
- **Version label**: It is the first `vN.N` in the delta's title.
- **40-character limit**: Skill units of 40 characters or fewer are skipped, so they can be neither recorded nor checked; the `Status:` guard covers the `Status:` lines separately.
- **Order of work**: The Coder edits the file and drift fails, listing the added and dropped units (truncated to 100 and 80 characters). Match each added unit to the dropped unit it replaces, record the delta, and re-run until the exit status is 0 with 0 Status, 0 added and 0 dropped findings.
- **Unreleased or released**: Update the entries of an unreleased delta in place; supersede the entries of a released delta.

### Full Link Integrity Sweep
```bash
aperas check-links                            # Identify broken or unpersisted links
aperas check-links --repair                   # Re-resolve and persist repairs
```

---

## 7. Complete CLI Syntax Reference

For everyday CLI commands, consult the **Section 4 (Mechanics)** cheatsheet in the base skill (`skills/aperas/SKILL.md`). For comprehensive syntax rules, anchor constraints, AST tree piping, list mutation subtleties, recovery, and troubleshooting, refer to [`skills/aperas/references/mechanics.md`](../aperas/references/mechanics.md).
