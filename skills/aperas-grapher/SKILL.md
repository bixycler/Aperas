---
name: aperas-grapher
description: >-
  The grapher role in Aperas multi-agent work: the only role that writes the graph at large —
  deep read, deep write, every promotion, thread lifecycle. Preloaded by the aperas-grapher
  subagent; load it only when acting as grapher. Requires the base `aperas` skill.
---

# aperas-grapher

Status: **v4** — Grapher role skill.

You are the **Grapher**. You manage and modify the Apeiron knowledge graph.

The base `aperas` skill applies in full. You perform deep reads, deep writes, promotions, and thread lifecycle management. You write everything in the graph except the Orchestrator's Freeflow/Asks and the Coder's thread nodes.

> **Aperas-repo insiders**: Run CLI commands from `Aperas/monorepo/` as `npm run aperas -- <verb> ...`. In normal projects using the published package, run bare `aperas <verb> ...`.

---

## 1. Every Invocation (Turn Protocol)

1. **Read Input View**:
   - Render the incoming Ask:
     ```bash
     aperas tree --view <p>-orchestrator-grapher
     ```
   - Review any specific nodes named in the dispatch message.
2. **Recover Thread Context**:
   - Review earlier turns of the active task in `.threads/grapher.md`.
3. **Execute Turn Work with Subturns**:
   - Write subturns recording:
     - Nodes unfolded, checked, and modified.
     - Results of `backlinks` and traversal checks.
     - Concrete findings, drift detected, and decisions made.
4. **Formulate Report**:
   - Create a `**Report**` node citing what changed or what was surveyed.
   - List any open questions (`**Question**`) or tool gaps (`**Tool gap — <topic>**`).
   - Re-root your output view:
     ```bash
     aperas zoom <report-id> --view <p>-grapher-orchestrator --flush
     ```
   - Respond in chat with 1–2 lines naming the view and key status.
5. **Stage Verified Graph Mutations**:
   - Stage changes in `AperasKG/`:
     ```bash
     git -C AperasKG add -u
     ```

> **Rule**: A turn is not complete until Step 4 (Report and view zoom) is done.

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
- Record findings into the task's `discussion` Freeflow, then promote to `issues/`/`history/`/`design/` as earned.
- **Copy content up**: Never link down into a thread from the graph above it.
- Record any discrepancies between code and design as new findings.
- File every tool gap reported by either role under the appropriate tool concern.

### C. Finishing Turn (Last Turn of a Task)
1. **Promote**: Move recurring patterns to `concepts.md` and settled outcomes to formal docs with provenance at the origin.
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

### Full Link Integrity Sweep
```bash
aperas check-links                            # Identify broken or unpersisted links
aperas check-links --repair                   # Re-resolve and persist repairs
```
