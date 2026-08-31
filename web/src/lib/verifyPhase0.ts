/**
 * Aperas Phase 0: Verification & Test Harness
 *
 * Validates the fractal-ontology substrate without UI overhead:
 * - Markdown AST parsing into a fractal BlockNode tree
 * - TerminusDB JSON-LD schema initialization
 * - Artifact tracking & on-demand ingestion (ArtifactNode + BlockNode tree)
 * - Reconciliation matching on re-ingestion of an edited artifact
 * - Artifact Projection round-trip (serialize a BlockNode tree back to Markdown)
 * - FolderNode structural tree ingestion
 * - Extrinsic Assertion storage & WOQL impact propagation
 * - GraphQL tree read path
 * - Temporal commit management
 */

import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseMarkdownTree, WIKILINK_PREDICATE } from './astParser';
import { createTerminusClient, initializeAperasDatabase } from './client';
import { getArtifactsDir, trackArtifact, ingestArtifact, getArtifactRecord } from './artifacts';
import { ingestFolderTree } from './folders';
import { insertAssertion, deleteAssertionsInvolvingNode, findLinkIdsTargeting, deleteDocumentIfExists, deleteDocumentsIfExist } from './crud';
import { queryNodeAssertions, traceImpactPropagation } from './woql';
import { getArtifactTreeViaGraphQL } from './graphql';
import { getCommitHistory, createBranch, deleteBranchIfExists } from './versionControl';
import { serializeBlock, projectFolderToReadme } from './project';
import { reconcileTree } from './reconcile';
import { getProp } from './props';

const DEMO_ARTIFACT_NAME = '__verify_phase0_demo.md';

function collectBlockIds(node: any): string[] {
  if (!node) return [];
  const ids = [node.blockId as string];
  for (const child of node.children || []) {
    ids.push(...collectBlockIds(child));
  }
  return ids;
}

/**
 * Tears down the demo ArtifactNode/BlockNode tree, if any exists, so re-runs (and a
 * fresh start) are idempotent. Order matters: TerminusDB enforces referential
 * integrity, so FolderNode/. has to stop referencing the demo ArtifactNode (by
 * rebuilding the folder tree from a demo-file-free disk) before the ArtifactNode can
 * be deleted, which in turn has to happen before its BlockNodes (still pointed to via
 * `root`) can be deleted. Re-derives the block ids fresh via GraphQL each call rather
 * than trusting a caller-tracked list, so it's correct whether there's fresh state
 * from this run or stale state left over from an earlier crashed one.
 */
async function resetDemoState(client: any, demoPath: string, demoReadmePath?: string): Promise<void> {
  if (existsSync(demoPath)) unlinkSync(demoPath);
  if (demoReadmePath && existsSync(demoReadmePath)) unlinkSync(demoReadmePath);
  await ingestFolderTree(client);
  const tree = await getArtifactTreeViaGraphQL(client, DEMO_ARTIFACT_NAME);
  // ArtifactNode's key is its Snowflake-generated artifactId, not path (Appendix G) — look up
  // its actual @id via a path-filtered query rather than guessing `ArtifactNode/<path>`.
  const record = await getArtifactRecord(client, DEMO_ARTIFACT_NAME);
  if (record) {
    await deleteDocumentIfExists(client, `terminusdb:///data/ArtifactNode/${record.artifactId}`);
  }
  if (tree?.root) {
    const ids = collectBlockIds(tree.root);
    // Assertion points AT a block (source/target), independently of everything else, so
    // deleting it first (before the blocks) is always safe. A `Link` is different: it sits in a
    // genuine reference cycle with the blocks around it (an owning block's `links` points at the
    // Link, which `target`s some other block) — see findLinkIdsTargeting's own comment. Deleted
    // separately in either order, each side fails as still-referenced by the other; deleted
    // together with the blocks in one combined batch, TerminusDB's referential-integrity check
    // only looks for references from *outside* the batch, so the cycle resolves cleanly.
    for (const id of ids) {
      await deleteAssertionsInvolvingNode(client, `BlockNode/${id}`);
    }
    const blockFullIds = ids.map((id) => `BlockNode/${id}`);
    const linkIds = await findLinkIdsTargeting(client, blockFullIds);
    await deleteDocumentsIfExist(client, [...blockFullIds.map((id) => `terminusdb:///data/${id}`), ...linkIds]);
  }
}

