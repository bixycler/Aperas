/**
 * Aperas Phase 1: FolderNode Ingestion — TerminusDB-backed half.
 *
 * Split out of `folders.ts` (Aperas-apeironngn-design.md §4 rollout, archiving step): the pure
 * tree-building logic (`ParsedFolderNode`/`buildFolderTree`/`collectFolderPaths`/`countFolders`)
 * stayed there since `apeironNgn/folders.ts` reuses it directly, unmodified; this file is only
 * the TerminusDB `client`-based lookup/commit wrappers `kgCli.ts` used, headed to `.archive/`
 * alongside it.
 */

import { getArtifactsDir } from './artifacts';
import { matchLeftoverByAbstract } from './reconcile';
import { buildFolderTree, collectFolderPaths, countFolders, type ParsedFolderNode } from './folders';

export interface FolderRecord {
  folderId: string;
  path: string;
  title: string;
  text?: string;
}

/**
 * Looks up a live (non-tombstoned) FolderNode by its path — the from-memory addressing
 * counterpart to artifactsTdb.ts's getArtifactRecord. Folders are navigated by path exactly the
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

  const tree = buildFolderTree(artifactsDir, artifactsDir, folderIdByPath, artifactIdByPath, existingByPath);
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
    if (oldDoc.unfolded) newNode.unfolded = oldDoc.unfolded;
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
