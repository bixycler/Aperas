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
