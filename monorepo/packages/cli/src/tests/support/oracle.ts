// The oracle: a naive implementation of the engine's interface, kept for tests. It is constructed with the same
// closed schema as the engine, holds its nodes and its pairs in two arrays and answers every read by a linear scan,
// and imports nothing of the engine's behaviour, only its types. Every later batch tests the engine against it with
// seeded random sequences of operations (planning/core.md, Batch 3 step 4).
//
// Scope: it implements every operation of the interface. The two rules the design settled (design/core.md, "Open points settled") are
// one function each, and each throws `Refused`:
//   - `existence`: a node exists by its record, so a write whose subject has no record is refused, and the reverse side of an id with no
//     record is not its existence (the read `exists` is whether a record stands for the id in the graph, `size` the number of records);
//   - `inShape`: a write outside the shape of the schema (a field the kind does not declare, a value of the wrong sort, an embedded value
//     of another kind than the field embeds) is refused, and so is a second value for a single-valued field.
// The id grammar is the oracle's own, written apart from the engine's (a regular expression and a split on `:`).
// Not built: the order of links without a position (the oracle sorts nothing: a set comes back in insertion order, which is
// promised to no reader) and the ports (Batch 14). The sweep is written by scan: a mark over the pairs, then one drop of every
// tombstone that the mark did not reach.
import type { BuildRecord, Bucket, CapturedView, Engine, FieldInput, GraphName, Id, NodeRecord, PortTreeRow, Value } from '@aperas/core/apeironNgn/interface';
import type { FieldDef, Schema } from '@aperas/core/apeironNgn/schema';

/** The graph that exists from the start. */
const DEFAULT_GRAPH_NAME: GraphName = 'default';

/** An operation that no batch has designed yet. */
export class NotBuilt extends Error {
  constructor(message: string) {
    super(`not built: ${message}`);
    this.name = 'NotBuilt';
  }
}

/** A write the design states a rule against, such as a second container for a node or a cycle. */
export class Refused extends Error {
  constructor(message: string) {
    super(`refused: ${message}`);
    this.name = 'Refused';
  }
}

interface NodeRow { readonly graph: GraphName; readonly id: Id; readonly kind: string }
interface PairRow { readonly graph: GraphName; readonly subject: Id; readonly field: string; readonly value: Value }

const isLiteral = (v: unknown): v is Value => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
/** The grammar of an id, written out: `Kind:snowflake`, then `:field:Kind:snowflake` for each level of nesting. */
const ID_GRAMMAR = /^[A-Za-z_]\w*:[0-9A-HJKMNP-TV-Z]{13}(:[A-Za-z_]\w*:[A-Za-z_]\w*:[0-9A-HJKMNP-TV-Z]{13})*$/;

/** Whether a string is an id. */
export const oracleIsId = (id: string): boolean => ID_GRAMMAR.test(id);

/** The kind an id carries: the second to last of its `:` parts. */
export const oracleKindOfId = (id: string): string | undefined => (oracleIsId(id) ? id.split(':').slice(-2)[0] : undefined);

/** The owner and the field of an embedded id, read by one expression apart from the engine's split: `undefined` for a top-level id or a string that is no id. */
const EMBEDDED = /^(.+):([A-Za-z_]\w*):[A-Za-z_]\w*:[0-9A-HJKMNP-TV-Z]{13}$/;
export const oracleOwnerOfId = (id: string): string | undefined => (oracleIsId(id) ? EMBEDDED.exec(id)?.[1] : undefined);
export const oracleFieldOfId = (id: string): string | undefined => (oracleIsId(id) ? EMBEDDED.exec(id)?.[2] : undefined);

/** The grammar of a graph's name, written out apart from the engine's: the hostname rule of RFC 1123 in lowercase, and `id` refused. */
export const oracleIsGraphName = (name: string): boolean =>
  name.length > 0 && name.length <= 253 && name !== 'id'
  && name.split('.').every((label) => label.length >= 1 && label.length <= 63 && /^[a-z0-9-]+$/.test(label) && !label.startsWith('-') && !label.endsWith('-'));

