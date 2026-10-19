// The graph a new node takes (planning/core.md, Batch 9 step 2; design/core.md, "Written by graph and kind"): a rule over the engine's reads,
// where `threadScope.ts` walks raw quads. A profile is in the main graph and a view in the graph of the views; an artifact or a folder is in
// the threads graph when its path, the file system's own, is `.threads` or lies under `.threads/`, and in the main graph otherwise; a block
// (and a link or a property that a node owns) takes the graph of the node it is built under. The stored `path` of a node is not read: the
// caller gives the path the node has on disk, because the stored one goes in Batch 16. Nothing here creates a node and nothing calls it yet,
// as the shell has no creation path before Batch 11; `threadScope.ts` stays for the reference copy.
import type { Engine, GraphName, Id } from '@aperas/core/apeironNgn/interface';
import { MAIN_GRAPH, THREADS_GRAPH, VIEWS_GRAPH } from '../graphConfig';

/** The folder at the root of the tree that holds the threads. */
export const THREADS_FOLDER = '.threads';

/** Whether a path, from the root of the tree, is the threads folder or lies under it: `a.threads`, `.threadsx` and `a/.threads/b` are not. */
export function isThreadsPath(path: string): boolean {
  const normal = path.replace(/\\/g, '/').replace(/^(\.\/)+/, '');
  return normal === THREADS_FOLDER || normal.startsWith(`${THREADS_FOLDER}/`);
}

/** A node about to be created: its kind, its path on disk when it is an artifact or a folder, and the node it is built under when it is not. */
export interface NewNode {
  readonly kind: string;
  /** The path of an artifact or a folder, from the root of the tree. */
  readonly path?: string;
  /** The container of a block, or the owner of a link or a property. */
  readonly under?: Id;
}

/** The graph a new node takes. An error for a node whose graph the rule cannot give: a path or a container it needs and was not given. */
export function graphOfNewNode(engine: Pick<Engine, 'graphOf'>, node: NewNode): GraphName {
  switch (node.kind) {
    case 'Profile':
      return MAIN_GRAPH;
    case 'TreeView':
      return VIEWS_GRAPH;
    case 'ArtifactNode':
    case 'FolderNode':
      if (node.path === undefined) throw new Error(`the graph of a new ${node.kind} needs its path`);
      return isThreadsPath(node.path) ? THREADS_GRAPH : MAIN_GRAPH;
    default: {
      if (node.under === undefined) throw new Error(`the graph of a new ${node.kind} needs the node it is built under`);
      const graph = engine.graphOf(node.under);
      if (graph === undefined) throw new Error(`the graph of a new ${node.kind} is the graph of ${node.under}, which is in no graph`);
      return graph;
    }
  }
}
