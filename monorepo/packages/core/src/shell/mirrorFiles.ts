// The files of the mirror (design/core.md, "Files" and "Format"): one JSON array for each kind and graph, the text of a file, and the
// mapping from a graph and a kind to a file, which the dump and the load take as an argument. The mapping is data: which file holds
// the records of a graph and a kind follows from the shell's table of settings (`graphConfig.ts`, "Addressing"), through `mirrorMapping`
// below; the rest of this file says what a mapping is, checks one, gives the file names and the text of a file that `kgInit.ts` writes
// a second time, and creates the shell's three graphs.
import { join, resolve } from 'node:path';
import { isGraphName } from '@aperas/core/apeironNgn/graphName';
import { DEFAULT_GRAPH, type Engine, type GraphName } from '@aperas/core/apeironNgn/interface';
import type { Schema } from '@aperas/core/apeironNgn/schema';
import { MAIN_GRAPH, MIRROR_GRAPHS, THREADS_GRAPH, VIEWS_GRAPH, type GraphSettings } from '../graphConfig';

export { MAIN_GRAPH, MIRROR_GRAPHS, THREADS_GRAPH, VIEWS_GRAPH };

/** The kinds each graph holds, in the order of the files of a mapping (design/core.md, "Written by graph and kind"). */
export const KINDS_OF_GRAPH: Readonly<Record<string, readonly string[]>> = {
  [MAIN_GRAPH]: ['ArtifactNode', 'FolderNode', 'BlockNode', 'Profile'],
  [THREADS_GRAPH]: ['ArtifactNode', 'FolderNode', 'BlockNode'],
  [VIEWS_GRAPH]: ['TreeView'],
};

/** One file of the mirror: it holds the records of one kind in one graph. `file` is a path; a relative one is taken from the mirror's root. */
export interface MirrorFile {
  readonly graph: GraphName;
  readonly kind: string;
  readonly file: string;
}

/** The files of a mirror, in the order they are read and written. A graph and a kind name one file, and a file one graph and kind. */
export type MirrorMapping = readonly MirrorFile[];

/** The name of the file of a kind inside its directory. */
export const fileNameOfKind = (kind: string): string => `${kind}.jsonld`;

/** The text of a file: the documents as a JSON array indented by two spaces, ending with a newline. */
export const documentsText = (documents: readonly unknown[]): string => JSON.stringify(documents, null, 2) + '\n';

/** The text of a file that holds no document. */
export const EMPTY_FILE_TEXT: string = documentsText([]);

/** The graphs a mapping names, each once, in the order it first names them. */
export function graphsOf(mapping: MirrorMapping): GraphName[] {
  return [...new Set(mapping.map((m) => m.graph))];
}

/** The file of a graph and a kind, or nothing when the mapping holds none. */
export function fileOf(mapping: MirrorMapping, graph: GraphName, kind: string): string | undefined {
  return mapping.find((m) => m.graph === graph && m.kind === kind)?.file;
}

/**
 * A mapping that cannot be a mirror is refused: a graph whose name fails the grammar, a graph and kind named twice, a file named
 * twice (two records of different graphs or kinds would be written one over the other).
 */
export function checkMapping(mapping: MirrorMapping): void {
  const pairs = new Set<string>();
  const files = new Set<string>();
  for (const { graph, kind, file } of mapping) {
    if (!isGraphName(graph)) throw new Error(`mirror mapping: ${JSON.stringify(graph)} is not a graph name`);
    if (typeof kind !== 'string' || kind === '' || typeof file !== 'string' || file === '') throw new Error(`mirror mapping: an entry for ${graph} needs a kind and a file`);
    const pair = JSON.stringify([graph, kind]);
    if (pairs.has(pair)) throw new Error(`mirror mapping: the graph ${graph} and the kind ${kind} are named twice`);
    if (files.has(resolve(file))) throw new Error(`mirror mapping: the file ${file} is named twice`);
    pairs.add(pair);
    files.add(resolve(file));
  }
}

/**
 * A mapping checked against the schema: every kind is one the schema declares and none is embedded in another (`Link` and `StringProp`
 * have no file; they are written inside the document of their owner).
 */
export function checkMappingKinds(schema: Schema, mapping: MirrorMapping): void {
  const embedded = new Set(schema.kinds.flatMap((k) => k.fields.flatMap((f) => (f.embeds === undefined ? [] : [f.embeds]))));
  for (const { graph, kind } of mapping) {
    if (!schema.kinds.some((k) => k.name === kind)) throw new Error(`mirror mapping: ${kind} (graph ${graph}) is not a kind of the schema`);
    if (embedded.has(kind)) throw new Error(`mirror mapping: ${kind} (graph ${graph}) is embedded in the document of its owner and has no file`);
  }
}

/**
 * The mapping made from the table of settings: for each of the three graphs, in order, and each kind it holds, the file `<the graph's
 * directory>/<kind>.jsonld`. The file is a function of the graph alone. Two graphs given one directory share kinds and so a file name,
 * which `checkMapping` refuses.
 */
export function mirrorMapping(settings: readonly GraphSettings[]): MirrorMapping {
  return MIRROR_GRAPHS.flatMap((graph) => {
    const found = settings.find((s) => s.graph === graph);
    if (found === undefined) throw new Error(`mirror mapping: the settings hold no entry for the graph ${graph}`);
    return KINDS_OF_GRAPH[graph]!.map((kind) => ({ graph, kind, file: join(found.directory, fileNameOfKind(kind)) }));
  });
}

/**
 * Creates `tree`, `threads.tree` and `treeviews`, in that order, on a fresh engine, and drops `default` (the engine's own first graph),
 * unless it already holds a record. Gives the warnings. The load creates the graphs of the mapping it is given in the same way
 * (`startGraphs` in `mirrorLoad.ts`), so an engine that is to be loaded is not given them first.
 */
export function createMirrorGraphs(engine: Engine): string[] {
  const warnings: string[] = [];
  for (const graph of MIRROR_GRAPHS) engine.createGraph(graph);
  if (engine.schema.kinds.some((k) => engine.idsOfKind(DEFAULT_GRAPH, k.name).length > 0)) warnings.push(`the graph ${DEFAULT_GRAPH} holds records and is not dropped`);
  else engine.dropGraph(DEFAULT_GRAPH);
  return warnings;
}
