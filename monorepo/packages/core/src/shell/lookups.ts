// The shell's maps of a literal value (planning/core.md, Batch 10; design/core.md, "Lookups by a literal value", "Handles and names", "How a path
// names one node"): a profile by its `handle`, a view by its `name`, and an artifact or a folder by its stored `path`. The engine keeps none of them
// ("Literal fields are properties of the record"); the shell adds them over the engine's reads, `idsOfKind` and `record`.
//   - Only a live node is in a map: the pass that builds them drops a node whose tombstone marker is set, so a tombstone, which keeps its stored `path`,
//     is not found by it, and the answer for a path does not depend on the order in which two nodes came to hold it (the primitive `liveAtPath`).
//   - The `name` field is shared by a profile and a view, so the map of views is over `TreeView` alone: the lookup does not filter a kind, the map does.
//   - A key held by more than one live node answers the first holder in `compareIds` order, and `duplicates` lists the keys with more than one holder,
//     for the load to warn about. The real mirror has none.
//   - The path map is one over all the graphs it was made for (the paths of `tree` and `threads.tree` are one namespace); a lookup may name a graph.
//   - The key of the path map is made in one place, `pathKeyOf`, so that Batch 16 changes it to the derived path and nothing else moves.
// The maps are rebuilt by `rebuild` (the load's) and kept by one function for each write that changes them. Nothing here writes to the engine, and
// each update is made after the engine accepted its write: it reads the engine for the state of the node and does not trust the call, so a call for a
// write the engine did not take leaves the map as the engine is. Nothing calls an update before Batch 11: the shell has no write layer yet.
import { compareIds } from '@aperas/core/apeironNgn/order';
import type { Engine, GraphName, Id, NodeRecord } from '@aperas/core/apeironNgn/interface';

/** The kinds the maps hold, and the literal field each is keyed by. */
export const PROFILE_KIND = 'Profile';
export const VIEW_KIND = 'TreeView';
export const PATH_KINDS: readonly string[] = ['ArtifactNode', 'FolderNode'];
const HANDLE_FIELD = 'handle';
const NAME_FIELD = 'name';
const PATH_FIELD = 'path';

/** The one place that gives the key of a node in the path map: the stored `path` of its record. Batch 16 derives it from the parent chain instead. */
export function pathKeyOf(record: NodeRecord): string | undefined {
  return literalOf(record, PATH_FIELD);
}

function literalOf(record: NodeRecord, field: string): string | undefined {
  const value = record.fields.find((f) => f.name === field)?.values[0];
  return typeof value === 'string' ? value : undefined;
}

export type MapName = 'handle' | 'name' | 'path';

/** A key held by more than one live node: the map, the key and every holder, by `compareIds`. */
export interface Duplicate {
  readonly map: MapName;
  readonly key: string;
  readonly ids: readonly Id[];
}

/** What a lookup by path may be limited to: the graph the node is in, and its kind (a path is a file or a directory, never both). */
export interface PathFilter {
  readonly graph?: GraphName;
  readonly kind?: string;
}

/** A key to the live ids that hold it, each list sorted by `compareIds`. */
class Holders {
  private readonly byKey = new Map<string, Id[]>();

  add(key: string, id: Id): void {
    const list = this.byKey.get(key);
    if (list === undefined) { this.byKey.set(key, [id]); return; }
    let at = list.length;
    while (at > 0 && compareIds(list[at - 1]!, id) > 0) at -= 1;
    if (list[at - 1] !== id) list.splice(at, 0, id);
  }

  delete(key: string, id: Id): void {
    const list = this.byKey.get(key);
    if (list === undefined) return;
    const at = list.indexOf(id);
    if (at >= 0) list.splice(at, 1);
    if (list.length === 0) this.byKey.delete(key);
  }

  clear(): void {
    this.byKey.clear();
  }

  /** The first holder, in `compareIds` order, that the test accepts. */
  first(key: string, accept: (id: Id) => boolean = () => true): Id | undefined {
    return this.byKey.get(key)?.find(accept);
  }

  /** The keys with more than one holder, by code point. */
  many(map: MapName): Duplicate[] {
    return [...this.byKey.entries()]
      .filter(([, ids]) => ids.length > 1)
      .sort(([a], [b]) => compareIds(a, b))
      .map(([key, ids]) => ({ map, key, ids: [...ids] }));
  }

  /** The number of ids held, counting a key's every holder. */
  get count(): number {
    let n = 0;
    for (const ids of this.byKey.values()) n += ids.length;
    return n;
  }
}

/** What a node is filed under: where it lives, its kind, and its keys. */
interface Filed {
  readonly graph: GraphName;
  readonly kind: string;
  readonly handle?: string;
  readonly name?: string;
  readonly path?: string;
}

