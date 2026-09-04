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
import { parseMarkdownTree, extractAbstract } from './astParser';
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
      // Copy, not consume (Aperas-apeironngn-design.md, ArtifactNode/FolderNode.text): a real
      // README is usually headed (`# Title` first, not a bare leading paragraph), so requiring a
      // literal top-level paragraph to consume produced an empty abstract for the common case.
      // `extractAbstract` finds the first non-blank descendant text anywhere in the tree instead
      // — the same primitive `ArtifactNode.text` already used — and nothing is removed from
      // `readmeChildren`, so this deliberately duplicates whatever that text already is among the
      // README's own rendered children.
      readmeText = extractAbstract(parsedRoot);
      readmeChildren = parsedRoot.children;
      // Carries the existing `frontmatter` StringProp's id forward when its value hasn't changed
      // (`carryForwardProp`) — same fix as `ArtifactNode.ingestFromDisk`'s, and a no-op for the
      // TerminusDB-backed caller, which doesn't populate `existingByPath`'s `props` (and whose own
      // `@key: {"@type": "Random"}` schema would ignore a supplied id regardless).
      readmeProps = frontmatter !== undefined
        ? [carryForwardProp(existingByPath.get(path)?.props, "frontmatter", frontmatter)]
        : undefined;
      // readmeChildren are relocated straight into FolderNode.children, never kept under a
      // persisted root block of their own — no `.parent` stamping needed here any more
      // (Aperas-apeironngn-design.md §5's `parent`/`PARENT_PRED` merge): `FolderNode.children = ...`
      // stamps each top-level child's real `parent` to this folder automatically, as a side effect
      // of the containment write, once this parsed tree reaches `node.ts`'s `hydrateFromParsed`.
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

  return {
    "@type": "FolderNode",
    folderId,
    path,
    title,
    ...(readmeText ? { text: readmeText } : {}),
    ...(readmeProps ? { props: readmeProps } : {}),
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

