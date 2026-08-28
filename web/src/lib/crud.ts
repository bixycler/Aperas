/**
 * Aperas Phase 1: Extrinsic Assertion CRUD
 *
 * Provides CRUD for `Assertion` (the concrete BaseEdge used for extrinsic semantic
 * claims, e.g. "impacts"/"verifies"/"affects" — see
 * AperasKG/artifacts/Aperas-core-ontology-design.md §2.C) plus generic document
 * delete helpers reused across artifact/folder ingestion resets.
 */

export interface AssertionInput {
  source: string;    // full node id, e.g. "BlockNode/01H..." or "ArtifactNode/foo.md"
  predicate: string;  // e.g. "impacts", "verifies", "derived_from", "affects"
  target: string;     // full node id
}

/**
 * Commits a new extrinsic Assertion connecting two BaseNodes. Every write is already
 * a TerminusDB commit — pass a message so the temporal history stays meaningful.
 */
export async function insertAssertion(
  client: any,
  assertion: AssertionInput,
  commitMessage?: string
): Promise<any> {
  const payload = {
    "@type": "Assertion",
    source: assertion.source,
    predicate: assertion.predicate,
    target: assertion.target
  };

  console.log(`[Aperas CRUD] Committing Assertion: (${assertion.source}) --[${assertion.predicate}]--> (${assertion.target})...`);
  await client.addDocument(
    payload,
    {},
    client.db(),
    commitMessage || `Assert (${assertion.source}) --[${assertion.predicate}]--> (${assertion.target})`
  );
  return payload;
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
  } catch (err: any) {
    // Best-effort: a missing document is the expected outcome on a clean database, but
    // other failures (e.g. referential-integrity schema check failures from a still-
    // referenced document) are real and worth surfacing rather than swallowing silently.
    console.warn(`[Aperas CRUD] deleteDocumentIfExists('${fullId}') failed (treated as best-effort):`, err.message || err);
  }
}

/**
 * Deletes a batch of documents by their full ids in a single commit — best-effort, same as
 * deleteDocumentIfExists, but for callers clearing many ids at once (e.g. bulk cleanup/reset)
 * where a commit per id would otherwise flood the history with one-line "Reset" commits.
 */
export async function deleteDocumentsIfExist(
  client: any,
  fullIds: string[],
  commitMessage: string = 'Reset demo state'
): Promise<void> {
  if (fullIds.length === 0) return;
  try {
    await client.deleteDocument({ id: fullIds }, client.db(), commitMessage);
  } catch (err: any) {
    // Best-effort, same reasoning as deleteDocumentIfExists — log rather than swallow.
    console.warn(`[Aperas CRUD] deleteDocumentsIfExist(${fullIds.length} id(s)) failed (treated as best-effort):`, err.message || err);
  }
}

/**
 * Deletes every Assertion whose source or target matches nodeId — used to clear prior
 * demo assertions before re-asserting the same edge on a re-run.
 */
export async function deleteAssertionsInvolvingNode(client: any, nodeId: string): Promise<number> {
  // as_list is required — without it, getDocument returns a single object (not an array)
  // whenever there's exactly one match, which would otherwise silently skip deletion.
  const docs = await client.getDocument({ type: 'Assertion', as_list: true });
  const matches: any[] = (Array.isArray(docs) ? docs : []).filter(
    (d: any) => d.source === nodeId || d.target === nodeId
  );
  await deleteDocumentsIfExist(client, matches.map((match) => `terminusdb:///data/${match['@id']}`));
  return matches.length;
}
