/**
 * ApeironNgn Verification & Test Harness — `verifyPhase0.ts`'s replacement now that
 * `client.ts`/`crud.ts`/`woql.ts`/`graphql.ts`/`versionControl.ts` (and `export.ts`'s
 * `kg:export`/`kg:import`) are all abandoned along with TerminusDB itself
 * (Aperas-apeironngn-design.md §4 rollout). No live server, no `--db` flag, no skip path —
 * ApeironNgn is in-process, so this always runs.
 *
 * Covers everything `verifyPhase0.ts` covered except two things dropped outright, not ported:
 * - Extrinsic Assertion storage & WOQL impact propagation — `Assertion`/`BaseEdge` were removed
 *   from the model entirely during the migration (Aperas-apeironngn-design.md §4), not merely
 *   left unread; there is nothing here to verify.
 * - Temporal commit management (branch/commit/reconciliation) — `AperasKG/Apeiron/` is plain
 *   JSON-LD in a real git repo now; ordinary `git branch`/`commit`/`diff` already covers this,
 *   nothing ApeironNgn-specific needs its own verification code for it.
 *
 * Validates:
 * - Markdown AST parsing into a fractal BlockNode tree (pure, no store involved)
 * - Artifact tracking & on-demand ingestion against a rehydrated in-process Store
 * - Reconciliation matching on re-ingestion of an edited artifact (blockId stability)
 * - BlockNode.links extraction (self-link, forward-reference-turned-holder, dangling)
 * - FolderNode structural tree ingestion, README projection, and write-by-default stability
 * - Artifact Projection round-trip (serialize -> re-parse -> reconcile, zero drift)
 * - dehydrate -> rehydrate round-trip, in an isolated scratch directory (never touches the
 *   real `AperasKG/Apeiron/` mirror)
 *
 * Safety: the demo artifact/folder live under a dedicated `__verify_apeironngn_demo/`
 * subfolder of the real `AperasKG/artifacts/` (`getArtifactsDir()`/`ingestFolderTree` have no
 * directory-override param, unlike `rehydrateStore`/`dehydrateToJsonLd`, so there's no way to
 * fully sandbox the artifact-source side) — deleted in a `finally`, regardless of pass/fail, so
 * a re-run is idempotent even after a crash. The real `AperasKG/Apeiron/*.jsonld` mirror is
 * never written to at all: everything here runs against an in-memory `Store` only, and the one
 * dehydrate/rehydrate check uses its own separate scratch directory.
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseMarkdownTree, WIKILINK_PREDICATE, HEADING_TREE_ANCHOR_PROP } from '@aperas/core/astParser';
import { slugify } from '@aperas/core/nodeRef';
import { getArtifactsDir } from '@aperas/core/artifacts';
import { serializeBlock } from '@aperas/core/project';
import { reconcileTree } from '@aperas/core/reconcile';
import { getProp, getProps } from '@aperas/core/props';
import { rehydrateStore } from '@aperas/core/apeironNgn/store';
import { dehydrateToJsonLd, dehydrateStateToJsonLd } from '@aperas/core/apeironNgn/dehydrate';
import { trackArtifact, ingestArtifact } from '@aperas/core/apeironNgn/artifacts';
import { ingestFolderTree, getFolderRecord } from '@aperas/core/apeironNgn/folders';
import { findByExactPath } from '@aperas/core/apeironNgn/tree';
import { wrap, ensureDefaultView, pruneUnreachableTombstones, type ArtifactNode, type BlockNode, type FolderNode, type Link, type TreeView, type ApeironNode } from '@aperas/core/apeironNgn/node';
import { nodeExists } from '@aperas/core/apeironNgn/vocab';
import { generateNodeId } from '@aperas/core/snowflake';
import { runAddBlockLink, runRemoveBlockLink } from './kgLink';
import { runBacklinks } from './kgBacklinks';
import { runInsert } from './kgInsert';
import { runUpdate } from './kgUpdate';

const DEMO_DIR = '__verify_apeironngn_demo';
const DEMO_ARTIFACT_PATH = `${DEMO_DIR}/demo.md`;
const DEMO_README_PATH = `${DEMO_DIR}/README.md`;

// Linking Slice 1/2 (AperasKG/artifacts/planning/linking.md) — its own scratch artifacts, distinct
// from the general demo above so its multi-file link-resolution/collision scenarios don't get
// tangled up with the unrelated reconciliation/GC narrative `demo.md` carries across steps 1-12.
const LINKING_A_PATH = `${DEMO_DIR}/linking-a.md`;
const LINKING_B_PATH = `${DEMO_DIR}/linking-b.md`;
const LINKING_DUP_PATH = `${DEMO_DIR}/linking-dup.md`;
const LINKING_RENAME_PATH = `${DEMO_DIR}/linking-rename.md`;
const LINKING_ANCHOR_TARGET_PATH = `${DEMO_DIR}/linking-anchor-target.md`;
const LINKING_ANCHOR_NEW_PATH = `${DEMO_DIR}/linking-anchor-new.md`;
const LINKING_CLEANUP_PATH = `${DEMO_DIR}/linking-cleanup.md`;
const LINKING_UNTRACKED_PATH = `${DEMO_DIR}/linking-untracked-referrer.md`;

function collectIds(node: any): string[] {
  if (!node) return [];
  const ids = [node.id as string];
  for (const child of node.children ?? []) {
    ids.push(...collectIds(child));
  }
  return ids;
}

function findByTitleContaining(node: any, needle: string): any {
  if (typeof node.text === 'string' && node.text.includes(needle)) return node;
  for (const child of node.children ?? []) {
    const found = findByTitleContaining(child, needle);
    if (found) return found;
  }
  return null;
}

function findHeadingByTitle(node: any, needle: string): any {
  if (node.type === 'heading' && node.title?.includes(needle)) return node;
  for (const child of node.children ?? []) {
    const found = findHeadingByTitle(child, needle);
    if (found) return found;
  }
  return null;
}

function findByText(node: any, needle: string): any {
  if (typeof node.text === 'string' && node.text.includes(needle)) return node;
  for (const child of node.children ?? []) {
    const found = findByText(child, needle);
    if (found) return found;
  }
  return null;
}

/** Removes the demo subfolder from disk, if present — safe to call before starting (cleans up
 *  a previous crashed run) and in the final `finally` (regardless of pass/fail). Nothing to
 *  reset in the Store itself: every test below runs against an in-memory `rehydrateStore()`
 *  result that's simply discarded when the process exits, never dehydrated back to the real
 *  mirror. */
