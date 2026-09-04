# Project instructions

## Don't write ephemeral info into long-lived artifacts

When editing a reference doc, walkthrough, or other long-lived artifact (e.g. anything
under `AperasKG/artifacts/`), don't bake in commentary whose value is tied to *this
session* rather than to the doc's ongoing purpose — parenthetical asides like "one `jq`
call, not two," inline before/after comparisons, or narration of a mistake just fixed.
That kind of thing is fleeting: it's useful right now, in the chat, and stops being
useful the moment the doc moves on. Say it in the conversation; don't write it into the
artifact.

If something genuinely needs to persist longer than the conversation but isn't part of
the artifact's lasting content, it belongs in a place built for that — a log, a changelog
entry, an "Updates"/"Appendix" section — not folded into the main body of a reference doc
as if it were permanent guidance. `Aperas-dev-status.md`'s appendix pattern is the model:
investigation narrative and now-resolved caveats live there, separate from the current-
state summary above it.

When in doubt: would this sentence still make sense to someone reading the doc a month
from now, with no memory of the conversation that produced it? If not, it's ephemeral —
leave it out of the artifact.

## Don't implement without explicit consensus and approval — design work or bug fixes alike

During a design discussion — especially a multi-turn one where the design shifts as it
goes — don't resume or continue implementation on the strength of a conversational cue
that merely *sounds* like agreement: a positive-sounding reaction, an emoji, "same
conclusion," a laugh, a "yeah" dropped in passing. Any of those can just be commentary on
the discussion, not authorization to act. Treat them as data about where the conversation
stands, never as a green light.

Before writing or editing code, get an explicit, unambiguous decision: either the user
states the decision directly ("go with the split"), or answers a direct question you
actually asked ("should I implement this now?"). If a remark could be read either way,
ask directly rather than guessing from tone. Pausing to confirm costs nothing; resuming
an edit that turns out to be premature does — and re-litigating a decision the user
thought was still open erodes trust in whatever "done" means going forward.

This applies with extra force once implementation is already underway and a new design
question interrupts it (e.g. a side discussion about class hierarchy mid-refactor): getting
consensus on the side question doesn't retroactively authorize resuming the interrupted
work — check that the user wants you to continue, not just that they agree with the point
just settled.

**Consensus also means confirming you understood the proposal itself, not just that you
agree with your own paraphrase of it.** With terse or ad hoc shorthand — bracket notation,
an informal diagram, a compressed description of a design — restate what you think it
means before agreeing *or* arguing against it. Arguing at length against a misread version
of someone's proposal costs exactly as much trust as jumping to implementation on a vague
nod: both skip the step where you actually check you're both talking about the same thing.
When notation or phrasing could parse more than one way (e.g. operator precedence in an
ad hoc tree diagram), say which reading you're using and ask if that's right, rather than
silently picking one and building a response on top of it.

**This isn't limited to design discussions — it applies just as much to investigating a
bug someone asked you to look at.** "Check this bug" is permission to investigate, not
pre-approval for whatever fix you land on. If the findings are substantial enough that you'd
reach for a written report instead of a one-line answer, that length is itself the signal to
stop and propose before touching any file — summarize the root cause, name the specific
change(s) you intend to make, flag anything you're planning to fix that wasn't explicitly
asked about (e.g. a related leak found along the way), and let the user say go before
writing code. Going straight from "here's what I found" to a finished, tested fix in the
same turn — even a correct one — skips the same approval step as jumping to implementation
on a vague nod; being right about the diagnosis doesn't retroactively authorize the specific
shape of the fix, when more than one shape was actually available.

