---
name: kg-doc-ingest
description: Workflow for the one-time on-ramp of migrating an old/legacy hand-written concern doc (design/discussion/issues/planning/history under AperasKG/artifacts/) into the ApeironNgn knowledge graph via the `aperas` CLI — tracking, ingesting, and verifying round-trip fidelity before handing off to the `aperas` skill's ongoing graph-editing discipline. Use this whenever the user asks to sync/ingest a doc (or several) into the graph for the first time, or migrate a legacy artifact to Apeiron — even if they don't name the skill directly.
---

# kg-doc-ingest

Status: **v0** — the core ingest/round-trip/wikilink loop was verified end-to-end on `design/documentation.md` + `discussion/documentation.md` + `issues/documentation.md`, then again migrating a `cli.md` doc set. The general graph-editing discipline this skill used to also carry (staging practice, wikilink syntax, renaming, discussion-before-execution, ...) moved to the `aperas` skill once a second workflow needed the same practices — **read that skill first**; this one is only steps 1-4 below.

All commands run from `Aperas/monorepo/` as `aperas <verb> <args>` (see the `aperas` skill's own insider note on today's actual invocation). Paths passed to `aperas ingest`/`aperas project`/etc. are relative to `AperasKG/artifacts/` (e.g. `design/foo.md`), not the repo root.

## Workflow

1. **Track + ingest.** `aperas ingest <path...> --track --flush`. If it reports a pending removal (some unrelated FolderNode/ArtifactNode it wants to tombstone), don't just answer yes or pass `--force` — check first whether that path still exists on disk somewhere else (e.g. a prior `git mv` to `archive/`). Confirm only once you understand why it thinks the removal is correct.

2. **Verify round-trip fidelity before trusting the ingest.** `aperas project <path> --dry-run` and diff the output against the original file — but strip `<a name='id/BlockNode:...' class='aperas-anchor aperas-id'></a>` anchor tags (and blank-line changes) before comparing. Those are an *expected* addition on projection (see `AperasKG/artifacts/design/linking.md`'s Architecture/Workflows sections), not data loss. The content-only diff should be empty.

3. **Actually project.** `aperas project <path>` (no `--dry-run`) to bake the id-anchors into the file on disk, matching already-migrated docs like `linking.md`. Then `aperas ingest <path> --track --flush` again — a clean pass reports "No artifacts required ingestion", confirming the graph's `fileHash`/`ingestedHash` caught up.

4. **Upgrade prose references into real wikilinks, then hand off.** A legacy doc often has plain `../folder/file.md/Slug`-style references pre-dating the graph — these look fine as prose but aren't real `Link`s (see the `aperas` skill's wikilink-syntax item). Fix them per that skill's rules, verify with `aperas backlinks`, then the doc is done being "migrated" — every further edit (a new section, a rename, anything) follows the `aperas` skill's own ongoing editing discipline from here on, not this skill's steps again.

## Reference

- `AperasKG/artifacts/design/linking.md` is the canonical spec for the addressing/anchor/wikilink syntax referenced in step 2 and 4.
- `AperasKG/artifacts/design/documentation.md` describes the concern taxonomy (design/issues/planning/history/discussion) these docs get sorted into.
