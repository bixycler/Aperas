// The engine: it is constructed with a schema and closes it. Batch 4 builds the records and the literal fields, Batch 5
// the reference and embed fields with their reverse side, the removal of a node and a pair, and the build, Batch 6 the
// ordered fields, the partitioning mark, containment with the derived parent, and the tree the records are arranged in, Batch 7
// the tombstone, the tombstone of a subtree and the sweep, Batch 8 the creation of graphs, Batch 9 the ids that are referenced and never defined; every other operation is typed and not built. An unbuilt operation throws an error that names the batch
// that builds it.
// The signatures are the interface's (`interface.ts`); a later batch may amend them where its work shows a shape the
// sentence of the design did not.
import { Refused } from './errors.ts';
import { isGraphName } from './graphName.ts';
import { fieldOfId, kindOfId, ownerOfId } from './ids.ts';
import { DEFAULT_GRAPH, type Engine, type GraphName, type Id, type NodeRecord, type Value } from './interface.ts';
import { compareIds } from './order.ts';
import { Registry, type Rec } from './records.ts';
import { closeSchema, type FieldDef, type LiteralValue, type Schema, type SchemaSpec } from './schema.ts';

export { Refused } from './errors.ts';

/** The error of an operation whose batch has not been done. */
export class NotBuiltError extends Error {
  readonly operation: string;
  readonly batch: string;
  constructor(operation: string, batch: string) {
    super(`apeironNgn: ${operation} is not built yet (${batch})`);
    this.name = 'NotBuiltError';
    this.operation = operation;
    this.batch = batch;
  }
}

/** The batch that builds each operation (planning/core.md). */
export const BUILT_BY: Readonly<Record<Exclude<keyof Engine, 'schema'>, string>> = {
  values: 'Batch 4',
  first: 'Batch 4',
  idsOfKind: 'Batch 4',
  graphOf: 'Batch 8',
  exists: 'Batch 4',
  size: 'Batch 4',
  record: 'Batch 4',
  createNode: 'Batch 4',
  addPair: 'Batch 4',
  clearField: 'Batch 4',
  subjectsOf: 'Batch 5',
  firstSubjectOf: 'Batch 5',
  countSubjectsOf: 'Batch 5',
  removeNode: 'Batch 5',
  removePair: 'Batch 5',
  build: 'Batch 5',
  items: 'Batch 6',
  placeOf: 'Batch 6',
  insertItem: 'Batch 6',
  moveItem: 'Batch 6',
  removeItem: 'Batch 6',
  tombstone: 'Batch 7',
  tombstoneSubtree: 'Batch 7',
  sweep: 'Batch 7',
  createGraph: 'Batch 8',
  dropGraph: 'Batch 8',
  danglingRefs: 'Batch 9',
  setPortCap: 'Batch 14',
  portTree: 'Batch 14',
  capturePortView: 'Batch 14',
  readThroughView: 'Batch 14',
  removePortView: 'Batch 14',
};

/** The operations that a batch has built. */
export const BUILT: ReadonlySet<keyof typeof BUILT_BY> = new Set(['createNode', 'addPair', 'removePair', 'clearField', 'values', 'first', 'subjectsOf', 'firstSubjectOf', 'countSubjectsOf', 'removeNode', 'build', 'idsOfKind', 'record', 'items', 'placeOf', 'insertItem', 'moveItem', 'removeItem', 'tombstone', 'tombstoneSubtree', 'sweep', 'createGraph', 'dropGraph', 'graphOf', 'danglingRefs', 'exists', 'size']);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const unbuilt = (operation: keyof typeof BUILT_BY) => (..._args: any[]): never => { throw new NotBuiltError(operation, BUILT_BY[operation]); };

// -- the two rules the engine enforces, one function each -------------------------------------------------------------

/**
 * Existence (design/core.md, "Open points settled"): a node exists by its record, as in a labelled property graph, and not by a pair
 * that names it. A write whose subject has no record is refused; the reverse side of an id with no record (the pairs that name it) is
 * not its existence, and the id is a dangling reference.
 */
function existence(graph: GraphName, id: Id): never {
  throw new Refused(`no node ${id} in the graph ${graph}`);
}

const isLiteral = (v: unknown): v is LiteralValue => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';

/** Construct an engine with a schema. The schema is closed here: checked, copied and frozen. */
export function createEngine(spec: SchemaSpec): Engine {
  const schema = closeSchema(spec);
  const unbuiltOps = Object.fromEntries((Object.keys(BUILT_BY) as (keyof typeof BUILT_BY)[]).filter((name) => !BUILT.has(name)).map((name) => [name, unbuilt(name)]));
  const registry = new Registry([DEFAULT_GRAPH]);
  const engine = { schema, ...unbuiltOps, ...built(schema, registry) } as unknown as Engine;
  registries.set(engine, registry);
  return engine;
}

