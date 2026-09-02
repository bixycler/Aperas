/**
 * ApeironNgn implementation of `kg:path` (id→path — Aperas-apeironngn-design.md §4 rollout).
 * Mirrors `nodeRef.ts`'s `resolveIdToPath` exactly: walks `BlockNode.parent` up to the owning
 * `ArtifactNode`/`FolderNode`, collecting each hop's slugified `title`, then prepends that node's
 * own `path`. Fully synchronous, reading from an in-process `Store` instead of TerminusDB.
 *
 * Reuses `nodeRef.ts`'s `slugify` directly — it's pure (no TerminusDB dependency), so there's
 * nothing to port.
 */

import type { Store } from 'oxigraph';
import { wrap, type ApeironNode } from './node';
import { nodeKindFromId } from './vocab';
import { slugify } from '../nodeRef';

/** Returns `null` on anything unwalkable: a missing document, a `Link` id (no structural
 *  `parent` at all), or a `BlockNode` with no `parent` set — same as `resolveIdToPath`. */
export function resolveIdToPath(store: Store, id: string): string | null {
  const segments: string[] = [];
  let currentId = id;

  for (;;) {
    const kind = nodeKindFromId(currentId);
    if (kind === 'ArtifactNode' || kind === 'FolderNode') {
      const node = wrap(store, currentId);
      if (node.path === undefined) return null; // not found
      return segments.length > 0 ? `${node.path}/${segments.join('/')}` : (node.path as string);
    }
    if (kind !== 'BlockNode') return null; // Link — no structural parent

    const node = wrap(store, currentId);
    if (node.title === undefined) return null; // not found
    segments.unshift(slugify(node.title as string));

    const parent = node.parent as ApeironNode | undefined;
    if (!parent) return null;
    currentId = parent.id;
  }
}
