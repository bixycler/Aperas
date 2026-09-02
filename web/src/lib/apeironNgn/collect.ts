/**
 * ApeironNgn implementation of `kgCli.ts`'s `collectBlockNodes` (Aperas-interactive-summarization-
 * design.md §3/§7's shared scoping rule — Aperas-apeironngn-design.md §4 rollout: `kg:title`/
 * `kg:link`). Collects every BlockNode `{id, node}` reachable from `id`, walking the same uniform
 * `children`/`root` tree `kg:tree`/`kg:resolve` traverse. Without `recursive`, only `id` itself is
 * visited (and only collected if it's a BlockNode); with `recursive`, every kind is walked as a
 * starting point but only BlockNode descendants are collected.
 */

import type { Store } from 'oxigraph';
import { wrap, type ApeironNode } from './node';
import { nodeExists, nodeKindFromId } from './vocab';
import { childIds } from './tree';

export function collectBlockNodes(store: Store, id: string, recursive: boolean): Array<{ id: string; node: ApeironNode }> {
  const out: Array<{ id: string; node: ApeironNode }> = [];

  function visit(nodeId: string, isRoot: boolean): void {
    if (!nodeExists(store, nodeId)) return;
    const kind = nodeKindFromId(nodeId);
    const node = wrap(store, nodeId);
    if (kind === 'BlockNode') out.push({ id: nodeId, node });
    if (isRoot && !recursive) return;
    for (const childId of childIds(node, kind)) visit(childId, false);
  }

  visit(id, true);
  return out;
}