const registries = new WeakMap<Engine, Registry>();

/**
 * A look at the registry of an engine for the tests, which read what is built from it and not from the interface: the fields
 * whose reverse is built, in the order they were built, the ids that have a bucket and no record, and the tree the records are
 * arranged in (the record a record is beneath, the records beneath it, the roots of a graph), and the ids that a bucket names as a subject. Not part of the interface.
 */
export function inspectEngine(engine: Engine): { reversesBuilt(): string[]; waitingIds(): Id[]; treeParentOf(id: Id): Id | undefined; nestedIds(id: Id): Id[]; rootIds(graph: GraphName): Id[]; bucketedSubjects(): Id[] } {
  const registry = registries.get(engine);
  if (registry === undefined) throw new Error('inspectEngine: not an engine made by createEngine');
  return {
    reversesBuilt: () => registry.reversesBuilt(),
    waitingIds: () => registry.waitingIds(),
    treeParentOf: (id) => registry.byId(id)?.under?.id,
    nestedIds: (id) => Array.from(registry.byId(id)?.beneath ?? [], (r) => r.id),
    rootIds: (graph) => registry.rootIds(graph),
    bucketedSubjects: () => registry.bucketedSubjects(),
  };
}

/** The operations of Batches 4 to 9, over one registry. */
function built(schema: Schema, registry: Registry): Pick<Engine, 'createNode' | 'addPair' | 'removePair' | 'removeNode' | 'clearField' | 'build' | 'values' | 'first' | 'subjectsOf' | 'firstSubjectOf' | 'countSubjectsOf' | 'idsOfKind' | 'record' | 'exists' | 'size' | 'items' | 'placeOf' | 'insertItem' | 'moveItem' | 'removeItem' | 'tombstone' | 'tombstoneSubtree' | 'sweep' | 'createGraph' | 'dropGraph' | 'graphOf' | 'danglingRefs'> {
  const kinds = new Map(schema.kinds.map((k) => [k.name, { def: k, fields: new Map(k.fields.map((f) => [f.name, f])) }]));
  const fieldOf = (rec: Rec, name: string): FieldDef | undefined => kinds.get(rec.kind)!.fields.get(name);

  /** Whether a kind is the kind `of` or one of its descendants. */
  const isKindOrBelow = (kind: string | undefined, of: string): boolean => {
    for (let k = kind; k !== undefined; k = kinds.get(k)?.def.parent) if (k === of) return true;
    return false;
  };

  /**
   * Enforcement (design/core.md, "Open points settled"): the engine refuses a write outside the shape of the schema: a field the kind
   * does not declare (or a derived one), a value of the wrong sort (a literal field holds a string, a number or a boolean, a reference or
   * embed field holds an id as a string; whether a string is well formed is not asked, a malformed one is a dangling reference). Gives the
   * field when the write is inside it. A write that names its subject (`addPair`, `build`, `insertItem`) also meets the rule for the
   * value of an embed field: an id of an embedded node whose owner is the subject and whose field is this one, of the embedded kind or a
   * descendant. A second value in a `one` or `optional` field is the caller's, `single`.
   */
  const inShape = (kind: string, name: string, value?: Value, subject?: Id): FieldDef => {
    const field = kinds.get(kind)?.fields.get(name);
    if (field === undefined) throw new Refused(`${kind} declares no field ${name}`);
    if (field.derived) throw new Refused(`${name} of ${kind} is derived and is not written`);
    if (value !== undefined && (field.storage === 'literal' ? !isLiteral(value) : typeof value !== 'string')) throw new Refused(`${JSON.stringify(value)} is not a value of ${name} of ${kind}, a ${field.storage === 'literal' ? 'literal' : 'reference'} field`);
    if (value !== undefined && subject !== undefined && field.storage === 'embed') {
      if (ownerOfId(value) !== subject || fieldOfId(value) !== field.name) throw new Refused(`${JSON.stringify(value)} is not an id of a node embedded by ${subject} in ${field.name}`);
      if (!isKindOrBelow(kindOfId(value), field.embeds!)) throw new Refused(`${value} is not of the kind ${field.embeds} that ${field.name} embeds, nor below it`);
    }
    return field;
  };

  /** A second value in a field that holds one: a replacement is a clear and then an add. */
  const single = (field: FieldDef, subject: Id): never => {
    throw new Refused(`${field.name} of ${subject} holds one value; clear it before adding another`);
  };

  /**
   * Containment: a node is owned or contained, never both. An id of the embedded shape (`owner:field:Kind:snowflake`) cannot be listed
   * in the containment field, so the node an owner embeds has no place in any container's list. Read from the id alone, as the owner is.
   */
  const notOwned = (field: FieldDef, value: Value): void => {
    if (field.name === schema.roles.containment && typeof value === 'string' && ownerOfId(value) !== undefined) throw new Refused(`${value} is an embedded node and cannot be listed in ${field.name}`);
  };

  /** The checks of a create: the graph, the grammar, the kind and the uniqueness of the id. `build` makes them too. */
  const checkCreate = (graph: GraphName, id: Id, kind: string): void => {
    if (!registry.hasGraph(graph)) throw new Refused(`no graph ${graph}`);
    const idKind = kindOfId(id);
    if (idKind === undefined) throw new Refused(`${JSON.stringify(id)} is not an id`);
    if (!kinds.has(kind)) throw new Refused(`${kind} is not a kind`);
    if (idKind !== kind) throw new Refused(`the id ${id} carries the kind ${idKind}, not ${kind}`);
    if (registry.taken(id)) throw new Refused(`the id ${id} is taken`);
  };

  /** The create of a record. */
  const create = (graph: GraphName, id: Id, kind: string): void => {
    checkCreate(graph, id, kind);
    place(registry.add(graph, id, kind));
  };

  /** The field a read names, or `undefined` when the subject or the field is not there. */
  const readable = (graph: GraphName, subject: Id, name: string): { rec: Rec; field: FieldDef } | undefined => {
    const rec = registry.get(graph, subject);
    if (rec === undefined) return undefined;
    const field = fieldOf(rec, name);
    return field === undefined ? undefined : { rec, field };
  };

  // -- the reverse side: built on first use, then kept up by every write --------------------------------------------

  /**
   * For each field name, the kinds that declare it as a reference or embed field, and whether every declaration is partitioning (so
   * that the reverse is built by the first write of the field, and while it is not, no pair is there). A derived entry is no field
   * of its own and has no reverse side: it is read from the reverse side of the field that carries its name (`reverseNames`).
   */
  const reverseKinds = new Map<string, { kinds: string[]; partitioning: boolean }>();
  const reverseNames = new Map<string, string>();
  for (const k of schema.kinds) {
    for (const f of k.fields) {
      if (f.storage === 'literal' || f.derived) continue;
      const info = reverseKinds.get(f.name) ?? { kinds: [], partitioning: true };
      reverseKinds.set(f.name, info);
      info.kinds.push(k.name);
      if (!f.partitioning) info.partitioning = false;
      if (f.reverse !== undefined) reverseNames.set(f.reverse, f.name);
    }
  }

  /** The reverse of a field, built if it is not: gives whether the field has one. A literal, unknown or derived field has none. */
  const reverseOf = (name: string): boolean => {
    const info = reverseKinds.get(name);
    if (info === undefined) return false;
    if (!registry.isReverseBuilt(name)) {
      for (const kind of info.kinds) for (const rec of registry.recordsOfKind(kind)) for (const v of rec.fields.get(name) ?? []) registry.addToBucket(v as Id, name, rec.id);
      registry.markReverseBuilt(name);
    }
    return true;
  };

  /** A pair put in a field of a record: the bucket of its object, if the reverse of the field is built. */
  const link = (rec: Rec, field: FieldDef, value: Value): void => {
    if (field.storage !== 'literal' && registry.isReverseBuilt(field.name)) registry.addToBucket(value as Id, field.name, rec.id);
  };

  // -- the tree the records are arranged in ----------------------------------------------------------------------

  /**
   * The record a record is beneath (design/core.md, "Records follow containment"): the node that holds its id in the embed field
   * the id names, else the container that lists it, else none. The embedded node comes first, since the owner is read from its id
   * and a node has one place in the tree. The container is read from the bucket of the node in the containment field, which the
   * first write of that field has built, on its record or in the waiting map; a container with no record is no place.
   */
  const parentOf = (rec: Rec): Rec | undefined => {
    const owner = ownerOfId(rec.id);
    if (owner !== undefined) {
      const name = fieldOfId(rec.id)!;
      const owning = registry.get(rec.graph, owner);
      if (owning !== undefined && fieldOf(owning, name)?.storage === 'embed' && owning.fields.get(name)?.includes(rec.id)) return owning;
    }
    const containment = schema.roles.containment;
    const container = containment === undefined ? undefined : registry.bucket(rec.id, containment)?.values().next().value;
    return container === undefined ? undefined : registry.get(rec.graph, container);
  };

  /** Put a record where the pairs say it belongs in the tree. Called wherever a pair that decides it, or the record itself, appears or goes. */
  const place = (rec: Rec): void => registry.nest(rec, parentOf(rec));

  /** A pair of a field that nests (the containment field, an embed field) has been put in or taken out of a record: its value, if it has a record, is placed again. */
  const replace = (rec: Rec, field: FieldDef, value: Value): void => {
    if (field.storage === 'literal' || (field.storage !== 'embed' && field.name !== schema.roles.containment)) return;
    const child = registry.get(rec.graph, value as Id);
    if (child !== undefined) place(child);
  };

  /**
   * The rule of a partitioning field, for the pair (host, item): the item has no subject in this field but the host (the climbed
   * side is the reverse: an object has at most one subject, as a node has at most one container), and the host is not the item
   * or under it, which would close a cycle. Both read the reverse of the field, held on the record of the item or in the waiting
   * map when it has none, so an item whose container still lists it after its own record went is counted in that container.
   * The reverse is built at the first write of the field, so while it is not, no pair is there to read. Changes nothing.
   */
  const partition = (host: Id, field: FieldDef, item: Id): void => {
    if (item === host) throw new Refused(`${item} cannot be in its own ${field.name}`);
    if (!registry.isReverseBuilt(field.name)) return;
    for (const subject of registry.bucket(item, field.name) ?? []) {
      if (subject !== host) throw new Refused(`${item} is already in the ${field.name} of ${subject}`);
    }
    // Climb from the host, one subject at a time: each node has at most one, so the climb is the depth of the tree and ends. The
    // bound turns a broken invariant (a cycle already in the lists) into a failure and not a hang.
    let steps = registry.count();
    for (let up = registry.bucket(host, field.name)?.values().next().value; up !== undefined; up = registry.bucket(up, field.name)?.values().next().value) {
      if (up === item) throw new Refused(`${host} under ${item} through ${field.name} closes a cycle`);
      if (--steps < 0) throw new Error(`apeironNgn: the ${field.name} of ${host} climbs without end: a cycle is in the lists`);
    }
  };

  /** Put a value in a field of a record, at the end or, for an ordered field, at the place `at`, and its entry in a built reverse. The checks are the caller's. */
  const attach = (rec: Rec, field: FieldDef, value: Value, at?: number): void => {
    if (field.partitioning) reverseOf(field.name); // built at the first write of the field, so that the rule has the buckets to read
    const held = rec.fields.get(field.name);
    if (held === undefined) rec.fields.set(field.name, [value]);
    else if (at === undefined || at >= held.length) held.push(value);
    else held.splice(at, 0, value);
    link(rec, field, value);
    replace(rec, field, value);
  };

  /** Take a value out of a field of a record, and its entry out of a built reverse. Gives whether it was there; a field left with no value has no entry. */
  const detach = (rec: Rec, field: FieldDef, value: Value): boolean => {
    const held = rec.fields.get(field.name);
    const at = held === undefined ? -1 : held.indexOf(value);
    if (at < 0) return false;
    held!.splice(at, 1);
    if (held!.length === 0) rec.fields.delete(field.name);
    if (field.storage !== 'literal' && registry.isReverseBuilt(field.name)) registry.removeFromBucket(value as Id, field.name, rec.id);
    replace(rec, field, value);
    return true;
  };

  /**
   * Take every value out of a field of a record in one pass, and their entries out of a built reverse: the field of a node that
   * goes, or a field cleared. Gives the values. One pass and not a `detach` for each, because that is a splice from the head of
   * the list for each item, a quadratic number of moves for a host with thousands.
   */
  const release = (rec: Rec, field: FieldDef): Value[] => {
    const held = rec.fields.get(field.name);
    if (held === undefined) return [];
    rec.fields.delete(field.name);
    if (field.storage !== 'literal' && registry.isReverseBuilt(field.name)) for (const v of held) registry.removeFromBucket(v as Id, field.name, rec.id);
    for (const v of held) replace(rec, field, v);
    return held;
  };

  // -- removal ---------------------------------------------------------------------------------------------------

  /** Before a removal changes anything: the reverse of each field dropped with its target is built, which a removal asks for (the first removal builds it). */
  const prepareRemoval = (): void => {
    for (const name of schema.roles.dropWithTarget) reverseOf(name);
  };

  /**
   * Remove a node and what it owns: each pair it holds as subject, as `removePair` removes it (so a built reverse loses the
   * entry), its embedded nodes in turn, and its place in every field dropped with its target. The pairs that name it stay, and
   * so do their buckets, which move to the waiting map with the record's leaving. Its literals go with its record.
   */
  const drop = (rec: Rec): void => {
    const embedded: Id[] = [];
    for (const name of [...rec.fields.keys()]) {
      const field = fieldOf(rec, name)!;
      if (field.storage === 'literal') continue;
      const held = release(rec, field) as Id[];
      if (field.storage === 'embed') embedded.push(...held);
    }
    for (const name of schema.roles.dropWithTarget) {
      for (const subject of [...(registry.bucket(rec.id, name) ?? [])]) {
        const owner = registry.byId(subject)!;
        detach(owner, fieldOf(owner, name)!, rec.id);
      }
    }
    registry.remove(rec);
    for (const id of embedded) {
      const child = registry.get(rec.graph, id);
      if (child !== undefined) drop(child);
    }
  };

  /** Take a value out of a field; on an embed field the node it names goes with it. `prepareRemoval` has been called for an embed field. */
  const removeValue = (rec: Rec, field: FieldDef, value: Value): void => {
    if (!detach(rec, field, value)) return;
    if (field.storage !== 'embed') return;
    const child = registry.get(rec.graph, value as Id);
    if (child !== undefined) drop(child);
  };

  // -- the tombstone and the sweep ------------------------------------------------------------------------------

  /** The marker of a tombstone, or `Refused` when the schema assigns none. */
  const markerOf = (): string => {
    const marker = schema.roles.tombstone;
    if (marker === undefined) throw new Refused('the schema assigns no tombstone marker');
    return marker;
  };

  /** Whether a record is a tombstone: its marker is set. A kind that does not declare the marker never is. */
  const isTombstone = (rec: Rec, marker: string): boolean => (rec.fields.get(marker)?.length ?? 0) > 0;

  /**
   * Make a record a tombstone, with the checks made (its kind declares the marker, the marker is not set). One operation that cannot
   * fail: the node leaves every list that holds it (the subjects in its bucket of the containment field, which the first write of the
   * field built, so that when it is not built nothing lists anything); every non-literal field it holds is taken out in one pass,
   * the embedded nodes dropped as `clearField` drops them; the marker is set. The literal fields stay, and so do the references that
   * name the node and its entries in the fields dropped with their target (that is removal's).
   */
  const makeTombstone = (rec: Rec, marker: string, at: string): void => {
    const containment = schema.roles.containment;
    if (containment !== undefined) {
      for (const subject of [...(registry.bucket(rec.id, containment) ?? [])]) {
        const host = registry.byId(subject)!;
        detach(host, fieldOf(host, containment)!, rec.id);
      }
    }
    const names = [...rec.fields.keys()].filter((name) => fieldOf(rec, name)!.storage !== 'literal');
    if (names.some((name) => fieldOf(rec, name)!.storage === 'embed')) prepareRemoval();
    const embedded: Id[] = [];
    for (const name of names) {
      const field = fieldOf(rec, name)!;
      const held = release(rec, field) as Id[];
      if (field.storage === 'embed') embedded.push(...held);
    }
    for (const id of embedded) {
      const child = registry.get(rec.graph, id);
      if (child !== undefined) drop(child);
    }
    rec.fields.set(marker, [at]);
  };

  /** The tombstone of a node: the checks in their order (the role, the record, the marker of the kind), then nothing more when it is one already. */
  const tombstone = (graph: GraphName, id: Id, at: string): void => {
    const marker = markerOf();
    const rec = registry.get(graph, id);
    if (rec === undefined) return existence(graph, id);
    if (fieldOf(rec, marker) === undefined) throw new Refused(`${rec.kind} has no tombstone marker ${marker}`);
    if (isTombstone(rec, marker)) return; // already a tombstone: the first timestamp stays
    makeTombstone(rec, marker, at);
  };

  /**
   * The tombstone of a node and of its subtree over containment. The members are collected first, by a walk of the lists with an
   * explicit stack and a visited set (a chain of thousands of containers must not overflow), in pre-order: an entry that names no
   * record in this graph is skipped. All the kinds are checked before the first change, so that a member that cannot be tombstoned
   * refuses the whole and leaves the engine as it was.
   */
  const tombstoneSubtree = (graph: GraphName, id: Id, at: string): void => {
    const marker = markerOf();
    const top = registry.get(graph, id);
    if (top === undefined) return existence(graph, id);
    const containment = schema.roles.containment;
    const members: Rec[] = [];
    const seen = new Set<Rec>([top]);
    for (const stack = [top]; stack.length > 0; ) {
      const rec = stack.pop()!;
      members.push(rec);
      const listed = containment === undefined ? undefined : rec.fields.get(containment);
      for (let i = (listed?.length ?? 0) - 1; i >= 0; i--) { // reversed, so that the first item is the next out
        const child = registry.get(graph, listed![i] as Id);
        if (child !== undefined && !seen.has(child)) { seen.add(child); stack.push(child); }
      }
    }
    for (const rec of members) if (fieldOf(rec, marker) === undefined) throw new Refused(`${rec.kind} has no tombstone marker ${marker}`);
    for (const rec of members) if (!isTombstone(rec, marker)) makeTombstone(rec, marker, at); // one that is a tombstone keeps its stamp
  };

  /**
   * The sweep: the mark from the live records of the root kinds (and the kinds below them) through the followed fields, with an
   * explicit stack and each record visited once; it goes through a tombstone it reaches. Then every tombstone of this graph that
   * is not marked is dropped, collected before the first removal. Gives their ids, sorted by code point.
   */
  const sweep = (graph: GraphName): Id[] => {
    if (!registry.hasGraph(graph)) throw new Refused(`no graph ${graph}`);
    const roles = schema.roles.sweep;
    if (roles === undefined) throw new Refused('the schema assigns no sweep');
    const marker = markerOf();
    const marked = new Set<Rec>();
    const stack: Rec[] = [];
    for (const kind of schema.kinds) {
      if (!roles.roots.some((root) => isKindOrBelow(kind.name, root))) continue;
      for (const rec of registry.recordsOf(graph, kind.name)) if (!isTombstone(rec, marker)) { marked.add(rec); stack.push(rec); }
    }
    while (stack.length > 0) {
      const rec = stack.pop()!;
      for (const name of roles.follow) {
        for (const value of rec.fields.get(name) ?? []) {
          const next = registry.get(graph, value as Id);
          if (next !== undefined && !marked.has(next)) { marked.add(next); stack.push(next); }
        }
      }
    }
    const doomed: Rec[] = [];
    for (const kind of schema.kinds) {
      if (!kind.fields.some((f) => f.name === marker)) continue;
      for (const rec of registry.recordsOf(graph, kind.name)) if (isTombstone(rec, marker) && !marked.has(rec)) doomed.push(rec);
    }
    if (doomed.length > 0) prepareRemoval();
    const ids = doomed.map((rec) => rec.id).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const rec of doomed) if (registry.get(graph, rec.id) === rec) drop(rec); // an embedded tombstone may have gone with its owner
    return ids;
  };

  /**
   * The values of a field of a record, as a copy; for an ordered field in order, and for a derived entry the subjects in the reverse
   * side of the field that carries its name (a node has at most one container). The reverse is built by this read, unless every
   * declaration of the field is partitioning: the first write of it builds the reverse, so before that no pair is there to read.
   */
  const valuesOf = (rec: Rec, field: FieldDef): Value[] => {
    if (!field.derived) return [...(rec.fields.get(field.name) ?? [])];
    const owner = reverseNames.get(field.name);
    if (owner === undefined || (!registry.isReverseBuilt(owner) && reverseKinds.get(owner)!.partitioning)) return [];
    if (!reverseOf(owner)) return [];
    return [...(registry.bucket(rec.id, owner) ?? [])].filter((subject) => registry.byId(subject)?.graph === rec.graph);
  };

  /**
   * The subjects of a reverse side that are in the graph the read names (design/core.md, "Reads and rules across graphs"): the bucket of
   * the object holds the subjects of every graph, since a pair may join a node of one graph to a node of another and the rules of the
   * whole store read it whole, and a read that gives a node's relations is filtered to the graph it names. A graph that does not exist
   * holds no subject, and a field with no reverse side has none.
   */
  const subjectsIn = (graph: GraphName, name: string, value: Id): Id[] => {
    if (!reverseOf(name) || !registry.hasGraph(graph)) return [];
    if (!registry.hasSeveralGraphs()) return [...(registry.bucket(value, name) ?? [])];
    const out: Id[] = [];
    for (const subject of registry.bucket(value, name) ?? []) if (registry.get(graph, subject) !== undefined) out.push(subject);
    return out;
  };

  /** The host and the field of a splice or of a read of a list: the host has a record, the field is in the shape and ordered. */
  const listOf = (graph: GraphName, host: Id, name: string): { rec: Rec; field: FieldDef } => {
    const rec = registry.get(graph, host);
    if (rec === undefined) return existence(graph, host);
    return { rec, field: orderedField(rec, name) };
  };

  /** The field of a list: in the shape of the kind of `rec`, and ordered. */
  const orderedField = (rec: Rec, name: string): FieldDef => {
    const field = inShape(rec.kind, name);
    if (field.cardinality !== 'ordered') throw new Refused(`${name} is not an ordered field`);
    return field;
  };

  return {
    createNode: create,

    addPair(graph, subject, name, value) {
      const rec = registry.get(graph, subject);
      if (rec === undefined) return existence(graph, subject);
      const field = inShape(rec.kind, name, value, subject);
      notOwned(field, value);
      const have = rec.fields.get(name);
      if (have?.some((v) => v === value)) return; // already present: nothing changes
      if (have !== undefined && (field.cardinality === 'one' || field.cardinality === 'optional')) single(field, subject);
      if (field.partitioning) partition(subject, field, value as Id);
      attach(rec, field, value as Value);
    },

    removePair(graph, subject, name, value) {
      const rec = registry.get(graph, subject);
      if (rec === undefined) return existence(graph, subject);
      const field = inShape(rec.kind, name, value);
      if (field.storage === 'embed' && rec.fields.get(name)?.includes(value)) prepareRemoval();
      removeValue(rec, field, value);
    },

    clearField(graph, subject, name) {
      const rec = registry.get(graph, subject);
      if (rec === undefined) return existence(graph, subject);
      const field = inShape(rec.kind, name);
      if (field.storage !== 'embed') {
        release(rec, field);
        return;
      }
      if (rec.fields.has(name)) prepareRemoval();
      for (const value of release(rec, field)) {
        const child = registry.get(rec.graph, value as Id);
        if (child !== undefined) drop(child);
      }
    },

    removeNode(graph, id) {
      const rec = registry.get(graph, id);
      if (rec === undefined) return; // not there: nothing changes, as the removal of a pair that is not there
      prepareRemoval();
      drop(rec);
    },

    build(graph, record) {
      checkCreate(graph, record.id, record.kind);
      // Everything is checked before the first change, so that a build that fails leaves the engine as it was.
      const kind = kinds.get(record.kind)!;
      const plan: [FieldDef, Value[]][] = [];
      for (const [name, input] of Object.entries(record.fields)) {
        if (kind.fields.get(name)?.derived) continue; // an assertion by the shell, never a pair
        inShape(record.kind, name); // a field the kind does not declare is refused even with no value
        const values: Value[] = [];
        const seen = new Set<string>(); // the strings of `values`, so that an array of thousands of items is not scanned for each
        for (const value of Array.isArray(input) ? (input as readonly Value[]) : [input as Value]) {
          const field = inShape(record.kind, name, value, record.id);
          notOwned(field, value);
          if (typeof value === 'string' ? seen.has(value) : values.some((v) => v === value)) continue;
          if (values.length > 0 && (field.cardinality === 'one' || field.cardinality === 'optional')) single(field, record.id);
          if (field.partitioning) partition(record.id, field, value as Id);
          values.push(value);
          if (typeof value === 'string') seen.add(value);
        }
        if (values.length > 0) plan.push([kind.fields.get(name)!, values]);
      }
      const rec = registry.add(graph, record.id, record.kind);
      place(rec);
      for (const [field, values] of plan) for (const value of values) attach(rec, field, value);
    },

    values(graph, subject, name) {
      const read = readable(graph, subject, name);
      return read === undefined ? [] : valuesOf(read.rec, read.field);
    },

    first(graph, subject, name) {
      const read = readable(graph, subject, name);
      return read === undefined ? undefined : valuesOf(read.rec, read.field)[0];
    },

    subjectsOf(graph, name, value) {
      return subjectsIn(graph, name, value);
    },

    firstSubjectOf(graph, name, value) {
      return subjectsIn(graph, name, value)[0];
    },

    countSubjectsOf(graph, name, value) {
      if (!registry.hasSeveralGraphs()) return reverseOf(name) && registry.hasGraph(graph) ? (registry.bucket(value, name)?.size ?? 0) : 0; // one graph: every subject is in it
      return subjectsIn(graph, name, value).length;
    },

    idsOfKind(graph, kind) {
      return registry.idsOfKind(graph, kind);
    },

    graphOf(id) {
      return registry.byId(id)?.graph;
    },

    items(graph, host, name) {
      const rec = registry.get(graph, host);
      if (rec === undefined) return []; // a read does not refuse on absence, as `values` does not
      orderedField(rec, name);
      return [...(rec.fields.get(name) ?? [])] as Id[];
    },

    placeOf(graph, host, name, item) {
      const rec = registry.get(graph, host);
      if (rec === undefined) return undefined;
      orderedField(rec, name);
      const at = rec.fields.get(name)?.indexOf(item) ?? -1;
      return at < 0 ? undefined : at;
    },

    insertItem(graph, host, name, item, at) {
      const { rec, field } = listOf(graph, host, name);
      inShape(rec.kind, name, item, host);
      notOwned(field, item);
      const list = rec.fields.get(name) ?? [];
      if (list.includes(item)) throw new Refused(`${item} is already in ${name} of ${host}`);
      const place = at ?? list.length;
      if (!Number.isInteger(place) || place < 0 || place > list.length) throw new Refused(`no place ${place} in a list of ${list.length}`);
      if (field.partitioning) partition(host, field, item);
      attach(rec, field, item, place);
    },

    moveItem(graph, host, name, item, to) {
      const { rec, field } = listOf(graph, host, name);
      notOwned(field, item);
      const list = rec.fields.get(name) ?? [];
      const from = list.indexOf(item);
      if (from < 0) throw new Refused(`${item} is not in ${name} of ${host}`);
      if (!Number.isInteger(to) || to < 0 || to >= list.length) throw new Refused(`no place ${to} in a list of ${list.length}`);
      list.splice(from, 1);
      list.splice(to, 0, item);
    },

    removeItem(graph, host, name, item) {
      const { rec, field } = listOf(graph, host, name);
      if (!detach(rec, field, item)) throw new Refused(`${item} is not in ${name} of ${host}`);
    },

    tombstone,
    tombstoneSubtree,
    sweep,

    dropGraph(graph) {
      if (!registry.hasGraph(graph)) throw new Refused(`no graph ${graph}`);
      // The check reads across graphs, by a scan of the forward sides of the records of the other graphs: the buckets of a reverse are
      // built on first use, and a drop is rare, so it does not build the reverse of every field to ask. Nothing changes before it ends.
      for (const rec of registry.records()) {
        if (rec.graph === graph) continue;
        for (const [name, values] of rec.fields) {
          if (fieldOf(rec, name)!.storage === 'literal') continue;
          for (const v of values) if (registry.get(graph, v as Id) !== undefined) throw new Refused(`${rec.id} in ${rec.graph} points into ${graph} through ${name}`);
        }
      }
      // The pairs that go out of the graph leave the buckets they sit in (on a record that remains, or in the waiting map); the
      // records go with their own buckets, whose subjects are all in the graph (a subject of another graph would have been a pair
      // into it). The tree is inside a graph, so no record of another graph is beneath one that goes.
      for (const rec of registry.recordsIn(graph)) {
        for (const [name, values] of rec.fields) {
          if (fieldOf(rec, name)!.storage === 'literal' || !registry.isReverseBuilt(name)) continue;
          for (const v of values) registry.removeFromBucket(v as Id, name, rec.id);
        }
      }
      registry.removeGraph(graph);
    },

    createGraph(graph) {
      if (!isGraphName(graph)) throw new Refused(`${JSON.stringify(graph)} is not a graph name`);
      if (registry.hasGraph(graph)) throw new Refused(`the graph ${graph} exists`);
      registry.addGraph(graph);
    },

    /**
     * The ids that a pair of a reference or embed field of this graph holds as its object and that no graph defines (design/core.md,
     * "Persistence"): an id defined in any graph is defined, since a pair may join a node of one graph to a node of another, so a
     * reference across graphs does not dangle while the node it names is built. A literal is no reference. Gives the ids once each,
     * sorted by code point; a graph that does not exist holds no pair. A derived entry is no pair and so is not read.
     */
    danglingRefs(graph) {
      const missing = new Set<Id>();
      for (const rec of registry.recordsIn(graph)) {
        for (const [name, values] of rec.fields) {
          if (fieldOf(rec, name)!.storage === 'literal') continue;
          for (const v of values) if (registry.byId(v as Id) === undefined) missing.add(v as Id);
        }
      }
      return [...missing].sort(compareIds);
    },

    exists(graph, id) {
      return registry.get(graph, id) !== undefined;
    },

    size(graph) {
      return registry.sizeOf(graph);
    },

    record(graph, id): NodeRecord | undefined {
      const rec = registry.get(graph, id);
      if (rec === undefined) return undefined;
      // A derived entry stands at its place, read from the reverse side.
      const fields = kinds.get(rec.kind)!.def.fields.flatMap((f) => {
        const held = valuesOf(rec, f);
        return held.length === 0 ? [] : [{ name: f.name, values: held }];
      });
      return { id, kind: rec.kind, fields };
    },
  };
}
