---
name: kg-doc-ingest
description: Workflow for migrating an old/legacy hand-written concern doc (design/discussion/issues/planning/history under AperasKG/artifacts/) into the ApeironNgn knowledge graph via the kg: CLI in Aperas/web — tracking, ingesting, verifying round-trip fidelity, and upgrading prose cross-references into real graph-resolvable wikilinks. Use this whenever the user asks to sync/ingest a doc (or several) into the graph, migrate a legacy artifact to Apeiron, add wikilinks between AperasKG docs, or mentions kg:ingest/kg:project/kg:backlinks/round-trip fidelity in the context of this project — even if they don't name the skill directly.
---

# kg-doc-ingest

Status: **v0 skeleton** — captures the steps verified once, end-to-end, on `design/documentation.md` + `discussion/documentation.md` + `issues/documentation.md`. Expect this to grow (worked examples, a references/ split) as it's used more.

All commands below run from `Aperas/web/` as `npm run kg:<cmd> -- <args>`. Paths passed to `kg:ingest`/`kg:project`/etc. are relative to `AperasKG/artifacts/` (e.g. `design/foo.md`), not the repo root.

## Workflow

1. **Track + ingest.** `kg:ingest -- <path...> --track --flush`. If it reports a pending removal (some unrelated FolderNode/ArtifactNode it wants to tombstone), don't just answer yes or pass `--force` — check first whether that path still exists on disk somewhere else (e.g. a prior `git mv` to `archive/`). Confirm only once you understand why it thinks the removal is correct.

2. **Verify round-trip fidelity before trusting the ingest.** `kg:project -- <path> --dry-run` and diff the output against the original file — but strip `<a name='id/BlockNode:...' class='aperas-anchor aperas-id'></a>` anchor tags (and blank-line changes) before comparing. Those are an *expected* addition on projection (see `AperasKG/artifacts/design/linking.md`'s Architecture/Workflows sections), not data loss. The content-only diff should be empty.

3. **Actually project.** `kg:project -- <path>` (no `--dry-run`) to bake the id-anchors into the file on disk, matching already-migrated docs like `linking.md`. Then `kg:ingest -- <path> --track --flush` again — a clean pass reports "No artifacts required ingestion", confirming the graph's `fileHash`/`ingestedHash` caught up.

4. **Upgrade prose references into real wikilinks.** The link resolver only recognizes a URL that is `[[code]]`, starts with `aperas://tree/` or `aperas://id/`, or contains a bare `#fragment`/`path#fragment`. A plain `../folder/file.md/Slug`-style reference (no `#`) renders fine as prose but is *not* a graph `Link` — `kg:backlinks` on it will come back empty. Fix by rewriting to `[title](../folder/file.md#id/BlockNode:<ID>)`, reading the target's actual anchor ID off its already-projected file. Verify with `kg:backlinks -- BlockNode:<ID> --text` (query the specific target block, not the whole-document path).

5. **Watch the bold-colon gotcha.** A list item's lead-in-term anchor placement requires the lead-in colon to sit *outside* any `**bold**` span — `**Term**:`, not `**Term:**`. A bold-wrapped colon is rejected by the lead-in detector, so anchor insertion falls through to the next plain-text colon it finds, which can splice an anchor into the middle of unrelated text (e.g. into a link's own title). Match the `**Term**:` convention already established in migrated docs.

6. **Track your own view while doing this.** `kg:profile create <handle> --name "<Display Name>"`, then `kg:profile create-view <name> --profile <handle>`. Use `kg:unfold -- <path> --view <name> --flush` to reveal nodes you're actively working on, `kg:tree -- --view <name>` to render that unfolded lens, and plain `kg:tree -- --depth <n>` (no `--view`) for a skeletal title-only view of the whole corpus.

7. **Restart to double-check disk state.** After a batch of mutations (especially tombstones), `kg:service -- restart` gracefully restarts the shared ApeironNgn service (flushes, then reloads fresh from the on-disk mirror) — the clean way to confirm what you think landed on disk actually did.

## Reference

- `AperasKG/artifacts/design/linking.md` is the canonical spec for the addressing/anchor/wikilink syntax referenced in steps 2, 4, and 5 — read it when a link isn't resolving and the reason isn't obvious.
- `AperasKG/artifacts/design/documentation.md` describes the concern taxonomy (design/issues/planning/history/discussion) these docs get sorted into.
