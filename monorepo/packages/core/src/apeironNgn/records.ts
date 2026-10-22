// The records of the engine (design/core.md, "Records by kind and by graph"): one record for each node, held in one
// map from id to record across all graphs, and in one collection for each graph and each kind. A collection holds
// the records themselves and no set of ids, in order of insertion. The records are also arranged in a tree (design/core.md,
// "Records follow containment"): each knows the record it is under and holds the records beneath it, and each graph holds its
// roots, the records that are under no other. A literal field is a plain property of the record, and
// so is the value of a reference or embed field (the id of a node). The reverse side of a field, once built, is a bucket
// of subject ids for each object, held on the record of the object, or in the waiting map while the object has no record.
import type { GraphName, Id } from './interface.ts';
import type { LiteralValue } from './schema.ts';

/** A node: its id, its kind and its graph, and the values of the fields that hold one, keyed by field name. */
export interface Rec {
  readonly id: Id;
  readonly kind: string;
  readonly graph: GraphName;
  /** A `Map` and not an object: a field may be named `__proto__`, `constructor` or `toString`. A field with no value has no entry. */
  readonly fields: Map<string, LiteralValue[]>;
  /** For each field whose reverse is built, the set of subjects that hold this node as a value of it. A field with no subject has no entry. */
  readonly buckets: Map<string, Set<Id>>;
  /** The record this one is beneath in the tree (its container, or the node that embeds it), or `undefined` for a root. */
  under: Rec | undefined;
  /** The records beneath this one, in no promised order: the order of the contents of a container is its list's. */
  readonly beneath: Set<Rec>;
}

export class Registry {
  private readonly master = new Map<Id, Rec>();
  private readonly collections = new Map<GraphName, Map<string, Set<Rec>>>();
  /** For each graph, the records that are beneath no other. */
  private readonly roots = new Map<GraphName, Set<Rec>>();
  /** The buckets of the ids that have no record (the waiting map): a reference may name a node not built yet, or one that was removed. */
  private readonly waiting = new Map<Id, Map<string, Set<Id>>>();
  /** The names of the fields whose reverse is built: kept up by every write from then on. */
  private readonly builtReverses = new Set<string>();

  constructor(graphs: readonly GraphName[]) {
    for (const g of graphs) {
      this.collections.set(g, new Map());
      this.roots.set(g, new Set());
    }
  }

  hasGraph(graph: GraphName): boolean {
    return this.collections.has(graph);
  }

  /** Whether more than one graph exists, which is when a read that gives a node's relations has anything to filter. */
  hasSeveralGraphs(): boolean {
    return this.collections.size > 1;
  }

  /** Add a graph with no record: an empty collection map and an empty set of roots. The caller has checked that the name is free. */
  addGraph(graph: GraphName): void {
    this.collections.set(graph, new Map());
    this.roots.set(graph, new Set());
  }

  /**
   * Remove a graph and every record in it from the master map, the collections and the roots. The caller has taken the pairs of those
   * records out of the buckets they sit in (a record's own buckets go with the record) and has seen that no record of another graph
   * is beneath one of them (the tree is inside a graph).
   */
  removeGraph(graph: GraphName): void {
    for (const collection of this.collections.get(graph)?.values() ?? []) for (const rec of collection) this.master.delete(rec.id);
    this.collections.delete(graph);
    this.roots.delete(graph);
  }

  /** The records of a graph, in every kind. */
  *recordsIn(graph: GraphName): Iterable<Rec> {
    for (const collection of this.collections.get(graph)?.values() ?? []) yield* collection;
  }

  /** Every record, in every graph. */
  records(): Iterable<Rec> {
    return this.master.values();
  }

  /** The ids named as a subject in any bucket, on a record or in the waiting map. */
  bucketedSubjects(): Id[] {
    const out = new Set<Id>();
    for (const rec of this.master.values()) for (const bucket of rec.buckets.values()) for (const s of bucket) out.add(s);
    for (const buckets of this.waiting.values()) for (const bucket of buckets.values()) for (const s of bucket) out.add(s);
    return [...out];
  }

  /** The number of records, in every graph. */
  count(): number {
    return this.master.size;
  }

  /** The number of records in a graph, in every kind; a graph that does not exist holds none. */
  sizeOf(graph: GraphName): number {
    let n = 0;
    for (const collection of this.collections.get(graph)?.values() ?? []) n += collection.size;
    return n;
  }

  /** Whether any graph holds the id: ids are unique across all graphs. */
  taken(id: Id): boolean {
    return this.master.has(id);
  }

  /** The record of a node in a graph. */
  get(graph: GraphName, id: Id): Rec | undefined {
    const rec = this.master.get(id);
    return rec !== undefined && rec.graph === graph ? rec : undefined;
  }

