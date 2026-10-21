// The engine-side handle of the shell (planning/core.md, Batch 11 steps 1 and 2; design/core.md, "Existence", "Handles and names", "No set of live ids"):
// the engine, the maps of Batch 10, the mapping of the mirror's files, the graph list and the write layer, in one value; `openDb` makes it from a mirror
// on disk and `newDb` makes an empty one for tests. Beside it, the reads the shell makes of the engine that no engine operation gives alone:
//   - `graphOfId` and `nodeExists`: a node exists when a document stands for it (`graphOf(id) !== undefined`); a ghost, named only by the `children` of its
//     parent or by a pair, does not exist.
//   - `allIdsOfKind` and `liveIdsOfKind`: the ids of a kind over all the graphs of the mapping, sorted by id (the engine lists a graph in insertion order and
//     keeps no set of live ids); the live ones are those without the tombstone marker.
//   - `backlinksOf`: the subjects whose field holds a node, from every graph, sorted by id (the engine's `subjectsOf` names one graph).
//   - `isThreadScoped`: whether the node is in the threads graph, which a node is given at creation by its path (`graphOfPath.ts`).
// The shell runs on it (Batch 11, the flip). Settings, warnings and the problems of the load are returned and not printed: what the service does with
// `rejected` and `errors` is the service's; `loadRefusal` words the refusal.
import { join } from 'node:path';
import { createEngine } from '@aperas/core/apeironNgn/engine';
import type { Engine, GraphName, Id } from '@aperas/core/apeironNgn/interface';
import { compareIds } from '@aperas/core/apeironNgn/order';
import { DEFAULT_MAIN_FLUSH_MS, DEFAULT_STATE_FLUSH_MS, MAIN_GRAPH, STATE_DIRECTORY, THREADS_GRAPH, VIEWS_GRAPH, type GraphSettings } from '../graphConfig';
import { APERAS_SCHEMA } from './aperasSchema';
import { createLookups, type Duplicate, type Lookups } from './lookups';
import { createMirrorGraphs, graphsOf, mirrorMapping, type MirrorMapping } from './mirrorFiles';
import { loadMirror, type LoadResult } from './mirrorLoad';
import { createWriteLayer, type WriteLayer } from './writeLayer';

/** The handle: everything the shell holds of the graph in memory. */
export interface Db {
  readonly engine: Engine;
  readonly maps: Lookups;
  /** The files of the mirror. A relative file is taken from the root a dump or a load is given. */
  readonly mapping: MirrorMapping;
  /** The settings the mapping was made from: the directory and the flush interval of each graph. */
  readonly settings: readonly GraphSettings[];
  /** The graphs of the mapping, in the order it names them. */
  readonly graphs: readonly GraphName[];
  /** The writes of the engine that the shell makes, each telling the maps. */
  readonly write: WriteLayer;
}

/** The settings of a mirror at `root` with today's layout: the main graph at `root`, the other two under its `.state/`, and today's intervals. */
export function defaultSettings(root: string): GraphSettings[] {
  const state = join(root, STATE_DIRECTORY);
  return [
    { graph: MAIN_GRAPH, directory: root, flushIntervalMs: DEFAULT_MAIN_FLUSH_MS },
    { graph: THREADS_GRAPH, directory: state, flushIntervalMs: DEFAULT_STATE_FLUSH_MS },
    { graph: VIEWS_GRAPH, directory: state, flushIntervalMs: DEFAULT_STATE_FLUSH_MS },
  ];
}

function handle(engine: Engine, settings: readonly GraphSettings[]): Db {
  const mapping = mirrorMapping(settings);
  const maps = createLookups(engine, graphsOf(mapping));
  return { engine, maps, mapping, settings, graphs: graphsOf(mapping), write: createWriteLayer(engine, maps) };
}

/** What `openDb` gives besides the handle. */
export interface Opened {
  readonly db: Db;
  /** The load's result: `rejected` and `errors` are the caller's to act on. */
  readonly load: LoadResult;
  /** Every warning to print once: the load's, then one for each key held by more than one live node. */
  readonly warnings: readonly string[];
  /** The keys held by more than one live node, as the maps give them. */
  readonly duplicates: readonly Duplicate[];
}

