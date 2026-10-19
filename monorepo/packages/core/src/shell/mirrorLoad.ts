// The load (planning/core.md, Batch 9 step 3; design/core.md, "A repeated `@id` at load", "A file whose `parent` and `children` disagree",
// "Containment in the file", "Persistence"): the shell builds the engine's graphs from the files of a mapping through the persistence API.
//   - One `createGraph` for each graph the mapping names, then one `build` for each document, in file order: the graph of a record is the
//     graph of the file it is read from (a document holds no `graph` field), its kind is the `@type`, a reference to a node not built yet
//     is accepted, and an embedded `Link` or `StringProp` is built as a node of its own, with the id it carries and the graph of its
//     owner; its id is the value of the owner's embed field.
//   - A repeated `@id`, at the top or embedded, across all the files together: every document that carries it is rejected, none is kept,
//     the id is reported, and the load goes on.
//   - `parent` and `children` are the file's two statements of one containment. `parent` wins: a node is put at the end of the `children`
//     of the container its `parent` names, and its entry in any other container is dropped, each with a warning that names both. A `parent`
//     that names no document that can hold the node leaves it with no container, and the id is returned among the dangling ones. A node
//     that a container lists and that has no `parent` stays in that container (the list is the source); the first container in file order
//     keeps it when several list it. The `parent` is never put in `fields`, as the engine skips a derived entry: it is read here only for this rule.
//   - What the engine refuses or leaves undecided for a document (a key outside the shape, a missing or doubled `one` field) is reported
//     with the id, the class of the error and the open point, by `problemOf` alone, so that the decision of the gate swaps in there.
//   - Once the graphs are built the load asks the engine for the ids referenced and never defined and returns them. What the shell does
//     with them is the service's (design/core.md, "The service lifecycle").
// A file that is absent is not an error (a fresh checkout has no `.state/`). A file that is not a JSON array stops the load: dumping
// over it afterwards would lose what it holds.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { compareIds } from '@aperas/core/apeironNgn/order';
import { DEFAULT_GRAPH, type BuildRecord, type Engine, type FieldInput, type GraphName, type Id, type Value } from '@aperas/core/apeironNgn/interface';
import { checkMapping, checkMappingKinds, graphsOf, type MirrorMapping } from './mirrorFiles';

/** A file of the mirror that cannot be read as an array of documents. */
export class MirrorFileError extends Error {
  readonly file: string;
  constructor(file: string, message: string) {
    super(`mirror file ${file}: ${message}`);
    this.name = 'MirrorFileError';
    this.file = file;
  }
}

/** A document or a file the load could not build, with what the engine said. */
export interface LoadProblem {
  /** The id of the document (or embedded entry), or the path of the file. */
  readonly subject: string;
  /** The class of the error: `Undecided`, `Refused`, or the name of another error. */
  readonly class: string;
  /** The open point, for an `Undecided` one. */
  readonly point?: string;
  readonly message: string;
}

/** An id carried by more than one document, and the files of the documents that carried it. */
export interface RejectedId {
  readonly id: Id;
  readonly files: readonly string[];
}