function resetDemoState(): void {
  const demoDir = join(getArtifactsDir(), DEMO_DIR);
  if (existsSync(demoDir)) rmSync(demoDir, { recursive: true, force: true });
}

export async function runApeironNgnVerification() {
  console.log("=================================================");
  console.log("   ApeironNgn: Substrate Verification Test        ");
  console.log("=================================================\n");

  // 1. Sample Markdown AST Parsing (pure -- no Store involved, identical coverage to
  //    verifyPhase0.ts's own section 1/1b/1c/1d, since parseMarkdownTree/reconcileTree/
  //    serializeBlock/getProp are all shared, TerminusDB-agnostic functions).
  const sampleMarkdown = `---
title: Metaphysics of Aperas
tags: [aperas, ontology]
---
# Metaphysics of Aperas

Aperas operates over a fluid, unconditioned semantic core (Apeiron) and crystallizes typed boundaries (Peras) on demand.

- Unbounded: Apeiron macrocosm
- Unbound: Aperas microcosm
- Bound: Peras transient interface
  - A nested clarification
- [ ] An open question
- [x] A settled one

1. First ordered step
2. Second ordered step

> A note on terminology:
> Apeiron and Peras derive from Anaximander.

\`\`\`ts
const example = 1;
\`\`\`

---

<div>A raw HTML block.</div>

| Concept | Role |
| :--- | ---: |
| Apeiron | Unbounded |
| Peras | Bound |

## A Consuming Example

An introductory sentence.

A second paragraph the list actually nests into.

- consumed item one
- consumed item two

## Two Runs Separated By An Opaque Leaf

- separated bullet one
- separated bullet two

\`\`\`ts
const separatorBetweenRuns = true;
\`\`\`

1. separated ordinal one
2. separated ordinal two`;

  console.log("1. Testing AST Transducer (Fractal BlockNode Tree)...");
  const { root: rootBlock, frontmatter } = parseMarkdownTree(sampleMarkdown);
  const allIds = collectIds(rootBlock);
  console.log(`   - Root title: "${rootBlock.title}"`);
  console.log(`   - Blocks parsed: ${allIds.length}`);
  console.log(`   - Ids unique: ${new Set(allIds).size === allIds.length}`);

  if (!frontmatter?.includes('title: Metaphysics of Aperas')) {
    throw new Error(`Expected frontmatter to be extracted as a raw YAML body, got: ${JSON.stringify(frontmatter)}`);
  }
  console.log("   [✓] YAML frontmatter extracted separately from the block tree.\n");

  const openItem = findByTitleContaining(rootBlock, 'An open question');
  const settledItem = findByTitleContaining(rootBlock, 'A settled one');
  if (getProp(openItem ?? {}, 'checked') !== 'false' || getProp(settledItem ?? {}, 'checked') !== 'true') {
    throw new Error(`Expected task-list checked to be captured correctly (remark-gfm) via props, got open=${getProp(openItem ?? {}, 'checked')} settled=${getProp(settledItem ?? {}, 'checked')}`);
  }
  console.log("   [✓] AST Transduction verified successfully.\n");

  console.log("1c. Testing consumption (list nests into a real preceding node, not the container itself)...");
  const consumingHeading = findHeadingByTitle(rootBlock, 'A Consuming Example');
  if (!consumingHeading) throw new Error('Expected to find the "A Consuming Example" heading.');
  if (consumingHeading.text !== 'An introductory sentence.') {
    throw new Error(`Expected the heading to consume its own leading paragraph as text, got: ${JSON.stringify(consumingHeading.text)}`);
  }
  const consumingChildren = consumingHeading.children ?? [];
  if (consumingChildren.length !== 1 || consumingChildren[0].type !== 'paragraph') {
    throw new Error(`Expected the heading's only child to be the second (non-leading) paragraph, surviving as a real node — got: ${JSON.stringify(consumingChildren.map((c: any) => c.type))}`);
  }
  const consumingParagraph = consumingChildren[0];
  const nestedItems = consumingParagraph.children ?? [];
  if (nestedItems.length !== 2 || !nestedItems.every((c: any) => c.type === 'listItem')) {
    throw new Error(`Expected the list to nest one level *inside* the second paragraph (true consumption, §1 of the unified law), got: ${JSON.stringify(nestedItems.map((c: any) => c.type))}`);
  }
  if (getProp(consumingParagraph, 'orderedList') !== undefined || getProp(consumingParagraph, 'startIndex') !== undefined) {
    throw new Error(`Expected the consuming paragraph itself to carry no orderedList/startIndex — those live on the run's own first item now, not the anchor.`);
  }
  if (getProp(nestedItems[0], 'orderedList') !== 'false' || getProp(nestedItems[0], 'startIndex') !== '1') {
    throw new Error(`Expected the nested list's own first item to carry orderedList/startIndex, got orderedList=${getProp(nestedItems[0], 'orderedList')} startIndex=${getProp(nestedItems[0], 'startIndex')}`);
  }
  console.log("   [✓] Consumption verified successfully.\n");

  console.log("1d. Testing dissolution when orphaned, zero-separator variant (two type-contiguous listItem runs, back-to-back, distinguished only by each run-leader's own explicit props)...");
  const metaphysicsHeading = findHeadingByTitle(rootBlock, 'Metaphysics of Aperas');
  if (!metaphysicsHeading) throw new Error('Expected to find the "Metaphysics of Aperas" heading.');
  const metaChildren = (metaphysicsHeading.children ?? []).filter((c: any) => c.type === 'listItem');
  if (metaChildren.some((c: any) => c.type === 'list') || (metaphysicsHeading.children ?? []).some((c: any) => c.type === 'list')) {
    throw new Error('Expected no child to ever be type "list" — every list dissolves into flat listItem children now.');
  }
  if (metaChildren.length !== 7) {
    throw new Error(`Expected 7 flat listItem children total (5 bullet + 2 ordinal, back-to-back), got ${metaChildren.length}.`);
  }
  const [bulletLeader, , , , bulletLast, ordinalLeader, ordinalLast] = metaChildren;
  if (getProp(bulletLeader, 'orderedList') !== 'false' || getProp(bulletLeader, 'startIndex') !== '1') {
    throw new Error(`Expected the bullet run's own first item to carry orderedList=false/startIndex=1, got orderedList=${getProp(bulletLeader, 'orderedList')} startIndex=${getProp(bulletLeader, 'startIndex')}`);
  }
  if (getProp(bulletLast, 'orderedList') !== undefined) {
    throw new Error(`Expected a non-leader bullet item to carry no orderedList of its own, got '${getProp(bulletLast, 'orderedList')}'.`);
  }
  if (getProp(ordinalLeader, 'orderedList') !== 'true' || getProp(ordinalLeader, 'startIndex') !== '1') {
    throw new Error(`Expected the second run's own leader (type-contiguous with the first, no structural separator) to still carry its own orderedList=true/startIndex=1, got orderedList=${getProp(ordinalLeader, 'orderedList')} startIndex=${getProp(ordinalLeader, 'startIndex')}`);
  }
  if (getProp(ordinalLast, 'orderedList') !== undefined) {
    throw new Error(`Expected the ordinal run's non-leader item to carry no orderedList of its own, got '${getProp(ordinalLast, 'orderedList')}'.`);
  }
  const metaProjected = serializeBlock(metaphysicsHeading);
  if (!metaProjected.includes('- Unbounded: Apeiron macrocosm') || !metaProjected.includes('1. First ordered step\n2. Second ordered step')) {
    throw new Error(`Expected the two dissolved runs to render as two distinct, correctly-numbered lists despite having no structural separator between them, got:\n${metaProjected}`);
  }
  console.log("   [✓] Zero-separator dissolution verified successfully.\n");

  console.log("1e. Testing dissolution when orphaned, separated variant (two runs split by an intervening opaque leaf under one parent)...");
  const separatedHeading = findHeadingByTitle(rootBlock, 'Two Runs Separated By An Opaque Leaf');
  if (!separatedHeading) throw new Error('Expected to find the "Two Runs Separated By An Opaque Leaf" heading.');
  const separatedChildren = separatedHeading.children ?? [];
  const separatedTypes = separatedChildren.map((c: any) => c.type);
  if (JSON.stringify(separatedTypes) !== JSON.stringify(['listItem', 'listItem', 'code', 'listItem', 'listItem'])) {
    throw new Error(`Expected [listItem, listItem, code, listItem, listItem] (both runs dissolved flat, the code block a real sibling between them), got: ${JSON.stringify(separatedTypes)}`);
  }
  if (getProp(separatedChildren[0], 'orderedList') !== 'false' || getProp(separatedChildren[3], 'orderedList') !== 'true') {
    throw new Error(`Expected each run's own leader to carry its own props, got first=${getProp(separatedChildren[0], 'orderedList')} second=${getProp(separatedChildren[3], 'orderedList')}`);
  }
  console.log("   [✓] Separated-runs dissolution verified successfully.\n");

  console.log("1b. Testing Artifact Projection (serialize -> re-parse -> reconcile round-trip)...");
  const projectedSample = serializeBlock(rootBlock);
  const { root: reparsedBlock } = parseMarkdownTree(projectedSample);
  const { stats: roundTripStats } = reconcileTree(rootBlock, reparsedBlock);
  console.log(`   - vs. re-parsed projection: ${roundTripStats.matched} matched, ${roundTripStats.moved} moved, ${roundTripStats.changed} changed, ${roundTripStats.added} added, ${roundTripStats.removed} removed.`);
  if (roundTripStats.added !== 0 || roundTripStats.removed !== 0 || roundTripStats.changed !== 0) {
    throw new Error(
      `Round-trip projection mismatch: expected zero added/removed/changed, got added=${roundTripStats.added} removed=${roundTripStats.removed} changed=${roundTripStats.changed}.\nProjected Markdown:\n${projectedSample}`
    );
  }
  console.log("   [✓] Artifact Projection round-trip verified successfully.\n");

  // 2. ApeironNgn substrate -- rehydrate the real mirror into an in-memory Store. Every mutation
  //    from here on stays in this Store only; it is never dehydrated back to the real
  //    AperasKG/Apeiron/ files (the one dehydrate check below uses its own scratch directory).
  console.log("2. Rehydrating the real AperasKG/Apeiron/ mirror into an in-process Store...");
  resetDemoState();
  const { store, quadCount, nodeCount } = rehydrateStore();
  console.log(`   - ${quadCount} quads, ${nodeCount} documents rehydrated.`);
  console.log("   [✓] Rehydration verified successfully.\n");

  try {
    console.log("3. Tracking & ingesting a demo ArtifactNode + fractal BlockNode tree...");
    mkdirSync(join(getArtifactsDir(), DEMO_DIR), { recursive: true });
    const demoAbsPath = join(getArtifactsDir(), DEMO_ARTIFACT_PATH);
    writeFileSync(demoAbsPath, sampleMarkdown, 'utf-8');
    trackArtifact(store, DEMO_ARTIFACT_PATH);
    // Folder tree rebuilt *before* ingesting content, same order `kgIngest.ts`'s `runIngest` uses
    // — otherwise this demo artifact's own wikilinks would resolve against a tree that doesn't
    // have it attached into its parent folder yet (`resolveCreate.ts`'s module doc has the story).
    ingestFolderTree(store);
    const ingestResult = ingestArtifact(store, DEMO_ARTIFACT_PATH);
    console.log(`   - Blocks ingested: ${ingestResult?.blockCount}`);
    console.log("   [✓] Artifact tracking & ingestion verified successfully.\n");

    console.log("4. Reading the ingested tree back via wrap()...");
    const demoId = findByExactPath(store, DEMO_ARTIFACT_PATH);
    if (!demoId) throw new Error('No ArtifactNode found for the demo artifact after ingestion — cannot continue verification.');
    const artifactNode = wrap(store, demoId) as unknown as ArtifactNode;
    if (artifactNode.ingestedHash === undefined) throw new Error('ArtifactNode has no ingested content — cannot continue verification.');
    const rootId = artifactNode.id;
    const firstChildId = ((artifactNode.children as unknown as BlockNode[] | undefined)?.[0])?.id;
    console.log(`   - Blocks resolved via wrap(): ${collectIds(artifactNode).length}`);
    console.log("   [✓] In-process tree read verified successfully.\n");

    console.log("5. Re-ingesting an edited version and verifying reconciliation...");
    const rootBareCode = rootId.split(':')[1];
    // The dangling link's `..` count must overshoot past the true artifacts root to stay
    // genuinely unresolvable — an artifact and its document content are literally the same node
    // now (`ArtifactNode extends BlockNode`, merged — Aperas-apeironngn-design.md), so
    // `../../../../nowhere` from here would land *inside* the demo artifact's own document and
    // validly create a new top-level heading there, rather than staying dangling.
    const editedMarkdown = sampleMarkdown + `\n\n## A New Section\n\nA freshly added paragraph.\n\nA [self link]([[${rootBareCode}]]) back to the root, a [forward reference]([[NotYetWritten]]) that should become a holder, and a [truly dangling one]([[../../../../../../nowhere]]) that still can't resolve.`;
    writeFileSync(demoAbsPath, editedMarkdown, 'utf-8');
    trackArtifact(store, DEMO_ARTIFACT_PATH);
    ingestFolderTree(store);
    const reingestResult = ingestArtifact(store, DEMO_ARTIFACT_PATH);
    if (!reingestResult?.reconciliation) {
      throw new Error('Expected a reconciliation report on re-ingestion of an already-ingested artifact.');
    }
    const { matched, moved, changed, added, removed } = reingestResult.reconciliation;
    console.log(`   - Reconciliation: ${matched} matched, ${moved} moved, ${changed} changed, ${added} added, ${removed} removed.`);
    if (matched === 0 || added === 0) {
      throw new Error(`Expected both matched and added blocks from this edit, got matched=${matched} added=${added}.`);
    }
    const reingestedArtifact = wrap(store, demoId) as unknown as ArtifactNode;
    const reingestedIds = new Set(collectIds(reingestedArtifact));
    if (!reingestedIds.has(rootId) || (firstChildId && !reingestedIds.has(firstChildId))) {
      throw new Error('Expected the artifact and first child to keep their id across reconciliation — identity was not preserved.');
    }
    console.log("   [✓] Reconciliation matching verified successfully.\n");

    console.log("5b. Testing BlockNode.links extraction (Aperas-markdown-fractal-mapping-design.md §4)...");
    const linkBlockSummary = findByText(reingestedArtifact, 'self link');
    if (!linkBlockSummary) throw new Error('Expected to find the paragraph containing the self-link.');
    const linkBlock = wrap(store, linkBlockSummary.id) as unknown as BlockNode;
    const links = (linkBlock.links as unknown as Array<{ target: BlockNode; predicate: string }>) ?? [];
    if (links.length !== 2) {
      throw new Error(`Expected exactly two resolved links (self-link + forward-reference-turned-holder; the truly-dangling one should still be skipped), got ${links.length}.`);
    }
    const selfLink = links.find((l) => (l.target as unknown as { id: string }).id === rootId);
    if (!selfLink || selfLink.predicate !== WIKILINK_PREDICATE) {
      throw new Error(`Expected a resolved Link targeting ${rootId} with predicate '${WIKILINK_PREDICATE}'.`);
    }
    const holderLink = links.find((l) => (l.target as unknown as { id: string }).id !== rootId);
    if (!holderLink) throw new Error('Expected a second resolved Link targeting a newly-created holder.');
    const holderTarget = holderLink.target as unknown as { holder?: boolean; title?: string; id: string };
    if (holderTarget.holder !== true || holderTarget.title !== 'NotYetWritten') {
      throw new Error(`Expected the forward-reference link to target a holder BlockNode titled 'NotYetWritten', got: ${JSON.stringify(holderTarget)}`);
    }
    console.log(`   - Resolved links: self-link -> ${rootId}; forward reference -> new holder ${holderTarget.id} ("${holderTarget.title}"); truly-dangling link correctly skipped.`);
    console.log("   [✓] BlockNode.links extraction verified successfully.\n");

    console.log("5c. Testing wikilink regeneration on re-ingestion (no duplication; manual kg:link survives)...");
    // A real kg:link-equivalent manual reference, distinct from any [[wikilink]] — should survive
    // untouched across re-ingestion, unlike a resolved wikilink Link (regenerated fresh each time).
    if (!runAddBlockLink(store, linkBlockSummary.id, rootId).resolved) {
      throw new Error('Expected the manual kg:link to resolve against the artifact itself.');
    }
    // A third ingestion where the self-link paragraph's own text is unchanged (a heading added
    // elsewhere forces a real file-hash change, so this isn't just the unchanged-hash skip path) —
    // it should still match via reconciliation and keep its identity, the exact case that used to
    // silently duplicate its resolved wikilink Links on every such re-ingestion.
    const thirdMarkdown = editedMarkdown + `\n\n## Yet Another Section\n\nUnrelated content, just to force a real file-hash change elsewhere.`;
    writeFileSync(demoAbsPath, thirdMarkdown, 'utf-8');
    trackArtifact(store, DEMO_ARTIFACT_PATH);
    ingestFolderTree(store);
    const thirdIngestResult = ingestArtifact(store, DEMO_ARTIFACT_PATH);
    if (!thirdIngestResult?.reconciliation) {
      throw new Error('Expected a reconciliation report on the third ingestion.');
    }
    const rewrappedLinkBlock = wrap(store, linkBlockSummary.id) as unknown as BlockNode;
    const linksAfterThirdIngest = (rewrappedLinkBlock.links as unknown as Array<{ target: BlockNode; predicate: string }>) ?? [];
    const wikilinkCount = linksAfterThirdIngest.filter((l) => l.predicate === WIKILINK_PREDICATE).length;
    const manualCount = linksAfterThirdIngest.filter((l) => l.predicate === 'references').length;
    if (wikilinkCount !== 2) {
      throw new Error(`Expected the self-link paragraph's wikilink Links to be regenerated, not duplicated, across a re-ingestion where its own text was unchanged — expected 2, got ${wikilinkCount}.`);
    }
    if (manualCount !== 1) {
      throw new Error(`Expected the manually-added 'references' link to survive the wikilink-regeneration fix untouched — expected 1, got ${manualCount}.`);
    }
    console.log(`   - After a third ingestion (self-link paragraph's own text unchanged): ${wikilinkCount} wikilink Link(s) — not duplicated — plus ${manualCount} manual Link(s), preserved.`);
    // Not just "not duplicated" — actually the *same* Link identity each time (Aperas-apeironngn-
    // design.md §5's "tractable half": a wikilink Link used to churn its own id on every
    // re-ingestion even when nothing about it changed). Captured here, checked again after the
    // next (5d) ingestion, which touches this same artifact but leaves this paragraph untouched.
    const wikilinkIdsByTarget = new Map(
      linksAfterThirdIngest
        .filter((l) => l.predicate === WIKILINK_PREDICATE)
        .map((l) => [(l.target as unknown as { id: string }).id, (l as unknown as { id: string }).id])
    );
    console.log("   [✓] Wikilink regeneration verified successfully.\n");

    console.log("5d. Testing target-deduped wikilink Links with occurrence positions (Aperas-apeironngn-design.md §4 Step 8)...");
    // The same target mentioned twice in one paragraph should collapse to one Link carrying two
    // `position` props, not two Links — `.links` is a real traversal axis (Aperas-apeironngn-
    // design.md §4 Step 8), so a duplicate edge to the same target is a correctness bug, not just
    // a display nit.
    const dedupMarkdown = thirdMarkdown + `\n\n## A Dedup Section\n\nMentioned twice: a [first mention]([[${rootBareCode}]]) and again a [second mention]([[${rootBareCode}]]).`;
    writeFileSync(demoAbsPath, dedupMarkdown, 'utf-8');
    trackArtifact(store, DEMO_ARTIFACT_PATH);
    ingestFolderTree(store);
    const fourthIngestResult = ingestArtifact(store, DEMO_ARTIFACT_PATH);
    if (!fourthIngestResult?.reconciliation) {
      throw new Error('Expected a reconciliation report on the fourth ingestion.');
    }
    const dedupBlockSummary = findByText(wrap(store, demoId) as unknown as ArtifactNode, 'Mentioned twice');
    if (!dedupBlockSummary) throw new Error('Expected to find the paragraph mentioning the same target twice.');
    const dedupBlock = wrap(store, dedupBlockSummary.id) as unknown as BlockNode;
    const dedupLinks = (dedupBlock.links as unknown as Array<{ target: BlockNode; predicate: string; props?: any[] }>) ?? [];
    const dedupWikilinks = dedupLinks.filter((l) => l.predicate === WIKILINK_PREDICATE);
    if (dedupWikilinks.length !== 1) {
      throw new Error(`Expected the two mentions of the same target to collapse into one Link, got ${dedupWikilinks.length}.`);
    }
    const positions = getProps(dedupWikilinks[0] as any, 'position').map(Number).sort((a, b) => a - b);
    if (positions.length !== 2) {
      throw new Error(`Expected the one Link to carry two 'position' props (one per occurrence), got ${positions.length}: ${JSON.stringify(positions)}.`);
    }
    const blockText = dedupBlock.text as unknown as string;
    for (const position of positions) {
      if (blockText[position] !== '[') {
        throw new Error(`Expected position ${position} to land on the opening '[' of a link occurrence in block.text, got '${blockText[position]}' (text: ${JSON.stringify(blockText)}).`);
      }
    }
    console.log(`   - One Link for the doubly-mentioned target, positions [${positions.join(', ')}] both correctly locating a '[' in block.text.`);
    console.log("   [✓] Target-deduped wikilink positions verified successfully.\n");
    const dedupLinkId = (dedupWikilinks[0] as unknown as { id: string }).id;

    console.log("5e. Testing wikilink Link identity stays stable across a later, unrelated re-ingestion...");
    // The 5d ingestion above touched this same artifact (added a whole new section elsewhere) but
    // never touched the self-link paragraph's own text — its self-link wikilink Link should carry
    // the exact same id captured after 5c, not a fresh one. (The paragraph's *other* wikilink, the
    // forward reference to "NotYetWritten", is deliberately not checked here: each ingestion that
    // resolves it before the target exists mints a brand-new holder BlockNode with its own fresh id
    // — `resolveDeepPathDetail`'s own `--create-holder` doesn't look up a prior holder by title —
    // so that Link's *target* itself legitimately differs each time, a separate, pre-existing
    // holder-churn question this fix isn't about.)
    const linkBlockAfterFourth = wrap(store, linkBlockSummary.id) as unknown as BlockNode;
    const linksAfterFourth = (linkBlockAfterFourth.links as unknown as Array<{ target: BlockNode; predicate: string; id: string }>) ?? [];
    const selfLinkAfterFourth = linksAfterFourth.find(
      (l) => l.predicate === WIKILINK_PREDICATE && (l.target as unknown as { id: string }).id === rootId
    );
    const expectedSelfLinkId = wikilinkIdsByTarget.get(rootId);
    if (!selfLinkAfterFourth || selfLinkAfterFourth.id !== expectedSelfLinkId) {
      throw new Error(`Expected the self-link wikilink Link to keep its id (${expectedSelfLinkId}) across an unrelated re-ingestion, got ${selfLinkAfterFourth?.id}.`);
    }
    console.log(`   - Self-link wikilink Link (${selfLinkAfterFourth.id}) kept its exact id across an unrelated re-ingestion — no id churn.`);
    console.log("   [✓] Wikilink identity stability verified successfully.\n");

    console.log("5f. Testing that position drift alone (target unchanged) does not churn a wikilink Link's id...");
    // Inserting a clause *before* the two mentions shifts both of their offsets without changing
    // which target they point at — `target`, not `position`, is the identity key (a real user
    // correction to the original design here: positions routinely drift from edits elsewhere in
    // the same block, and treating that drift as an identity change would defeat the whole point
    // of this fix). The `Link` should keep its id; only its `position` props should change.
    const driftedMarkdown = dedupMarkdown.replace(
      'Mentioned twice: a [first mention]',
      'Mentioned twice: with an inserted clause first, a [first mention]'
    );
    if (driftedMarkdown === dedupMarkdown) throw new Error('Expected the dedup paragraph text to actually change.');
    writeFileSync(demoAbsPath, driftedMarkdown, 'utf-8');
    trackArtifact(store, DEMO_ARTIFACT_PATH);
    ingestFolderTree(store);
    const fifthIngestResult = ingestArtifact(store, DEMO_ARTIFACT_PATH);
    if (!fifthIngestResult?.reconciliation) {
      throw new Error('Expected a reconciliation report on the fifth ingestion.');
    }
    const dedupBlockAfterDrift = wrap(store, dedupBlockSummary.id) as unknown as BlockNode;
    const dedupLinksAfterDrift = (dedupBlockAfterDrift.links as unknown as Array<{ predicate: string; id: string }>) ?? [];
    const dedupWikilinksAfterDrift = dedupLinksAfterDrift.filter((l) => l.predicate === WIKILINK_PREDICATE);
    if (dedupWikilinksAfterDrift.length !== 1 || dedupWikilinksAfterDrift[0].id !== dedupLinkId) {
      throw new Error(`Expected exactly one wikilink Link keeping id ${dedupLinkId} after position drift, got: ${JSON.stringify(dedupWikilinksAfterDrift)}.`);
    }
    const positionsAfterDrift = getProps(dedupWikilinksAfterDrift[0] as any, 'position').map(Number).sort((a, b) => a - b);
    const textAfterDrift = dedupBlockAfterDrift.text as unknown as string;
    for (const position of positionsAfterDrift) {
      if (textAfterDrift[position] !== '[') {
        throw new Error(`Expected drifted position ${position} to still land on '[', got '${textAfterDrift[position]}' (text: ${JSON.stringify(textAfterDrift)}).`);
      }
    }
    if (JSON.stringify(positionsAfterDrift) === JSON.stringify(positions)) {
      throw new Error(`Expected positions to actually shift after the inserted clause, still got [${positionsAfterDrift.join(', ')}].`);
    }
    console.log(`   - Same Link (${dedupLinkId}) after position drift — positions updated to [${positionsAfterDrift.join(', ')}], id unchanged.`);
    console.log("   [✓] Position-drift identity stability verified successfully.\n");

    console.log("6. Ingesting FolderNode structural tree...");
    const { folderCount } = ingestFolderTree(store);
    console.log(`   - Folders in tree: ${folderCount}`);
    console.log("   [✓] Folder ingestion verified successfully.\n");

    console.log("6b. Testing FolderNode README projection & write-by-default...");
    const demoReadme = `---
draft: true
---
# Demo Folder

Intro sentence for the demo folder.

- item one
- item two`;
    const demoReadmeAbsPath = join(getArtifactsDir(), DEMO_README_PATH);
    writeFileSync(demoReadmeAbsPath, demoReadme, 'utf-8');
    ingestFolderTree(store);
    const folderRecord = getFolderRecord(store, DEMO_DIR);
    if (!folderRecord) throw new Error(`Expected a FolderNode for '${DEMO_DIR}' after ingestion.`);
    const folderNode = wrap(store, `FolderNode:${folderRecord.folderId}`) as unknown as FolderNode;
    // Copy, not consume (Aperas-apeironngn-design.md): the demo README is headed (`# Demo
    // Folder` first, not a bare leading paragraph) — a real-world shape the old top-level-
    // leading-paragraph consuming rule produced an *empty* abstract for. `folderNode.text` should
    // still pick up the heading's own consumed sentence via `extractAbstract`'s recursive search.
    if (folderNode.text !== 'Intro sentence for the demo folder.') {
      throw new Error(`Expected FolderNode.text to be copied from the first descendant with content, got: ${JSON.stringify(folderNode.text)}`);
    }
    const projected = folderNode.toReadme();
    if (!projected.includes('draft: true') || !projected.includes('Intro sentence for the demo folder.') || !projected.includes('item one')) {
      throw new Error(`Expected projected README to include frontmatter, the intro sentence, and list items, got:\n${projected}`);
    }
    // Write-by-default: actually write the regenerated content, re-ingest it, and confirm
    // projecting again reproduces the exact same output -- a stable fixed point, not drift.
    writeFileSync(demoReadmeAbsPath, projected, 'utf-8');
    ingestFolderTree(store);
    const reprojected = (wrap(store, `FolderNode:${folderRecord.folderId}`) as unknown as FolderNode).toReadme();
    if (reprojected !== projected) {
      throw new Error(`Expected project -> write -> re-ingest -> project to be stable, got drift.\nfirst:\n${projected}\nsecond:\n${reprojected}`);
    }
    console.log("   [✓] FolderNode README projection verified successfully.\n");

    console.log("7. Testing dehydrate -> rehydrate round-trip (isolated scratch directory)...");
    const scratchDir = mkdtempSync(join(tmpdir(), 'apeironngn-verify-'));
    try {
      const { counts } = dehydrateToJsonLd(store, scratchDir);
      // `store` (built by this file's own top-of-run `rehydrateStore()`, no dir override) reads
      // the real AperasKG/Apeiron/.state/ mirror too -- if a real TreeView/Profile exists there
      // (e.g. from an actual `kg:tree --view`/`kg:unfold` run), `store.size` below counts those
      // quads. Round-tripping only the content mirror would then permanently undercount the
      // rehydrated side by exactly that much, on every run, regardless of anything content-side --
      // so the state mirror needs the same dehydrate -> rehydrate pass, into the same scratch dir,
      // for this to be an apples-to-apples comparison.
      const { counts: stateCounts } = dehydrateStateToJsonLd(store, join(scratchDir, '.state'));
      const { store: rehydrated, quadCount: scratchQuadCount, danglingRefs } = rehydrateStore(scratchDir);
      console.log(`   - Dehydrated: ${JSON.stringify(counts)}, state: ${JSON.stringify(stateCounts)}`);
      if (danglingRefs.length > 0) {
        throw new Error(`Expected zero dangling references after a round-trip, got ${danglingRefs.length}: ${danglingRefs.slice(0, 5).join(', ')}`);
      }
      if (scratchQuadCount !== store.size) {
        throw new Error(`Expected the round-tripped Store to have the same quad count as the original, got ${scratchQuadCount} vs ${store.size}.`);
      }
      const rehydratedArtifact = wrap(rehydrated, demoId) as unknown as ArtifactNode;
      if (rehydratedArtifact.title !== artifactNode.title || rehydratedArtifact.id !== reingestedArtifact.id) {
        throw new Error('Expected the demo artifact\'s title and id to survive a dehydrate -> rehydrate round-trip unchanged.');
      }
      console.log(`   - ${scratchQuadCount} quads round-tripped, 0 dangling references, demo artifact identity intact.`);
      console.log("   [✓] Dehydrate/rehydrate round-trip verified successfully.\n");
    } finally {
      rmSync(scratchDir, { recursive: true, force: true });
    }

    console.log("8. Testing tombstone visibility in tree rendering (Aperas-apeironngn-design.md §5)...");
    // Tombstoning only clears a dead node's *own* children/links/props — it never sweeps other
    // documents' references *to* it, so a tombstoned node reached through a stale `children`
    // pointer, or through a still-live Link elsewhere, used to render with no signal it had died.
    // Constructed directly against the store (a standalone victim node + a manual link to it from
    // an already-ingested block, rather than driven through a full re-ingestion) to isolate exactly
    // the rendering code path being fixed. Run *after* section 7's round-trip check, deliberately:
    // `TreeView`/`Profile` (minted below by `ensureDefaultView`) are per-viewer state dehydrated
    // separately from the main JSON-LD mirror (Aperas-treeview-design.md §8), outside what section
    // 7's plain-content round-trip check exercises or expects present in the store.
    const victimId = `BlockNode:${generateNodeId()}`;
    const victim = wrap(store, victimId) as unknown as BlockNode;
    victim.type = 'heading';
    victim.title = 'A Node That Will Be Tombstoned';
    victim.children = [];
    victim.tombstonedAt = new Date().toISOString();

    const dedupBlockForTombstoneTest = wrap(store, dedupBlockSummary.id) as unknown as BlockNode;
    const priorLinkIds = ((dedupBlockForTombstoneTest.links as unknown as Link[] | undefined) ?? []).map((l) => (l as unknown as { id: string }).id);
    const victimLinkId = dedupBlockForTombstoneTest.mintWikilink(victimId, [0]);
    dedupBlockForTombstoneTest.links = [...priorLinkIds, victimLinkId] as unknown as ApeironNode[];

    const view = ensureDefaultView(store);
    view.unfold(dedupBlockSummary.id); // makes this block's own .links visible in the view render
    const viewLines = (wrap(store, demoId) as unknown as ArtifactNode).renderTree({ view });
    const tombstonedLine = viewLines.find((l) => l.includes(victimId));
    if (!tombstonedLine || !tombstonedLine.includes('(tombstoned)')) {
      throw new Error(`Expected a rendered line for the tombstoned target ${victimId} tagged '(tombstoned)', got: ${JSON.stringify(tombstonedLine)}.`);
    }
    console.log(`   - Tombstoned target rendered with a visible marker: ${tombstonedLine.trim()}`);
    console.log("   [✓] Tombstone visibility verified successfully.\n");

    console.log("9. Testing dangling `unfolds` cleanup on a genuinely-deleted Link (Aperas-apeironngn-design.md §5)...");
    // A Link/StringProp has no tombstone concept of its own — deleting one is a real hard delete
    // (`hardDeleteNode`). `unfolds` is the only field that can reference a Link directly, so
    // deleting a Link that's currently unfolded must sweep it out of `unfolds` too, or the entry
    // dangles forever with zero trace (the "hard half" of §5's Link-tombstone open question).
    const scratchLinkId = dedupBlockForTombstoneTest.mintWikilink(rootId, [0]);
    const existingLinkIds = ((dedupBlockForTombstoneTest.links as unknown as Link[] | undefined) ?? []).map((l) => (l as unknown as { id: string }).id);
    dedupBlockForTombstoneTest.links = [...existingLinkIds, scratchLinkId] as unknown as ApeironNode[];
    view.unfold(scratchLinkId);
    const unfoldsBeforeDelete = ((view.unfolds as unknown as Array<{ id: string }> | undefined) ?? []).map((n) => n.id);
    if (!unfoldsBeforeDelete.includes(scratchLinkId)) {
      throw new Error(`Expected '${scratchLinkId}' to be present in unfolds before deletion.`);
    }
    // Delete just the scratch Link by reassigning `.links` without it — `writeField`'s embed-diff
    // (Step 8) is what actually calls `hardDeleteNode` on it.
    dedupBlockForTombstoneTest.links = existingLinkIds.filter((id) => id !== scratchLinkId) as unknown as ApeironNode[];
    const viewAfterDelete = wrap(store, view.id) as unknown as TreeView;
    const unfoldsAfterDelete = ((viewAfterDelete.unfolds as unknown as Array<{ id: string }> | undefined) ?? []).map((n) => n.id);
    if (unfoldsAfterDelete.includes(scratchLinkId)) {
      throw new Error(`Expected '${scratchLinkId}' to be swept out of unfolds once its Link was deleted, still present: ${JSON.stringify(unfoldsAfterDelete)}.`);
    }
    console.log(`   - Deleted Link's dangling 'unfolds' entry was swept automatically (${unfoldsBeforeDelete.length} -> ${unfoldsAfterDelete.length} entries).`);
    console.log("   [✓] Dangling unfolds cleanup verified successfully.\n");

    console.log("10. Testing mark-and-sweep GC collects a cyclic dead cluster but spares a referenced tombstone...");
    // The naive design considered for this (drop a tombstoned node once it has *zero* incoming
    // references, dead or alive) fails exactly like refcounting GC fails on a cycle: two
    // tombstoned nodes pointing only at *each other*, with nothing live pointing in, would each
    // show a nonzero referrer count forever. Real mark-and-sweep (starting from live roots) has
    // no such blind spot — constructed here directly against the store, standalone (unattached to
    // any real tree), since building a genuinely disconnected dead cluster through real ingestion
    // isn't practical.
    const deadAId = `BlockNode:${generateNodeId()}`;
    const deadBId = `BlockNode:${generateNodeId()}`;
    const deadA = wrap(store, deadAId) as unknown as BlockNode;
    const deadB = wrap(store, deadBId) as unknown as BlockNode;
    deadA.type = 'heading'; deadA.title = 'Dead A'; deadA.children = [];
    deadB.type = 'heading'; deadB.title = 'Dead B'; deadB.children = [];
    deadA.addLink('references', deadBId);
    deadB.addLink('references', deadAId);
    deadA.tombstonedAt = new Date().toISOString();
    deadB.tombstonedAt = new Date().toISOString();

    // A third tombstoned node, kept alive by a manual link from a still-live block — must survive
    // the same GC pass, proving it isn't just deleting every tombstoned node unconditionally.
    const keptDeadId = `BlockNode:${generateNodeId()}`;
    const keptDead = wrap(store, keptDeadId) as unknown as BlockNode;
    keptDead.type = 'heading'; keptDead.title = 'Kept Dead'; keptDead.children = [];
    keptDead.tombstonedAt = new Date().toISOString();
    const stillLiveBlock = wrap(store, linkBlockSummary.id) as unknown as BlockNode;
    const stillLiveLinkIds = ((stillLiveBlock.links as unknown as Link[] | undefined) ?? []).map((l) => (l as unknown as { id: string }).id);
    stillLiveBlock.addLink('references', keptDeadId);

    const { pruned } = pruneUnreachableTombstones(store);
    if (nodeExists(store, deadAId) || nodeExists(store, deadBId)) {
      throw new Error(`Expected the mutually-referencing dead cluster (${deadAId}, ${deadBId}) to be pruned, but at least one still exists.`);
    }
    if (!nodeExists(store, keptDeadId)) {
      throw new Error(`Expected '${keptDeadId}' to survive — it's still referenced by a live block's manual link.`);
    }
    if (pruned < 2) {
      throw new Error(`Expected at least 2 nodes pruned (the dead cluster), got ${pruned}.`);
    }
    console.log(`   - Pruned ${pruned} unreachable tombstone(s), including the mutually-referencing pair; the still-referenced tombstone survived.`);
    console.log("   [✓] Mark-and-sweep GC verified successfully.\n");

    console.log("11. Testing kg:unlink (runRemoveBlockLink) — the missing removal counterpart to kg:link...");
    // `runAddBlockLink` has never had a removal counterpart — a manually-added `kg:link` could only
    // ever be added, never taken back, short of tombstoning its whole owning block. Also exercises
    // exactly what let `keptDead` survive GC above: removing this same manual link should let a
    // *later* GC pass finally collect it, proving `kg:unlink` and the GC compose correctly.
    const removeResult = runRemoveBlockLink(store, linkBlockSummary.id, keptDeadId);
    if (!removeResult.removed) {
      throw new Error(`Expected runRemoveBlockLink to remove the manual link from ${linkBlockSummary.id} to ${keptDeadId}.`);
    }
    const linksAfterRemove = ((wrap(store, linkBlockSummary.id) as unknown as BlockNode).links as unknown as Link[] | undefined) ?? [];
    const stillPointsAtKeptDead = linksAfterRemove.some(
      (l) => l.predicate === 'references' && (l.target as unknown as { id: string } | undefined)?.id === keptDeadId
    );
    if (stillPointsAtKeptDead) {
      throw new Error(`Expected no remaining manual link to ${keptDeadId} after removal.`);
    }
    const wikilinkCountAfterRemove = linksAfterRemove.filter((l) => l.predicate === WIKILINK_PREDICATE).length;
    const manualCountAfterRemove = linksAfterRemove.filter((l) => l.predicate === 'references').length;
    if (manualCountAfterRemove !== stillLiveLinkIds.filter((id) => {
      const l = wrap(store, id) as unknown as Link;
      return l.predicate === 'references';
    }).length) {
      throw new Error(`Expected runRemoveBlockLink to touch only the targeted link, leaving this block's other manual links untouched.`);
    }
    const { pruned: prunedAfterUnlink } = pruneUnreachableTombstones(store);
    if (nodeExists(store, keptDeadId)) {
      throw new Error(`Expected '${keptDeadId}' to finally be collected by GC now that its only reference was removed via kg:unlink.`);
    }
    console.log(`   - Manual link removed (${wikilinkCountAfterRemove} wikilink(s), ${manualCountAfterRemove} manual link(s) remain); a further GC pass then collected the now-unreferenced tombstone (${prunedAfterUnlink} pruned).`);
    console.log("   [✓] kg:unlink verified successfully.\n");

    console.log("12. Testing kg:backlinks (runBacklinks) — the reverse of kg:unfold's forward view...");
    const backlinkTargetId = `BlockNode:${generateNodeId()}`;
    const backlinkTarget = wrap(store, backlinkTargetId) as unknown as BlockNode;
    backlinkTarget.type = 'heading'; backlinkTarget.title = 'Backlink Target'; backlinkTarget.children = [];
    const referrerId = `BlockNode:${generateNodeId()}`;
    const referrer = wrap(store, referrerId) as unknown as BlockNode;
    referrer.type = 'paragraph'; referrer.title = 'Referrer Para'; referrer.text = 'See the target above.'; referrer.children = [];
    referrer.addLink('references', backlinkTargetId);

    const backlinkResults = runBacklinks(store, backlinkTargetId, false);
    if (backlinkResults.length !== 1) {
      throw new Error(`Expected exactly 1 backlink to ${backlinkTargetId}, got ${backlinkResults.length}.`);
    }
    const [bl] = backlinkResults;
    if (!bl.linkId.startsWith(`${referrerId}:links:Link:`)) {
      throw new Error(`Expected the backlink's linkId to be prefixed by its owner ${referrerId}, got '${bl.linkId}'.`);
    }
    if (bl.label !== 'paragraph') throw new Error(`Expected label 'paragraph', got '${bl.label}'.`);
    if (bl.title !== 'Referrer Para') throw new Error(`Expected title 'Referrer Para', got '${bl.title}'.`);
    if (bl.text !== undefined) throw new Error(`Expected no 'text' field without --text, got '${bl.text}'.`);
    const backlinkResultsWithText = runBacklinks(store, backlinkTargetId, true);
    if (backlinkResultsWithText[0].text !== 'See the target above.') {
      throw new Error(`Expected --text to include the referrer's own abstract, got '${backlinkResultsWithText[0].text}'.`);
    }
    console.log(`   - Found ${backlinkResults.length} backlink(s) to ${backlinkTargetId}: ${bl.linkId}  [${bl.label}]  ${bl.title}`);
    console.log("   [✓] kg:backlinks verified successfully.\n");

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
    const occurrencesAfterReingest = ((termItemAfterReingest.text as string) ?? '').split(idAnchorMarker).length - 1;
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

    console.log("   [✓] ApeironNgn Substrate Integration complete & verified!");
  } finally {
    console.log("\n   Cleaning up demo state...");
    resetDemoState();
  }

  console.log("\n=================================================");
  console.log("   ApeironNgn Substrate Verification Complete!    ");
  console.log("=================================================");
}

// Execute locally if run directly
if (typeof process !== 'undefined' && process.argv && process.argv[1]?.endsWith('verify.ts')) {
  runApeironNgnVerification().catch((err) => {
    console.error('\n[!] ApeironNgn verification failed:', err.message || err);
    process.exit(1);
  });
}
