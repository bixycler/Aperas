/**
 * Live benchmark, kept for reuse (not throwaway) — compares bulk-fetch-then-consume (GraphQL's
 * getArtifactTreeViaGraphQL) against node-by-node paired fetch (data structure built one node at
 * a time, in lockstep with the recursive walk that builds it) across all three TerminusDB APIs,
 * plus ApeironNgn's in-process Oxigraph engine (E) as a structurally different fifth strategy —
 * no round trip at all, bulk or otherwise, since the whole store lives in-process. Builds only the
 * raw block tree (blockId/type/title/text/childIds) — no Markdown projection.
 */
import { createTerminusClient } from './client';
import { getArtifactTreeViaGraphQL, executeGraphQLQuery } from './graphql';
// @ts-ignore
import TerminusDB from 'terminusdb';
import { rehydrateStore, getApeironExportDir } from './apeironNgn/store';
import { wrap } from './apeironNgn/node';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Aperas-design.md currently triggers a real TerminusDB server panic on bulk GraphQL fetch
// ("end byte index 1000 is not a char boundary; it is inside '–'") — the same bug seen before the
// last DB reset, reproduced again with fresh content. Using the artifact the original bulk-fetch
// benchmark (graphql.ts's own docstring) already validated as working instead.
const ARTIFACT = 'Aperas-core-ontology-design.md';

function WOQL() {
  return (TerminusDB as any).WOQL || (TerminusDB as any).woql || TerminusDB;
}

// Real per-strategy round-trip counts (not estimated) — answers "why is the ranking Doc API >
// WOQL > GraphQL, given WOQL needs more calls per node than either of the others?" with actual
// numbers rather than a plausible-sounding guess.
const callCounts = { docApi: 0, graphql: 0, woql: 0 };

function countNodes(node: any): number {
  if (!node) return 0;
  const children = node.children ?? [];
  return 1 + children.reduce((sum: number, c: any) => sum + countNodes(c), 0);
}

async function time<T>(label: string, fn: () => Promise<T>): Promise<{ result: T; ms: number }> {
  const t0 = performance.now();
  const result = await fn();
  const ms = performance.now() - t0;
  console.log(`${label}: ${ms.toFixed(1)}ms`);
  return { result, ms };
}

// --- A. Bulk fetch (existing production path) ---------------------------------------------

async function bulkGraphQL(client: any) {
  return getArtifactTreeViaGraphQL(client, ARTIFACT);
}

// --- B. Node-by-node, Document API -----------------------------------------------------------

async function nodeByNodeDocAPI(client: any, rootId: string): Promise<any> {
  async function fetchNode(id: string): Promise<any> {
    callCounts.docApi++;
    const doc = await client.getDocument({ id });
    const children = [];
    for (const childId of doc.children ?? []) {
      children.push(await fetchNode(childId));
    }
    return { blockId: doc.blockId, type: doc.type, title: doc.title, text: doc.text, children };
  }
  return fetchNode(rootId);
}

// --- C. Node-by-node, GraphQL (shallow query per node: own fields + immediate child ids) ------

async function fetchShallowGraphQL(client: any, blockId: string): Promise<any> {
  callCounts.graphql++;
  const query = `
    query BlockShallow($id: String!) {
      BlockNode(filter: { blockId: { eq: $id } }) {
        blockId type title text
        children { blockId }
      }
    }
  `;
  const result = await executeGraphQLQuery(client, query, { id: blockId });
  const matches: any[] = result.data?.BlockNode ?? [];
  return matches[0] ?? null;
}

async function nodeByNodeGraphQL(client: any, rootBlockId: string): Promise<any> {
  async function fetchNode(blockId: string): Promise<any> {
    const doc = await fetchShallowGraphQL(client, blockId);
    const children = [];
    for (const child of doc.children ?? []) {
      children.push(await fetchNode(child.blockId));
    }
    return { blockId: doc.blockId, type: doc.type, title: doc.title, text: doc.text, children };
  }
  return fetchNode(rootBlockId);
}