  /** Add a new record to the master map and to the collection of its graph and kind. */
  add(graph: GraphName, id: Id, kind: string): Rec {
    const held = this.waiting.get(id); // the buckets of the references that were waiting for this node move onto its record
    this.waiting.delete(id);
    const rec: Rec = { id, kind, graph, fields: new Map(), buckets: held ?? new Map(), under: undefined, beneath: new Set() };
    this.master.set(id, rec);
    this.roots.get(graph)!.add(rec); // a root until the engine nests it
    const byKind = this.collections.get(graph)!;
    const collection = byKind.get(kind) ?? new Set<Rec>();
    byKind.set(kind, collection);
    collection.add(rec);
    return rec;
  }

  /** The record with this id, in whichever graph holds it. */
  byId(id: Id): Rec | undefined {
    return this.master.get(id);
  }

  /** Remove a record from the master map, the collection of its graph and kind, and the tree (the records beneath it become roots); the buckets of its incoming references go to the waiting map. */
  remove(rec: Rec): void {
    this.nest(rec, undefined);
    this.roots.get(rec.graph)?.delete(rec);
    for (const child of [...rec.beneath]) this.nest(child, undefined);
    this.master.delete(rec.id);
    this.collections.get(rec.graph)?.get(rec.kind)?.delete(rec);
    if (rec.buckets.size > 0) this.waiting.set(rec.id, rec.buckets);
  }

  /** Place a record in the tree: beneath `parent`, or among the roots of its graph when there is none. */
  nest(rec: Rec, parent: Rec | undefined): void {
    if (rec.under === parent) return;
    if (rec.under !== undefined) rec.under.beneath.delete(rec);
    else this.roots.get(rec.graph)?.delete(rec);
    rec.under = parent;
    if (parent !== undefined) parent.beneath.add(rec);
    else this.roots.get(rec.graph)?.add(rec);
  }

  /** The ids of the roots of a graph, in the order they became roots. */
  rootIds(graph: GraphName): Id[] {
    return Array.from(this.roots.get(graph) ?? [], (r) => r.id);
  }

  /** The records of exactly this kind, in every graph. */
  *recordsOfKind(kind: string): Iterable<Rec> {
    for (const byKind of this.collections.values()) yield* byKind.get(kind) ?? [];
  }

  /** The records of exactly this kind in a graph, in order of insertion. */
  *recordsOf(graph: GraphName, kind: string): Iterable<Rec> {
    yield* this.collections.get(graph)?.get(kind) ?? [];
  }

  /** Whether the reverse of a field is built. */
  isReverseBuilt(field: string): boolean {
    return this.builtReverses.has(field);
  }

  /** Mark the reverse of a field built, once its buckets are filled from the forward side. */
  markReverseBuilt(field: string): void {
    this.builtReverses.add(field);
  }

  /** The names of the fields whose reverse is built, in the order they were built. */
  reversesBuilt(): string[] {
    return [...this.builtReverses];
  }

  /** The ids that have a bucket and no record. */
  waitingIds(): Id[] {
    return [...this.waiting.keys()];
  }

  /** The bucket of a node for a field: on its record, or in the waiting map when it has none. */
  bucket(object: Id, field: string): ReadonlySet<Id> | undefined {
    return (this.master.get(object)?.buckets ?? this.waiting.get(object))?.get(field);
  }

  /** Put a subject in the bucket of an object for a field. */
  addToBucket(object: Id, field: string, subject: Id): void {
    const rec = this.master.get(object);
    let buckets = rec?.buckets ?? this.waiting.get(object);
    if (buckets === undefined) this.waiting.set(object, (buckets = new Map()));
    const bucket = buckets.get(field) ?? new Set<Id>();
    buckets.set(field, bucket);
    bucket.add(subject);
  }

  /** Take a subject out of the bucket of an object for a field; a bucket that empties goes, and a waiting entry that empties with it. */
  removeFromBucket(object: Id, field: string, subject: Id): void {
    const rec = this.master.get(object);
    const buckets = rec?.buckets ?? this.waiting.get(object);
    const bucket = buckets?.get(field);
    if (bucket === undefined) return;
    bucket.delete(subject);
    if (bucket.size > 0) return;
    buckets!.delete(field);
    if (rec === undefined && buckets!.size === 0) this.waiting.delete(object);
  }

  /** The ids of the records of exactly this kind in a graph, in order of insertion. */
  idsOfKind(graph: GraphName, kind: string): Id[] {
    const collection = this.collections.get(graph)?.get(kind);
    return collection === undefined ? [] : Array.from(collection, (r) => r.id);
  }
}
