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

/** `kg:path -- <path>`'s common case, not the full deep-path grammar (`resolveNodeRefDetail`) —
 *  an exact match on a `path` literal, same as `resolveArtifactOrFolderPrefix`'s single-segment
 *  case. Deep multi-segment/`.`/`..`/snowflake-code addressing is `kg:resolve`'s own migration,
 *  not duplicated here. */
export function findByExactPath(store: Store, path: string): string | null {
  const matches = store.match(null, predIri('path'), encodeLiteral(path), null);
  if (matches.length === 0) return null;
  return idFromNodeIri(String(matches[0].subject.value));
}

/** Accepts a full node id as-is, otherwise resolves as an exact artifact/folder `path`. */
export function resolveTreeRef(store: Store, ref: string): string | null {
  if (nodeKindFromId(ref) !== 'Unknown') return ref;
  return findByExactPath(store, ref);
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
