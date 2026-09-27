/**
 * Thread-scope check: is a node's owning ArtifactNode/FolderNode path under `.threads/`
 * (design/aperas-skill.md's Multi-agent working; design/treeview.md's thread persistence)?
 * `.threads/`-scoped content is persisted to the gitignored `.state/` mirror instead of the tracked
 * content mirror, since a subagent's thread is working state as ephemeral as a `TreeView`.
 *
 * A raw-quad implementation, not a `wrap()`/`owningArtifactId()` one (`linkIntegrity.ts` has an
 * equivalent walk) — this module has to stay importable from `dehydrate.ts`, which `node.ts` and
 * `linkIntegrity.ts` both already import `allIdsOfKind` from; importing either back would cycle.
 * Depends only on `vocab.ts`, a leaf module, so nothing else can cycle through this one either.
 */

import type { Store } from 'oxigraph';
import { nodeIri, predIri, idFromNodeIri, decodeLiteral, isLiteralTerm, isNamedNodeTerm, nodeKindFromId, PARENT_PRED } from './vocab';

export const THREADS_PATH_PREFIX = '.threads/';

function pathOf(store: Store, id: string): string | undefined {
  const matches = store.match(nodeIri(id), predIri('path'), null, null);
  if (matches.length === 0) return undefined;
  const obj = matches[0].object;
  return isLiteralTerm(obj) ? String(decodeLiteral(obj)) : undefined;
}

function isThreadScopedPath(path: string | undefined): boolean {
  return path !== undefined && (path === '.threads' || path.startsWith(THREADS_PATH_PREFIX));
}

/** Walks `.parent` up from any node to the id of the `ArtifactNode`/`FolderNode` that owns it —
 *  `linkIntegrity.ts#owningArtifactId`'s raw-quad twin (see this file's own doc comment for why it
 *  isn't reused directly). */
function owningArtifactOrFolderId(store: Store, id: string): string | null {
  let current = id;
  for (;;) {
    const kind = nodeKindFromId(current);
    if (kind === 'ArtifactNode' || kind === 'FolderNode') return current;
    if (kind !== 'BlockNode') return null;
    const parentMatches = store.match(nodeIri(current), PARENT_PRED, null, null);
    if (parentMatches.length === 0) return null;
    const obj = parentMatches[0].object;
    if (!isNamedNodeTerm(obj)) return null;
    current = idFromNodeIri(obj.value);
  }
}

/** `kind` is the caller's already-known `nodeKindFromId(id)` — every call site here already has it
 *  on hand (from an `allIdsOfKind(store, kind)` sweep), so it isn't recomputed. `Profile`/`Link`/
 *  `StringProp`/`TreeView` are never thread-scoped by this check — only the three tree-positioned
 *  kinds an artifact's own subtree is made of. */
export function isThreadScopedId(store: Store, id: string, kind: string): boolean {
  if (kind === 'ArtifactNode' || kind === 'FolderNode') return isThreadScopedPath(pathOf(store, id));
  if (kind === 'BlockNode') {
    const owner = owningArtifactOrFolderId(store, id);
    return owner !== null && isThreadScopedPath(pathOf(store, owner));
  }
  return false;
}
