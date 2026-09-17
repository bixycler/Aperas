/**
 * ApeironNgn Verification & Test Harness — slow half, split out from `verify.ts` (`issues/core.md`:
 * "runtime had no visibility and two real, fixable costs"). Covers the Linking Slice ingestion
 * scenarios (full-slug-path collision rejection, anchor-emission, the aperas-tree cleanup pass) and
 * the corpus-wide link-integrity sweeps — the same kind of ingestion/parsing work `verify.ts`'s own
 * fast steps 3-6 do, at a cost 20-100x higher for reasons neither this file nor `verify.ts` is
 * responsible for (a process-lifetime effect measured, not fixed — see `issues/core.md`'s still-
 * open entry). Run this on demand (`npm run verify:slow`) when the full picture actually matters,
 * not on every iteration `npm run verify` (this file's fast sibling) already covers.
 *
 * Fully independent of `verify.ts`: its own `rehydrateStore()`, its own scratch fixtures (the
 * `LINKING_*` paths below, distinct from `verify.ts`'s own `demo.md`/`README.md`), sharing only the
 * small structural helpers in `verifySupport.ts` and the same `__verify_apeironngn_demo/` scratch
 * directory (cleaned up by each half independently — see that file's own doc comment on why running
 * both concurrently isn't supported). Not a subset of `verify.ts`'s state: nothing here depends on
 * any of `verify.ts`'s own steps having run.
 */

import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { WIKILINK_PREDICATE, HEADING_TREE_ANCHOR_PROP } from '@aperas/core/astParser';
import { slugify } from '@aperas/core/nodeRef';
import { getArtifactsDir } from '@aperas/core/artifacts';
import { getProp, getProps } from '@aperas/core/props';
import { rehydrateStore } from '@aperas/core/apeironNgn/store';
import { trackArtifact, ingestArtifact } from '@aperas/core/apeironNgn/artifacts';
import { ingestFolderTree } from '@aperas/core/apeironNgn/folders';
import { findByExactPath } from '@aperas/core/apeironNgn/tree';
import { wrap, type ArtifactNode, type BlockNode, type Link } from '@aperas/core/apeironNgn/node';
import { checkLinkIntegrity, checkArtifactLinkIntegrity, owningArtifactId, repairLinkIntegrity } from '@aperas/core/apeironNgn/linkIntegrity';
import { predIri, nodeIri } from '@aperas/core/apeironNgn/vocab';
import { runBacklinks } from './kgBacklinks';
import { runInsert } from './kgInsert';
import { runUpdate } from './kgUpdate';
import { DEMO_DIR, resetDemoState, findHeadingByTitle, findByText, instrumentStepTiming } from './verifySupport';

// Linking Slice 1/2 (AperasKG/artifacts/planning/linking.md) — its own scratch artifacts, distinct
// from `verify.ts`'s own `demo.md`, so its multi-file link-resolution/collision scenarios don't get
// tangled up with that file's unrelated reconciliation/GC narrative.
const LINKING_A_PATH = `${DEMO_DIR}/linking-a.md`;
const LINKING_B_PATH = `${DEMO_DIR}/linking-b.md`;
const LINKING_DUP_PATH = `${DEMO_DIR}/linking-dup.md`;
const LINKING_RENAME_PATH = `${DEMO_DIR}/linking-rename.md`;
const LINKING_ANCHOR_TARGET_PATH = `${DEMO_DIR}/linking-anchor-target.md`;
const LINKING_ANCHOR_NEW_PATH = `${DEMO_DIR}/linking-anchor-new.md`;
const LINKING_CLEANUP_PATH = `${DEMO_DIR}/linking-cleanup.md`;
const LINKING_UNTRACKED_PATH = `${DEMO_DIR}/linking-untracked-referrer.md`;
// Own fixture for the link-integrity sweep test (step 19) — previously piggybacked on `verify.ts`'s
// own `demo.md`/steps 3-5 state, which is exactly the cross-file coupling this split exists to
// remove. Self-contained the same way 13-18 already are: an anchor-tagged target heading plus a
// citing paragraph, both freshly minted here.
const LINKING_CHECK_PATH = `${DEMO_DIR}/linking-check-integrity.md`;
// Own fixture for step 20 (`kg:update --text-only`'s own scope-mismatch regression, the sibling
// bug to step 19's `repairLinkIntegrity` one) — a heading with a real child that carries a
// resolved wikilink, distinct from every other fixture above.
const LINKING_TEXTONLY_PATH = `${DEMO_DIR}/linking-textonly-scope.md`;

