#!/usr/bin/env python3
"""PreToolUse hook: a hard, opt-in gate on touching `monorepo/` source code
without having consulted the Aperas graph first this session.

This is deliberately NOT part of the `aperas` skill's own auto-invocation —
that stays soft (a description the host may or may not match) and ships to
everyone via `.claude/skills/`. This script is the harder fallback: registered
only in a personal `.claude/settings.local.json` (untracked, opt-in), never in
the project's own shared settings. See discussion/aperas-skill.md's Freeflow
entry on the read-side trigger gap for why the two need to be separate.

Two call shapes, one script:

  aperas_gate.py            gate mode — deny reading/editing monorepo source
                             unless this session has already run an `aperas`
                             command (tracked via a session-scoped marker file).
  aperas_gate.py --mark     mark mode — bound to a Bash `*aperas*` matcher;
                             touches the marker so the gate opens. Always
                             allows; this call itself is never gated.

Fails open on anything unexpected (bad/missing stdin JSON, no session id):
a hook bug should never be the thing that blocks a whole session.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

MARKER_DIR = Path("/tmp/aperas-gate")


def marker_path(session_id: str) -> Path:
    return MARKER_DIR / f"{session_id}.oriented"


def deny(reason: str) -> None:
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }
    }))


def main() -> None:
    mark_mode = "--mark" in sys.argv[1:]

    try:
        payload = json.loads(sys.stdin.read())
        session_id = payload["session_id"]
    except Exception:
        return  # fail open — exit 0, no output, normal permission flow applies

    marker = marker_path(session_id)

    if mark_mode:
        MARKER_DIR.mkdir(parents=True, exist_ok=True)
        marker.touch()
        return

    if marker.exists():
        return  # already oriented this session — allow silently

    deny(
        "This session hasn't touched the Aperas graph yet. Before reading or "
        "editing monorepo source, orient first: `aperas unfold`/`backlinks` on "
        "the relevant concern, or at least read its issues/design/planning doc "
        "under AperasKG/artifacts/ — see the aperas skill. Running any "
        "`aperas`/`npm run aperas` command opens this gate for the rest of the "
        "session."
    )


if __name__ == "__main__":
    main()
