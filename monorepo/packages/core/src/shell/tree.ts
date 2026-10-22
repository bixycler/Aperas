/**
 * Store-wide helpers `kg:tree`/`kg:path`/others use to find a *starting* node — not itself a
 * node's own behavior, so these stay free functions (Aperas-apeironngn-design.md §4 rollout step
 * 3's classification: "a function folds onto a class only when a single already-identified node
 * is a natural `this` for it"). The recursive tree-render engine that used to live here folded
 * onto `TreeNode.renderTree` (`node.ts`) once `treeChildren` made it kind-generic.
 */

import { nodeKindFromId } from './nodeIds';
import type { TreeView } from './node';

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
  /** Reveal tombstoned nodes (tagged `(tombstoned)`) instead of the default of hiding them
   *  entirely — issues/treeview.md's "both `unfold` and `tree` should hide them by default". */
  showTombstoned?: boolean;
  view?: TreeView;
}