/** The maps, over an engine and the graphs of a mapping. */
export interface Lookups {
  /** The live profile with this handle: the first in `compareIds` order when several hold it. */
  profileByHandle(handle: string): Id | undefined;
  /** The live view with this name. A profile with the same `name` is not a view and is not found. */
  viewByName(name: string): Id | undefined;
  /** The live artifact or folder with this stored path, whatever order the nodes came to hold it in; the graph and the kind are optional filters. */
  liveAtPath(path: string, filter?: PathFilter): Id | undefined;
  /** The keys with more than one live holder, in each map: by map (`handle`, `name`, `path`), then by key. */
  duplicates(): Duplicate[];
  /** The number of live nodes each map holds. */
  size(): { readonly profiles: number; readonly views: number; readonly paths: number };

  /** The load's: forget every entry and make the maps again from the graphs, in one pass over each of the four kinds. Gives the duplicates. */
  rebuild(): Duplicate[];

  /** After `build` of a node (a profile, a view, an artifact or a folder; any other kind is ignored). */
  built(graph: GraphName, id: Id): void;
  /** After a write or a clear of a field of a node, or the removal of a pair: only `handle`, `name`, `path` and the tombstone marker change a map. */
  fieldWritten(graph: GraphName, id: Id, field: string): void;
  /** After `tombstone` of a node. */
  tombstoned(graph: GraphName, id: Id): void;
  /** After `tombstoneSubtree`: the nodes of the subtree leave the containment, so they are found by their marker and not by a walk from the root. */
  subtreeTombstoned(graph: GraphName): void;
  /** After `removeNode`. */
  removed(graph: GraphName, id: Id): void;
  /** After `sweep`, with the ids it returned. */
  swept(graph: GraphName, ids: readonly Id[]): void;
  /** After `dropGraph`. */
  graphDropped(graph: GraphName): void;
}

/**
 * The maps over `engine`, for the graphs of a mapping (they must exist in the engine). Made empty; `rebuild` fills them. The kinds and the fields
 * are the shell's own (the Aperas schema), the tombstone marker is the engine's role.
 */
export function createLookups(engine: Engine, graphs: readonly GraphName[]): Lookups {
  const marker = engine.schema.roles.tombstone;
  const profiles = new Holders();
  const views = new Holders();
  const paths = new Holders();
  const filed = new Map<Id, Filed>();
  const watched = new Set<string>([HANDLE_FIELD, NAME_FIELD, PATH_FIELD, ...(marker !== undefined ? [marker] : [])]);

  const drop = (id: Id): void => {
    const was = filed.get(id);
    if (was === undefined) return;
    filed.delete(id);
    if (was.handle !== undefined) profiles.delete(was.handle, id);
    if (was.name !== undefined) views.delete(was.name, id);
    if (was.path !== undefined) paths.delete(was.path, id);
  };

  /** Files the node as the engine holds it now: not at all when it has no record, is not of a kind of a map, or is tombstoned. */
  const sync = (graph: GraphName, id: Id): void => {
    drop(id);
    const record = engine.record(graph, id);
    if (record === undefined) return;
    const { kind } = record;
    if (kind !== PROFILE_KIND && kind !== VIEW_KIND && !PATH_KINDS.includes(kind)) return;
    if (marker !== undefined && record.fields.some((f) => f.name === marker && f.values.length > 0)) return;
    const handle = kind === PROFILE_KIND ? literalOf(record, HANDLE_FIELD) : undefined;
    const name = kind === VIEW_KIND ? literalOf(record, NAME_FIELD) : undefined;
    const path = PATH_KINDS.includes(kind) ? pathKeyOf(record) : undefined;
    filed.set(id, { graph, kind, ...(handle !== undefined ? { handle } : {}), ...(name !== undefined ? { name } : {}), ...(path !== undefined ? { path } : {}) });
    if (handle !== undefined) profiles.add(handle, id);
    if (name !== undefined) views.add(name, id);
    if (path !== undefined) paths.add(path, id);
  };

  const duplicates = (): Duplicate[] => [...profiles.many('handle'), ...views.many('name'), ...paths.many('path')];

  return {
    profileByHandle: (handle) => profiles.first(handle),
    viewByName: (name) => views.first(name),
    liveAtPath: (path, filter = {}) => paths.first(path, (id) => {
      const at = filed.get(id)!;
      return (filter.graph === undefined || at.graph === filter.graph) && (filter.kind === undefined || at.kind === filter.kind);
    }),
    duplicates,
    size: () => ({ profiles: profiles.count, views: views.count, paths: paths.count }),

    rebuild() {
      profiles.clear(); views.clear(); paths.clear(); filed.clear();
      for (const graph of graphs) for (const kind of [PROFILE_KIND, VIEW_KIND, ...PATH_KINDS]) for (const id of engine.idsOfKind(graph, kind)) sync(graph, id);
      return duplicates();
    },

    built: sync,
    fieldWritten(graph, id, field) {
      if (watched.has(field)) sync(graph, id);
    },
    tombstoned: sync,
    subtreeTombstoned(graph) {
      for (const [id, at] of [...filed]) if (at.graph === graph) sync(graph, id);
    },
    removed: sync,
    swept(graph, ids) {
      for (const id of ids) sync(graph, id);
    },
    graphDropped(graph) {
      for (const [id, at] of [...filed]) if (at.graph === graph) drop(id);
    },
  };
}
