// The dump (planning/core.md, Batch 9 steps 1 and 5; design/core.md, "Format", "Orders in the mirror", "A flush is a dump"): the shell reads the
// records of each kind of each graph out of the engine through its persistence API, serializes them and rebuilds nothing from pairs. A
// document lists `@id`, `@type` and the kind's fields in the order the schema declares them; a field that is unset or an empty set is left
// out, except the containment field, which is always written, as an empty array when empty; the documents of a file, the embedded entries
// of a set field and the values of a reference set are in id order by code point (`compareIds`, never `localeCompare`); a value is written
// as it was read. Which file holds the records of a graph and a kind is the mapping the caller passes in (`mirrorFiles.ts`).
// Only the service writes the mirror and a flush rewrites a whole file; when it runs, and the guard against a file that changed on
// disk, are the service's. This file decides neither.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { compareIds } from '@aperas/core/apeironNgn/order';
import type { Engine, GraphName, Id, Value } from '@aperas/core/apeironNgn/interface';
import type { FieldDef, KindDef } from '@aperas/core/apeironNgn/schema';
import { checkMapping, checkMappingKinds, documentsText, graphsOf, type MirrorFile, type MirrorMapping } from './mirrorFiles';

/** A document of the mirror, as JSON: `@id` and `@type` first, then the fields in the schema's order. */
export type MirrorDocument = Record<string, unknown>;

/** What one file of a dump holds. */
export interface DumpedFile {
  readonly graph: GraphName;
  readonly kind: string;
  /** The path written, resolved from the root. */
  readonly path: string;
  readonly documents: number;
}

/** Literal values of a set: by the name of their type and then by value, a plain comparison (a set of literals does not occur in the Aperas schema). */
function compareLiterals(a: Value, b: Value): number {
  if (typeof a !== typeof b) return typeof a < typeof b ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Reads documents out of one engine. Built for an engine and the graphs of a mapping, once, so that the kind definitions and the
 * reverse of each derived entry are looked up once.
 */
class Reader {
  private readonly engine: Engine;
  private readonly graphs: readonly GraphName[];
  private readonly kinds: ReadonlyMap<string, KindDef>;
  /** For each derived entry, the field of which it is the reverse side (`parent` of `children`). */
  private readonly reverseOf = new Map<string, string>();

  constructor(engine: Engine, graphs: readonly GraphName[]) {
    this.engine = engine;
    this.graphs = graphs;
    this.kinds = new Map(engine.schema.kinds.map((k) => [k.name, k]));
    for (const k of engine.schema.kinds) for (const f of k.fields) if (f.reverse !== undefined) this.reverseOf.set(f.reverse, f.name);
  }

  /** The document of a node, with the embedded nodes it owns written inline; nothing for an id with no record in the graph. */
  document(graph: GraphName, id: Id): MirrorDocument | undefined {
    const record = this.engine.record(graph, id);
    if (record === undefined) return undefined;
    const kind = this.kinds.get(record.kind)!;
    const held = new Map(record.fields.map((f) => [f.name, f.values]));
    const doc: MirrorDocument = { '@id': id, '@type': record.kind };
    for (const field of kind.fields) {
      const values = held.get(field.name) ?? (field.derived ? this.derivedAcrossGraphs(graph, id, field) : []);
      const written = this.write(graph, field, values);
      if (written !== undefined) doc[field.name] = written;
    }
    return doc;
  }

  /**
   * The derived entry of a node whose container is in another graph. A read that gives a node's relations is filtered to the graph it
   * names, so the record of the `.threads` folder in the threads graph holds no `parent`, while the root folder in the main graph lists
   * it in its `children` (design/core.md, "A reference across graphs"). The document states the containment twice, so the dump bridges
   * the difference: it asks the other graphs of the mapping for the container. Nothing when no graph, or more than one, holds one.
   */
  private derivedAcrossGraphs(graph: GraphName, id: Id, field: FieldDef): Value[] {
    const owner = this.reverseOf.get(field.name);
    if (owner === undefined) return [];
    const containers: Id[] = [];
    for (const other of this.graphs) if (other !== graph) containers.push(...this.engine.subjectsOf(other, owner, id));
    return containers.length === 1 ? [containers[0]!] : [];
  }

  /** The value of one field as the document writes it, or nothing when the document leaves the field out. */
  private write(graph: GraphName, field: FieldDef, values: readonly Value[]): unknown {
    const containment = this.engine.schema.roles.containment;
    if (field.name === containment && field.storage !== 'literal' && !field.derived) return [...values];
    if (values.length === 0) return undefined;
    if (field.storage === 'embed') {
      const ids = [...(values as readonly Id[])].sort(compareIds);
      // An embedded node with no record cannot be written inline; its id stands, as the owner holds it.
      return ids.map((id) => this.document(graph, id) ?? id);
    }
    if (field.cardinality === 'one' || field.cardinality === 'optional') return values[0];
    if (field.cardinality === 'ordered') return [...values];
    return field.storage === 'literal' ? [...values].sort(compareLiterals) : [...(values as readonly Id[])].sort(compareIds);
  }
}

/** The document of one node, as the dump writes it (`kg:show` prints it): nothing for an id with no record in the graph. `graphs` are the graphs of the mapping. */
export function documentOf(engine: Engine, graph: GraphName, id: Id, graphs: readonly GraphName[] = [graph]): MirrorDocument | undefined {
  return new Reader(engine, graphs).document(graph, id);
}

/** The documents of one kind in one graph, sorted by `@id` by code point. */
export function dumpDocuments(engine: Engine, graph: GraphName, kind: string, graphs: readonly GraphName[] = [graph]): MirrorDocument[] {
  const reader = new Reader(engine, graphs);
  return engine.idsOfKind(graph, kind).sort(compareIds).map((id) => reader.document(graph, id)!);
}

/** The text of the file of one kind in one graph. */
export function dumpText(engine: Engine, graph: GraphName, kind: string, graphs: readonly GraphName[] = [graph]): string {
  return documentsText(dumpDocuments(engine, graph, kind, graphs));
}

/**
 * Writes every file of the mapping, whole, under `root` (a relative file is taken from it): the file for a graph and kind holds the records
 * of that kind in that graph, and a file with no record holds an empty array. The directory of a file is made when it is not there.
 * Nothing is read back and nothing is decided about when to write.
 */
export function dumpMirror(engine: Engine, root: string, mapping: MirrorMapping, select: (file: MirrorFile) => boolean = () => true): DumpedFile[] {
  checkMapping(mapping);
  checkMappingKinds(engine.schema, mapping);
  const graphs = graphsOf(mapping);
  const written: DumpedFile[] = [];
  for (const entry of mapping) {
    if (!select(entry)) continue; // the whole mapping is still the graphs a document is read across: a node may have its container in a graph whose files are not written now
    const { graph, kind, file } = entry;
    const documents = dumpDocuments(engine, graph, kind, graphs);
    const path = resolve(root, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, documentsText(documents));
    written.push({ graph, kind, path, documents: documents.length });
  }
  return written;
}
