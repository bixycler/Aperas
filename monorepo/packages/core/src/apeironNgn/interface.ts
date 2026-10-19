// The engine's interface (design/core.md, "The engine's interface"): what the shell asks of the engine and nothing
// else, as plain strings, numbers, booleans and rows. No term and no pair appears in it (the index is private).
// Every read and write names the graph it acts on. Each operation is built by the batch named in `engine.ts`.
import type { LiteralValue, Schema } from './schema.ts';

/** A node id in the engine's grammar, `Kind:snowflake` or `owner:field:Kind:snowflake`. The shell mints it and the engine checks it. */
export type Id = string;

/** The name of a graph. */
export type GraphName = string;

/** The graph that exists from the start, a graph as any other (its name is a valid one, and it can be dropped). Others are made and dropped by `createGraph` and `dropGraph`. */
export const DEFAULT_GRAPH: GraphName = 'default';

/** The value of a field: a literal, or the id of a node (the value of a reference or embed field). */
export type Value = LiteralValue;

/** A field's value or values as the shell hands them over; an ordered field's array is the order of its list. */
export type FieldInput = Value | readonly Value[];

/** The record of a node as the read-out gives it: the fields that hold a value, in the order the schema declares them. */
export interface NodeRecord {
  readonly id: Id;
  readonly kind: string;
  /** A derived entry stands at its place, read from the reverse side. A set's values come in no promised order. */
  readonly fields: readonly { readonly name: string; readonly values: readonly Value[] }[];
}

/** What the build gets for one node. A supplied derived entry is an assertion by the shell and never a pair. */
export interface BuildRecord {
  readonly id: Id;
  readonly kind: string;
  readonly fields: Readonly<Record<string, FieldInput>>;
}

export interface EngineReads {
  /** The values of field `field` of `subject`, unordered; for an ordered field, in order. A derived entry reads the reverse side. */
  values(graph: GraphName, subject: Id, field: string): Value[];
  /** The first or only value of a single-valued field, as a literal or as a reference. */
  first(graph: GraphName, subject: Id, field: string): Value | undefined;
  /** The subjects whose reference or embed field `field` holds node `value`, in no promised order. */
  subjectsOf(graph: GraphName, field: string, value: Id): Id[];
  /** The first of those subjects, in no promised order. */
  firstSubjectOf(graph: GraphName, field: string, value: Id): Id | undefined;
  /** The count of those subjects. */
  countSubjectsOf(graph: GraphName, field: string, value: Id): number;
  /** The items of an ordered field in order, such as the contents of a container. */
  items(graph: GraphName, host: Id, field: string): Id[];
  /** The place (an index) of an item in an ordered field, read from its port. */
  placeOf(graph: GraphName, host: Id, field: string, item: Id): number | undefined;
  /** All ids of a kind in a graph (the read-out of Persistence is this call), an iteration over the collection of the kind. */
  idsOfKind(graph: GraphName, kind: string): Id[];
  /** Whether a node exists. */
  exists(graph: GraphName, id: Id): boolean;
  /**
   * The graph whose record has the id, or nothing when no graph holds one: an id does not say its graph, so this is the read from an id
   * to its record's graph, which lets `aperas://id/<ID>` resolve without naming the graph. Proposed by the orchestrator, awaiting the
   * user's confirmation (design/core.md, "The interface"). Names no graph, as it reads across all of them.
   */
  graphOf(id: Id): GraphName | undefined;
  /** The size of the store. */
  size(graph: GraphName): number;
}