export interface LoadResult {
  /** The graphs the mapping names. */
  readonly graphs: readonly GraphName[];
  /** The documents built, and the embedded nodes built with them. */
  readonly documents: number;
  readonly embedded: number;
  readonly rejected: readonly RejectedId[];
  readonly warnings: readonly string[];
  readonly errors: readonly LoadProblem[];
  /** The ids referenced and never defined, sorted by code point: the engine's, and the `parent` that names no document. */
  readonly dangling: readonly Id[];
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The one place that turns an error of the engine for a document into a problem. Another sort of error is not the document's and is thrown on. */
export function problemOf(subject: string, error: unknown): LoadProblem {
  if (!(error instanceof Error)) throw error;
  const point = (error as { point?: unknown }).point;
  if (error.name !== 'Undecided' && error.name !== 'Refused') throw error;
  return { subject, class: error.name, ...(typeof point === 'string' ? { point } : {}), message: error.message };
}

/**
 * The engine at the start of the shell: the graphs of the mapping are created and the graph the engine starts with is dropped, unless
 * the mapping names it or it already holds a record.
 */
export function startGraphs(engine: Engine, graphs: readonly GraphName[]): string[] {
  const warnings: string[] = [];
  for (const graph of graphs) if (graph !== DEFAULT_GRAPH) engine.createGraph(graph);
  if (!graphs.includes(DEFAULT_GRAPH)) {
    if (engine.schema.kinds.some((k) => engine.idsOfKind(DEFAULT_GRAPH, k.name).length > 0)) warnings.push(`the graph ${DEFAULT_GRAPH} holds records and is not dropped`);
    else engine.dropGraph(DEFAULT_GRAPH);
  }
  return warnings;
}

interface Source {
  readonly graph: GraphName;
  readonly file: string;
  readonly fileKind: string;
  readonly doc: Json;
  readonly id: Id;
  readonly kind: string;
}

/** Every `@id` a value carries, the value's own and those of the entries nested in it, with repeats. */
function idsIn(value: unknown, into: string[]): void {
  if (Array.isArray(value)) for (const item of value) idsIn(item, into);
  else if (isObject(value)) {
    if (typeof value['@id'] === 'string') into.push(value['@id']);
    for (const [k, v] of Object.entries(value)) if (k !== '@id') idsIn(v, into);
  }
}

/** Reads the files of a mapping into the engine. */
export function loadMirror(engine: Engine, root: string, mapping: MirrorMapping): LoadResult {
  checkMapping(mapping);
  checkMappingKinds(engine.schema, mapping);
  const warnings: string[] = [];
  const errors: LoadProblem[] = [];

  // 1. The documents of every file that is there.
  const sources: Source[] = [];
  for (const { graph, kind: fileKind, file } of mapping) {
    const path = resolve(root, file);
    if (!existsSync(path)) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(readFileSync(path, 'utf8')); } catch (e) { throw new MirrorFileError(path, `not JSON (${(e as Error).message})`); }
    if (!Array.isArray(parsed)) throw new MirrorFileError(path, 'not a JSON array');
    parsed.forEach((doc, index) => {
      if (!isObject(doc) || typeof doc['@id'] !== 'string' || typeof doc['@type'] !== 'string') {
        errors.push({ subject: path, class: 'Refused', message: `the document at position ${index} has no @id and @type as strings` });
        return;
      }
      if (doc['@type'] !== fileKind) warnings.push(`${doc['@id']} is of the type ${doc['@type']} and stands in the file of ${fileKind} (${path})`);
      sources.push({ graph, file: path, fileKind, doc, id: doc['@id'], kind: doc['@type'] });
    });
  }

  // 2. A repeated @id, top-level or embedded, across all the files: every document that carries it is rejected.
  const carriers = new Map<Id, { count: number; at: Set<number> }>();
  sources.forEach((s, index) => {
    const ids: string[] = [];
    idsIn(s.doc, ids);
    for (const id of ids) {
      const seen = carriers.get(id) ?? { count: 0, at: new Set<number>() };
      carriers.set(id, seen);
      seen.count++;
      seen.at.add(index);
    }
  });
  const rejectedAt = new Set<number>();
  const rejected: RejectedId[] = [];
  for (const [id, { count, at }] of [...carriers].sort(([a], [b]) => compareIds(a, b))) {
    if (count < 2) continue;
    for (const index of at) rejectedAt.add(index);
    const files = [...new Set([...at].map((index) => sources[index]!.file))];
    rejected.push({ id, files });
    warnings.push(`the id ${id} is carried ${count} times (${[...at].map((index) => `${sources[index]!.id} in ${sources[index]!.file}`).join('; ')}): every document that carries it is rejected`);
  }
  const live = sources.filter((_, index) => !rejectedAt.has(index));

  // 3. Containment: the final `children` of each container, with `parent` winning.
  const containment = engine.schema.roles.containment;
  const derived = containment === undefined ? undefined : engine.schema.kinds.flatMap((k) => k.fields).find((f) => f.name === containment)?.reverse;
  const children = new Map<Id, Id[]>();
  const unplaced: Id[] = [];
  if (containment !== undefined && derived !== undefined) {
    resolveContainment(engine, containment, derived, live, children, warnings, unplaced);
  }

