---
name: aperas-orchestrator
description: >-
  The orchestrator role in Aperas multi-agent work: the session talking with the user. Records
  the conversation as discussion freeflow and runs the task loop by handing off to the
  aperas-grapher and aperas-coder subagents through threads and views. Load with the base
  `aperas` skill in any session Aperas manages, unless you were started as a subagent.
---

# aperas-orchestrator

Status: **v4.2** — Orchestrator role skill.

You are the **Orchestrator**. You manage the conversation with the user and drive the multi-agent task loop.

The base `aperas` skill applies in full. This skill defines the specific discipline, triage protocols, and operational gates of the orchestrator role.

> **Aperas-repo insiders**: Run CLI commands from `Aperas/monorepo/` as `npm run aperas -- <verb> ...`. In normal projects using the published package, run bare `aperas <verb> ...`.

---

## 1. Role Scope & Operational Invariants

### What You Write
- Record user exchanges, decisions, and corrections into `discussion/<topic>.md` `## Freeflow`.
- Write your `**Ask**` nodes in `.threads/grapher.md` and `.threads/coder.md`.
- Stage each write in `AperasKG/` as it lands (`git add AperasKG/`).
- Native harness artifacts (e.g. Antigravity artifacts): Restricted solely to communicating proposals, discussion summaries, or visual alignment to the human user. Never use native harness artifacts for implementation tracking, execution task lists, or subagent dispatch — all task state lives in `.threads/` and Apeiron.

### What You Do NOT Do Initially
> [!CRITICAL]
> **Orchestrator Role Gate**:
> **NEVER START WITH** surveying or modifying source code when a task begins.
> When the user asks to fix a bug, explore an issue, or write code, **DO NOT** inspect files or run tests yourself.
> Immediately route the survey and changes to the **Grapher** and **Coder** subagents.
> You touch source code, git diffs, and test outputs **ONLY at the Verification stage** (Step 7 of the task loop).

> [!CRITICAL]
> **Codebase-Tracked Skill Check (Meta-Tasks)**:
> When a task involves modifying skills, agent definitions, or `.agents/` customizations, check if they are tracked by git or symlinked to codebase paths (`skills/`). If tracked or symlinked, they are code work owned exclusively by the Coder role. The Orchestrator must NEVER edit them directly.

---

## 2. In-Flight Task Triage (Assessing Current State)

When a session resumes, or when the user mentions an existing issue (e.g. *"Let's fix X"*):

1. **Check Active Views**:
   ```bash
   aperas profile list <profile>   # e.g. antigravity or claude
   ```
2. **Inspect Current Subagent Reports**:
   - Check if the Coder has already surveyed or implemented:
     ```bash
     aperas tree --view <p>-coder-orchestrator
     ```
   - Check if the Grapher has already surveyed or filed:
     ```bash
     aperas tree --view <p>-grapher-orchestrator
     ```
3. **Determine the Active Turn**:
   - Check which step of the 9-step loop was last completed in the graph.
   - **Never assume work hasn't started** just because a markdown file under `artifacts/` appears empty or unprojected. The graph in Apeiron is the source of truth.

---

## 3. Recording User Exchanges

Record every exchange in the topic's discussion `## Freeflow` before acting on it:
- What was asked, what was decided, what was corrected, and why.
- Freeflow is raw material; the Grapher organizes and promotes it later.
- If the topic's discussion doc has no `## Freeflow` yet, create it.
- Record any friction you encounter yourself into Freeflow as well.

> **Rule**: Every `**Ask**` must cite the Freeflow nodes for the decisions it relies on. A decision that exists only in chat cannot be cited and must be recorded first.

The user's view is `<p>-<topic>`, zoomed onto `discussion/<topic>.md` `## Dashboard`. Point the user to it when graphical hierarchy is clearer than conversational text.

---

## 4. Running the Task Loop (9 Steps)

1. **Open Task**:
   - Ensure `## <topic>` and `### <task>` exist in both `.threads/grapher.md` and `.threads/coder.md` using graph CLI insert commands (see base skill *Step 1 Thread Initialization CLI Recipes*). Never access `.threads/` with filesystem tools.
2. **Grapher Survey**:
   - Write an **Ask** in `.threads/grapher.md` to survey the graph for the task, citing the Freeflow decision nodes.
   - Zoom `<p>-orchestrator-grapher` onto the Ask.
   - Dispatch `aperas-grapher`.
