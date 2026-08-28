/**
 * Aperas Phase 1: FolderNode Ingestion
 *
 * Builds and commits the structural layer of the fractal tree — one FolderNode per
 * directory under AperasKG/artifacts/, each absorbing its own README.md (if present)
 * per AperasKG/artifacts/Aperas-core-ontology-design.md §4.A. README.md is never
 * exposed as a separate ArtifactNode; its top-level parsed blocks become the
 * FolderNode's own children, alongside nested FolderNodes and ArtifactNode references.
 *
 * The whole tree is committed as a single nested write from the artifacts root, the
 * same whole-tree-per-commit pattern ingestArtifact uses for a BlockNode tree — the
 * folder tree is small (directory-count-sized, not content-sized) so re-ingesting it
 * whole on every `kg:ingest` run is cheap. Files are referenced by id (they're tracked
 * and ingested independently via artifacts.ts, not re-embedded here).
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseMarkdownTree } from './astParser';
import { getArtifactsDir } from './artifacts';

export interface ParsedFolderNode {
  "@type": "FolderNode";
  path: string;
  title: string;
  text?: string;
  children: unknown[];
}

const README_NAME = 'readme.md';

function buildFolderTree(absoluteDir: string, artifactsDir: string): ParsedFolderNode {
  const relPath = relative(artifactsDir, absoluteDir);
  const isRoot = relPath === '';
  const path = isRoot ? '.' : relPath;
  const title = isRoot ? 'Artifacts' : relPath.split('/').pop()!;

  const entries = readdirSync(absoluteDir).sort();

  const structuralChildren: unknown[] = [];
  let readmeChildren: unknown[] = [];
  let readmeText = '';

  for (const entry of entries) {
    if (entry.startsWith('.')) continue;
    const fullPath = join(absoluteDir, entry);
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      structuralChildren.push(buildFolderTree(fullPath, artifactsDir));
      continue;
    }
    if (!entry.endsWith('.md')) continue;

    if (entry.toLowerCase() === README_NAME) {
      const content = readFileSync(fullPath, 'utf-8');
      const parsedRoot = parseMarkdownTree(content);
      readmeChildren = parsedRoot.children;
      readmeText = parsedRoot.text ?? '';
    } else {
      const artifactPath = relative(artifactsDir, fullPath);
      // Reference an independently tracked/ingested ArtifactNode by id rather than
      // re-embedding it — its own content lifecycle is owned by artifacts.ts.
      structuralChildren.push(`ArtifactNode/${artifactPath}`);
    }
  }

  return {
    "@type": "FolderNode",
    path,
    title,
    ...(readmeText ? { text: readmeText } : {}),
    children: [...readmeChildren, ...structuralChildren]
  };
}

function countFolders(node: ParsedFolderNode): number {
  const nested = node.children.filter(
    (c): c is ParsedFolderNode => typeof c === 'object' && c !== null && (c as any)['@type'] === 'FolderNode'
  );
  return 1 + nested.reduce((sum, c) => sum + countFolders(c), 0);
}

/**
 * Builds and commits the entire FolderNode tree rooted at AperasKG/artifacts/ in a
 * single write. Idempotent — FolderNode's Lexical key on `path` means re-running
 * upserts the same documents rather than duplicating them.
 */
export async function ingestFolderTree(client: any): Promise<{ folderCount: number }> {
  const artifactsDir = getArtifactsDir();
  const tree = buildFolderTree(artifactsDir, artifactsDir);
  const folderCount = countFolders(tree);

  console.log(`[Aperas Folders] Ingesting folder tree (${folderCount} folder(s))...`);
  await client.updateDocument(
    tree,
    {},
    client.db(),
    'Ingest FolderNode structural tree',
    undefined,
    undefined,
    undefined,
    true
  );
  return { folderCount };
}
