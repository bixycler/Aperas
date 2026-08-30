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
import { getArtifactsDir, isReadmeFilename } from './artifacts';
import { generateNodeId } from './snowflake';
import { matchLeftoverByAbstract } from './reconcile';
import type { PropEntry } from './props';

export interface ParsedFolderNode {
  "@type": "FolderNode";
  folderId: string;
  path: string;
  title: string;
  text?: string;
  children: unknown[];
  props?: PropEntry[];
}

function buildFolderTree(
  absoluteDir: string,
  artifactsDir: string,
  folderIdByPath: Map<string, string>,
  artifactIdByPath: Map<string, string>
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
      structuralChildren.push(buildFolderTree(fullPath, artifactsDir, folderIdByPath, artifactIdByPath));
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
      readmeProps = frontmatter !== undefined
        ? [{ "@type": "StringProp", key: "frontmatter", value: frontmatter }]
        : undefined;
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
function collectFolderPaths(node: ParsedFolderNode, out: Map<string, ParsedFolderNode>): void {
  out.set(node.path, node);
  for (const child of node.children) {
    if (typeof child === 'object' && child !== null && (child as any)['@type'] === 'FolderNode') {
      collectFolderPaths(child as ParsedFolderNode, out);
    }
  }
}

function countFolders(node: ParsedFolderNode): number {
  const nested = node.children.filter(
    (c): c is ParsedFolderNode => typeof c === 'object' && c !== null && (c as any)['@type'] === 'FolderNode'
  );
  return 1 + nested.reduce((sum, c) => sum + countFolders(c), 0);
}

export interface FolderRecord {
  folderId: string;
  path: string;
  title: string;
  text?: string;
}

/**
 * Looks up a live (non-tombstoned) FolderNode by its path — the from-memory addressing
 * counterpart to artifacts.ts's getArtifactRecord. Folders are navigated by path exactly the
 * same way artifacts are (nobody remembers a folderId either), so the two go together rather
 * than treating FolderNode as raw-id-only (see Aperas-basic-assertion-skill-design.md §2).
 */
export async function getFolderRecord(client: any, folderPath: string): Promise<FolderRecord | null> {
  try {
    const docs = await client.getDocument({ type: 'FolderNode', query: { path: folderPath }, as_list: true });
    const matches = Array.isArray(docs) ? docs : [docs];
    const doc = matches.find((d: any) => d && typeof d !== 'string' && !d.tombstonedAt);
    if (!doc) return null;
    return { folderId: doc.folderId, path: doc.path, title: doc.title, ...(doc.text ? { text: doc.text } : {}) };
  } catch (err) {
    return null;
  }
}

export interface FolderSweepStats {
  renamed: number;
  removed: number;
}

/**
 * Builds and commits the entire FolderNode tree rooted at AperasKG/artifacts/ in a
 * single write. Idempotent — existing folders reuse their `folderId` (looked up by `path`
 * against the live FolderNode set) rather than minting a fresh one each run. A path that
 * disappeared alongside a new, previously-untracked path is checked for a rename via the same
 * abstract-similarity leftover matching used for artifacts (design §4, "one mechanism, three
 * fractal layers") before falling back to treating them as an unrelated removal + addition.
 */
export async function ingestFolderTree(client: any): Promise<{ folderCount: number; sweep: FolderSweepStats }> {
  const artifactsDir = getArtifactsDir();

  const existingDocs: any[] = await client.getDocument({ type: 'FolderNode', as_list: true }).catch(() => []);
  const liveExisting = (Array.isArray(existingDocs) ? existingDocs : []).filter((d) => !d.tombstonedAt);
  const existingByPath = new Map(liveExisting.map((d) => [d.path, d]));
  const folderIdByPath = new Map(liveExisting.map((d) => [d.path, d.folderId]));

  const artifactDocs: any[] = await client.getDocument({ type: 'ArtifactNode', as_list: true }).catch(() => []);
  const artifactIdByPath = new Map(
    (Array.isArray(artifactDocs) ? artifactDocs : []).filter((d) => !d.tombstonedAt).map((d) => [d.path, d.artifactId])
  );

  const tree = buildFolderTree(artifactsDir, artifactsDir, folderIdByPath, artifactIdByPath);
  const folderCount = countFolders(tree);

  const newByPath = new Map<string, ParsedFolderNode>();
  collectFolderPaths(tree, newByPath);

  const diskOnlyPaths = [...newByPath.keys()].filter((p) => !existingByPath.has(p));
  const dbOnlyPaths = [...existingByPath.keys()].filter((p) => !newByPath.has(p));

  const removedCandidates = dbOnlyPaths.map((p) => ({ key: existingByPath.get(p).text ?? '', item: existingByPath.get(p) }));
  const addedCandidates = diskOnlyPaths.map((p) => ({ key: newByPath.get(p)!.text ?? '', item: newByPath.get(p)! }));
  const { matched, stillRemoved } = matchLeftoverByAbstract(removedCandidates, addedCandidates);

  const sweep: FolderSweepStats = { renamed: 0, removed: 0 };

  for (const { old: oldDoc, new: newNode } of matched) {
    console.log(`[Aperas Folders] Detected rename '${oldDoc.path}' -> '${newNode.path}'`);
    newNode.folderId = oldDoc.folderId;
    sweep.renamed++;
  }

  for (const doc of stillRemoved) {
    console.log(`[Aperas Folders] Tombstoning removed folder '${doc.path}'`);
    await client.updateDocument(
      {
        "@type": "FolderNode",
        folderId: doc.folderId,
        path: doc.path,
        title: doc.title,
        ...(doc.text ? { text: doc.text } : {}),
        children: [],
        tombstonedAt: new Date().toISOString()
      },
      {},
      client.db(),
      `Tombstone removed folder '${doc.path}'`,
      undefined,
      undefined,
      undefined,
      true
    );
    sweep.removed++;
  }

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
  return { folderCount, sweep };
}
