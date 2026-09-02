/**
 * ApeironNgn implementation of `kg:ingest`'s FolderNode half (Aperas-apeironngn-design.md §4
 * rollout). Reuses `folders.ts`'s own `buildFolderTree`/`collectFolderPaths`/`countFolders`
 * directly, unmodified — they're already pure (no TerminusDB calls; every existing-state lookup
 * comes in as a plain `Map` argument), so only the outer orchestration (populating those maps from
 * a `Store` instead of `client.getDocument`, and writing the built tree back through `node.ts`'s
 * `set` trap instead of one big nested `updateDocument`) is new here.
 */

import type { Store } from 'oxigraph';
import { wrap, type ApeironNode } from './node';
import { nodeKindFromId } from './vocab';
import { allIdsOfKind } from './dehydrate';
import { writeBlockTree } from './artifacts';
import { buildFolderTree, collectFolderPaths, countFolders, type ParsedFolderNode } from '../folders';
import { getArtifactsDir } from '../artifacts';
import { matchLeftoverByAbstract } from '../reconcile';
import type { ParsedBlockNode } from '../astParser';

function allLiveIdsOfKind(store: Store, kind: string): string[] {
  return allIdsOfKind(store, kind).filter((id) => wrap(store, id).tombstonedAt !== true);
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
    const node = wrap(store, id);
    if (node.path === folderPath) {
      return { folderId: node.folderId as string, path: node.path as string, title: node.title as string, ...(node.text !== undefined ? { text: node.text as string } : {}) };
    }
  }
  return null;
}

/** Writes a freshly-built `ParsedFolderNode` tree into the `Store`, recursing into nested
 *  FolderNodes and any README-derived BlockNode content (`artifacts.ts`'s `writeBlockTree`,
 *  reused directly — a FolderNode's `children` mixes BlockNode content with FolderNode/
 *  ArtifactNode structural references, but each individual entry is exactly one of those three
 *  already-handled shapes). ArtifactNode entries are bare reference ids already (`folders.ts`'s
 *  own `buildFolderTree` never inlines them), nothing to write for those here. */
function writeFolderTree(store: Store, node: ParsedFolderNode): void {
  const fullId = `FolderNode/${node.folderId}`;
  const n = wrap(store, fullId);
  n.title = node.title;
  n.path = node.path;
  n.text = node.text ?? undefined;
  n.props = node.props?.length ? node.props : undefined;
  n.unfolded = node.unfolded ?? undefined;

  const childIds: string[] = [];
  for (const child of node.children) {
    if (typeof child === 'string') {
      childIds.push(child); // ArtifactNode reference
    } else if ((child as any)['@type'] === 'FolderNode') {
      writeFolderTree(store, child as ParsedFolderNode);
      childIds.push(`FolderNode/${(child as ParsedFolderNode).folderId}`);
    } else {
      writeBlockTree(store, child as ParsedBlockNode);
      childIds.push(`BlockNode/${(child as ParsedBlockNode).blockId}`);
    }
  }
  n.children = childIds;
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
  const existingByPath = new Map(liveFolderIds.map((id) => [wrap(store, id).path as string, { unfolded: wrap(store, id).unfolded as boolean | undefined }]));
  const folderIdByPath = new Map(liveFolderIds.map((id) => [wrap(store, id).path as string, wrap(store, id).folderId as string]));

  const liveArtifactIds = allLiveIdsOfKind(store, 'ArtifactNode');
  const artifactIdByPath = new Map(liveArtifactIds.map((id) => [wrap(store, id).path as string, wrap(store, id).artifactId as string]));

  const tree = buildFolderTree(artifactsDir, artifactsDir, folderIdByPath, artifactIdByPath, existingByPath);
  const folderCount = countFolders(tree);

  const newByPath = new Map<string, ParsedFolderNode>();
  collectFolderPaths(tree, newByPath);

  const diskOnlyPaths = [...newByPath.keys()].filter((p) => !existingByPath.has(p));
  const dbOnlyPaths = [...existingByPath.keys()].filter((p) => !newByPath.has(p));
  const dbOnlyIds = new Map(dbOnlyPaths.map((p) => [p, folderIdByPath.get(p)!]));

  const removedCandidates = dbOnlyPaths.map((p) => {
    const id = `FolderNode/${dbOnlyIds.get(p)}`;
    return { key: (wrap(store, id).text as string) ?? '', item: id };
  });
  const addedCandidates = diskOnlyPaths.map((p) => ({ key: newByPath.get(p)!.text ?? '', item: newByPath.get(p)! }));
  const { matched, stillRemoved } = matchLeftoverByAbstract(removedCandidates, addedCandidates);

  const sweep: FolderSweepStats = { renamed: 0, removed: 0 };

  for (const { old: oldId, new: newNode } of matched as Array<{ old: string; new: ParsedFolderNode }>) {
    const oldNode = wrap(store, oldId);
    console.log(`[ApeironNgn Folders] Detected rename '${oldNode.path}' -> '${newNode.path}'`);
    newNode.folderId = oldNode.folderId as string;
    if (oldNode.unfolded) newNode.unfolded = oldNode.unfolded as boolean;
    sweep.renamed++;
  }

  for (const id of stillRemoved as string[]) {
    const node = wrap(store, id);
    console.log(`[ApeironNgn Folders] Tombstoning removed folder '${node.path}'`);
    node.children = [];
    node.tombstonedAt = new Date().toISOString();
    sweep.removed++;
  }

  console.log(`[ApeironNgn Folders] Ingesting folder tree (${folderCount} folder(s))...`);
  writeFolderTree(store, tree);

  return { folderCount, sweep };
}
