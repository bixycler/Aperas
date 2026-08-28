/**
 * Aperas Phase 1: WOQL Graph Traversal & Impact Propagation Engine
 *
 * Provides WOQL graph queries over `Assertion` (the concrete BaseEdge, see crud.ts) to
 * find semantic dependency edges (e.g. `impacts`, `verifies`, `affects`) and calculate
 * downstream impact zones. `source`/`target` are node-typed (BaseNode), not xsd:string —
 * see AperasKG/artifacts/Aperas-core-ontology-design.md Appendix B on why a flat-string
 * `subjectId`/`objectId` design was rejected.
 */

// @ts-ignore - terminusdb npm package exports WOQL builder
import TerminusDB from 'terminusdb';

function resolveWOQL(): any {
  return (TerminusDB as any).WOQL || (TerminusDB as any).woql || TerminusDB;
}

/**
 * Returns a WOQL query object for every Assertion where `nodeId` is the source,
 * binding the predicate and the other (target) node.
 */
export function buildOutgoingAssertionsQuery(nodeId: string) {
  const WOQL = resolveWOQL();
  const v = WOQL.Vars("Assertion", "Predicate", "Target");
  return WOQL.and(
    WOQL.triple(v.Assertion, "source", nodeId),
    WOQL.triple(v.Assertion, "predicate", v.Predicate),
    WOQL.triple(v.Assertion, "target", v.Target)
  );
}

/**
 * Returns a WOQL query object for every Assertion where `nodeId` is the target,
 * binding the predicate and the other (source) node.
 */
export function buildIncomingAssertionsQuery(nodeId: string) {
  const WOQL = resolveWOQL();
  const v = WOQL.Vars("Assertion", "Predicate", "Source");
  return WOQL.and(
    WOQL.triple(v.Assertion, "target", nodeId),
    WOQL.triple(v.Assertion, "predicate", v.Predicate),
    WOQL.triple(v.Assertion, "source", v.Source)
  );
}

/**
 * Returns a WOQL query object to trace one hop of downstream dependency edges along a
 * target predicate (e.g. "impacts", "affects") from a starting node.
 */
export function buildImpactPropagationQuery(startNodeId: string, targetPredicate: string = "impacts") {
  const WOQL = resolveWOQL();
  const v = WOQL.Vars("Assertion", "AffectedNode");
  return WOQL.and(
    WOQL.triple(v.Assertion, "source", startNodeId),
    WOQL.triple(v.Assertion, "predicate", WOQL.string(targetPredicate)),
    WOQL.triple(v.Assertion, "target", v.AffectedNode)
  );
}

export interface NodeAssertion {
  assertionId: string;
  predicate: string;
  otherNodeId: string;
  direction: 'outgoing' | 'incoming';
}

/**
 * Executes both directions of WOQL traversal to find every Assertion connected to a node.
 */
export async function queryNodeAssertions(client: any, nodeId: string): Promise<NodeAssertion[]> {
  try {
    const [outResult, inResult] = await Promise.all([
      client.query(buildOutgoingAssertionsQuery(nodeId)),
      client.query(buildIncomingAssertionsQuery(nodeId))
    ]);

    const outgoing: NodeAssertion[] = (outResult?.bindings || []).map((b: any) => ({
      assertionId: b.Assertion,
      predicate: b.Predicate,
      otherNodeId: b.Target,
      direction: 'outgoing' as const
    }));
    const incoming: NodeAssertion[] = (inResult?.bindings || []).map((b: any) => ({
      assertionId: b.Assertion,
      predicate: b.Predicate,
      otherNodeId: b.Source,
      direction: 'incoming' as const
    }));

    return [...outgoing, ...incoming];
  } catch (err) {
    console.error(`[Aperas WOQL] Error querying assertions for node ${nodeId}:`, err);
    return [];
  }
}

/**
 * Executes a WOQL impact propagation sweep starting from a changed node, tracing
 * one hop of downstream dependency edges (e.g. "impacts", "affects") directly in the graph engine.
 */
export async function traceImpactPropagation(client: any, startNodeId: string, predicate: string = "impacts"): Promise<string[]> {
  try {
    const query = buildImpactPropagationQuery(startNodeId, predicate);
    const result = await client.query(query);
    const bindings: any[] = result?.bindings || [];
    const affectedNodeIds = bindings.map((b) => b.AffectedNode).filter(Boolean);
    return Array.from(new Set(affectedNodeIds));
  } catch (err) {
    console.error(`[Aperas WOQL] Error tracing impact propagation from ${startNodeId}:`, err);
    return [];
  }
}
