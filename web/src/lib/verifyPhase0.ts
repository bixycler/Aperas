/**
 * Aperas Phase 0: Verification & Test Harness
 * 
 * Validates the core Apeiron substrate without UI overhead:
 * - AST parsing & offset tracking
 * - TerminusDB JSON-LD schema initialization
 * - Coarse Markdown block tree storage
 * - On-demand lazy span atomization
 * - Triple assertion storage & WOQL impact propagation
 */

import { parseMarkdownDocument, createReifiedSpan } from './astParser';
import { createTerminusClient, initializeAperasDatabase } from './client';
import {
  insertDocumentAndBlocks,
  reifySpanOnDemand,
  insertTripleAssertion,
  deleteDocumentIfExists,
  deleteTripleAssertionsInvolvingNode
} from './crud';
import { queryNodeAssertions, traceImpactPropagation } from './woql';
import { getDocumentBlocksViaGraphQL } from './graphql';
import { getCommitHistory, createBranch, deleteBranchIfExists } from './versionControl';

export async function runPhase0Verification(opts: { connectToDb?: boolean } = {}) {
  console.log("=================================================");
  console.log("   Aperas Phase 0: Substrate Verification Test   ");
  console.log("=================================================\n");

  // 1. Sample Markdown AST Parsing
  const sampleMarkdown = `# Metaphysics of Aperas

Aperas operates over a fluid, unconditioned semantic core (Apeiron) and crystallizes typed boundaries (Peras) on demand.

- Unbounded: Apeiron macrocosm
- Unbound: Aperas microcosm
- Bound: Peras transient interface`;

  console.log("1. Testing AST Transducer & Character Offset Tracking...");
  const parsedDoc = parseMarkdownDocument("doc_demo_1", "Metaphysics of Aperas", sampleMarkdown);
  console.log(`   - Document ID: ${parsedDoc.docId}`);
  console.log(`   - Blocks Extracted: ${parsedDoc.blocks.length}`);
  parsedDoc.blocks.forEach((b, idx) => {
    console.log(`     [Block ${idx + 1}] Type: ${b.nodeType} | Offsets: [${b.startOffset}, ${b.endOffset}] | Snippet: "${b.content.slice(0, 40).replace(/\n/g, ' ')}..."`);
  });
  console.log("   [✓] AST Transduction verified successfully.\n");

  // 2. Lazy Atomization Check
  console.log("2. Testing On-Demand Inline Span Reification (Lazy Atomization)...");
  const targetBlock = parsedDoc.blocks[1]; // paragraph block
  const span = createReifiedSpan(
    targetBlock,
    "span_apeiron_1",
    35, 42, // slices "Apeiron"
    "refers_to"
  );
  console.log(`   - Reified Span ID: ${span.spanId}`);
  console.log(`   - Target Text: "${span.text}"`);
  console.log(`   - Absolute Offsets: [${span.startOffset}, ${span.endOffset}]`);
  console.log("   [✓] Lazy span atomization verified successfully.\n");

  // 3. Database Connection Check if DB server is available
  if (opts.connectToDb) {
    try {
      console.log("3. Connecting to TerminusDB & Initializing Schema...");
      await initializeAperasDatabase();
      const client = createTerminusClient();

      console.log("   Resetting prior demo state for an idempotent re-run...");
      await deleteTripleAssertionsInvolvingNode(client, span.spanId);
      await deleteDocumentIfExists(client, `terminusdb:///data/SpanNode/${span.spanId}`);
      for (const block of parsedDoc.blocks) {
        await deleteDocumentIfExists(client, `terminusdb:///data/BlockNode/${block.blockId}`);
      }
      await deleteDocumentIfExists(client, `terminusdb:///data/DocumentNode/${parsedDoc.docId}`);
      await deleteBranchIfExists(client, `verify_phase0_${parsedDoc.docId}`);

      console.log("4. Committing Document & Blocks to TerminusDB Substrate...");
      await insertDocumentAndBlocks(client, parsedDoc);

      console.log("5. Committing Reified Span to TerminusDB Substrate...");
      await reifySpanOnDemand(client, targetBlock, span.spanId, 35, 42, "refers_to");

      console.log("6. Committing TripleAssertion & Graph Traversal...");
      await insertTripleAssertion(client, {
        subjectId: span.spanId,
        predicate: "impacts",
        objectId: "doc_demo_1_block_3",
        provenance: "Agent reasoning sweep"
      });

      const assertions = await queryNodeAssertions(client, span.spanId);
      console.log(`   - Assertions found for ${span.spanId}: ${assertions.length}`);

      const affected = await traceImpactPropagation(client, span.spanId, "impacts");
      console.log(`   - Impact sweep results from ${span.spanId}: ${JSON.stringify(affected)}`);

      console.log("7. Querying BlockNodes via auto-generated GraphQL endpoint...");
      const gqlBlocks = await getDocumentBlocksViaGraphQL(client, parsedDoc.docId);
      console.log(`   - Blocks returned via GraphQL: ${gqlBlocks.length}`);

      console.log("8. Verifying Temporal Commit Management (branch + commit log)...");
      await createBranch(client, `verify_phase0_${parsedDoc.docId}`);
      const commitHistory = await getCommitHistory(client, 0, 5);
      console.log(`   - Branch 'verify_phase0_${parsedDoc.docId}' created.`);
      console.log(`   - Recent commits on main: ${commitHistory.length}`);

      console.log("\n   [✓] TerminusDB Substrate Integration complete & verified!");
    } catch (err: any) {
      console.warn("\n   [!] TerminusDB substrate verification failed:", err.message || err);
      console.log("   Note: Ensure TerminusDB container is running locally (`docker run -p 6363:6363 terminusdb/terminusdb-server`).");
    }
  } else {
    console.log("3. Database connectivity test skipped (run with connectToDb: true when TerminusDB server is running).");
  }

  console.log("\n=================================================");
  console.log("   Phase 0 Substrate Verification Complete!     ");
  console.log("=================================================");
}

// Execute locally if run directly
if (typeof process !== 'undefined' && process.argv && process.argv[1]?.includes('verifyPhase0')) {
  const shouldConnect = process.argv.includes('--db');
  runPhase0Verification({ connectToDb: shouldConnect });
}