// --- D. Node-by-node, WOQL ----------------------------------------------------------------------
// Own scalar fields (title/type/text) are Set/Optional-shaped triples — work directly.
// `children` is List-typed. First attempt (see conversation): a naive forward
// `t(X, 'children', v.Child)` does return a binding, but NOT the member value — it binds to
// TerminusDB's internal `Cons` cell (confirmed live: `Child: "Cons/xxx"`, not `"BlockNode/xxx"`).
// Real live-verified shape of that cons cell: `rdf:type: rdf:List`, `rdf:first: <the actual
// value>`, `rdf:rest: <next Cons, or 'rdf:nil' at the end>` — a real RDF linked list, requiring an
// explicit walk, not a single triple lookup, in EITHER direction (§3.A's reverse-direction finding
// plus this forward-direction one together mean List gives you no shortcut via plain `triple()` at
// all — only class-level `@unfoldable`/GraphQL/Document API resolve it without manual cons-walking).

async function woqlTripleValue(client: any, subject: string, predicate: string): Promise<string | null> {
  callCounts.woql++;
  const w = WOQL();
  const v = w.Vars('Value');
  const result = await client.query(w.triple(subject, predicate, v.Value));
  const bindings = result?.bindings || [];
  if (bindings.length === 0) return null;
  const raw = bindings[0].Value;
  return typeof raw === 'object' && raw !== null && '@value' in raw ? raw['@value'] : raw;
}

/** Walks the `children` List's cons-cell chain one hop at a time, collecting `rdf:first` values
 *  until `rdf:rest` reaches `rdf:nil` — the only correct way to read a List's members via plain
 *  WOQL triples (confirmed live: neither the reverse nor a naive forward triple() gives the
 *  member value directly). One extra round trip per list element, on top of the head lookup. */
async function woqlChildren(client: any, subject: string): Promise<string[]> {
  const w = WOQL();
  callCounts.woql++;
  const headResult = await client.query(w.triple(subject, 'children', w.Vars('Cons').Cons));
  const headBindings = headResult?.bindings || [];
  if (headBindings.length === 0) return [];

  const items: string[] = [];
  let consId: string = headBindings[0].Cons;
  while (consId && consId !== 'rdf:nil') {
    const v = w.Vars('First', 'Rest');
    callCounts.woql++;
    const cellResult = await client.query(
      w.and(w.triple(consId, 'rdf:first', v.First), w.triple(consId, 'rdf:rest', v.Rest))
    );
    const cellBindings = cellResult?.bindings || [];
    if (cellBindings.length === 0) break;
    items.push(cellBindings[0].First);
    consId = cellBindings[0].Rest;
  }
  return items;
}

async function nodeByNodeWOQL(client: any, rootId: string): Promise<any> {
  async function fetchNode(id: string): Promise<any> {
    const [type, title] = await Promise.all([
      woqlTripleValue(client, id, 'type'),
      woqlTripleValue(client, id, 'title')
    ]);
    const text = await woqlTripleValue(client, id, 'text');
    const childIds = await woqlChildren(client, id);

    const children = [];
    for (const childId of childIds) {
      children.push(await fetchNode(childId));
    }
    return { blockId: id.split('/')[1], type, title, text, children };
  }
  return fetchNode(rootId);
}

// --- E. ApeironNgn — in-process Oxigraph, rehydrated from AperasKG/Apeiron/'s JSON-LD mirror ---
// Not "node-by-node" in the TerminusDB sense (no round trip per node at all, in-process or
// otherwise) — measures the one thing that's actually comparable: rehydrating the whole store
// fresh, then walking this one artifact's tree end to end, same shape (blockId/type/title/text/
// children) as the other strategies, so `countNodes` applies unchanged.

function apeironNgnRootId(): string {
  const docs: any[] = JSON.parse(readFileSync(join(getApeironExportDir(), 'ArtifactNode.jsonld'), 'utf-8'));
  const doc = docs.find((d) => d && d.path === ARTIFACT);
  if (!doc?.root) throw new Error(`No ingested root found for '${ARTIFACT}' in the JSON-LD mirror.`);
  return doc.root;
}