const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export class Oracle implements Engine {
  readonly schema: Schema;
  private readonly graphs = new Set<GraphName>([DEFAULT_GRAPH_NAME]);
  private nodes: NodeRow[] = [];
  private pairs: PairRow[] = [];

  constructor(schema: Schema) {
    this.schema = schema;
  }

  // -- the two rules, one function each -------------------------------------------------------------------------

  /** Existence: a node exists by its record, so a write to a subject that has none is refused. */
  private existence(graph: GraphName, id: Id): never {
    throw new Refused(`no node ${id} in the graph ${graph}`);
  }

  /** Enforcement: a write outside the shape of the schema is refused. Gives the field when the write is inside it. */
  private inShape(kind: string, name: string, value?: Value, subject?: Id): FieldDef {
    const field = this.field(kind, name);
    if (field === undefined || field.derived) throw new Refused(`${kind} has no writable field ${name}`);
    if (value !== undefined && (field.storage === 'literal' ? !isLiteral(value) : typeof value !== 'string')) throw new Refused(`${JSON.stringify(value)} is not a value of ${name}`);
    // The value of an embed field, for a write that names its subject: an id of a node the subject embeds in this field, of the embedded kind or below it.
    if (value !== undefined && subject !== undefined && field.storage === 'embed') {
      if (oracleOwnerOfId(value as string) !== subject || oracleFieldOfId(value as string) !== name) throw new Refused(`${JSON.stringify(value)} is not an id of a node embedded by ${subject} in ${name}`);
      if (!this.isKindOrBelow(oracleKindOfId(value as string), field.embeds!)) throw new Refused(`${value} is not of the kind ${field.embeds} that ${name} embeds`);
    }
    return field;
  }

  /** Containment: a node is owned or contained, never both, so an id of the embedded shape cannot be listed in the containment field. */
  private notOwned(name: string, value: Value): void {
    if (name === this.schema.roles.containment && typeof value === 'string' && oracleOwnerOfId(value) !== undefined) throw new Refused(`${value} is an embedded node and cannot be listed in ${name}`);
  }

  private isKindOrBelow(kind: string | undefined, of: string): boolean {
    for (let k = kind; k !== undefined; k = this.schema.kinds.find((d) => d.name === k)?.parent) if (k === of) return true;
    return false;
  }

  // -- the schema, read by scan ----------------------------------------------------------------------------------

  private field(kind: string, name: string): FieldDef | undefined {
    return this.schema.kinds.find((k) => k.name === kind)?.fields.find((f) => f.name === name);
  }

  /** The field whose reverse side carries this name, for a derived entry. */
  private reverseOf(name: string): string | undefined {
    for (const k of this.schema.kinds) for (const f of k.fields) if (f.reverse === name) return f.name;
    return undefined;
  }

  // -- the store, read by scan -----------------------------------------------------------------------------------

  private node(graph: GraphName, id: Id): NodeRow | undefined {
    return this.nodes.find((n) => n.graph === graph && n.id === id);
  }

  private defined(id: Id): boolean {
    return this.nodes.some((n) => n.id === id);
  }

  private mustHaveGraph(graph: GraphName): void {
    if (!this.graphs.has(graph)) throw new Refused(`no graph ${graph}`);
  }

  private pairsOf(graph: GraphName, subject: Id, field: string): PairRow[] {
    return this.pairs.filter((p) => p.graph === graph && p.subject === subject && p.field === field);
  }

  private holds(field: string, value: Id): PairRow[] {
    return this.pairs.filter((p) => p.field === field && p.value === value);
  }

  // -- Reads -----------------------------------------------------------------------------------------------------

  values(graph: GraphName, subject: Id, field: string): Value[] {
    const node = this.node(graph, subject);
    if (node === undefined) return [];
    const def = this.field(node.kind, field);
    if (def === undefined) return [];
    if (def.derived) {
      const owner = this.reverseOf(field);
      return owner === undefined ? [] : this.pairs.filter((p) => p.graph === graph && p.field === owner && p.value === subject).map((p) => p.subject);
    }
    return this.pairsOf(graph, subject, field).map((p) => p.value);
  }

  first(graph: GraphName, subject: Id, field: string): Value | undefined {
    return this.values(graph, subject, field)[0];
  }

  subjectsOf(graph: GraphName, field: string, value: Id): Id[] {
    // A literal or unknown field has no reverse side: no kind declares the name as a reference or embed field.
    if (!this.schema.kinds.some((k) => k.fields.some((f) => f.name === field && f.storage !== 'literal'))) return [];
    return this.pairs.filter((p) => p.graph === graph && p.field === field && p.value === value).map((p) => p.subject);
  }

  firstSubjectOf(graph: GraphName, field: string, value: Id): Id | undefined {
    return this.subjectsOf(graph, field, value)[0];
  }

  countSubjectsOf(graph: GraphName, field: string, value: Id): number {
    return this.subjectsOf(graph, field, value).length;
  }

  items(graph: GraphName, host: Id, field: string): Id[] {
    const node = this.node(graph, host);
    if (node === undefined) return [];
    this.mustBeOrdered(graph, host, field);
    return this.pairsOf(graph, host, field).map((p) => p.value as Id);
  }

  placeOf(graph: GraphName, host: Id, field: string, item: Id): number | undefined {
    const at = this.items(graph, host, field).indexOf(item);
    return at < 0 ? undefined : at;
  }

  idsOfKind(graph: GraphName, kind: string): Id[] {
    return this.nodes.filter((n) => n.graph === graph && n.kind === kind).map((n) => n.id);
  }

  graphOf(id: Id): GraphName | undefined {
    return this.nodes.find((n) => n.id === id)?.graph;
  }

  exists(graph: GraphName, id: Id): boolean {
    return this.node(graph, id) !== undefined;
  }

  size(graph: GraphName): number {
    return this.nodes.filter((n) => n.graph === graph).length;
  }

  // -- Writes ----------------------------------------------------------------------------------------------------

  createNode(graph: GraphName, id: Id, kind: string): void {
    this.mustHaveGraph(graph);
    if (!oracleIsId(id)) throw new Refused(`${JSON.stringify(id)} is not an id`);
    if (!this.schema.kinds.some((k) => k.name === kind)) throw new Refused(`${kind} is not a kind`);
    if (oracleKindOfId(id) !== kind) throw new Refused(`the id ${id} carries another kind than ${kind}`);
    if (this.defined(id)) throw new Refused(`the id ${id} is taken`);
    this.nodes.push({ graph, id, kind });
  }

  addPair(graph: GraphName, subject: Id, field: string, value: Value): void {
    const node = this.node(graph, subject);
    if (node === undefined) return this.existence(graph, subject);
    const def = this.inShape(node.kind, field, value, subject);
    this.notOwned(field, value);
    if (this.pairsOf(graph, subject, field).some((p) => p.value === value)) return; // already present: nothing changes
    if (def.cardinality === 'ordered') return this.insertItem(graph, subject, field, value as Id);
    if ((def.cardinality === 'one' || def.cardinality === 'optional') && this.pairsOf(graph, subject, field).length > 0) throw new Refused(`${field} of ${subject} holds one value`);
    if (def.partitioning) this.mustPartition(subject, field, value as Id);
    this.pairs.push({ graph, subject, field, value });
  }

  clearField(graph: GraphName, subject: Id, field: string): void {
    const node = this.node(graph, subject);
    if (node === undefined) return this.existence(graph, subject);
    const def = this.inShape(node.kind, field);
    const gone = this.pairsOf(graph, subject, field);
    this.pairs = this.pairs.filter((p) => !gone.includes(p));
    if (def.storage === 'embed') for (const p of gone) this.drop(graph, p.value as Id); // an embedded node the new value does not keep goes
  }

  removePair(graph: GraphName, subject: Id, field: string, value: Value): void {
    const node = this.node(graph, subject);
    if (node === undefined) return this.existence(graph, subject);
    const def = this.inShape(node.kind, field, value);
    const gone = this.pairsOf(graph, subject, field).filter((p) => p.value === value);
    if (gone.length === 0) return; // not there: nothing changes
    this.pairs = this.pairs.filter((p) => !gone.includes(p)); // the other pairs of an ordered field keep their order
    if (def.storage === 'embed') this.drop(graph, value as Id); // the embedded node goes, and the nodes it embeds
  }

  removeNode(graph: GraphName, id: Id): void {
    if (this.node(graph, id) === undefined) return; // not there: nothing changes, as the removal of a pair that is not there
    this.drop(graph, id);
  }

  /** Remove a node, its pairs, its embedded nodes, and its place in every field dropped with its target. */
  private drop(graph: GraphName, id: Id): void {
    const node = this.node(graph, id);
    if (node === undefined) return;
    const embedded = this.pairs.filter((p) => p.graph === graph && p.subject === id && this.field(node.kind, p.field)?.storage === 'embed').map((p) => p.value as Id);
    this.pairs = this.pairs.filter((p) => !(p.graph === graph && p.subject === id) && !(this.schema.roles.dropWithTarget.includes(p.field) && p.value === id));
    this.nodes = this.nodes.filter((n) => n !== node);
    for (const e of embedded) this.drop(graph, e);
  }

  insertItem(graph: GraphName, host: Id, field: string, item: Id, at?: number): void {
    const list = this.mustBeOrdered(graph, host, field);
    this.inShape(this.node(graph, host)!.kind, field, item, host);
    this.notOwned(field, item);
    if (list.some((p) => p.value === item)) throw new Refused(`${item} is already in ${field} of ${host}`);
    const place = at ?? list.length;
    if (!Number.isInteger(place) || place < 0 || place > list.length) throw new Refused(`no place ${place} in a list of ${list.length}`);
    if (this.field(this.node(graph, host)!.kind, field)!.partitioning) this.mustPartition(host, field, item);
    this.splice(list, place, { graph, subject: host, field, value: item });
  }

  moveItem(graph: GraphName, host: Id, field: string, item: Id, to: number): void {
    const list = this.mustBeOrdered(graph, host, field);
    this.notOwned(field, item);
    const pair = list.find((p) => p.value === item);
    if (pair === undefined) throw new Refused(`${item} is not in ${field} of ${host}`);
    if (!Number.isInteger(to) || to < 0 || to >= list.length) throw new Refused(`no place ${to} in a list of ${list.length}`);
    this.pairs = this.pairs.filter((p) => p !== pair);
    this.splice(list.filter((p) => p !== pair), to, pair);
  }

  removeItem(graph: GraphName, host: Id, field: string, item: Id): void {
    const pair = this.mustBeOrdered(graph, host, field).find((p) => p.value === item);
    if (pair === undefined) throw new Refused(`${item} is not in ${field} of ${host}`);
    this.pairs = this.pairs.filter((p) => p !== pair);
  }

  /** Put `pair` at place `at` of a list whose other pairs are `list`, in the array of pairs. */
  private splice(list: readonly PairRow[], at: number, pair: PairRow): void {
    const before = at < list.length ? this.pairs.indexOf(list[at]!) : list.length > 0 ? this.pairs.indexOf(list[list.length - 1]!) + 1 : this.pairs.length;
    this.pairs.splice(before, 0, pair);
  }

  private mustBeOrdered(graph: GraphName, host: Id, field: string): PairRow[] {
    const node = this.node(graph, host);
    if (node === undefined) return this.existence(graph, host);
    const def = this.inShape(node.kind, field);
    if (def.cardinality !== 'ordered') throw new Refused(`${field} is not an ordered field`);
    return this.pairsOf(graph, host, field);
  }

  /** A partitioning field: a node has at most one subject on the side that is climbed, and the relation has no cycle. Across all graphs. */
  private mustPartition(subject: Id, field: string, value: Id): void {
    if (this.holds(field, value).some((p) => p.subject !== subject)) throw new Refused(`${value} already has a ${field} subject`);
    const below = new Set<Id>();
    const walk = (id: Id): void => {
      if (below.has(id)) return;
      below.add(id);
      for (const p of this.pairs) if (p.field === field && p.subject === id) walk(p.value as Id);
    };
    walk(value);
    if (below.has(subject)) throw new Refused(`${subject} under ${value} through ${field} closes a cycle`);
  }

  tombstone(graph: GraphName, id: Id, at: string): void {
    const marker = this.schema.roles.tombstone;
    if (marker === undefined) throw new Refused('the schema assigns no tombstone marker');
    const node = this.node(graph, id);
    if (node === undefined) return this.existence(graph, id);
    if (this.field(node.kind, marker) === undefined) throw new Refused(`${node.kind} has no tombstone marker ${marker}`);
    if (this.pairsOf(graph, id, marker).length > 0) return; // already a tombstone: the first timestamp stays
    const containment = this.schema.roles.containment;
    const references = this.pairs.filter((p) => p.graph === graph && p.subject === id && this.field(node.kind, p.field)!.storage !== 'literal');
    this.pairs = this.pairs.filter((p) => !references.includes(p) && !(p.field === containment && p.value === id));
    for (const p of references) if (this.field(node.kind, p.field)!.storage === 'embed') this.drop(graph, p.value as Id);
    this.pairs.push({ graph, subject: id, field: marker, value: at });
  }

  /** A tombstone and its subtree over containment: all the members are checked before the first change, so a refusal changes nothing. */
  tombstoneSubtree(graph: GraphName, id: Id, at: string): void {
    const marker = this.schema.roles.tombstone;
    if (marker === undefined) throw new Refused('the schema assigns no tombstone marker');
    if (this.node(graph, id) === undefined) return this.existence(graph, id);
    const containment = this.schema.roles.containment;
    const subtree: Id[] = [];
    const stack: Id[] = [id];
    while (stack.length > 0) {
      const n = stack.pop()!;
      if (subtree.includes(n)) continue;
      subtree.push(n);
      if (containment !== undefined) for (const p of this.pairsOf(graph, n, containment).reverse()) if (this.node(graph, p.value as Id) !== undefined) stack.push(p.value as Id);
    }
    for (const n of subtree) {
      const kind = this.node(graph, n)!.kind;
      if (this.field(kind, marker) === undefined) throw new Refused(`${kind} has no tombstone marker ${marker}`);
    }
    for (const n of subtree) this.tombstone(graph, n, at);
  }

  /**
   * Delete outright every tombstone that the mark does not reach. The mark starts from the live nodes (marker unset) of the root
   * kinds and of the kinds below them, and follows the pairs of the followed fields in this graph; it goes through a tombstone it
   * reaches. The tombstones that are not marked are collected, then dropped one by one as `drop` drops a node. Gives their ids, sorted.
   */
  sweep(graph: GraphName): Id[] {
    this.mustHaveGraph(graph);
    const sweep = this.schema.roles.sweep;
    if (sweep === undefined) throw new Refused('the schema assigns no sweep');
    const marker = this.schema.roles.tombstone;
    if (marker === undefined) throw new Refused('the schema assigns no tombstone marker');
    const isTombstone = (n: NodeRow): boolean => this.pairsOf(graph, n.id, marker).length > 0;
    const marked = new Set<Id>();
    const work: Id[] = [];
    for (const n of this.nodes) {
      if (n.graph !== graph || isTombstone(n) || !sweep.roots.some((root) => this.isKindOrBelow(n.kind, root))) continue;
      marked.add(n.id);
      work.push(n.id);
    }
    while (work.length > 0) {
      const id = work.pop()!;
      for (const p of this.pairs) {
        if (p.graph !== graph || p.subject !== id || !sweep.follow.includes(p.field) || this.node(graph, p.value as Id) === undefined || marked.has(p.value as Id)) continue;
        marked.add(p.value as Id);
        work.push(p.value as Id);
      }
    }
    const doomed = this.nodes.filter((n) => n.graph === graph && isTombstone(n) && !marked.has(n.id)).map((n) => n.id).sort(byCodePoint);
    for (const id of doomed) this.drop(graph, id);
    return doomed;
  }

  createGraph(graph: GraphName): void {
    if (!oracleIsGraphName(graph)) throw new Refused(`${JSON.stringify(graph)} is not a graph name`);
    if (this.graphs.has(graph)) throw new Refused(`the graph ${graph} exists`);
    this.graphs.add(graph);
  }

  dropGraph(graph: GraphName): void {
    this.mustHaveGraph(graph);
    const inside = new Set(this.nodes.filter((n) => n.graph === graph).map((n) => n.id));
    const pointing = this.pairs.find((p) => p.graph !== graph && inside.has(p.value as Id) && this.fieldOf(p)?.storage !== 'literal');
    if (pointing !== undefined) throw new Refused(`${pointing.subject} in ${pointing.graph} points into ${graph} through ${pointing.field}`);
    this.nodes = this.nodes.filter((n) => n.graph !== graph);
    this.pairs = this.pairs.filter((p) => p.graph !== graph);
    this.graphs.delete(graph);
  }

  private fieldOf(pair: PairRow): FieldDef | undefined {
    const node = this.node(pair.graph, pair.subject);
    return node === undefined ? undefined : this.field(node.kind, pair.field);
  }

  // -- Persistence -----------------------------------------------------------------------------------------------

  build(graph: GraphName, record: BuildRecord): void {
    const nodes = this.nodes;
    const pairs = this.pairs;
    this.nodes = [...nodes];
    this.pairs = [...pairs];
    try {
      this.createNode(graph, record.id, record.kind);
      for (const [name, input] of Object.entries(record.fields) as [string, FieldInput][]) {
        if (this.field(record.kind, name)?.derived) continue; // an assertion by the shell, never a pair
        this.inShape(record.kind, name); // a field the kind does not declare is refused even with no value
        for (const value of Array.isArray(input) ? (input as readonly Value[]) : [input as Value]) this.addPair(graph, record.id, name, value);
      }
    } catch (e) {
      this.nodes = nodes;
      this.pairs = pairs;
      throw e;
    }
  }

  record(graph: GraphName, id: Id): NodeRecord | undefined {
    const node = this.node(graph, id);
    if (node === undefined) return undefined;
    const fields: { name: string; values: Value[] }[] = [];
    for (const f of this.schema.kinds.find((k) => k.name === node.kind)!.fields) {
      const values = this.values(graph, id, f.name);
      if (values.length > 0) fields.push({ name: f.name, values });
    }
    return { id, kind: node.kind, fields };
  }

  danglingRefs(graph: GraphName): Id[] {
    const missing = new Set<Id>();
    for (const p of this.pairs) {
      if (p.graph !== graph || this.fieldOf(p)?.storage === 'literal') continue;
      if (!this.defined(p.value as Id)) missing.add(p.value as Id);
    }
    return [...missing].sort(byCodePoint);
  }

  // -- Ports: Batch 14 -------------------------------------------------------------------------------------------

  setPortCap(_graph: GraphName, _field: string, _cap: number, _partitioningField: string): void {
    throw new NotBuilt('the ports are Batch 14');
  }

  portTree(_graph: GraphName, _bucket: Bucket): PortTreeRow[] {
    throw new NotBuilt('the ports are Batch 14');
  }

  capturePortView(_graph: GraphName, _bucket: Bucket): CapturedView {
    throw new NotBuilt('the ports are Batch 14');
  }

  readThroughView(_view: CapturedView, _bucket: Bucket): Id[] {
    throw new NotBuilt('the ports are Batch 14');
  }

  removePortView(_view: CapturedView): void {
    throw new NotBuilt('the ports are Batch 14');
  }
}
