/**
 * Aperas Artifact Projection — TerminusDB-backed half.
 *
 * Split out of `project.ts` (Aperas-apeironngn-design.md §4 rollout, archiving step): the
 * `serializeBlock`/`renderChildren`/`withFrontmatter` serializer itself stayed there since
 * `apeironNgn/node.ts` imports it directly; this file is only the GraphQL fetch-then-serialize
 * wrappers `kgCli.ts`'s `project` command used, headed to `.archive/` alongside it.
 */

import { getArtifactTreeViaGraphQL, getFolderTreeViaGraphQL } from './graphqlTdb';
import { withFrontmatter, renderChildren, serializeBlock } from './project';

/**
 * Fetches an ArtifactNode's ingested tree and serializes it back to Markdown. Always fully
 * "unfolded" — file serialization ignores each block's `unfolded` view-state, since the
 * physical file has to contain the whole document body regardless (design doc §0/intro).
 * Returns null when the artifact isn't found.
 */
export async function projectArtifactToMarkdown(client: any, path: string): Promise<string | null> {
  const artifact = await getArtifactTreeViaGraphQL(client, path);
  if (!artifact?.root) return null;
  return withFrontmatter(serializeBlock(artifact.root), artifact);
}

/**
 * Serializes a FolderNode's own content (its README's consumed leading text, plus its
 * README-derived block children) back into `README.md` Markdown. `renderChildren` never
 * switches on `node.type` itself — only `serializeBlock`'s dispatch does — so it works directly
 * against a FolderNode with no wrapper needed. Nested `FolderNode`/`ArtifactNode` references in
 * `children` are structural, not textual content — they were never part of the README's own
 * source, so they're filtered out here (Aperas-markdown-fractal-mapping-design.md §6).
 */
export function serializeFolderToReadme(folder: any): string {
  const blockChildren = (folder.children ?? []).filter((c: any) => c._type === undefined);
  const parts: string[] = [];
  if (folder.text) parts.push(folder.text);
  const body = renderChildren({ ...folder, children: blockChildren });
  if (body) parts.push(body);
  return withFrontmatter(parts.join('\n\n'), folder);
}

/**
 * Fetches a FolderNode's content and serializes it back to a `README.md`. Returns null when the
 * folder isn't found.
 */
export async function projectFolderToReadme(client: any, path: string): Promise<string | null> {
  const folder = await getFolderTreeViaGraphQL(client, path);
  if (!folder) return null;
  return serializeFolderToReadme(folder);
}
