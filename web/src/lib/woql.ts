/**
 * Aperas Phase 0: WOQL Graph Traversal & Impact Propagation Engine
 * 
 * Provides WOQL graph queries to query triples, traverse semantic dependency edges
 * (e.g. `impacts`, `verifies`, `affects`), and calculate downstream impact zones.
 */

// @ts-ignore - terminusdb npm package exports WOQL builder
import TerminusDB from 'terminusdb';

/**
 * Returns a WOQL query object to retrieve all TripleAssertions connected to a target node,
 * binding every field so the caller gets full assertion records back, not just the node id.
 */
export function buildNodeAssertionsQuery(nodeId: string) {
  const WOQL: any = (TerminusDB as any).WOQL || (TerminusDB as any).woql || TerminusDB;
  const v = WOQL.Vars("Assertion", "SubjectId", "ObjectId", "Predicate", "Provenance", "Timestamp");

  return WOQL.and(
    WOQL.triple(v.Assertion, "subjectId", v.SubjectId),
    WOQL.triple(v.Assertion, "objectId", v.ObjectId),
    WOQL.triple(v.Assertion, "predicate", v.Predicate),
    WOQL.triple(v.Assertion, "provenance", v.Provenance),
    WOQL.triple(v.Assertion, "timestamp", v.Timestamp),
    WOQL.or(
      WOQL.eq(v.SubjectId, WOQL.string(nodeId)),
      WOQL.eq(v.ObjectId, WOQL.string(nodeId))
    )
  );
}

/**
 * Returns a WOQL query object to trace downstream dependency paths along target predicates (e.g. "impacts", "affects").
 */
export function buildImpactPropagationQuery(startNodeId: string, targetPredicate: string = "impacts") {
  const WOQL: any = (TerminusDB as any).WOQL || (TerminusDB as any).woql || TerminusDB;

  return WOQL.and(
    WOQL.triple("v:Assertion", "subjectId", WOQL.string(startNodeId)),
    WOQL.triple("v:Assertion", "predicate", WOQL.string(targetPredicate)),
    WOQL.triple("v:Assertion", "objectId", "v:AffectedNode")
  );
}

/**
 * Executes a WOQL graph traversal query on TerminusDB to find all assertions involving a node.
 */
export async function queryNodeAssertions(client: any, nodeId: string): Promise<any[]> {
  try {
    const query = buildNodeAssertionsQuery(nodeId);
    const result = await client.query(query);
    const bindings: any[] = result?.bindings || [];
    return bindings.map((b) => ({
      subjectId: b.SubjectId,
      predicate: b.Predicate,
      objectId: b.ObjectId,
      provenance: b.Provenance,
      timestamp: b.Timestamp
    }));
  } catch (err) {
    console.error(`[Aperas WOQL] Error querying assertions for node ${nodeId}:`, err);
    return [];
  }
}

/**
 * Executes a WOQL impact propagation sweep starting from a changed node, tracing
 * downstream dependency edges (e.g. "impacts", "affects") directly in the graph engine.
 */
export async function traceImpactPropagation(client: any, startNodeId: string, predicate: string = "impacts"): Promise<string[]> {
  try {
    const query = buildImpactPropagationQuery(startNodeId, predicate);
    const result = await client.query(query);
    const bindings: any[] = result?.bindings || [];
    const affectedObjectIds = bindings.map((b) => b.AffectedNode).filter(Boolean);
    return Array.from(new Set(affectedObjectIds));
  } catch (err) {
    console.error(`[Aperas WOQL] Error tracing impact propagation from ${startNodeId}:`, err);
    return [];
  }
}
