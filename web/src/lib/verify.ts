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

import { writeFileSync, existsSync, mkdirSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseMarkdownTree, WIKILINK_PREDICATE } from './astParser';
import { getArtifactsDir } from './artifacts';
import { serializeBlock } from './project';
import { reconcileTree } from './reconcile';
import { getProp, getProps } from './props';
import { rehydrateStore } from './apeironNgn/store';
import { dehydrateToJsonLd } from './apeironNgn/dehydrate';
import { trackArtifact, ingestArtifact } from './apeironNgn/artifacts';
import { ingestFolderTree, getFolderRecord } from './apeironNgn/folders';
import { findByExactPath } from './apeironNgn/tree';
import { wrap, ensureDefaultView, pruneUnreachableTombstones, type ArtifactNode, type BlockNode, type FolderNode, type Link, type TreeView, type ApeironNode } from './apeironNgn/node';
import { nodeExists } from './apeironNgn/vocab';
import { generateNodeId } from './snowflake';
import { runAddBlockLink, runRemoveBlockLink } from './kgLink';

const DEMO_DIR = '__verify_apeironngn_demo';
const DEMO_ARTIFACT_PATH = `${DEMO_DIR}/demo.md`;
const DEMO_README_PATH = `${DEMO_DIR}/README.md`;

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

- consumed item one
- consumed item two`;

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

  console.log("1c. Testing heading consume + list adoption (§2/§8)...");
  const consumingHeading = findHeadingByTitle(rootBlock, 'A Consuming Example');
  if (!consumingHeading) throw new Error('Expected to find the "A Consuming Example" heading.');
  if (consumingHeading.text !== 'An introductory sentence.') {
    throw new Error(`Expected the heading to consume its leading paragraph as its own text, got: ${JSON.stringify(consumingHeading.text)}`);
  }
  const consumingChildren = consumingHeading.children ?? [];
  if (consumingChildren.some((c: any) => c.type === 'paragraph')) {
    throw new Error('Expected the consumed leading paragraph to NOT also survive as a separate child (that would be the old copy bug).');
  }
  if (consumingChildren.length !== 2 || !consumingChildren.every((c: any) => c.type === 'listItem')) {
    throw new Error(`Expected the list right after the leading paragraph to adopt directly into the heading (2 listItem children), got: ${JSON.stringify(consumingChildren.map((c: any) => c.type))}`);
  }
  if (getProp(consumingHeading, 'orderedList') !== 'false' || getProp(consumingHeading, 'startIndex') !== '1') {
    throw new Error(`Expected the heading itself to carry the adopted list's orderedList/startIndex props, got orderedList=${getProp(consumingHeading, 'orderedList')} startIndex=${getProp(consumingHeading, 'startIndex')}`);
  }
  console.log("   [✓] Heading consume + list adoption verified successfully.\n");

  console.log("1d. Testing two directly-adjacent lists (second one must be orphaned, not merged into the first's adoption)...");
  const metaphysicsHeading = findHeadingByTitle(rootBlock, 'Metaphysics of Aperas');
  if (!metaphysicsHeading) throw new Error('Expected to find the "Metaphysics of Aperas" heading.');
  const metaChildren = metaphysicsHeading.children ?? [];
  const adoptedBulletItems = metaChildren.filter((c: any) => c.type === 'listItem');
  const orphanOrderedList = metaChildren.find((c: any) => c.type === 'list');
  if (adoptedBulletItems.length !== 5) {
    throw new Error(`Expected the bullet list's 5 items to adopt directly into the heading, got ${adoptedBulletItems.length}.`);
  }
  if (getProp(metaphysicsHeading, 'orderedList') !== 'false') {
    throw new Error(`Expected the heading's own props to reflect the (unordered) bullet list it adopted, got orderedList=${getProp(metaphysicsHeading, 'orderedList')}.`);
  }
  if (!orphanOrderedList || getProp(orphanOrderedList, 'orderedList') !== 'true' || (orphanOrderedList.children ?? []).length !== 2) {
    throw new Error(`Expected the immediately-following ordered list to be its own orphaned node (its preceding sibling is a list, not a valid anchor), got: ${JSON.stringify(orphanOrderedList)}`);
  }
  console.log("   [✓] Adjacent-lists orphaning verified successfully.\n");

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
    const rootBareCode = rootId.split('/')[1];
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
    const folderNode = wrap(store, `FolderNode/${folderRecord.folderId}`) as unknown as FolderNode;
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
    const reprojected = (wrap(store, `FolderNode/${folderRecord.folderId}`) as unknown as FolderNode).toReadme();
    if (reprojected !== projected) {
      throw new Error(`Expected project -> write -> re-ingest -> project to be stable, got drift.\nfirst:\n${projected}\nsecond:\n${reprojected}`);
    }
    console.log("   [✓] FolderNode README projection verified successfully.\n");

    console.log("7. Testing dehydrate -> rehydrate round-trip (isolated scratch directory)...");
    const scratchDir = mkdtempSync(join(tmpdir(), 'apeironngn-verify-'));
    try {
      const { counts } = dehydrateToJsonLd(store, scratchDir);
      const { store: rehydrated, quadCount: scratchQuadCount, danglingRefs } = rehydrateStore(scratchDir);
      console.log(`   - Dehydrated: ${JSON.stringify(counts)}`);
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
    const victimId = `BlockNode/${generateNodeId()}`;
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
    const deadAId = `BlockNode/${generateNodeId()}`;
    const deadBId = `BlockNode/${generateNodeId()}`;
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
    const keptDeadId = `BlockNode/${generateNodeId()}`;
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
