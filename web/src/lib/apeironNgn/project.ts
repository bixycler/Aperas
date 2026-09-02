/**
 * ApeironNgn implementation of `kg:project`'s dry-run mode (Aperas-apeironngn-design.md §4 rollout:
 * "`project.ts` itself has zero direct TerminusDB calls, pure serialization, reusable as-is").
 * Reuses `project.ts`'s `serializeBlock`/`renderChildren`/`withFrontmatter` directly against
 * `wrap()`-returned nodes — a `Proxy`'s property reads are indistinguishable from a plain object's
 * to that code, so nothing there needed porting, only a new pair of fetch functions in place of
 * `graphql.ts`'s `getArtifactTreeViaGraphQL`/`getFolderTreeViaGraphQL`.
 *
 * Non-dry-run mode (writing the projected Markdown back to the artifact file / folder README) is
 * out of scope for this migration step (Aperas-apeironngn-design.md §4: "nearly free once dry-run
 * works, since that write targets the filesystem, not the DB") — not yet built here.
 */

import type { Store } from 'oxigraph';
import { wrap, type ApeironNode } from './node';
import { nodeKindFromId } from './vocab';
import { findByExactPath } from './tree';
import { serializeBlock, renderChildren, withFrontmatter } from '../project';

/** Fetches an ArtifactNode's ingested tree and serializes it back to Markdown. `null` when no
 *  ArtifactNode is tracked at `path`. */
export function projectArtifactToMarkdown(store: Store, path: string): string | null {
  const id = findByExactPath(store, path);
  if (!id || nodeKindFromId(id) !== 'ArtifactNode') return null;
  const artifact = wrap(store, id);
  const root = artifact.root as ApeironNode | undefined;
  if (!root) return null;
  return withFrontmatter(serializeBlock(root), artifact);
}

/** Fetches a FolderNode's own content and serializes it back to `README.md` Markdown. `null` when
 *  no FolderNode is tracked at `path`. Nested `FolderNode`/`ArtifactNode` children are structural,
 *  not textual content — filtered out here, same as `project.ts`'s own `_type` filter, just keyed
 *  off `nodeKindFromId` instead of GraphQL's `_type` tag (ApeironNgn's `children` carries the same
 *  BlockNode/FolderNode/ArtifactNode mix, just without that tag). */
export function projectFolderToReadme(store: Store, path: string): string | null {
  const id = findByExactPath(store, path);
  if (!id || nodeKindFromId(id) !== 'FolderNode') return null;
  const folder = wrap(store, id);
  const blockChildren = (folder.children as ApeironNode[]).filter((c) => nodeKindFromId(c.id) === 'BlockNode');
  const parts: string[] = [];
  if (folder.text) parts.push(folder.text as string);
  const body = renderChildren({ children: blockChildren });
  if (body) parts.push(body);
  return withFrontmatter(parts.join('\n\n'), folder);
}