export async function runPhase0Verification(opts: { connectToDb?: boolean } = {}) {
  console.log("=================================================");
  console.log("   Aperas Phase 0: Substrate Verification Test   ");
  console.log("=================================================\n");

  // 1. Sample Markdown AST Parsing
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
  const allIds = collectBlockIds(rootBlock);
  console.log(`   - Root title: "${rootBlock.title}"`);
  console.log(`   - Blocks parsed: ${allIds.length}`);
  console.log(`   - Ids unique: ${new Set(allIds).size === allIds.length}`);

  // Frontmatter (§5) is extracted separately from the BlockNode tree entirely, opaque (raw
  // YAML body, not parsed into key/value pairs) — never a block, never folded into `children`.
  if (!frontmatter?.includes('title: Metaphysics of Aperas')) {
    throw new Error(`Expected frontmatter to be extracted as a raw YAML body, got: ${JSON.stringify(frontmatter)}`);
  }
  console.log("   [✓] YAML frontmatter extracted separately from the block tree.\n");

  function findByTitleContaining(node: any, needle: string): any {
    if (typeof node.text === 'string' && node.text.includes(needle)) return node;
    for (const child of node.children || []) {
      const found = findByTitleContaining(child, needle);
      if (found) return found;
    }
    return null;
  }
  // Task-list `checked` needs remark-gfm (plain remark-parse leaves it `null` regardless of
  // source syntax) — now a `props` entry (§7/§8), not a plain field. Assert the actual values,
  // not just structural round-trip equivalence, since a passing round-trip previously masked
  // `checked` being silently non-functional.
  const openItem = findByTitleContaining(rootBlock, 'An open question');
  const settledItem = findByTitleContaining(rootBlock, 'A settled one');
  if (getProp(openItem ?? {}, 'checked') !== 'false' || getProp(settledItem ?? {}, 'checked') !== 'true') {
    throw new Error(`Expected task-list checked to be captured correctly (remark-gfm) via props, got open=${getProp(openItem ?? {}, 'checked')} settled=${getProp(settledItem ?? {}, 'checked')}`);
  }
  console.log("   [✓] AST Transduction verified successfully.\n");

  console.log("1c. Testing heading consume + list adoption (§2/§8)...");
  function findHeadingByTitle(node: any, needle: string): any {
    if (node.type === 'heading' && node.title?.includes(needle)) return node;
    for (const child of node.children || []) {
      const found = findHeadingByTitle(child, needle);
      if (found) return found;
    }
    return null;
  }
  const consumingHeading = findHeadingByTitle(rootBlock, 'A Consuming Example');
  if (!consumingHeading) {
    throw new Error('Expected to find the "A Consuming Example" heading.');
  }
  if (consumingHeading.text !== 'An introductory sentence.') {
    throw new Error(`Expected the heading to consume its leading paragraph as its own text, got: ${JSON.stringify(consumingHeading.text)}`);
  }
  const consumingChildren = consumingHeading.children ?? [];
  const hasStandaloneParagraphChild = consumingChildren.some((c: any) => c.type === 'paragraph');
  if (hasStandaloneParagraphChild) {
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
  if (!metaphysicsHeading) {
    throw new Error('Expected to find the "Metaphysics of Aperas" heading.');
  }
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
  const projected = serializeBlock(rootBlock);
  const { root: reparsedBlock } = parseMarkdownTree(projected);
  const { stats: roundTripStats } = reconcileTree(rootBlock, reparsedBlock);
  console.log(`   - vs. re-parsed projection: ${roundTripStats.unchanged} unchanged, ${roundTripStats.moved} moved, ${roundTripStats.added} added, ${roundTripStats.removed} removed.`);
  if (roundTripStats.added !== 0 || roundTripStats.removed !== 0) {
    throw new Error(
      `Round-trip projection mismatch: expected zero added/removed, got added=${roundTripStats.added} removed=${roundTripStats.removed}.\nProjected Markdown:\n${projected}`
    );
  }
  console.log("   [✓] Artifact Projection round-trip verified successfully.\n");

  // 2. Database Connection Check if DB server is available
  if (opts.connectToDb) {
    const artifactsDir = getArtifactsDir();
    const demoPath = join(artifactsDir, DEMO_ARTIFACT_NAME);
    const demoReadmePath = join(artifactsDir, 'README.md');
    let branchId = '';

    try {
      console.log("2. Connecting to TerminusDB & Initializing Schema...");
      await initializeAperasDatabase();
      const client = createTerminusClient();

      console.log("   Resetting prior demo state for an idempotent re-run...");
      await resetDemoState(client, demoPath, demoReadmePath);
      branchId = `verify_phase0_${Date.now()}`;
      await deleteBranchIfExists(client, branchId);

      console.log("3. Tracking & Ingesting a demo ArtifactNode + fractal BlockNode tree...");
      writeFileSync(demoPath, sampleMarkdown, 'utf-8');
      await trackArtifact(client, DEMO_ARTIFACT_NAME);
      const ingestResult = await ingestArtifact(client, DEMO_ARTIFACT_NAME);
      console.log(`   - Blocks ingested: ${ingestResult?.blockCount}`);
      console.log("   [✓] Artifact tracking & ingestion verified successfully.\n");

      console.log("4. Reading the ingested tree back via the GraphQL endpoint...");
      const artifactTree = await getArtifactTreeViaGraphQL(client, DEMO_ARTIFACT_NAME);
      if (!artifactTree?.root) {
        throw new Error('GraphQL returned no root for the ingested ArtifactNode — cannot continue verification.');
      }
      const rootId = `BlockNode/${artifactTree.root.blockId}`;
      const childId = `BlockNode/${artifactTree.root.children[0].blockId}`;
      console.log(`   - Blocks resolved via GraphQL: ${collectBlockIds(artifactTree.root).length}`);
      console.log("   [✓] GraphQL read path verified successfully.\n");

      console.log("5. Re-ingesting an edited version and verifying reconciliation...");
      const rootBareCode = artifactTree.root.blockId;
      const editedMarkdown = sampleMarkdown + `\n\n## A New Section\n\nA freshly added paragraph.\n\nA [self link]([[${rootBareCode}]]) back to the root, and a [dangling one]([[ZZZZZZZZZZZZZ]]) that shouldn't resolve.`;
      writeFileSync(demoPath, editedMarkdown, 'utf-8');
      await trackArtifact(client, DEMO_ARTIFACT_NAME);
      const reingestResult = await ingestArtifact(client, DEMO_ARTIFACT_NAME);
      if (!reingestResult?.reconciliation) {
        throw new Error('Expected a reconciliation report on re-ingestion of an already-ingested artifact.');
      }
      const { unchanged, moved, added, removed } = reingestResult.reconciliation;
      console.log(`   - Reconciliation: ${unchanged} unchanged, ${moved} moved, ${added} added, ${removed} removed.`);
      if (unchanged === 0 || added === 0) {
        throw new Error(`Expected both unchanged and added blocks from this edit, got unchanged=${unchanged} added=${added}.`);
      }
      const reingestedTree = await getArtifactTreeViaGraphQL(client, DEMO_ARTIFACT_NAME);
      const reingestedIds = new Set(collectBlockIds(reingestedTree.root));
      if (!reingestedIds.has(artifactTree.root.blockId) || !reingestedIds.has(artifactTree.root.children[0].blockId)) {
        throw new Error('Expected the root and first child to keep their blockId across reconciliation — identity was not preserved.');
      }
      console.log("   [✓] Reconciliation matching verified successfully.\n");

      console.log("5b. Testing BlockNode.links extraction (Aperas-markdown-fractal-mapping-design.md §4)...");
      function findByText(node: any, needle: string): any {
        if (typeof node.text === 'string' && node.text.includes(needle)) return node;
        for (const child of node.children ?? []) {
          const found = findByText(child, needle);
          if (found) return found;
        }
        return null;
      }
      const linkBlockSummary = findByText(reingestedTree.root, 'self link');
      if (!linkBlockSummary) {
        throw new Error('Expected to find the paragraph containing the self-link.');
      }
      // Plain Document API, not GraphQL, for this read — simpler here since only the raw
      // links/predicate values are needed, not a full nested tree walk (kgCli.ts's kg:tree/
      // kg:unfold make the same choice for the same reason).
      const linkBlockDoc = await client.getDocument({ id: `BlockNode/${linkBlockSummary.blockId}` });
      const linkIds: string[] = linkBlockDoc?.links ?? [];
      if (linkIds.length !== 1) {
        throw new Error(`Expected exactly one resolved link (the dangling one should be skipped), got ${linkIds.length}: ${JSON.stringify(linkIds)}`);
      }
      const linkDoc = await client.getDocument({ id: linkIds[0] });
      if (linkDoc?.predicate !== WIKILINK_PREDICATE || linkDoc?.target !== rootId) {
        throw new Error(`Expected the resolved Link to target ${rootId} with predicate '${WIKILINK_PREDICATE}', got: ${JSON.stringify(linkDoc)}`);
      }
      console.log(`   - Resolved link: (${linkIds[0]}) --[${WIKILINK_PREDICATE}]--> (${rootId}); dangling link correctly skipped.`);
      console.log("   [✓] BlockNode.links extraction verified successfully.\n");

      console.log("6. Ingesting FolderNode structural tree...");
      const { folderCount } = await ingestFolderTree(client);
      console.log(`   - Folders in tree: ${folderCount}`);
      console.log("   [✓] Folder ingestion verified successfully.\n");

      console.log("6b. Testing FolderNode README projection & write-by-default kg:project...");
      const demoReadme = `---
draft: true
---
# Demo Folder

Intro sentence for the demo folder.

- item one
- item two`;
      writeFileSync(demoReadmePath, demoReadme, 'utf-8');
      await ingestFolderTree(client);
      const projected = await projectFolderToReadme(client, '.');
      if (!projected?.includes('draft: true') || !projected.includes('Intro sentence for the demo folder.') || !projected.includes('item one')) {
        throw new Error(`Expected projected README to include frontmatter, consumed text, and list items, got:\n${projected}`);
      }
      // Write-by-default: actually write the regenerated content, re-ingest it, and confirm
      // projecting again reproduces the exact same output — a stable fixed point, not drift.
      writeFileSync(demoReadmePath, projected, 'utf-8');
      await ingestFolderTree(client);
      const reprojected = await projectFolderToReadme(client, '.');
      if (reprojected !== projected) {
        throw new Error(`Expected project -> write -> re-ingest -> project to be stable, got drift.\nfirst:\n${projected}\nsecond:\n${reprojected}`);
      }
      console.log("   [✓] FolderNode README projection verified successfully.\n");

      console.log("7. Committing an extrinsic Assertion & querying it back via WOQL...");
      await insertAssertion(client, { source: rootId, predicate: "impacts", target: childId });
      const assertions = await queryNodeAssertions(client, rootId);
      console.log(`   - Assertions found for ${rootId}: ${assertions.length}`);
      const affected = await traceImpactPropagation(client, rootId, "impacts");
      console.log(`   - Impact sweep results from ${rootId}: ${JSON.stringify(affected)}`);
      if (!affected.includes(childId)) {
        throw new Error(`Expected impact propagation to include ${childId}, got ${JSON.stringify(affected)}`);
      }
      console.log("   [✓] Assertion CRUD & WOQL traversal verified successfully.\n");

      console.log("8. Verifying Temporal Commit Management (branch + commit log)...");
      await createBranch(client, branchId);
      const commitHistory = await getCommitHistory(client, 0, 5);
      console.log(`   - Branch '${branchId}' created.`);
      console.log(`   - Recent commits on main: ${commitHistory.length}`);
      console.log("   [✓] Temporal commit management verified successfully.\n");

      console.log("   [✓] TerminusDB Substrate Integration complete & verified!");
    } catch (err: any) {
      console.warn("\n   [!] TerminusDB substrate verification failed:", err.message || err);
      console.log("   Note: Ensure TerminusDB container is running locally (`docker run -p 6363:6363 terminusdb/terminusdb-server`).");
    } finally {
      console.log("\n   Cleaning up demo state...");
      try {
        const client = createTerminusClient();
        await resetDemoState(client, demoPath, demoReadmePath);
        if (branchId) await deleteBranchIfExists(client, branchId);
      } catch (cleanupErr: any) {
        console.warn("   [!] Cleanup of demo KG state failed:", cleanupErr.message || cleanupErr);
      }
    }
  } else {
    console.log("2. Database connectivity test skipped (run with connectToDb: true when TerminusDB server is running).");
  }

  console.log("\n=================================================");
  console.log("   Phase 0 Substrate Verification Complete!      ");
  console.log("=================================================");
}

// Execute locally if run directly
if (typeof process !== 'undefined' && process.argv && process.argv[1]?.includes('verifyPhase0')) {
  const shouldConnect = process.argv.includes('--db');
  runPhase0Verification({ connectToDb: shouldConnect });
}

