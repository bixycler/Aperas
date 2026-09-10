/**
 * Store-wide helpers `kg:tree`/`kg:path`/others use to find a *starting* node — not itself a
 * node's own behavior, so these stay free functions (Aperas-apeironngn-design.md §4 rollout step
 * 3's classification: "a function folds onto a class only when a single already-identified node
 * is a natural `this` for it"). The recursive tree-render engine that used to live here folded
 * onto `TreeNode.renderTree` (`node.ts`) once `treeChildren` made it kind-generic.
 */

import type { Store } from 'oxigraph';
import { predIri, encodeLiteral, idFromNodeIri, nodeKindFromId } from './vocab';
import type { TreeView } from './node';

/** An exact match on a stored `path` literal — only ever true for an `ArtifactNode`/`FolderNode`
 *  itself (a `BlockNode`'s path is never stored, only computed on demand by `TreeNode.toPath()`).
 *  Used internally as a building block (anchoring at the root `FolderNode`, checking how much of a
 *  `--create-holder` prefix chain already exists) by `resolve.ts`/`resolveCreate.ts`'s real deep-path
 *  grammar — `kg:tree`/`kg:path`'s own public ref resolution is `resolveDeepPath` (`resolve.ts`),
 *  not this function directly. */
export function findByExactPath(store: Store, path: string): string | null {
  const matches = store.match(null, predIri('path'), encodeLiteral(path), null);
  if (matches.length === 0) return null;
  return idFromNodeIri(String(matches[0].subject.value));
}

export function displayLabel(id: string, node: any): string {
  const kind = nodeKindFromId(id);
  return kind === 'BlockNode' ? (node.type as string) : kind;
}

/** `view` replaces the old `unfoldedMode` boolean (Aperas-treeview-design.md §5): supplying a
 *  `TreeView` drives unfolded-mode rendering keyed off that view's `unfolds` set; omitting it
 *  keeps the plain title-only, no-expand/collapse-simulation default. */
export interface TreeOptions {
  maxDepth?: number;
  noHolders?: boolean;
  view?: TreeView;
}