export interface EngineWrites {
  /** Create a node with the id the shell mints, its kind and its graph. */
  createNode(graph: GraphName, id: Id, kind: string): void;
  /** Add a pair (or set a literal); adding a pair that is already present changes nothing. */
  addPair(graph: GraphName, subject: Id, field: string, value: Value): void;
  /** Clear a field of a subject, which a write of the field does before it adds the new values. */
  clearField(graph: GraphName, subject: Id, field: string): void;
  /**
   * Remove one pair of a field, which a write of an embed field does for each value it drops, before it adds the new ones
   * (so a node the new value keeps keeps its id). On an embed field the embedded node goes with the pair, with the nodes it
   * embeds in turn. A pair that is not there changes nothing. On an ordered field the other items keep their order.
   */
  removePair(graph: GraphName, subject: Id, field: string, value: Value): void;
  /** Remove a node, all of its pairs at once. */
  removeNode(graph: GraphName, id: Id): void;
  /** Insert an item into an ordered field at `at` (the end when omitted), as one splice of its list. */
  insertItem(graph: GraphName, host: Id, field: string, item: Id, at?: number): void;
  /** Move an item inside the list of an ordered field to `to`, as one splice. */
  moveItem(graph: GraphName, host: Id, field: string, item: Id, to: number): void;
  /** Take an item out of the list of an ordered field, as one splice. The item is detached and not deleted. */
  removeItem(graph: GraphName, host: Id, field: string, item: Id): void;
  /** Tombstone a node with the timestamp the shell passes in. */
  tombstone(graph: GraphName, id: Id, at: string): void;
  /** Tombstone a node and its subtree over containment, with the timestamp the shell passes in. */
  tombstoneSubtree(graph: GraphName, id: Id, at: string): void;
  /**
   * Delete outright every tombstone that the mark from the live nodes of the schema's root kinds, through the schema's followed
   * fields, does not reach. Gives the ids removed, sorted by code point. When it runs is the service's.
   */
  sweep(graph: GraphName): Id[];
  /** Create a graph. `Refused` for a name that fails the grammar of a graph's name (`graphName.ts`), for `id`, and for a name taken. */
  createGraph(graph: GraphName): void;
  /** Drop a graph, which the engine does only if no pair from the remaining graphs points into it. */
  dropGraph(graph: GraphName): void;
}

export interface EnginePersistence {
  /** Build: create a node with a given id, kind and graph and set its fields, accepting a reference to a node not built yet. */
  build(graph: GraphName, record: BuildRecord): void;
  /** Read out: the record of a node, its fields in the order the schema declares them. (All ids of a kind: `idsOfKind`.) */
  record(graph: GraphName, id: Id): NodeRecord | undefined;
  /** The ids referenced from a graph and never defined, which the shell asks once it has built a graph. Sorted by code point. */
  danglingRefs(graph: GraphName): Id[];
}

/** One bucket of a reverse side: the objects of a reference or embed field, as the ports split it. */
export interface Bucket {
  readonly field: string;
  readonly value: Id;
}

/** The plainest rows the design sentence allows (Batch 14 refines them): the boundary node of each port, with its count. */
export interface PortTreeRow {
  readonly boundary: Id;
  readonly count: number;
  readonly splits: readonly PortTreeRow[];
}

/** A captured port view. Its name is open (design/core.md, "The name of a captured port view"), so the type is neutral. */
export type CapturedView = string;

export interface EnginePorts {
  /** Set the cap of a field and name the partitioning field its reverse is split along. */
  setPortCap(graph: GraphName, field: string, cap: number, partitioningField: string): void;
  /** The current port tree of a bucket. */
  portTree(graph: GraphName, bucket: Bucket): PortTreeRow[];
  /** Capture the current port tree of a bucket as a view. */
  capturePortView(graph: GraphName, bucket: Bucket): CapturedView;
  /** Read a bucket through a captured view. */
  readThroughView(view: CapturedView, bucket: Bucket): Id[];
  /** Remove a captured view. */
  removePortView(view: CapturedView): void;
}

/**
 * The engine, constructed with a schema it closes. Not offered, and so absent: a read over an unbound field, a match
 * on the object alone, a graph position, a query language, a load or a dump. No operation marks a field partitioning.
 */
export interface Engine extends EngineReads, EngineWrites, EnginePersistence, EnginePorts {
  readonly schema: Schema;
}