  // 4. The graphs, then the documents.
  const graphs = graphsOf(mapping);
  warnings.push(...startGraphs(engine, graphs));
  let documents = 0;
  let embedded = 0;
  const buildEntry = (graph: GraphName, entry: Json, extra: ((fields: Record<string, FieldInput>) => void) | undefined, top: boolean): void => {
    const id = entry['@id'] as string;
    const kind = entry['@type'];
    const fields: Record<string, FieldInput> = {};
    const queue: Json[] = [];
    const convert = (item: unknown): Value => {
      if (isObject(item) && typeof item['@id'] === 'string') { queue.push(item); return item['@id']; }
      return item as Value;
    };
    for (const [name, value] of Object.entries(entry)) {
      if (name === '@id' || name === '@type' || name === derived) continue;
      fields[name] = Array.isArray(value) ? value.map(convert) : convert(value);
    }
    extra?.(fields);
    try {
      engine.build(graph, { id, kind: kind as string, fields } satisfies BuildRecord);
    } catch (e) {
      errors.push(problemOf(id, e));
      return; // what it embeds is not built: there is no owner
    }
    if (top) documents++; else embedded++;
    for (const child of queue) {
      if (typeof child['@type'] !== 'string') { errors.push({ subject: child['@id'] as string, class: 'Refused', message: `the embedded entry has no @type as a string (owner ${id})` }); continue; }
      buildEntry(graph, child, undefined, false);
    }
  };
  for (const s of live) {
    buildEntry(s.graph, s.doc, containment === undefined ? undefined : (fields) => {
      const final = children.get(s.id);
      if (final !== undefined) fields[containment] = final;
    }, true);
  }

  // 5. The ids referenced and never defined.
  const dangling = new Set<Id>(unplaced);
  for (const graph of graphs) for (const id of engine.danglingRefs(graph)) dangling.add(id);
  return { graphs, documents, embedded, rejected, warnings, errors, dangling: [...dangling].sort(compareIds) };
}

/**
 * The containment of the documents: for each container, the `children` it will be built with. A node's container is the one its
 * `parent` names, when a document that can hold it stands there; with no `parent`, the first container that lists it. A container lists a
 * node only if it is that node's container: the entry in any other is dropped, and the node is appended to the container its `parent`
 * names if that one does not list it. Every change is a warning that names the node and both containers.
 */
function resolveContainment(engine: Engine, containment: string, derived: string, live: readonly Source[], children: Map<Id, Id[]>, warnings: string[], unplaced: Id[]): void {
  const holds = new Set(engine.schema.kinds.filter((k) => k.fields.some((f) => f.name === containment && !f.derived)).map((k) => k.name));
  const byId = new Map(live.map((s) => [s.id, s]));
  const canHold = (id: Id): boolean => {
    const s = byId.get(id);
    return s !== undefined && holds.has(s.kind);
  };
  // What each container lists, in order, as it stands in the file.
  const listed = new Map<Id, Id[]>();
  const listers = new Map<Id, Id[]>();
  for (const s of live) {
    if (!holds.has(s.kind)) continue;
    const list = s.doc[containment];
    if (!Array.isArray(list)) continue;
    listed.set(s.id, list.filter((x): x is string => typeof x === 'string'));
    for (const item of new Set(listed.get(s.id))) listers.set(item, [...(listers.get(item) ?? []), s.id]);
  }
  // The container of each node.
  const owner = new Map<Id, Id | null>();
  for (const s of live) {
    const claim = s.doc[derived];
    if (claim === undefined) continue;
    if (typeof claim !== 'string') { warnings.push(`the ${derived} of ${s.id} is not an id: it is ignored`); continue; }
    if (canHold(claim)) owner.set(s.id, claim);
    else {
      owner.set(s.id, null);
      if (!byId.has(claim)) unplaced.push(claim);
      warnings.push(`${s.id} names ${claim} as its ${derived}, and no document that can hold it stands there: ${s.id} has no container`);
    }
  }
  for (const [node, containers] of listers) {
    if (owner.has(node)) continue;
    owner.set(node, containers[0]!);
    if (containers.length > 1) warnings.push(`${node} is listed in the ${containment} of ${containers.join(' and ')} and has no ${derived}: it stays in ${containers[0]}`);
  }
  // Each container's final list.
  for (const [container, list] of listed) {
    const kept: Id[] = [];
    for (const item of list) {
      if (owner.get(item) !== container) {
        const to = owner.get(item);
        warnings.push(`${item} is listed in the ${containment} of ${container} but its ${derived} is ${to === null ? 'not a container' : (to ?? 'unstated')}: the entry is dropped`);
      } else if (kept.includes(item)) warnings.push(`${item} is listed twice in the ${containment} of ${container}: once is kept`);
      else kept.push(item);
    }
    children.set(container, kept);
  }
  // A node whose `parent` names a container that does not list it goes at the end of that container's list, in file order.
  for (const s of live) {
    const to = owner.get(s.id);
    if (to === undefined || to === null) continue;
    const list = children.get(to) ?? (holds.has(byId.get(to)!.kind) ? [] : undefined);
    if (list === undefined || list.includes(s.id)) continue;
    list.push(s.id);
    children.set(to, list);
    warnings.push(`${s.id} names ${to} as its ${derived}, which does not list it: ${s.id} is appended at the end of its ${containment}`);
  }
}