/** The refusal a load that did not read the mirror in full deserves, naming the files and ids; nothing when it read every document. A flush after such a load would write each file whole and remove what was skipped. */
export function loadRefusal(load: LoadResult): string | undefined {
  const parts: string[] = [];
  if (load.rejected.length > 0) parts.push(`${load.rejected.length} id(s) carried by more than one document, none kept: ${load.rejected.map((r) => `${r.id} (${r.files.join(', ')})`).join('; ')}`);
  if (load.errors.length > 0) parts.push(`${load.errors.length} document(s) the engine refused: ${load.errors.map((e) => `${e.subject} (${e.class}${e.point !== undefined ? ` on ${e.point}` : ''}: ${e.message})`).join('; ')}`);
  return parts.length > 0 ? `the mirror was not read in full — ${parts.join(' — ')}` : undefined;
}

const warningOfDuplicate = (d: Duplicate): string => `the ${d.map} ${JSON.stringify(d.key)} is held by ${d.ids.length} live nodes (${d.ids.join(', ')}): a lookup answers the first`;

/**
 * Opens the mirror at `root`: the engine under the Aperas schema, the files of the mapping loaded (`settings` default to today's layout under `root`;
 * the service passes the table of `resolveGraphSettings`), the maps built. The caller reads `load.rejected` and `load.errors`; `warnings` holds the
 * load's and one for each duplicated key.
 */
export function openDb(root: string, settings: readonly GraphSettings[] = defaultSettings(root)): Opened {
  const db = handle(createEngine(APERAS_SCHEMA), settings);
  const load = loadMirror(db.engine, root, db.mapping);
  const duplicates = db.maps.rebuild();
  return { db, load, warnings: [...load.warnings, ...duplicates.map(warningOfDuplicate)], duplicates };
}

/** An empty handle for tests: the three graphs made, the mapping with relative directories (`Apeiron/`, `Apeiron/.state/`) for any root a test dumps to. */
export function newDb(): Db {
  const engine = createEngine(APERAS_SCHEMA);
  createMirrorGraphs(engine);
  const db = handle(engine, [
    { graph: MAIN_GRAPH, directory: 'Apeiron', flushIntervalMs: DEFAULT_MAIN_FLUSH_MS },
    { graph: THREADS_GRAPH, directory: `Apeiron/${STATE_DIRECTORY}`, flushIntervalMs: DEFAULT_STATE_FLUSH_MS },
    { graph: VIEWS_GRAPH, directory: `Apeiron/${STATE_DIRECTORY}`, flushIntervalMs: DEFAULT_STATE_FLUSH_MS },
  ]);
  db.maps.rebuild();
  return db;
}

/** The graph whose record has the id, or nothing. */
export function graphOfId(db: Db, id: Id): GraphName | undefined {
  return db.engine.graphOf(id);
}

/** Whether a node exists: a document stands for it. A ghost does not. */
export function nodeExists(db: Db, id: Id): boolean {
  return graphOfId(db, id) !== undefined;
}

/** The ids of a kind in every graph of the mapping, sorted by id. */
export function allIdsOfKind(db: Db, kind: string): Id[] {
  return db.graphs.flatMap((graph) => db.engine.idsOfKind(graph, kind)).sort(compareIds);
}

/** The ids of a kind that are not tombstones, sorted by id. A kind with no tombstone marker has only live nodes. */
export function liveIdsOfKind(db: Db, kind: string): Id[] {
  const marker = db.engine.schema.roles.tombstone;
  return db.graphs
    .flatMap((graph) => db.engine.idsOfKind(graph, kind).filter((id) => marker === undefined || db.engine.first(graph, id, marker) === undefined))
    .sort(compareIds);
}

/** The subjects, in every graph, whose reference or embed field `field` holds `id`, sorted by id. */
export function backlinksOf(db: Db, id: Id, field: string): Id[] {
  return db.graphs.flatMap((graph) => db.engine.subjectsOf(graph, field, id)).sort(compareIds);
}

/** Whether a node is thread-scoped: it is in the threads graph, as a node under `.threads/` is given at creation. */
export function isThreadScoped(db: Db, id: Id): boolean {
  return graphOfId(db, id) === THREADS_GRAPH;
}
