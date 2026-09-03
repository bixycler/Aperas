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

import { writeFileSync, unlinkSync, existsSync, mkdirSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseMarkdownTree, WIKILINK_PREDICATE } from './astParser';
import { getArtifactsDir } from './artifacts';
import { serializeBlock } from './project';
import { reconcileTree } from './reconcile';
import { getProp } from './props';
import { rehydrateStore } from './apeironNgn/store';
import { dehydrateToJsonLd } from './apeironNgn/dehydrate';
import { trackArtifact, ingestArtifact } from './apeironNgn/artifacts';
import { ingestFolderTree, getFolderRecord } from './apeironNgn/folders';
import { findByExactPath } from './apeironNgn/tree';
import { wrap, type ArtifactNode, type BlockNode, type FolderNode } from './apeironNgn/node';

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
  console.log(`   - vs. re-parsed projection: ${roundTripStats.unchanged} unchanged, ${roundTripStats.moved} moved, ${roundTripStats.added} added, ${roundTripStats.removed} removed.`);
  if (roundTripStats.added !== 0 || roundTripStats.removed !== 0) {
    throw new Error(
      `Round-trip projection mismatch: expected zero added/removed, got added=${roundTripStats.added} removed=${roundTripStats.removed}.\nProjected Markdown:\n${projectedSample}`
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
    const ingestResult = ingestArtifact(store, DEMO_ARTIFACT_PATH);
    console.log(`   - Blocks ingested: ${ingestResult?.blockCount}`);
    console.log("   [✓] Artifact tracking & ingestion verified successfully.\n");

    console.log("4. Reading the ingested tree back via wrap()...");
    const demoId = findByExactPath(store, DEMO_ARTIFACT_PATH);
    if (!demoId) throw new Error('No ArtifactNode found for the demo artifact after ingestion — cannot continue verification.');
    const artifactNode = wrap(store, demoId) as unknown as ArtifactNode;
    const rootNode = artifactNode.root as unknown as BlockNode;
    if (!rootNode) throw new Error('ArtifactNode.root is unset after ingestion — cannot continue verification.');
    const rootId = rootNode.id;
    const firstChildId = ((rootNode.children as unknown as BlockNode[] | undefined)?.[0])?.id;
    console.log(`   - Blocks resolved via wrap(): ${collectIds(rootNode).length}`);
    console.log("   [✓] In-process tree read verified successfully.\n");

    console.log("5. Re-ingesting an edited version and verifying reconciliation...");
    const rootBareCode = rootId.split('/')[1];
    const editedMarkdown = sampleMarkdown + `\n\n## A New Section\n\nA freshly added paragraph.\n\nA [self link]([[${rootBareCode}]]) back to the root, a [forward reference]([[NotYetWritten]]) that should become a holder, and a [truly dangling one]([[../../../../nowhere]]) that still can't resolve.`;
    writeFileSync(demoAbsPath, editedMarkdown, 'utf-8');
    trackArtifact(store, DEMO_ARTIFACT_PATH);
    const reingestResult = ingestArtifact(store, DEMO_ARTIFACT_PATH);
    if (!reingestResult?.reconciliation) {
      throw new Error('Expected a reconciliation report on re-ingestion of an already-ingested artifact.');
    }
    const { unchanged, moved, added, removed } = reingestResult.reconciliation;
    console.log(`   - Reconciliation: ${unchanged} unchanged, ${moved} moved, ${added} added, ${removed} removed.`);
    if (unchanged === 0 || added === 0) {
      throw new Error(`Expected both unchanged and added blocks from this edit, got unchanged=${unchanged} added=${added}.`);
    }
    const reingestedRoot = (wrap(store, demoId) as unknown as ArtifactNode).root as unknown as BlockNode;
    const reingestedIds = new Set(collectIds(reingestedRoot));
    if (!reingestedIds.has(rootId) || (firstChildId && !reingestedIds.has(firstChildId))) {
      throw new Error('Expected the root and first child to keep their id across reconciliation — identity was not preserved.');
    }
    console.log("   [✓] Reconciliation matching verified successfully.\n");

    console.log("5b. Testing BlockNode.links extraction (Aperas-markdown-fractal-mapping-design.md §4)...");
    const linkBlockSummary = findByText(reingestedRoot, 'self link');
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
    const projected = folderNode.toReadme();
    if (!projected.includes('draft: true') || !projected.includes('Intro sentence for the demo folder.') || !projected.includes('item one')) {
      throw new Error(`Expected projected README to include frontmatter, consumed text, and list items, got:\n${projected}`);
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
      const rehydratedRootId = (rehydratedArtifact.root as unknown as BlockNode | undefined)?.id;
      if (rehydratedArtifact.title !== artifactNode.title || rehydratedRootId !== reingestedRoot.id) {
        throw new Error('Expected the demo artifact\'s title and root id to survive a dehydrate -> rehydrate round-trip unchanged.');
      }
      console.log(`   - ${scratchQuadCount} quads round-tripped, 0 dangling references, demo artifact identity intact.`);
      console.log("   [✓] Dehydrate/rehydrate round-trip verified successfully.\n");
    } finally {
      rmSync(scratchDir, { recursive: true, force: true });
    }

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
if (typeof process !== 'undefined' && process.argv && process.argv[1]?.includes('verifyApeironNgn')) {
  runApeironNgnVerification().catch((err) => {
    console.error('\n[!] ApeironNgn verification failed:', err.message || err);
    process.exit(1);
  });
}
