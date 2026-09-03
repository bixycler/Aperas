/**
 * ApeironNgn implementation of `kg:ingest`'s FolderNode half (Aperas-apeironngn-design.md §4
 * rollout). Reuses `folders.ts`'s own `buildFolderTree`/`collectFolderPaths`/`countFolders`
 * directly, unmodified — they're already pure (no TerminusDB calls; every existing-state lookup
 * comes in as a plain `Map` argument), so only the outer orchestration (populating those maps from
 * a `Store` instead of `client.getDocument`) is here. §4 rollout step 3 folded the actual tree
 * write onto `FolderNode.hydrateFromParsed` (`node.ts`).
 */

import type { Store } from 'oxigraph';
import { wrap } from './node';
import type { FolderNode } from './node';
import { allIdsOfKind } from './dehydrate';
import { buildFolderTree, collectFolderPaths, countFolders, type ParsedFolderNode } from '../folders';
import { getArtifactsDir } from '../artifacts';
import { matchLeftoverByAbstract } from '../reconcile';

function allLiveIdsOfKind(store: Store, kind: string): string[] {
  return allIdsOfKind(store, kind).filter((id) => !(wrap(store, id) as unknown as FolderNode).tombstonedAt);
}

export interface FolderRecord {
  folderId: string;
  path: string;
  title: string;
  text?: string;
}

/** Looks up a live FolderNode by path — the from-`Store` counterpart to `folders.ts`'s
 *  `getFolderRecord`. */
export function getFolderRecord(store: Store, folderPath: string): FolderRecord | null {
  for (const id of allLiveIdsOfKind(store, 'FolderNode')) {
    const node = wrap(store, id) as unknown as FolderNode;
    if (node.path === folderPath) {
      return { folderId: node.key, path: node.path as string, title: node.title as string, ...(node.text !== undefined ? { text: node.text as string } : {}) };
    }
  }
  return null;
}

export interface FolderSweepStats {
  renamed: number;
  removed: number;
}

/** Builds and writes the entire FolderNode tree rooted at `AperasKG/artifacts/` — see
 *  `ingestFolderTree`'s own doc comment in `folders.ts` for the rename-detection rationale,
 *  unchanged here. A matched rename reuses the existing `folderId`/`unfolded` (via
 *  `buildFolderTree`'s own `existingByPath`/`folderIdByPath` maps, same as the original); a
 *  tombstone sets one field directly rather than replacing the whole document. */
export function ingestFolderTree(store: Store): { folderCount: number; sweep: FolderSweepStats } {
  const artifactsDir = getArtifactsDir();

  const liveFolderIds = allLiveIdsOfKind(store, 'FolderNode');
  const existingByPath = new Map(liveFolderIds.map((id) => {
    const node = wrap(store, id) as unknown as FolderNode;
    return [node.path as string, { unfolded: node.unfolded, props: node.props }];
  }));
  const folderIdByPath = new Map(liveFolderIds.map((id) => {
    const node = wrap(store, id) as unknown as FolderNode;
    return [node.path as string, node.key];
  }));

  const liveArtifactIds = allLiveIdsOfKind(store, 'ArtifactNode');
  const artifactIdByPath = new Map(liveArtifactIds.map((id) => {
    const node = wrap(store, id) as unknown as FolderNode; // only .path/.key are read below, common to every TreeNode
    return [node.path as string, node.key];
  }));

  const tree = buildFolderTree(artifactsDir, artifactsDir, folderIdByPath, artifactIdByPath, existingByPath);
  const folderCount = countFolders(tree);

  const newByPath = new Map<string, ParsedFolderNode>();
  collectFolderPaths(tree, newByPath);

  const diskOnlyPaths = [...newByPath.keys()].filter((p) => !existingByPath.has(p));
  const dbOnlyPaths = [...existingByPath.keys()].filter((p) => !newByPath.has(p));
  const dbOnlyIds = new Map(dbOnlyPaths.map((p) => [p, folderIdByPath.get(p)!]));

  const removedCandidates = dbOnlyPaths.map((p) => {
    const id = `FolderNode/${dbOnlyIds.get(p)}`;
    return { key: ((wrap(store, id) as unknown as FolderNode).text as string) ?? '', item: id };
  });
  const addedCandidates = diskOnlyPaths.map((p) => ({ key: newByPath.get(p)!.text ?? '', item: newByPath.get(p)! }));
  // Explicit <any>: the two sides carry genuinely different item shapes (an existing node's bare
  // id vs. a freshly-built ParsedFolderNode) — same asymmetry the original TerminusDB-backed
  // `folders.ts` has, where it goes unnoticed only because that side's item comes from an
  // untyped `client.getDocument` result.
  const { matched, stillRemoved } = matchLeftoverByAbstract<any>(removedCandidates, addedCandidates);

  const sweep: FolderSweepStats = { renamed: 0, removed: 0 };

  for (const { old: oldId, new: newNode } of matched as Array<{ old: string; new: ParsedFolderNode }>) {
    const oldNode = wrap(store, oldId) as unknown as FolderNode;
    console.log(`[ApeironNgn Folders] Detected rename '${oldNode.path}' -> '${newNode.path}'`);
    newNode.folderId = oldNode.key;
    if (oldNode.unfolded) newNode.unfolded = oldNode.unfolded;
    sweep.renamed++;
  }

  for (const id of stillRemoved as string[]) {
    const node = wrap(store, id) as unknown as FolderNode;
    console.log(`[ApeironNgn Folders] Tombstoning removed folder '${node.path}'`);
    node.children = [];
    node.tombstonedAt = new Date().toISOString();
    sweep.removed++;
  }

  console.log(`[ApeironNgn Folders] Ingesting folder tree (${folderCount} folder(s))...`);
  (wrap(store, `FolderNode/${tree.folderId}`) as unknown as FolderNode).hydrateFromParsed(tree);

  return { folderCount, sweep };
}
