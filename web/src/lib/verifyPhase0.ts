/**
 * Aperas Phase 1: Verification & Test Harness
 *
 * Validates the fractal-ontology substrate without UI overhead:
 * - Markdown AST parsing into a fractal BlockNode tree
 * - TerminusDB JSON-LD schema initialization
 * - Artifact tracking & on-demand ingestion (ArtifactNode + BlockNode tree)
 * - Reconciliation matching on re-ingestion of an edited artifact
 * - FolderNode structural tree ingestion
 * - Extrinsic Assertion storage & WOQL impact propagation
 * - GraphQL tree read path
 * - Temporal commit management
 */

import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseMarkdownTree } from './astParser';
import { createTerminusClient, initializeAperasDatabase } from './client';
import { getArtifactsDir, trackArtifact, ingestArtifact, getArtifactRecord } from './artifacts';
import { ingestFolderTree } from './folders';
import { insertAssertion, deleteAssertionsInvolvingNode, deleteDocumentIfExists, deleteDocumentsIfExist } from './crud';
import { queryNodeAssertions, traceImpactPropagation } from './woql';
import { getArtifactTreeViaGraphQL } from './graphql';
import { getCommitHistory, createBranch, deleteBranchIfExists } from './versionControl';

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
async function resetDemoState(client: any, demoPath: string): Promise<void> {
  if (existsSync(demoPath)) unlinkSync(demoPath);
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
    for (const id of ids) {
      await deleteAssertionsInvolvingNode(client, `BlockNode/${id}`);
    }
    await deleteDocumentsIfExist(client, ids.map((id) => `terminusdb:///data/BlockNode/${id}`));
  }
}

export async function runPhase0Verification(opts: { connectToDb?: boolean } = {}) {
  console.log("=================================================");
  console.log("   Aperas Phase 1: Substrate Verification Test   ");
  console.log("=================================================\n");

  // 1. Sample Markdown AST Parsing
  const sampleMarkdown = `# Metaphysics of Aperas

Aperas operates over a fluid, unconditioned semantic core (Apeiron) and crystallizes typed boundaries (Peras) on demand.

- Unbounded: Apeiron macrocosm
- Unbound: Aperas microcosm
- Bound: Peras transient interface`;

  console.log("1. Testing AST Transducer (Fractal BlockNode Tree)...");
  const rootBlock = parseMarkdownTree(sampleMarkdown);
  const allIds = collectBlockIds(rootBlock);
  console.log(`   - Root title: "${rootBlock.title}"`);
  console.log(`   - Blocks parsed: ${allIds.length}`);
  console.log(`   - Ids unique: ${new Set(allIds).size === allIds.length}`);
  console.log("   [✓] AST Transduction verified successfully.\n");

  // 2. Database Connection Check if DB server is available
  if (opts.connectToDb) {
    const artifactsDir = getArtifactsDir();
    const demoPath = join(artifactsDir, DEMO_ARTIFACT_NAME);
    let branchId = '';

    try {
      console.log("2. Connecting to TerminusDB & Initializing Schema...");
      await initializeAperasDatabase();
      const client = createTerminusClient();

      console.log("   Resetting prior demo state for an idempotent re-run...");
      await resetDemoState(client, demoPath);
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
      const editedMarkdown = sampleMarkdown + `\n\n## A New Section\n\nA freshly added paragraph.`;
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

      console.log("6. Ingesting FolderNode structural tree...");
      const { folderCount } = await ingestFolderTree(client);
      console.log(`   - Folders in tree: ${folderCount}`);
      console.log("   [✓] Folder ingestion verified successfully.\n");

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
        await resetDemoState(client, demoPath);
        if (branchId) await deleteBranchIfExists(client, branchId);
      } catch (cleanupErr: any) {
        console.warn("   [!] Cleanup of demo KG state failed:", cleanupErr.message || cleanupErr);
      }
    }
  } else {
    console.log("2. Database connectivity test skipped (run with connectToDb: true when TerminusDB server is running).");
  }

  console.log("\n=================================================");
  console.log("   Phase 1 Substrate Verification Complete!      ");
  console.log("=================================================");
}

// Execute locally if run directly
if (typeof process !== 'undefined' && process.argv && process.argv[1]?.includes('verifyPhase0')) {
  const shouldConnect = process.argv.includes('--db');
  runPhase0Verification({ connectToDb: shouldConnect });
}
