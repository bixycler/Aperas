// The write layer (planning/core.md, Batch 11 steps 1 and 2; design/core.md, "Lookups by a literal value", "Enforcement"): the one object whose functions
// are the writes of the engine that the shell makes, each followed by the call that tells the maps of Batch 10 (`lookups.ts`). The shell writes through it
// and through nothing else, so that a map is told for every write and told only for a write the engine took.
//   - Each function calls the engine first and the map after: the engine throws before the map is touched when it refuses (`Refused`, which passes
//     through to the caller: the shell obeys the schema and writes to nodes that have a record, so a throw is a finding), and a map is never updated for a
//     write that did not happen. The maps read the node back from the engine, so a call for a write the engine took in part leaves them as the engine is.
//   - `createNode` is the one function that does not take a graph: a new node takes the graph of `graphOfNewNode` (a profile in the main graph, a view in
//     the views graph, an artifact or a folder by its path, a block and what a node owns in the graph of the node they are built under). It gives the graph.
//   - `tombstoneSubtree` collects the ids of the subtree before the write, because the write takes each member out of the lists that held it and empties
//     its own, and tells the maps by id after it. The walk is the engine's: containment inside the graph, a member of another graph (the root folder lists
//     the threads folder) is not in the subtree and is not told, since the engine did not tombstone it.
//   - Each function that changes the engine tells `touch` which graphs it changed, after the engine took the write and before the maps are told, so the service
//     flushes a graph that was written and none other (planning/core.md, Batch 11 step 8). A write of a graph touches that graph; a list splice also touches the graph
//     of the item, whose document states its container (`parent`); a tombstone, a removal and a sweep that removed something touch every graph, because they leave
//     the lists and the `unfolds` of the other graphs too (design/core.md, "Reads and rules across graphs"). `undefined` means every graph.
//   - Nothing here reads a map.
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
  /**
   * Runs `fn` and gives what it gives. When `fn` throws, the nodes created through this layer while it ran are taken out, newest first (the list that holds one lets it go, the
   * maps are told), and the error passes on: a command that made records and then met a refusal leaves no record of its own behind. Only the nodes `fn` created are
   * undone; a change to a node that was there before is not. A guard inside a guard undoes its own nodes when it throws, and the outer one the rest when it throws in turn.
   */
  guard<T>(fn: () => T): T;
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

/** Which graphs a write changed: one graph, or `undefined` for every graph. */
export type Touch = (graph: GraphName | undefined) => void;

/** The write layer over an engine and its maps; `touch` is told the graphs each write changed. `graphs` are the graphs of the mapping, which `guard` looks through for the container of a node it takes out. */
export function createWriteLayer(engine: Engine, maps: Lookups, touch: Touch = () => {}, graphs: readonly GraphName[] = []): WriteLayer {
  /** The graph of an item whose document states its container; a ghost, which no graph holds, changes no file. */
  const touchItem = (item: Id): void => {
    const graph = engine.graphOf(item);
    if (graph !== undefined) touch(graph);
  };
  /** The nodes created through this layer while a guard is open, in the order they were made; a guard that ends truncates it to where it began. */
  const created: Array<{ graph: GraphName; id: Id }> = [];
  let guards = 0;
  const containment = engine.schema.roles.containment;
  /** Takes a node made by the guarded function out: from the list that holds it, then outright. An embedded node goes with its owner's pair, so its record may be gone already. */
  const undo = (graph: GraphName, id: Id): void => {
    if (!engine.exists(graph, id)) return;
    if (containment !== undefined) {
      for (const g of graphs.includes(graph) ? graphs : [graph, ...graphs]) {
        for (const host of engine.subjectsOf(g, containment, id)) {
          engine.removeItem(g, host, containment, id);
          touch(g);
        }
      }
    }
    engine.removeNode(graph, id);
    touch(undefined);
    maps.removed(graph, id);
  };
  return {
    createNode(id, node) {
      const graph = graphOfNewNode(engine, node);
      engine.createNode(graph, id, node.kind);
      if (guards > 0) created.push({ graph, id });
      touch(graph);
      maps.built(graph, id);
      return graph;
    },
    guard(fn) {
      const from = created.length;
      guards++;
      try {
        return fn();
      } catch (error) {
        for (const { graph, id } of created.splice(from).reverse()) undo(graph, id);
        throw error;
      } finally {
        guards--;
        if (guards === 0) created.length = 0;
      }
    },
    addPair(graph, subject, field, value) {
      engine.addPair(graph, subject, field, value);
      touch(graph);
      maps.fieldWritten(graph, subject, field);
    },
    clearField(graph, subject, field) {
      engine.clearField(graph, subject, field);
      touch(graph);
      maps.fieldWritten(graph, subject, field);
    },
    removePair(graph, subject, field, value) {
      engine.removePair(graph, subject, field, value);
      touch(graph);
      maps.fieldWritten(graph, subject, field);
    },
    insertItem(graph, host, field, item, at) {
      engine.insertItem(graph, host, field, item, at);
      touch(graph);
      touchItem(item);
    },
    moveItem(graph, host, field, item, to) {
      engine.moveItem(graph, host, field, item, to);
      touch(graph);
    },
    removeItem(graph, host, field, item) {
      engine.removeItem(graph, host, field, item);
      touch(graph);
      touchItem(item);
    },
    tombstone(graph, id, at) {
      engine.tombstone(graph, id, at);
      touch(undefined);
      maps.tombstoned(graph, id);
    },
    tombstoneSubtree(graph, id, at) {
      const members = subtreeIds(engine, graph, id);
      engine.tombstoneSubtree(graph, id, at);
      touch(undefined);
      for (const member of members) maps.tombstoned(graph, member);
    },
    removeNode(graph, id) {
      if (!engine.exists(graph, id)) return; // no record: the engine changes nothing, and so no file and no map
      engine.removeNode(graph, id);
      touch(undefined);
      maps.removed(graph, id);
    },
    sweep(graph) {
      const ids = engine.sweep(graph);
      if (ids.length > 0) touch(undefined);
      maps.swept(graph, ids);
      return ids;
    },
  };
}