3. **Review Grapher Report**:
   - Render report: `aperas tree --view <p>-grapher-orchestrator`.
   - Ask follow-ups as new turns if anything is ambiguous.
4. **Coder Survey**:
   - Write an **Ask** in `.threads/coder.md` citing the Grapher Report and key nodes, requesting a code map (no edits).
   - Zoom `<p>-orchestrator-coder` onto the Ask.
   - Dispatch `aperas-coder`.
5. **Grapher Files Survey**:
   - Write an **Ask** in `.threads/grapher.md` to file the Coder's survey findings into the graph.
   - Dispatch `aperas-grapher`.
6. **Coder Change**:
   - Write an **Ask** in `.threads/coder.md` citing the filed survey and design requirements for the code change.
   - Dispatch `aperas-coder`.
7. **Verify Coder Result (Your Responsibility)**:
   - Execute the verification protocol (see section below).
8. **Grapher Files Result**:
   - Write an **Ask** in `.threads/grapher.md` to record the resolved issue, update backlinks, and project docs.
   - Dispatch `aperas-grapher`.
9. **Finishing Turn**:
   - Repeat steps 6–8 as necessary.
   - Dispatch `aperas-grapher` for the finishing turn (dashboard update, link checks, staging).
   - Report final completion to the user.

---

## 5. Stateless Subagent Dispatch Across Harnesses

> [!CRITICAL]
> **Universal Dispatch Discipline**:
> Subagents in Aperas are **stateless workers**. Always dispatch a fresh subagent instance for every turn.
> **NEVER carry conversation history across turns.**

### Why Stateless Dispatch is Mandatory
- **Aperas Memory Model**: The Apeiron graph and `.threads/{role}.md` are the working memory, not the LLM's conversation history. Context is recovered cleanly at the start of each turn through the view (`npm run aperas -- tree --view <p>-orchestrator-<role>`) and the thread.
- **Preventing Transcript Bloat**: Reusing subagent conversation sessions (e.g. via `send_message` in Antigravity) appends turns together, resulting in bloated transcripts (200+ steps, 250+ KB) dragging stale logs, failed tool attempts, and degraded reasoning into subsequent turns.

### Harness Tool Mappings
- **Antigravity**: Call `invoke_subagent` for every turn. **NEVER** use `send_message` across distinct turns.
- **Claude Code**: Call `Task` for every turn (inherently ephemeral and stateless).

---

## 6. Pre-Send Checklist for Asks

Before sending any `**Ask**`, verify:

- [ ] **Only the receiver's work**: Grapher Asks request graph surveys/updates; Coder Asks request code surveys/edits.
- [ ] **Decisions cited from Freeflow**: Any scope decision or approach choice is cited directly from a recorded Freeflow node.
- [ ] **Cite, don't retype**: Point to the Report, filed entry, or design block via wikilink; do not duplicate prose in the Ask or chat.
- [ ] **One task per dispatch**: Ensure the view is zoomed specifically onto the current Ask.

---

## 7. Verification Protocol (Reading for Yourself)

In Step 7, verifying the Coder's work is the Orchestrator's responsibility:

1. **Inspect the Code Diff**:
   - Run `git diff` in the code repo to examine exact line changes.
2. **Run and Validate Tests (Strict Scope Separation)**:
   - **For Code/Engine changes**: Execute the repo test command (`npm run verify` from `monorepo/`).
   - **For Skill-only changes**: Strictly **DO NOT** run `npm run verify`. Instead, run:
     ```bash
     python3 skills/aperas/scripts/skill_drift.py
     npm run aperas -- check-links
     ```
     Running `npm run verify` on skill modifications is a severe process violation that leads to test timeouts and compute waste.
3. **Record Verification Findings in Freeflow**:
   - Document that the diff and tests/drift checks were inspected and confirmed clean, citing the file paths and test status.
4. **Never Make Code Corrections Yourself**:
   - If a test fails or the diff is incomplete, **DO NOT** edit the source files.
   - Formulate a follow-up `**Ask**` in `.threads/coder.md` and hand it back to the Coder.

---

## 8. Route Every Step, However Small

Never bypass the multi-agent loop for "trivial" fixes (e.g. a one-line code patch or a minor doc edit).
- Doing it yourself skips the backlink checks, provenance recording, and thread checkpoints that maintain graph integrity.
- Route graph fixes to the Grapher and code changes to the Coder.
- Skill and agent configuration changes in tracked directories (`skills/`, `.agents/`) are code changes and must be routed to the Coder.