export async function runApeironNgnExtendedVerification(): Promise<void> {
  console.log("=================================================");
  console.log("   ApeironNgn: Extended Verification (slow half)  ");
  console.log("=================================================\n");

  const stopTiming = instrumentStepTiming();
  try {
    resetDemoState();
    mkdirSync(join(getArtifactsDir(), DEMO_DIR), { recursive: true });
    const { store, quadCount, nodeCount } = rehydrateStore();
    console.log(`0. Rehydrated ${quadCount} quad(s), ${nodeCount} node(s) from the real mirror.\n`);

    console.log("13. Testing Linking Slice 1's anchor-emission mechanism end-to-end (scratch-ingest, folded in from planning/linking.md's own Verification Plan)...");
    writeFileSync(join(getArtifactsDir(), LINKING_A_PATH), `# H1 Heading <a name='h1-heading' class='aperas-anchor aperas-tree'></a>

Genuine leading prose for H1 that must stay as text, unaffected by the trailing anchor.

## H2 With Anchor <a name='h1-heading/h2-with-anchor' class='aperas-anchor aperas-tree'></a>

Leading prose for H2, also must stay unaffected.

- Term: a list item lead-in with no anchor yet.

## Unanchored Heading

No anchor tag on this one at all.
`, 'utf-8');
    trackArtifact(store, LINKING_A_PATH);
    ingestArtifact(store, LINKING_A_PATH);
    const linkingAId = findByExactPath(store, LINKING_A_PATH);
    if (!linkingAId) throw new Error(`Expected '${LINKING_A_PATH}' to be tracked after ingestion.`);
    const linkingAArtifact = wrap(store, linkingAId) as unknown as ArtifactNode;

    const h1Block = findHeadingByTitle(linkingAArtifact, 'H1 Heading');
    if (!h1Block) throw new Error(`Expected to find heading 'H1 Heading' in '${LINKING_A_PATH}'.`);
    // `title` keeps the heading's own `#` marker(s) (the raw line, anchor-stripped) — only the
    // trailing anchor tag itself is what gets cleaned out here, not the marker.
    if (h1Block.title !== '# H1 Heading') throw new Error(`Expected H1's title to be clean of its anchor (marker included), got '${h1Block.title}'.`);
    if (h1Block.text !== 'Genuine leading prose for H1 that must stay as text, unaffected by the trailing anchor.') {
      throw new Error(`Expected H1's leading prose to survive untouched as its own text, got '${h1Block.text}'.`);
    }
    if (getProp(h1Block, HEADING_TREE_ANCHOR_PROP) !== `<a name='h1-heading' class='aperas-anchor aperas-tree'></a>`) {
      throw new Error(`Expected H1's tree-anchor to survive in its 'treeAnchor' prop, got '${getProp(h1Block, HEADING_TREE_ANCHOR_PROP)}'.`);
    }
    const h1Projected = (h1Block as unknown as BlockNode).toMarkdown()!;
    const h1FirstLine = h1Projected.split('\n')[0];
    if (h1FirstLine !== `# H1 Heading <a name='h1-heading' class='aperas-anchor aperas-tree'></a><a name='id/${h1Block.id}' class='aperas-anchor aperas-id'></a>`) {
      throw new Error(`Expected H1's projected line to re-emit its tree-anchor then a fresh id-anchor, got '${h1FirstLine}'.`);
    }
    console.log(`   - H1: title clean, leading prose preserved, tree-anchor survives in props, both anchors re-emitted in order.`);

    const h2Block = findHeadingByTitle(linkingAArtifact, 'H2 With Anchor');
    if (!h2Block) throw new Error(`Expected to find heading 'H2 With Anchor' in '${LINKING_A_PATH}'.`);
    if (h2Block.text !== 'Leading prose for H2, also must stay unaffected.') {
      throw new Error(`Expected H2's leading prose to survive untouched, got '${h2Block.text}'.`);
    }
    if (getProp(h2Block, HEADING_TREE_ANCHOR_PROP) !== `<a name='h1-heading/h2-with-anchor' class='aperas-anchor aperas-tree'></a>`) {
      throw new Error(`Expected H2's tree-anchor to survive, got '${getProp(h2Block, HEADING_TREE_ANCHOR_PROP)}'.`);
    }
    console.log(`   - H2 (nested, with genuine leading prose *and* a tree-anchor): prose stays exactly as text, unaffected — the live-verified regression this whole mechanism was built to guard against.`);

    const termItem = findByText(linkingAArtifact, 'a list item lead-in with no anchor yet.');
    if (!termItem) throw new Error(`Expected to find the 'Term' list item in '${LINKING_A_PATH}'.`);
    const idAnchorMarker = `name='id/${termItem.id}'`;
    if ((termItem.text as string).includes(idAnchorMarker)) {
      throw new Error(`Expected the list item's own stored text to have no id-anchor yet before projection, got '${termItem.text}'.`);
    }
    // A bare listItem has no `serializeBlock` case of its own — `serializeListItem` is only ever
    // invoked by its *parent*'s `renderChildren` (which is what actually detects a run of listItem
    // children and applies the `- `/checkbox prefix). So the splice is only visible by projecting
    // the parent H2, not by calling `.toMarkdown()` on the list item directly.
    const h2ProjectedOnce = (h2Block as unknown as BlockNode).toMarkdown()!;
    const occurrencesOnce = h2ProjectedOnce.split(idAnchorMarker).length - 1;
    if (occurrencesOnce !== 1) {
      throw new Error(`Expected exactly one id-anchor spliced into the list item, right after its lead-in colon, got ${occurrencesOnce} in '${h2ProjectedOnce}'.`);
    }
    if (!h2ProjectedOnce.includes(`- Term: <a name='id/${termItem.id}'`)) {
      throw new Error(`Expected the id-anchor spliced in right after the lead-in colon, got '${h2ProjectedOnce}'.`);
    }
    console.log(`   - List item with a colon and no anchor: projecting adds the id-anchor once, right after the colon.`);

    // Idempotency across a *real* re-ingestion cycle (not just calling toMarkdown() twice on the
    // same untouched in-memory node, which would never exercise the "already anchored" input at
    // all): project the whole artifact back to disk, re-track, re-ingest, and confirm the same
    // list item — matched, not re-minted, since its lead-in text is unchanged — still has exactly
    // one id-anchor, not two.
    const wholeProjected = linkingAArtifact.toMarkdown()!;
    writeFileSync(join(getArtifactsDir(), LINKING_A_PATH), wholeProjected, 'utf-8');
    trackArtifact(store, LINKING_A_PATH);
    ingestArtifact(store, LINKING_A_PATH);
    const termItemAfterReingest = findByText(wrap(store, linkingAId) as unknown as ArtifactNode, 'a list item lead-in with no anchor yet.');
    if (!termItemAfterReingest) throw new Error(`Expected the 'Term' list item to still exist after re-ingesting the projected artifact.`);
    if (termItemAfterReingest.id !== termItem.id) {
      throw new Error(`Expected the list item to reconcile-match (same id) across the projected round-trip, got ${termItem.id} -> ${termItemAfterReingest.id}.`);
    }
    const h2BlockAfterReingest = findHeadingByTitle(wrap(store, linkingAId) as unknown as ArtifactNode, 'H2 With Anchor')!;
    const h2ProjectedAfterReingest = (h2BlockAfterReingest as unknown as BlockNode).toMarkdown()!;
    const occurrencesAfterReingest = h2ProjectedAfterReingest.split(idAnchorMarker).length - 1;
    if (occurrencesAfterReingest !== 1) {
      throw new Error(`Expected re-projecting an already-anchored list item to not duplicate its id-anchor, got ${occurrencesAfterReingest} occurrence(s).`);
    }
    console.log(`   - Re-projecting the same already-ingested content (a real write-back + re-ingest cycle) doesn't duplicate the anchor.`);

    const h2Id = h2Block.id as string;
    const unanchoredHeading = findHeadingByTitle(wrap(store, linkingAId) as unknown as ArtifactNode, 'Unanchored Heading');
    if (!unanchoredHeading) throw new Error(`Expected to find 'Unanchored Heading' in '${LINKING_A_PATH}'.`);

    writeFileSync(join(getArtifactsDir(), LINKING_B_PATH), `# Cross-File Referrer

Three forms, one target: [bracket](<[[${h2Id}]]>), [aperas](aperas://id/${h2Id}), and [rel](linking-a.md#id/${h2Id}).

# Anchor Gate Referrer

Should not resolve: [nope](linking-a.md#h1-heading/unanchored-heading).
`, 'utf-8');
    trackArtifact(store, LINKING_B_PATH);
    const linkingBResult = ingestArtifact(store, LINKING_B_PATH);
    if (!linkingBResult) throw new Error(`Expected '${LINKING_B_PATH}' to actually ingest.`);
    if (linkingBResult.linkResolution.resolved !== 3) {
      throw new Error(`Expected all 3 link forms ([[Kind:snowflake]], aperas://id/<ID>, ../file#id/<ID>) to resolve, got ${linkingBResult.linkResolution.resolved}.`);
    }
    const linkingBId = findByExactPath(store, LINKING_B_PATH);
    const crossFileReferrer = findHeadingByTitle(wrap(store, linkingBId!) as unknown as ArtifactNode, 'Cross-File Referrer');
    const crossFileLinks = ((crossFileReferrer.links as unknown as Link[] | undefined) ?? []).filter((l) => l.predicate === WIKILINK_PREDICATE);
    if (crossFileLinks.length !== 1) {
      throw new Error(`Expected the 3 equivalent link forms to dedupe onto exactly 1 target (same block), got ${crossFileLinks.length} distinct link(s).`);
    }
    if ((crossFileLinks[0].target as unknown as { id: string } | undefined)?.id !== h2Id) {
      throw new Error(`Expected the deduped link's target to be H2 (${h2Id}), got '${(crossFileLinks[0].target as unknown as { id: string } | undefined)?.id}'.`);
    }
    const crossFilePositions = getProps(crossFileLinks[0] as unknown as { props?: any[] }, 'position');
    if (crossFilePositions.length !== 3) {
      throw new Error(`Expected 3 distinct occurrence positions (one per link form) folded onto the one deduped Link, got ${crossFilePositions.length}.`);
    }
    console.log(`   - aperas://id/<ID>, ../file#id/<ID>, and [[Kind:snowflake]] all resolve to the same target — deduped onto one Link with ${crossFilePositions.length} occurrence positions.`);

    const anchorGateReferrer = findHeadingByTitle(wrap(store, linkingBId!) as unknown as ArtifactNode, 'Anchor Gate Referrer');
    const anchorGateLinks = ((anchorGateReferrer.links as unknown as Link[] | undefined) ?? []).filter((l) => l.predicate === WIKILINK_PREDICATE);
    const anchorGateResolvedToUnanchored = anchorGateLinks.some((l) => (l.target as unknown as { id: string } | undefined)?.id === unanchoredHeading.id);
    if (anchorGateResolvedToUnanchored) {
      throw new Error(`Expected a #fragment link matching an unanchored heading's title-derived slug to be rejected by the anchor-matching gate, but it resolved.`);
    }
    console.log(`   - A #fragment link whose text happens to match a real heading's slug, but that heading carries no aperas-anchor tag, correctly does not resolve.`);
    console.log("   [✓] Linking Slice 1 anchor-emission mechanism verified successfully.\n");

    console.log("14. Testing full-slug-path collision rejection at ingestion (Linking Slice 2, Task 2)...");
    // (a) Two brand-new blocks, same document, same tree position, identical title — rejected on
    //     the very first ingestion (nothing to reconcile against yet).
    writeFileSync(join(getArtifactsDir(), LINKING_DUP_PATH), `# Dup Test

## Same Name

First one.

## Same Name

Second one, colliding with the first from the very first ingestion.
`, 'utf-8');
    trackArtifact(store, LINKING_DUP_PATH);
    let dupThrew = false;
    try {
      ingestArtifact(store, LINKING_DUP_PATH);
    } catch (err: any) {
      dupThrew = true;
      if (!/collision/i.test(err.message || '')) throw new Error(`Expected a collision error for two same-named siblings, got: ${err.message}`);
    }
    if (!dupThrew) throw new Error(`Expected ingesting two identically-titled siblings in one document to be rejected.`);
    console.log(`   - (a) Two new blocks in the same document, same tree position, same title: rejected.`);

    // (b) A block added *later*, in a re-ingestion, colliding with an existing sibling that isn't
    //     itself being changed — proves this isn't only checked against blocks freshly minted in
    //     the same pass. The clean first ingest here also covers (d): no false positive when the
    //     one title present is genuinely unique.
    writeFileSync(join(getArtifactsDir(), LINKING_RENAME_PATH), `# Stable Sibling

First heading, ingested cleanly.
`, 'utf-8');
    trackArtifact(store, LINKING_RENAME_PATH);
    ingestArtifact(store, LINKING_RENAME_PATH); // (d) no false positive on a genuinely unique title
    writeFileSync(join(getArtifactsDir(), LINKING_RENAME_PATH), `# Stable Sibling

First heading, ingested cleanly.

# Stable Sibling

A second heading colliding with the first.
`, 'utf-8');
    trackArtifact(store, LINKING_RENAME_PATH);
    let renameThrew = false;
    try {
      ingestArtifact(store, LINKING_RENAME_PATH);
    } catch (err: any) {
      renameThrew = true;
      if (!/collision/i.test(err.message || '')) throw new Error(`Expected a collision error for a newly-added sibling colliding with an existing one, got: ${err.message}`);
    }
    if (!renameThrew) throw new Error(`Expected re-ingesting a doc that adds a title colliding with an existing, untouched sibling to be rejected.`);
    console.log(`   - (b) A newly-added heading colliding with an existing, unchanged sibling's path: rejected. (d) A genuinely unique title: not a false positive.`);

    // (c) Cross-artifact collision via an embedded anchor name, not a plain toPath()-vs-toPath()
    //     match (which can never happen across two different real artifacts — each artifact's own
    //     path is a unique prefix). File A hand-writes a tree-anchor equal to what File B's own,
    //     perfectly ordinary heading will naturally compute as its toPath() — proving the check
    //     really does look at embedded anchor names, not just each block's current title.
    // `slugify()` runs on a heading's raw title *including* its own `#`/`##` markers (`toPath()`'s
    // own rule) — computed via the real function rather than hand-derived, so this can't drift
    // from whatever slugify actually does.
    const collidingAnchorName = `${LINKING_ANCHOR_NEW_PATH}/${slugify('# New Doc')}/${slugify('## Shared Title')}`;
    writeFileSync(join(getArtifactsDir(), LINKING_ANCHOR_TARGET_PATH), `# Anchor Owner <a name='${collidingAnchorName}' class='aperas-anchor aperas-tree'></a>

Holds a hand-written anchor that happens to name another file's future, perfectly ordinary path.
`, 'utf-8');
    trackArtifact(store, LINKING_ANCHOR_TARGET_PATH);
    ingestArtifact(store, LINKING_ANCHOR_TARGET_PATH);

    writeFileSync(join(getArtifactsDir(), LINKING_ANCHOR_NEW_PATH), `# New Doc

## Shared Title

Ordinary content with no anchor of its own.
`, 'utf-8');
    trackArtifact(store, LINKING_ANCHOR_NEW_PATH);
    let anchorCollisionThrew = false;
    try {
      ingestArtifact(store, LINKING_ANCHOR_NEW_PATH);
    } catch (err: any) {
      anchorCollisionThrew = true;
      if (!/collision/i.test(err.message || '')) throw new Error(`Expected a collision error against an embedded anchor name, got: ${err.message}`);
    }
    if (!anchorCollisionThrew) throw new Error(`Expected an ordinary heading's own natural path colliding with another block's hand-written anchor to be rejected.`);
    console.log(`   - (c) An ordinary heading's own natural path colliding with a *different* file's hand-written anchor name (not its title): rejected.`);
    console.log("   [✓] Full-slug-path collision rejection verified successfully.\n");

    console.log("15. Testing the aperas-tree cleanup pass (Linking Slice 2, Task 3) — a mechanical text strip, not a new subsystem...");
    writeFileSync(join(getArtifactsDir(), LINKING_CLEANUP_PATH), `# Cleanup Target <a name='cleanup-target' class='aperas-anchor aperas-tree'></a>

Some content that should survive untouched.
`, 'utf-8');
    trackArtifact(store, LINKING_CLEANUP_PATH);
    ingestArtifact(store, LINKING_CLEANUP_PATH);
    const cleanupId = findByExactPath(store, LINKING_CLEANUP_PATH);
    if (!cleanupId) throw new Error(`Expected '${LINKING_CLEANUP_PATH}' to be tracked after ingestion.`);
    const cleanupTargetBefore = findHeadingByTitle(wrap(store, cleanupId) as unknown as ArtifactNode, 'Cleanup Target');
    if (!cleanupTargetBefore || getProp(cleanupTargetBefore, HEADING_TREE_ANCHOR_PROP) === undefined) {
      throw new Error(`Expected 'Cleanup Target' to carry a treeAnchor prop before cleanup.`);
    }
    const cleanupTargetId = cleanupTargetBefore.id as string;

    // The cleanup pass itself: delete the aperas-tree anchor tag straight out of the source text —
    // no graph-side removal API to call, nothing else to touch.
    writeFileSync(join(getArtifactsDir(), LINKING_CLEANUP_PATH), `# Cleanup Target

Some content that should survive untouched.
`, 'utf-8');
    trackArtifact(store, LINKING_CLEANUP_PATH);
    ingestArtifact(store, LINKING_CLEANUP_PATH);
    const cleanupTargetAfter = findHeadingByTitle(wrap(store, cleanupId) as unknown as ArtifactNode, 'Cleanup Target');
    if (!cleanupTargetAfter) throw new Error(`Expected 'Cleanup Target' to still exist after its anchor was stripped.`);
    if (cleanupTargetAfter.id !== cleanupTargetId) {
      throw new Error(`Expected the same block identity (matched, not re-minted) after stripping its anchor, got ${cleanupTargetId} -> ${cleanupTargetAfter.id}.`);
    }
    if (getProp(cleanupTargetAfter, HEADING_TREE_ANCHOR_PROP) !== undefined) {
      throw new Error(`Expected the treeAnchor prop to be gone after the anchor was removed from the source text, got '${getProp(cleanupTargetAfter, HEADING_TREE_ANCHOR_PROP)}'.`);
    }
    if (cleanupTargetAfter.text !== 'Some content that should survive untouched.') {
      throw new Error(`Expected the block's own text to be unaffected by the anchor's removal, got '${cleanupTargetAfter.text}'.`);
    }
    console.log(`   - Deleting the anchor tag from source text and re-ingesting drops it from 'treeAnchor'/the graph too, same block identity preserved, no other content affected.`);

    // Confirm the plan's own point about *how* safety is checked: kg:backlinks only queries the
    // graph, so a real, on-disk reference that was never tracked/ingested is invisible to it — a
    // full-text search over the corpus's actual files is what would catch it instead.
    writeFileSync(join(getArtifactsDir(), LINKING_UNTRACKED_PATH), `# Untracked Referrer

Old-style reference, never ingested: [old](linking-a.md#h1-heading).
`, 'utf-8');
    const h1Id = h1Block.id as string;
    const backlinksForH1 = runBacklinks(store, h1Id, false);
    if (backlinksForH1.length !== 0) {
      throw new Error(`Expected kg:backlinks to report zero referrers for H1 (the untracked file was never ingested), got ${backlinksForH1.length}.`);
    }
    const untrackedContent = readFileSync(join(getArtifactsDir(), LINKING_UNTRACKED_PATH), 'utf-8');
    if (!untrackedContent.includes('#h1-heading')) {
      throw new Error(`Expected the untracked file's own real content to still contain the old-style reference a full-text search would find.`);
    }
    console.log(`   - kg:backlinks reports 0 referrer(s) for H1 — blind to the untracked file's real, on-disk reference; a full-text search over the corpus's own files finds it instead.`);
    console.log("   [✓] Cleanup-pass mechanics verified successfully.\n");

    console.log("16. Testing full-slug-path collision rejection reaches kg:insert too, not just ingestFromDisk...");
    let insertCollisionThrew = false;
    try {
      runInsert(store, { path: `aperas://id/${h1Block.id}`, markdown: '## H2 With Anchor\n\nA new heading colliding with an existing sibling.\n' });
    } catch (err: any) {
      insertCollisionThrew = true;
      if (!/collision/i.test(err.message || '')) throw new Error(`Expected a collision error from kg:insert, got: ${err.message}`);
    }
    if (!insertCollisionThrew) throw new Error(`Expected kg:insert to reject a new heading colliding with an existing sibling's path.`);
    console.log(`   - kg:insert rejects a newly-created heading colliding with an existing sibling: rejected.`);
    const insertOk = runInsert(store, { path: `aperas://id/${h1Block.id}`, markdown: '## A Genuinely New Heading\n\nNo collision here.\n' });
    if (insertOk.lines.length !== 1) throw new Error(`Expected kg:insert to succeed for a genuinely unique title, got: ${JSON.stringify(insertOk.lines)}`);
    console.log(`   - A genuinely unique new heading: not a false positive, inserted fine.`);
    console.log("   [✓] kg:insert collision rejection verified successfully.\n");

    console.log("17. Testing full-slug-path collision rejection reaches kg:update's heading-rename too...");
    let updateCollisionThrew = false;
    try {
      runUpdate(store, { path: `aperas://id/${unanchoredHeading.id}`, markdown: '## H2 With Anchor\n\nRenamed to collide with an existing sibling.\n', textOnly: false });
    } catch (err: any) {
      updateCollisionThrew = true;
      if (!/collision/i.test(err.message || '')) throw new Error(`Expected a collision error from kg:update, got: ${err.message}`);
    }
    if (!updateCollisionThrew) throw new Error(`Expected kg:update to reject renaming a heading to collide with an existing sibling's path.`);
    console.log(`   - kg:update rejects renaming a heading to collide with an existing sibling: rejected.`);
    console.log("   [✓] kg:update collision rejection verified successfully.\n");

    console.log("18. Testing kg:update preserves a list adopted onto its own leading paragraph (a real bug: adoption isn't gated to heading/listItem containers, but the plain-paragraph branch only ever read firstChild.text)...");
    const adoptionUpdateResult = runUpdate(store, {
      path: `aperas://id/${termItem.id}`,
      markdown: 'Some replacement paragraph text.\n\n- Sub item one\n- Sub item two\n',
      textOnly: false,
    });
    if (adoptionUpdateResult.added !== 2) {
      throw new Error(`Expected the adopted list's 2 items to survive as overflow children (added=2), got added=${adoptionUpdateResult.added}.`);
    }
    const termItemChildren = (wrap(store, termItem.id) as unknown as BlockNode).children as unknown as BlockNode[] | undefined;
    if ((termItemChildren ?? []).length !== 2) {
      throw new Error(`Expected the target to end up with 2 real children, got ${(termItemChildren ?? []).length}.`);
    }
    console.log(`   - A list adopted onto the piped input's own leading paragraph survives as the target's children, not silently dropped.`);
    console.log("   [✓] kg:update list-adoption fix verified successfully.\n");

    console.log("19. Testing checkLinkIntegrity and repairLinkIntegrity sweeps...");
    const initialReport = checkLinkIntegrity(store);
    console.log(`   - Initial link integrity scan: ${initialReport.totalLiveBlocks} live blocks, ${initialReport.discrepancies.length} discrepancies.`);

    // Self-contained fixture, same pattern as 13-18 above (an anchor-tagged target heading plus a
    // citing paragraph, both freshly minted here) — not a reuse of any state from elsewhere, which
    // is exactly the cross-file coupling this split exists to remove.
    writeFileSync(join(getArtifactsDir(), LINKING_CHECK_PATH), `# Check Link Integrity

## Target <a name='check-link-integrity/target' class='aperas-anchor aperas-tree'></a>

Content for the link-integrity sweep test to cite.

## Citation

A [self-reference](#check-link-integrity/target) back to the target above.

## Other Target <a name='check-link-integrity/other-target' class='aperas-anchor aperas-tree'></a>

Unrelated content that a separate citation below points to.

## Other Citation

An [unrelated reference](#check-link-integrity/other-target) that must survive a repair of the
*other* citation above untouched — same \`Link\` id, same target — since \`repairLinkIntegrity\`
must never reprocess a block the discrepancy report didn't name.
`, 'utf-8');
    trackArtifact(store, LINKING_CHECK_PATH);
    ingestFolderTree(store);
    ingestArtifact(store, LINKING_CHECK_PATH);
    const linkCheckId = findByExactPath(store, LINKING_CHECK_PATH);
    if (!linkCheckId) throw new Error(`Expected '${LINKING_CHECK_PATH}' to be tracked after ingestion.`);
    const linkCheckArtifact = wrap(store, linkCheckId) as unknown as ArtifactNode;
    const targetHeading = findHeadingByTitle(linkCheckArtifact, 'Target');
    if (!targetHeading) throw new Error(`Expected to find the 'Target' heading in '${LINKING_CHECK_PATH}'.`);
    // Search for the link's own label only, not a phrase spanning across it — `.text` stores the
    // raw markdown syntax in between (`[self-reference](#...)`), so a needle straddling the link
    // boundary is never actually a contiguous substring of the stored text.
    const citingBlockSummary = findByText(linkCheckArtifact, 'self-reference');
    if (!citingBlockSummary) throw new Error('Expected to find the citing paragraph.');
    const citingBlock = wrap(store, citingBlockSummary.id) as unknown as BlockNode;
    const citingLinks = (citingBlock.links as unknown as Array<{ id: string; target?: { id: string } }>) ?? [];
    const targetLink = citingLinks.find((l) => l.target?.id === targetHeading.id);
    if (!targetLink) {
      throw new Error(`Expected the citing paragraph to carry a resolved Link targeting ${targetHeading.id}, got: ${JSON.stringify(citingLinks)}`);
    }

    // The unrelated pair, captured before anything is dropped — `repairLinkIntegrity` must never
    // touch this block at all, since the discrepancy report below never names it. Regression check
    // for the incident this fixture exists to catch: `oldWikilinksByBlock` used to be built by
    // walking the *whole artifact*, so `resolveBlockLinks`'s own key-union reprocessed every other
    // link-bearing block in it too — this one included — with zero pending codes, wiping its real
    // `.links` to empty (2 discrepancies became 16 on a real corpus artifact).
    const otherTargetHeading = findHeadingByTitle(linkCheckArtifact, 'Other Target');
    if (!otherTargetHeading) throw new Error(`Expected to find the 'Other Target' heading in '${LINKING_CHECK_PATH}'.`);
    const otherCitingSummary = findByText(linkCheckArtifact, 'unrelated reference');
    if (!otherCitingSummary) throw new Error('Expected to find the unrelated citing paragraph.');
    const otherCitingBlock = wrap(store, otherCitingSummary.id) as unknown as BlockNode;
    const otherLinksBefore = (otherCitingBlock.links as unknown as Array<{ id: string; target?: { id: string } }>) ?? [];
    const otherLinkBefore = otherLinksBefore.find((l) => l.target?.id === otherTargetHeading.id);
    if (!otherLinkBefore) {
      throw new Error(`Expected the unrelated citing paragraph to carry a resolved Link targeting ${otherTargetHeading.id}, got: ${JSON.stringify(otherLinksBefore)}`);
    }
    for (const q of store.match(nodeIri(citingBlockSummary.id), predIri('links'), nodeIri(targetLink.id), null)) store.delete(q);

    const reportWithDropped = checkLinkIntegrity(store);
    const droppedDelta = reportWithDropped.discrepancies.length - initialReport.discrepancies.length;
    if (droppedDelta !== 1) {
      throw new Error(`Expected exactly one new discrepancy after dropping ${citingBlockSummary.id}'s link, got a delta of ${droppedDelta} (before=${initialReport.discrepancies.length}, after=${reportWithDropped.discrepancies.length}).`);
    }
    const droppedDisc = reportWithDropped.discrepancies.find((d) => d.blockId === citingBlockSummary.id);
    if (!droppedDisc || droppedDisc.missingCodes.length !== 1) {
      throw new Error(`Expected ${citingBlockSummary.id}'s own discrepancy to name exactly one missing code, got: ${JSON.stringify(droppedDisc)}`);
    }
    console.log(`   - Detected the dropped link precisely: ${citingBlockSummary.id} now missing '${droppedDisc.missingCodes[0]}' (discrepancies ${initialReport.discrepancies.length} -> ${reportWithDropped.discrepancies.length}).`);

    const scopedArtifactId = owningArtifactId(store, citingBlockSummary.id);
    if (scopedArtifactId !== linkCheckId) {
      throw new Error(`Expected owningArtifactId to walk ${citingBlockSummary.id} back to ${linkCheckId}, got ${scopedArtifactId}.`);
    }
    const scopedReport = checkArtifactLinkIntegrity(store, scopedArtifactId);
    const scopedDisc = scopedReport.discrepancies.find((d) => d.blockId === citingBlockSummary.id);
    if (!scopedDisc || scopedDisc.missingCodes.length !== 1) {
      throw new Error(`Expected the scoped artifact check to report the same dropped code, got: ${JSON.stringify(scopedReport.discrepancies)}`);
    }
    if (scopedReport.totalLiveBlocks >= reportWithDropped.totalLiveBlocks) {
      throw new Error(`Expected the scoped check to inspect fewer blocks than the corpus sweep (${scopedReport.totalLiveBlocks} vs ${reportWithDropped.totalLiveBlocks}) — it isn't actually scoped.`);
    }
    console.log(`   - Scoped check agrees: same discrepancy found inspecting ${scopedReport.totalLiveBlocks} blocks of one artifact, vs ${reportWithDropped.totalLiveBlocks} corpus-wide.`);

    // `reportWithDropped` is already an up-to-date corpus-wide sweep (nothing has mutated the store
    // since) — handed in so `repairLinkIntegrity` doesn't pay for the same full sweep a second time.
    const repairResult = repairLinkIntegrity(store, reportWithDropped);
    if (repairResult.reportAfter.discrepancies.length !== initialReport.discrepancies.length) {
      throw new Error(`Expected repairLinkIntegrity to restore the discrepancy count to baseline (${initialReport.discrepancies.length}), got ${repairResult.reportAfter.discrepancies.length}.`);
    }
    const restoredBlock = wrap(store, citingBlockSummary.id) as unknown as BlockNode;
    const restoredLinks = (restoredBlock.links as unknown as Array<{ target?: { id: string } }>) ?? [];
    if (!restoredLinks.some((l) => l.target?.id === targetHeading.id)) {
      throw new Error(`Expected repairLinkIntegrity to re-resolve ${citingBlockSummary.id}'s link back onto ${targetHeading.id}.`);
    }
    console.log(`   - repairLinkIntegrity executed: ${repairResult.repairedArtifacts.length} artifact(s) re-resolved, link restored, discrepancies back to ${repairResult.reportAfter.discrepancies.length}.`);

    // The regression check: the unrelated block the discrepancy report never named must come out of
    // the repair completely untouched — same Link id, same target, not wiped and not reminted.
    const otherCitingAfter = wrap(store, otherCitingSummary.id) as unknown as BlockNode;
    const otherLinksAfter = (otherCitingAfter.links as unknown as Array<{ id: string; target?: { id: string } }>) ?? [];
    const otherLinkAfter = otherLinksAfter.find((l) => l.target?.id === otherTargetHeading.id);
    if (!otherLinkAfter) {
      throw new Error(`Expected repairLinkIntegrity to leave the unrelated citing paragraph's Link to ${otherTargetHeading.id} in place, but '.links' is now: ${JSON.stringify(otherLinksAfter)}`);
    }
    if (otherLinkAfter.id !== otherLinkBefore.id) {
      throw new Error(`Expected repairLinkIntegrity to leave the unrelated Link's id untouched (${otherLinkBefore.id}), but it's now ${otherLinkAfter.id} — reminted despite not being named in the discrepancy report.`);
    }
    console.log(`   - Unrelated Link ${otherLinkAfter.id} (never named in the discrepancy report) survived the repair untouched.`);
    console.log("   [✓] checkLinkIntegrity and repairLinkIntegrity sweeps verified successfully.\n");

    console.log("20. Testing kg:update --text-only doesn't wipe an untouched real child's wikilink (the sibling bug to step 19 — issues/linking.md's Open Issues (3))...");
    writeFileSync(join(getArtifactsDir(), LINKING_TEXTONLY_PATH), `# Update Text-Only Scope

## Parent Heading

Parent's own original leading text.

### Child Citation

A [child self-reference](#update-text-only-scope/target) to the target below.

## Target <a name='update-text-only-scope/target' class='aperas-anchor aperas-tree'></a>

Content the child citation points to.
`, 'utf-8');
    trackArtifact(store, LINKING_TEXTONLY_PATH);
    ingestFolderTree(store);
    ingestArtifact(store, LINKING_TEXTONLY_PATH);
    const textOnlyId = findByExactPath(store, LINKING_TEXTONLY_PATH);
    if (!textOnlyId) throw new Error(`Expected '${LINKING_TEXTONLY_PATH}' to be tracked after ingestion.`);
    const textOnlyArtifact = wrap(store, textOnlyId) as unknown as ArtifactNode;
    const parentHeading = findHeadingByTitle(textOnlyArtifact, 'Parent Heading');
    if (!parentHeading) throw new Error(`Expected to find the 'Parent Heading' heading in '${LINKING_TEXTONLY_PATH}'.`);
    const textOnlyTargetHeading = findHeadingByTitle(textOnlyArtifact, 'Target');
    if (!textOnlyTargetHeading) throw new Error(`Expected to find the 'Target' heading in '${LINKING_TEXTONLY_PATH}'.`);
    const childCitationSummary = findByText(textOnlyArtifact, 'child self-reference');
    if (!childCitationSummary) throw new Error('Expected to find the child citing paragraph.');
    const childCitationBlock = wrap(store, childCitationSummary.id) as unknown as BlockNode;
    const childLinksBefore = (childCitationBlock.links as unknown as Array<{ id: string; target?: { id: string } }>) ?? [];
    const childLinkBefore = childLinksBefore.find((l) => l.target?.id === textOnlyTargetHeading.id);
    if (!childLinkBefore) {
      throw new Error(`Expected the child citing paragraph to carry a resolved Link targeting ${textOnlyTargetHeading.id}, got: ${JSON.stringify(childLinksBefore)}`);
    }

    // The write under test: `--text-only` on the *parent* heading, touching none of the child's own
    // text or links directly — piping a bare heading line, exactly the "holder promotion" shape that
    // originally surfaced this bug (issues/linking.md's Open Issues (3)).
    runUpdate(store, { path: `aperas://id/${parentHeading.id}`, markdown: '## Parent Heading\n', textOnly: true });
    const parentAfter = wrap(store, parentHeading.id) as unknown as BlockNode;
    if (parentAfter.text !== undefined) {
      throw new Error(`Expected the --text-only update to leave 'Parent Heading' with no leading text (bare heading line piped), got: ${JSON.stringify(parentAfter.text)}`);
    }
    const childAfter = wrap(store, childCitationSummary.id) as unknown as BlockNode;
    const childLinksAfter = (childAfter.links as unknown as Array<{ id: string; target?: { id: string } }>) ?? [];
    const childLinkAfter = childLinksAfter.find((l) => l.target?.id === textOnlyTargetHeading.id);
    if (!childLinkAfter) {
      throw new Error(`Expected 'Parent Heading's --text-only update to leave the untouched child's Link to ${textOnlyTargetHeading.id} in place, but '.links' is now: ${JSON.stringify(childLinksAfter)}`);
    }
    if (childLinkAfter.id !== childLinkBefore.id) {
      throw new Error(`Expected the child's Link id to survive untouched (${childLinkBefore.id}), but it's now ${childLinkAfter.id} — reminted despite the child never being part of this write.`);
    }
    if (!parentAfter.treeChildren.some((c) => c.id === childCitationBlock.id)) {
      throw new Error(`Expected 'Child Citation' to remain 'Parent Heading's own child after the --text-only update.`);
    }
    console.log(`   - --text-only update on the parent left the untouched child's Link ${childLinkAfter.id} in place, unchanged.`);
    console.log("   [✓] kg:update --text-only scope fix verified successfully.\n");

    console.log("   [✓] ApeironNgn Extended Verification complete!");
  } finally {
    console.log("\n   Cleaning up demo state...");
    resetDemoState();
    stopTiming();
  }

  console.log("\n=================================================");
  console.log("   ApeironNgn Extended Verification Complete!     ");
  console.log("=================================================");
}

if (process.argv[1]?.endsWith('verifyExtended.ts')) {
  runApeironNgnExtendedVerification().catch((err) => {
    console.error('\n[!] ApeironNgn extended verification failed:', err.message || err);
    process.exit(1);
  });
}
