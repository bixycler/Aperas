// The write layer (planning/core.md, Batch 11 steps 1 and 2; design/core.md, "Lookups by a literal value", "Enforcement"): the one object whose functions
// are the writes of the engine that the shell makes, each followed by the call that tells the maps of Batch 10 (`lookups.ts`). The shell writes through it
// and through nothing else, so that a map is told for every write and told only for a write the engine took.
//   - Each function calls the engine first and the map after: the engine throws before the map is touched when it refuses (`Refused`, or `Undecided` on
//     Enforcement or Existence, which pass through to the caller: the shell obeys the schema, so a throw is a finding), and a map is never updated for a
//     write that did not happen. The maps read the node back from the engine, so a call for a write the engine took in part leaves them as the engine is.
//   - `createNode` is the one function that does not take a graph: a new node takes the graph of `graphOfNewNode` (a profile in the main graph, a view in
//     the views graph, an artifact or a folder by its path, a block and what a node owns in the graph of the node they are built under). It gives the graph.
//   - `tombstoneSubtree` collects the ids of the subtree before the write, because the write takes each member out of the lists that held it and empties
//     its own, and tells the maps by id after it. The walk is the engine's: containment inside the graph, a member of another graph (the root folder lists
//     the threads folder) is not in the subtree and is not told, since the engine did not tombstone it.
//   - Nothing here reads a map and nothing here is imported yet: the shell still runs on the old code until the flip.
import type { Engine, GraphName, Id, Value } from '@aperas/core/apeironNgn/interface';
import { graphOfNewNode, type NewNode } from './graphOfPath';
import type { Lookups } from './lookups';

export interface WriteLayer {
  /** Create a node in the graph the rule gives it and tell the maps; gives the graph. The kind is `node.kind`. */
  createNode(id: Id, node: NewNode): GraphName;
  /** Add a pair, or set a literal. A map that is keyed by the field is told. */
  addPair(graph: GraphName, subject: Id, field: string, value: Value): void;
  /** Clear a field of a subject. A map that is keyed by the field is told. */
  clearField(graph: GraphName, subject: Id, field: string): void;
  /** Remove one pair of a field; on an embed field the embedded node goes with it. A map that is keyed by the field is told. */
  removePair(graph: GraphName, subject: Id, field: string, value: Value): void;
  /** Insert an item into an ordered field. No map is keyed by a list. */
  insertItem(graph: GraphName, host: Id, field: string, item: Id, at?: number): void;
  /** Move an item inside an ordered field. No map is keyed by a list. */
  moveItem(graph: GraphName, host: Id, field: string, item: Id, to: number): void;
  /** Take an item out of an ordered field; the item is detached and not deleted. No map is keyed by a list. */
  removeItem(graph: GraphName, host: Id, field: string, item: Id): void;
  /** Tombstone a node and tell the maps. */
  tombstone(graph: GraphName, id: Id, at: string): void;
  /** Tombstone a node and its subtree over containment, and tell the maps of each member by id. */
  tombstoneSubtree(graph: GraphName, id: Id, at: string): void;
  /** Remove a node outright and tell the maps. */
  removeNode(graph: GraphName, id: Id): void;
  /** Sweep the unreachable tombstones of a graph and tell the maps of each id removed; gives the ids. */
  sweep(graph: GraphName): Id[];
}

/** The ids of the subtree of `id` over the containment of the schema, the node first, in pre-order; the members of this graph only, each once. */
function subtreeIds(engine: Engine, graph: GraphName, id: Id): Id[] {
  const containment = engine.schema.roles.containment;
  const members: Id[] = [];
  const seen = new Set<Id>([id]);
  for (const stack = [id]; stack.length > 0; ) {
    const next = stack.pop()!;
    members.push(next);
    if (containment === undefined) continue;
    const listed = engine.values(graph, next, containment) as Id[];
    for (let i = listed.length - 1; i >= 0; i--) { // reversed, so that the first item is the next out
      const child = listed[i]!;
      if (!seen.has(child) && engine.graphOf(child) === graph) { seen.add(child); stack.push(child); }
    }
  }
  return members;
}

/** The write layer over an engine and its maps. */
export function createWriteLayer(engine: Engine, maps: Lookups): WriteLayer {
  return {
    createNode(id, node) {
      const graph = graphOfNewNode(engine, node);
      engine.createNode(graph, id, node.kind);
      maps.built(graph, id);
      return graph;
    },
    addPair(graph, subject, field, value) {
      engine.addPair(graph, subject, field, value);
      maps.fieldWritten(graph, subject, field);
    },
    clearField(graph, subject, field) {
      engine.clearField(graph, subject, field);
      maps.fieldWritten(graph, subject, field);
    },
    removePair(graph, subject, field, value) {
      engine.removePair(graph, subject, field, value);
      maps.fieldWritten(graph, subject, field);
    },
    insertItem: (graph, host, field, item, at) => engine.insertItem(graph, host, field, item, at),
    moveItem: (graph, host, field, item, to) => engine.moveItem(graph, host, field, item, to),
    removeItem: (graph, host, field, item) => engine.removeItem(graph, host, field, item),
    tombstone(graph, id, at) {
      engine.tombstone(graph, id, at);
      maps.tombstoned(graph, id);
    },
    tombstoneSubtree(graph, id, at) {
      const members = subtreeIds(engine, graph, id);
      engine.tombstoneSubtree(graph, id, at);
      for (const member of members) maps.tombstoned(graph, member);
    },
    removeNode(graph, id) {
      engine.removeNode(graph, id);
      maps.removed(graph, id);
    },
    sweep(graph) {
      const ids = engine.sweep(graph);
      maps.swept(graph, ids);
      return ids;
    },
  };
}