function apeironNgnTree(rootId: string, store: any): any {
  function walk(id: string): any {
    const n = wrap(store, id);
    return {
      blockId: n.id.split('/')[1],
      type: n.type,
      title: n.title,
      text: n.text,
      children: (n.children ?? []).map((c: any) => walk(c.id)),
    };
  }
  return walk(rootId);
}

// --- Main ----------------------------------------------------------------------------------

async function main() {
  const client = createTerminusClient();

  const artifactDoc = await client.getDocument({ type: 'ArtifactNode', query: { path: ARTIFACT }, as_list: true });
  const artifact = (Array.isArray(artifactDoc) ? artifactDoc : [artifactDoc]).find((d: any) => d && !d.tombstonedAt);
  if (!artifact?.root) throw new Error(`No ingested root found for '${ARTIFACT}'.`);
  const rootId: string = artifact.root;
  console.log(`Artifact: ${ARTIFACT}, root: ${rootId}\n`);

  const bulk = await time('A. Bulk GraphQL (getArtifactTreeViaGraphQL)', () => bulkGraphQL(client));
  const nodeCount = countNodes(bulk.result.root);
  console.log(`   (${nodeCount} nodes)\n`);

  const doc = await time('B. Node-by-node, Document API', () => nodeByNodeDocAPI(client, rootId));
  console.log(`   (${countNodes(doc.result)} nodes)\n`);

  const gql = await time('C. Node-by-node, GraphQL (shallow per-node)', () => nodeByNodeGraphQL(client, rootId.split('/')[1]));
  console.log(`   (${countNodes(gql.result)} nodes)\n`);

  const woql = await time('D. Node-by-node, WOQL', () => nodeByNodeWOQL(client, rootId));
  console.log(`   (${countNodes(woql.result)} nodes)\n`);

  const ngnRootId = apeironNgnRootId();
  const t0 = performance.now();
  const { store } = rehydrateStore();
  const rehydrateMs = performance.now() - t0;
  const t1 = performance.now();
  const ngnTree = apeironNgnTree(ngnRootId, store);
  const walkMs = performance.now() - t1;
  console.log(`E. ApeironNgn — rehydrate whole store: ${rehydrateMs.toFixed(1)}ms, walk this tree: ${walkMs.toFixed(1)}ms`);
  console.log(`   (${countNodes(ngnTree)} nodes)\n`);

  console.log('--- Summary ---');
  console.log(`Nodes: ${nodeCount}`);
  console.log(`A. Bulk GraphQL:              ${bulk.ms.toFixed(1)}ms`);
  console.log(`B. Node-by-node Document API: ${doc.ms.toFixed(1)}ms  (${(doc.ms / bulk.ms).toFixed(1)}x bulk)`);
  console.log(`C. Node-by-node GraphQL:      ${gql.ms.toFixed(1)}ms  (${(gql.ms / bulk.ms).toFixed(1)}x bulk)`);
  console.log(`D. Node-by-node WOQL:         ${woql.ms.toFixed(1)}ms  (${(woql.ms / bulk.ms).toFixed(1)}x bulk)`);
  console.log(`E. ApeironNgn walk (post-rehydration): ${walkMs.toFixed(1)}ms  (${(walkMs / bulk.ms).toFixed(3)}x bulk)`);
  console.log();
  console.log('--- Round trips & cost per round trip (why Doc API > WOQL > GraphQL, not the reverse) ---');
  console.log(`B. Doc API: ${callCounts.docApi} calls, ${(doc.ms / callCounts.docApi).toFixed(1)}ms/call`);
  console.log(`C. GraphQL: ${callCounts.graphql} calls, ${(gql.ms / callCounts.graphql).toFixed(1)}ms/call`);
  console.log(`D. WOQL:    ${callCounts.woql} calls, ${(woql.ms / callCounts.woql).toFixed(1)}ms/call`);
  console.log(`   ApeironNgn rehydrate-whole-store-once cost: ${rehydrateMs.toFixed(1)}ms — a one-time per-process cost`);
  console.log(`   (amortized across every artifact/script run afterward), not comparable to A-D's per-request cost.`);
}

main().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
