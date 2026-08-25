/**
 * Aperas Phase 0: Substrate Document CRUD & Reification Transducers
 * 
 * Provides high-level CRUD operations for DocumentNode, BlockNode, SpanNode, and TripleAssertion
 * over TerminusDB document APIs.
 */

import { ParsedDocument, createReifiedSpan, ParsedBlock } from './astParser';

export interface TripleAssertionInput {
  subjectId: string;
  predicate: string; // e.g. "impacts", "verifies", "derived_from", "affects"
  objectId: string;
  provenance: string;
}

/**
 * Inserts a parsed Markdown document along with its coarse BlockNodes into TerminusDB.
 * Each write is a TerminusDB commit — pass a message so the temporal history stays meaningful.
 */
export async function insertDocumentAndBlocks(
  client: any,
  parsedDoc: ParsedDocument,
  commitMessage: string = `Ingest document '${parsedDoc.docId}' and its block tree`
): Promise<void> {
  const docPayload = {
    "@type": "DocumentNode",
    docId: parsedDoc.docId,
    title: parsedDoc.title,
    rawMarkdown: parsedDoc.rawMarkdown,
    createdAt: parsedDoc.createdAt
  };

  const blockPayloads = parsedDoc.blocks.map(b => ({
    "@type": "BlockNode",
    blockId: b.blockId,
    docId: b.docId,
    nodeType: b.nodeType,
    content: b.content,
    startOffset: b.startOffset,
    endOffset: b.endOffset
  }));

  console.log(`[Aperas CRUD] Storing document '${parsedDoc.docId}' and ${blockPayloads.length} block nodes...`);
  await client.addDocument([docPayload, ...blockPayloads], {}, client.db(), commitMessage);
  console.log(`[Aperas CRUD] Document '${parsedDoc.docId}' committed successfully.`);
}

/**
 * Performs on-demand lazy atomization: creates a reified SpanNode for a specific block slice.
 */
export async function reifySpanOnDemand(
  client: any,
  parentBlock: ParsedBlock,
  spanId: string,
  relativeStart: number,
  relativeEnd: number,
  predicate?: string,
  commitMessage?: string
): Promise<any> {
  const spanPayload = createReifiedSpan(parentBlock, spanId, relativeStart, relativeEnd, predicate);

  console.log(`[Aperas CRUD] Reifying span '${spanId}' on block '${parentBlock.blockId}' [text: "${spanPayload.text}"]...`);
  await client.addDocument(
    spanPayload,
    {},
    client.db(),
    commitMessage || `Reify span '${spanId}' on block '${parentBlock.blockId}'`
  );
  console.log(`[Aperas CRUD] Span '${spanId}' reified successfully.`);
  return spanPayload;
}

/**
 * Inserts a semantic TripleAssertion connecting two reified entities or blocks.
 */
export async function insertTripleAssertion(
  client: any,
  assertion: TripleAssertionInput,
  commitMessage?: string
): Promise<any> {
  const payload = {
    "@type": "TripleAssertion",
    subjectId: assertion.subjectId,
    predicate: assertion.predicate,
    objectId: assertion.objectId,
    provenance: assertion.provenance,
    timestamp: new Date().toISOString()
  };

  console.log(`[Aperas CRUD] Committing TripleAssertion: (${assertion.subjectId}) --[${assertion.predicate}]--> (${assertion.objectId})...`);
  await client.addDocument(
    payload,
    {},
    client.db(),
    commitMessage || `Assert (${assertion.subjectId}) --[${assertion.predicate}]--> (${assertion.objectId})`
  );
  return payload;
}

/**
 * Fetches all BlockNodes belonging to a specific DocumentNode.
 */
export async function getDocumentBlocks(client: any, docId: string): Promise<any[]> {
  const query = {
    "@type": "BlockNode",
    docId
  };
  return await client.getDocument({ type: "BlockNode", query });
}

/**
 * Deletes a document by its full id if present — best-effort, so seed/demo scripts can
 * reset their own fixed-id state and stay re-runnable instead of failing on "already exists".
 */
export async function deleteDocumentIfExists(
  client: any,
  fullId: string,
  commitMessage: string = 'Reset demo state'
): Promise<void> {
  try {
    await client.deleteDocument({ id: [fullId] }, client.db(), commitMessage);
  } catch (err) {
    // Not found is the expected outcome on a clean database — nothing to reset.
  }
}

/**
 * Deletes every TripleAssertion whose subjectId or objectId matches nodeId — used to clear
 * prior demo assertions before re-asserting the same edge on a re-run.
 */
export async function deleteTripleAssertionsInvolvingNode(client: any, nodeId: string): Promise<number> {
  // as_list is required — without it, getDocument returns a single object (not an array)
  // whenever there's exactly one match, which would otherwise silently skip deletion.
  const docs = await client.getDocument({ type: 'TripleAssertion', as_list: true });
  const matches: any[] = (Array.isArray(docs) ? docs : []).filter(
    (d: any) => d.subjectId === nodeId || d.objectId === nodeId
  );
  for (const match of matches) {
    await deleteDocumentIfExists(client, `terminusdb:///data/${match['@id']}`);
  }
  return matches.length;
}
