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

/**
 * Finds every `Link` (the one concrete `BaseLink` leaf — inline `BlockNode.links`, see
 * Aperas-markdown-fractal-mapping-design.md §4) targeting any of nodeIds — returns full ids
 * rather than deleting them directly, because a `Link` sits in a genuine reference *cycle* with
 * the blocks around it (the owning block's own `links` field points at the `Link`, which in
 * turn `target`s some other block — e.g. a self-link makes this a 3-node cycle back to the same
 * root). TerminusDB's referential-integrity-on-delete check only allows a reference from
 * *outside* the set of documents being deleted in one call — sequential separate deletes (Link
 * first, or blocks first) each fail as still-referenced by the other; deleting the `Link` ids
 * *together with* the blocks that form the cycle, in one combined `deleteDocument` batch, is the
 * only order that succeeds. Callers should merge this with whatever block ids they're already
 * deleting rather than calling this and `deleteDocumentsIfExist` as two separate steps.
 */
export async function findLinkIdsTargeting(client: any, nodeIds: string[]): Promise<string[]> {
  const targets = new Set(nodeIds);
  const docs = await client.getDocument({ type: 'Link', as_list: true }).catch(() => []);
  const matches: any[] = (Array.isArray(docs) ? docs : []).filter((d: any) => targets.has(d.target));
  return matches.map((match) => `terminusdb:///data/${match['@id']}`);
}

/**
 * Fetch-merge-replace update for one already-ingested BlockNode field (Aperas-interactive-
 * summarization-design.md §2) — TerminusDB has no partial-field PATCH, so this fetches the full
 * document, shallow-merges `patch` onto it, and replaces it whole via `updateDocument`. For
 * `links`, `patch.links` should be the *complete* desired array (existing ref-id strings plus
 * any new `{ "@type": "Link", target, predicate }` literals to instantiate) — callers append,
 * this function doesn't.
 */
export async function updateBlockNode(
  client: any,
  id: string,
  patch: { title?: string; links?: any[] }
): Promise<void> {
  const doc = await client.getDocument({ id });
  if (!doc || typeof doc === 'string') {
    throw new Error(`BlockNode '${id}' not found.`);
  }
  await client.updateDocument(
    { ...doc, ...patch },
    {},
    client.db(),
    `Update ${id} (${Object.keys(patch).join(', ')})`,
    undefined,
    undefined,
    undefined,
    true
  );
}

/**
 * Deletes only the Assertion(s) matching this exact source/predicate/target triple — the
 * narrow counterpart to deleteAssertionsInvolvingNode's blunt "wipe everything touching this
 * node" (which stays reserved for demo/reset cleanup). This is the real "undo this one claim"
 * operation (see Aperas-basic-assertion-skill-design.md §3).
 */
export async function deleteAssertion(client: any, assertion: AssertionInput): Promise<number> {
  const docs = await client.getDocument({ type: 'Assertion', as_list: true });
  const matches: any[] = (Array.isArray(docs) ? docs : []).filter(
    (d: any) => d.source === assertion.source && d.predicate === assertion.predicate && d.target === assertion.target
  );
  await deleteDocumentsIfExist(
    client,
    matches.map((match) => `terminusdb:///data/${match['@id']}`),
    `Unassert (${assertion.source}) --[${assertion.predicate}]--> (${assertion.target})`
  );
  return matches.length;
}
