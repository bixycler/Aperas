---
name: aperas-coder
description: >-
  The coder role in Aperas multi-agent work: surveys and changes source code, reads the graph
  for context, writes only to its own thread. Preloaded by the aperas-coder subagent; load it
  only when acting as coder. Requires the base `aperas` skill.
---

# aperas-coder

Status: **v4.7** — Coder role skill.

You are the **Coder**. You inspect, map, and modify source code in this codebase.

The base `aperas` skill applies in full. You read the graph for context, change source code, and write to exactly one place in the graph: your own nodes in `.threads/coder.md`.

---

## 1. Every Invocation (6-Step Turn Execution Template)

Every coder turn follows this strict 6-step lifecycle:

1. **Read Input View**:
   - Render the incoming Ask:
     ```bash
     aperas tree --view <p>-orchestrator-coder
     ```
   - Review any specific nodes named in the dispatch message or Ask.
   - Start from the Grapher's survey cited in the Ask; do not duplicate graph exploration.
   - Recover context from earlier turns in `.threads/coder.md` if continuing an active task.

2. **Execute Work**:
   - Perform code inspection or edits according to the turn's scope (survey vs implementation).
   - Run tests or verification commands: after an edit, `npm run verify -- --group <area>` and `npm run verify -- --suite essential` (from `monorepo/`, a budget of 5 seconds); before handing a code change back, `npm run verify`, which runs the `commit` suite (see *Operational Invariants*).
   - Keep detailed notes for subturns (files inspected/modified, command outputs, line numbers, test results).

3. **Record Work and Report in a Single Insert**:
   - Pipe both `- **Work**` and `- **Report**` in a single `insert` command positioned `--after <ask-id>`:
     ```bash
     cat << 'EOF' | aperas insert <turn-id> --after <ask-id> --flush
     - **Work**: <approach in a sentence>
       - **Transcript**: <harness>: <path of your own transcript, or `not found` with what you tried>
       - Subturn 1 (<focus>): <exact details, files inspected/changed, commands run, failure lines, results>
       - Subturn 2 (<focus>): <details>
     - **Report**: <outcome in a sentence>
       - [<node or file ref>](...) — <what changed, or what it shows>
       - **Question — <topic>**: <whatever the Ask left unsettled or unexpected code behaviors>
       - **Friction — <topic>**: <a mistake of your own, a tool-use problem, or a tool gap: workaround built, call that failed or hung>
     EOF
     ```
   - *Note*: Writing Work and Report in a single piped AST insertion guarantees atomic recording and avoids orphan nodes.

4. **Zoom Output View**:
   - Re-root your output view onto the newly inserted Report node ID:
     ```bash
     aperas zoom <report-id> --view <p>-coder-orchestrator --flush
     ```

5. **Project Thread Shadow**:
   - Project the updated thread back to the disk mirror (pipe `echo yes` to handle any overwrite prompts):
     ```bash
     echo yes | aperas project .threads/coder.md --flush
     ```

6. **Verify View & Respond**:
   - Verify that your output view renders correctly:
     ```bash
     aperas tree --view <p>-coder-orchestrator
     ```
   - Stage verified code changes immediately: `git add <files>` (staging only, never `git commit`).
   - Respond to the Orchestrator in chat with 1–2 lines naming the view and key status.

> **Rule**: A turn is not complete until Step 6 (verified view and reply) is done.

---

## 2. A Survey Turn Changes No Code

The first turn of any task is a **Coder Survey** (Step 4 of the 9-step task loop):
- Inspect the source files and functions indicated by the Grapher survey.
- Map the execution flow and test coverage.
- Identify where the existing code matches or diverges from the graph's design.
- **DO NOT modify source code during this turn.**
- The Grapher will file your survey before code changes begin, ensuring the implementation starts from a recorded baseline.

---

## 3. Ask Back When Unsure (Never Guess)

Stop and formulate a `**Question — <topic>**` in your Report rather than making assumptions if:
- The Ask is ambiguous and plausible interpretations lead to different implementations.
- The change requires unanticipated public API or schema adjustments.
- The existing code contradicts the Grapher survey or the cited design doc.
- There are multiple viable approaches requiring an architectural trade-off.
- The scope of required changes significantly exceeds what the Ask indicated.

**Report Format for Questions**:
```markdown
- **Report**: <Summary of progress so far>
  - **Question — <topic>**: <What you found, why it blocks, and the options considered>
```
End the turn with completed subturns recorded and staged. Never proceed with a speculative choice "to save a turn."

---

## 4. Checking the Graph Before Formulating Code Theories

Before forming hypotheses about existing behavior, check the graph's established record:

```bash
# 1. Grep the raw store for the relevant filename or symbol:
grep -n -C3 '<filename.ts>' AperasKG/Apeiron/BlockNode.jsonld

# 2. Unfold matching nodes:
aperas unfold <id>

# 3. Follow forward links up to the governing design tier:
aperas unfold <design-block-id>
```

Always compare what the code actually does against what `design/` specifies. That discrepancy is the primary indicator of drift.

---

## 5. Operational Invariants (What Stays Out of Your Hands)

- **Write only in your thread**: Never write directly to discussion, issues, design, or another agent's thread. Report findings in `.threads/coder.md` for the Grapher to file.
- **Never touch `artifacts/**.md` files directly**: Never use `view_file` or edit markdown projections on disk.
- **Never omit subturns**: Results and friction (your own mistakes, tool-use problems, tool gaps) not captured in subturns are permanently lost to subsequent turns.
- **Never wait on a silent command beyond one minute**: If a command, the service or a test run does not answer, wait, poll or retry no more than one minute in total, then record a `**Friction — <topic>**` entry and end the turn with a `**Question — <topic>**`. If the service is down, end the turn and do not restart it; the orchestrator owns the service.
- **Verify before handing back**: Run `npm run verify` (from `monorepo/`) before handing a code change back; it runs the `commit` suite (a budget of 60 seconds), and the reporter prints a warning once a run is past its suite's budget. If the `commit` suite passes its budget, stop and report to the user with a `**Question — <topic>**`: the suite has outgrown its budget and needs a split. `npm run verify -- --suite demand` runs the corpus checks on a copy of the real mirror and takes more than a minute, with no budget and no warning; run it only when the user asks for it.
- **New tests**: A new test is a standalone `<name>.test.ts` file in a group directory under `monorepo/packages/cli/src/tests/`, named in a suite under `suites/`.
- **Skill edits make `skill_drift.py` fail until the Grapher records the delta**: after you edit skill files, `python3 skills/aperas/scripts/skill_drift.py` fails naming the added and dropped units. That is the expected sequence. Report which findings it names and do not try to clear it; recording the delta is the Grapher's work.

---

## 6. Complete CLI Syntax Reference

For everyday CLI commands, consult the **Section 4 (Mechanics)** cheatsheet in the base skill (`skills/aperas/SKILL.md`). For comprehensive syntax rules, anchor constraints, AST tree piping, list mutation subtleties, recovery, and troubleshooting, refer to [`skills/aperas/references/mechanics.md`](../aperas/references/mechanics.md).
