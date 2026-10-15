/**
 * Aperas Phase 1: FolderNode tree building — engine-agnostic (Aperas-apeironngn-design.md §4
 * rollout, archiving step). Builds the structural layer of the fractal tree — one FolderNode per
 * directory under AperasKG/artifacts/, each absorbing its own README.md (if present) per
 * AperasKG/artifacts/Aperas-core-ontology-design.md §4.A. README.md is never exposed as a
 * separate ArtifactNode; its top-level parsed blocks become the FolderNode's own children,
 * alongside nested FolderNodes and ArtifactNode references.
 *
 * `apeironNgn/folders.ts` reuses `buildFolderTree`/`collectFolderPaths`/`countFolders` directly,
 * unmodified. The TerminusDB `client`-based commit wrappers (`getFolderRecord`/`ingestFolderTree`)
 * that used to live here moved to `foldersTdb.ts`, headed to `.archive/` with `kgCli.ts`.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseMarkdownTree } from './astParser';
import { isReadmeFilename } from './artifacts';
import { generateNodeId } from './snowflake';
import { carryForwardProp, type PropEntry } from './props';

export interface ParsedFolderNode {
  "@type": "FolderNode";
  folderId: string;
  path: string;
  title: string;
  text?: string;
  children: unknown[];
  props?: PropEntry[];
  /** BaseNode field (Aperas-agentic-query-tools-design.md §4) — the whole tree is rebuilt fresh
   *  from disk on every ingest, so unlike ArtifactNode's field-by-field record reuse, this has to
   *  be explicitly read back from `existingByPath` or a re-ingest silently folds every unfolded
   *  folder back up. */
  unfolded?: boolean;
}

export function buildFolderTree(
  absoluteDir: string,
  artifactsDir: string,
  folderIdByPath: Map<string, string>,
  artifactIdByPath: Map<string, string>,
  existingByPath: Map<string, any>
): ParsedFolderNode {
  const relPath = relative(artifactsDir, absoluteDir);
  const isRoot = relPath === '';
  const path = isRoot ? '.' : relPath;
  const title = isRoot ? 'Artifacts' : relPath.split('/').pop()!;
  const folderId = folderIdByPath.get(path) ?? generateNodeId();

  const entries = readdirSync(absoluteDir).sort();

  const structuralChildren: unknown[] = [];
  let readmeChildren: unknown[] = [];
  let readmeText = '';
  let readmeProps: PropEntry[] | undefined;

  for (const entry of entries) {
    if (entry.startsWith('.')) continue;
    const fullPath = join(absoluteDir, entry);
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      structuralChildren.push(buildFolderTree(fullPath, artifactsDir, folderIdByPath, artifactIdByPath, existingByPath));
      continue;
    }
    if (!entry.endsWith('.md')) continue;

    if (isReadmeFilename(entry)) {
      const content = readFileSync(fullPath, 'utf-8');
      const { root: parsedRoot, frontmatter } = parseMarkdownTree(content);
      // Same consuming rule as heading/listItem (§2/§6): the README's own leading paragraph
      // becomes the FolderNode's own `text`, not a separately duplicated child. If that
      // paragraph had itself adopted a list (§8 — e.g. an intro sentence immediately followed
      // by a list), those adopted items become the FolderNode's own leading children, exactly
      // as they would have if the FolderNode were a heading/listItem consuming the same content.
      const [firstChild, ...restChildren] = parsedRoot.children;
      if (firstChild?.type === 'paragraph') {
        readmeText = firstChild.text ?? '';
        readmeChildren = [...(firstChild.children ?? []), ...restChildren];
      } else {
        readmeChildren = parsedRoot.children;
      }
      // Carries the existing `frontmatter` StringProp's id forward when its value hasn't changed
      // (`carryForwardProp`) — same fix as `ArtifactNode.ingestFromDisk`'s, and a no-op for the
      // TerminusDB-backed caller, which doesn't populate `existingByPath`'s `props` (and whose own
      // `@key: {"@type": "Random"}` schema would ignore a supplied id regardless).
      readmeProps = frontmatter !== undefined
        ? [carryForwardProp(existingByPath.get(path)?.props, "frontmatter", frontmatter)]
        : undefined;
      // readmeChildren are relocated straight into FolderNode.children, never kept under a
      // persisted root block of their own — astParser.ts's stampParents pointed them at
      // parsedRoot/firstChild (discarded, never written), so that's stale now. Re-stamp only the
      // top level to the FolderNode itself; every deeper descendant's `parent` is already correct
      // relative to *its own* still-intact subtree.
      for (const child of readmeChildren as any[]) {
        child.parent = `FolderNode/${folderId}`;
      }
    } else {
      const artifactPath = relative(artifactsDir, fullPath);
      // Reference an independently tracked/ingested ArtifactNode by its actual (Snowflake)
      // id rather than by path — path is no longer the key, so `ArtifactNode/${path}` would
      // be a broken reference. A file not yet tracked (no artifactId assigned) is skipped
      // rather than referenced incorrectly; kg:track runs before kg:ingest in the normal flow.
      const artifactId = artifactIdByPath.get(artifactPath);
      if (artifactId) {
        structuralChildren.push(`ArtifactNode/${artifactId}`);
      } else {
        console.warn(`[Aperas Folders] '${artifactPath}' has no tracked ArtifactNode yet — omitting from folder tree until tracked.`);
      }
    }
  }

  const existingUnfolded = existingByPath.get(path)?.unfolded;
  return {
    "@type": "FolderNode",
    folderId,
    path,
    title,
    ...(readmeText ? { text: readmeText } : {}),
    ...(readmeProps ? { props: readmeProps } : {}),
    ...(existingUnfolded ? { unfolded: existingUnfolded } : {}),
    children: [...readmeChildren, ...structuralChildren]
  };
}

/** Every FolderNode path in a freshly-built tree, root included, for rename-detection bookkeeping. */
export function collectFolderPaths(node: ParsedFolderNode, out: Map<string, ParsedFolderNode>): void {
  out.set(node.path, node);
  for (const child of node.children) {
    if (typeof child === 'object' && child !== null && (child as any)['@type'] === 'FolderNode') {
      collectFolderPaths(child as ParsedFolderNode, out);
    }
  }
}

export function countFolders(node: ParsedFolderNode): number {
  const nested = node.children.filter(
    (c): c is ParsedFolderNode => typeof c === 'object' && c !== null && (c as any)['@type'] === 'FolderNode'
  );
  return 1 + nested.reduce((sum, c) => sum + countFolders(c), 0);
}

