/**
 * ApeironNgn implementation of `kg:ingest`'s FolderNode half (Aperas-apeironngn-design.md §4
 * rollout). Reuses `folders.ts`'s own `buildFolderTree`/`collectFolderPaths`/`countFolders`
 * directly — they're pure (every existing-state lookup comes in as the `FolderReaders` argument), so only
 * the outer orchestration (answering those readers from the shell's one map by path, `store.maps`) is here. §4 rollout step 3 folded the actual tree
 * write onto `FolderNode.hydrateFromParsed` (`node.ts`).
 */

import { liveDocumentIdsOfKind, type Db } from './db';
import { wrap, wrapOrCreate, applyTombstone, tombstoneNode, collectLinkTargetsByBlock, collectOldWikilinksByBlock } from './node';
import type { FolderNode, BlockNode } from './node';
import { nodeKindFromId } from './nodeIds';
import { buildFolderTree, collectFolderPaths, countFolders, type FolderReaders, type ParsedFolderNode } from '../folders';
import { getArtifactsDir, type PendingLinkCodes } from '../artifacts';
import { resolveBlockLinks } from './artifacts';
import { matchLeftoverByAbstract } from '../reconcile';
import type { PropEntry } from '../props';

export interface FolderRecord {
  folderId: string;
  path: string;
  title: string;
  text?: string;
}

/** Looks up a live FolderNode by path — the from-`Store` counterpart to `folders.ts`'s
 *  `getFolderRecord`. */
export function getFolderRecord(store: Db, folderPath: string): FolderRecord | null {
  const id = store.maps.liveAtPath(folderPath, { kind: 'FolderNode' });
  if (id === undefined) return null;
  const node = wrap(store, id) as unknown as FolderNode;
  return { folderId: node.key, path: node.path as string, title: node.title as string, ...(node.text !== undefined ? { text: node.text as string } : {}) };
}

export interface FolderSweepStats {
  renamed: number;
  removed: number;
}

/** Builds and writes the entire FolderNode tree rooted at `AperasKG/artifacts/` — see
 *  `ingestFolderTree`'s own doc comment in `folders.ts` for the rename-detection rationale,
 *  unchanged here. A matched rename reuses the existing `folderId` (via `buildFolderTree`'s own
 *  `FolderReaders`, answered from the one map by path, same rename rule as the original); a tombstone sets one field
 *  directly rather than replacing the whole document. */
export function ingestFolderTree(store: Db, force: boolean = false): { folderCount: number; sweep: FolderSweepStats; pendingRemovals: string[] } {
  const artifactsDir = getArtifactsDir();

  const liveFolderIds = liveDocumentIdsOfKind(store, 'FolderNode');
  const folderAt = (path: string): string | undefined => store.maps.liveAtPath(path, { kind: 'FolderNode' });
  const keyOf = (id: string | undefined): string | undefined => (id === undefined ? undefined : id.slice(id.indexOf(':') + 1));
  const readers: FolderReaders = {
    folderKeyAt: (path) => keyOf(folderAt(path)),
    artifactKeyAt: (path) => keyOf(store.maps.liveAtPath(path, { kind: 'ArtifactNode' })),
    existingAt(path) {
      const id = folderAt(path);
      if (id === undefined) return undefined;
      const node = wrap(store, id) as unknown as FolderNode;
      // `readmeChildren`: this folder's own current BlockNode-kind children (its README's content —
      // the only kind of child a FolderNode ever has besides nested FolderNode/ArtifactNode
      // structural references), in the same reconcile-shape `ArtifactNode.ingestFromDisk` already
      // uses, so `folders.ts`'s `buildFolderTree` can reconcile a fresh parse against it instead of
      // re-minting every README content block's id on every ingestion (AperasKG/artifacts/planning/
      // linking.md's Task 3 made that churn visible via the id-anchor it now embeds).
      const readmeChildren = node.treeChildren
        .filter((c) => nodeKindFromId(c.id) === 'BlockNode')
        .map((c) => (c as unknown as BlockNode).toReconcileShape());
      return { props: node.props as unknown as PropEntry[] | undefined, readmeChildren };
    },
  };
  // The paths of the live folders, each once: a path held by two live nodes is one entry, the holder the map answers.
  const livePaths = [...new Set(liveFolderIds.map((id) => (wrap(store, id) as unknown as FolderNode).path as string))];

  // Snapshot of every live folder's *own* current wikilinks (its `description`'s, from a prior
  // ingest), taken before the tree write below touches anything — same "capture before mutation"
  // requirement `ArtifactNode.ingestFromDisk` already has for `resolveBlockLinks`'s identity-stable
  // reuse, applied here per-folder instead of per-artifact. `false` (non-recursive): this call's own
  // `pendingDescriptionLinks` covers only each folder's own key, never its README children's —
  // those keep resolving lazily via the corpus-wide sweep, unchanged (`collectOldWikilinksByBlock`'s
  // own doc comment on why recursing here would wrongly wipe children this pass never touches).
  const oldLinkTargets = new Map<string, Set<string>>();
  const oldWikilinksByBlock = new Map<string, Array<{ id: string; target: string; positions: number[] }>>();
  for (const id of liveFolderIds) {
    const node = wrap(store, id) as unknown as FolderNode;
    collectLinkTargetsByBlock(node, oldLinkTargets);
    collectOldWikilinksByBlock(node, oldWikilinksByBlock, false);
  }

  const pendingReadmeTombstones: any[] = [];
  const pendingDescriptionLinks: PendingLinkCodes[] = [];
  const tree = buildFolderTree(artifactsDir, artifactsDir, readers, pendingReadmeTombstones, pendingDescriptionLinks);
  // Applied unconditionally, not `force`-gated like the folder/artifact removal sweep below: a
  // README content block genuinely missing from the fresh parse was already becoming permanently
  // orphaned (unreferenced, ungoverned) garbage before this reconciliation existed at all — writing
  // an explicit tombstone for it is strictly safer than that prior silent-orphan status quo, not a
  // new destructive behavior that needs confirmation the way a whole file/folder disappearing does.
  for (const tombstone of pendingReadmeTombstones) applyTombstone(store, tombstone);
  const folderCount = countFolders(tree);

  const newByPath = new Map<string, ParsedFolderNode>();
  collectFolderPaths(tree, newByPath);

  const diskOnlyPaths = [...newByPath.keys()].filter((p) => folderAt(p) === undefined);
  // Aperas-crud-design.md §6: a holder-flagged FolderNode not appearing in the fresh disk walk is
  // never evidence of removal — it was never going to be produced by one in the first place — so
  // it's excluded here before it can ever reach `removedCandidates` below and get tombstoned by
  // this sweep, independent of whatever `FolderNode.hydrateFromParsed`'s own preservation loop
  // does for a *parent's reference* to it.
  const dbOnlyIds = livePaths
    .filter((p) => !newByPath.has(p))
    .map((p) => folderAt(p)!)
    .filter((id) => !(wrap(store, id) as unknown as FolderNode).holder);

  const removedCandidates = dbOnlyIds.map((id) => ({ key: ((wrap(store, id) as unknown as FolderNode).text as string) ?? '', item: id }));
  const addedCandidates = diskOnlyPaths.map((p) => ({ key: newByPath.get(p)!.text ?? '', item: newByPath.get(p)! }));
  // Explicit <any>: the two sides carry genuinely different item shapes (an existing node's bare
  // id vs. a freshly-built ParsedFolderNode) — same asymmetry the original TerminusDB-backed
  // `folders.ts` has, where it goes unnoticed only because that side's item comes from an
  // untyped `client.getDocument` result.
  const { matched, stillRemoved } = matchLeftoverByAbstract<any>(removedCandidates, addedCandidates);

  const sweep: FolderSweepStats = { renamed: 0, removed: 0 };
  const pendingRemovals: string[] = [];

  for (const { old: oldId, new: newNode } of matched as Array<{ old: string; new: ParsedFolderNode }>) {
    const oldNode = wrap(store, oldId) as unknown as FolderNode;
    console.log(`[ApeironNgn Folders] Detected rename '${oldNode.path}' -> '${newNode.path}'`);
    newNode.folderId = oldNode.key;
    sweep.renamed++;
  }

  // Aperas-crud-design.md §14: a real folder disappearing from disk is exactly the destructive
  // case that needs confirmation before applying — held back (left alive, untombstoned) rather
  // than applied when `!force`, its path reported via `pendingRemovals` instead. Renames/additions
  // above are unaffected; only this specific removal step is gated.
  for (const id of stillRemoved as string[]) {
    const node = wrap(store, id) as unknown as FolderNode;
    if (!force) {
      console.log(`[ApeironNgn Folders] '${node.path}' would be tombstoned as removed — held back pending confirmation (re-run with --force to apply).`);
      pendingRemovals.push(node.path as string);
      continue;
    }
    console.log(`[ApeironNgn Folders] Tombstoning removed folder '${node.path}'`);
    tombstoneNode(store, id, new Date().toISOString());
    sweep.removed++;
  }

  console.log(`[ApeironNgn Folders] Ingesting folder tree (${folderCount} folder(s))...`);
  (wrapOrCreate(store, `FolderNode:${tree.folderId}`, { path: tree.path }) as unknown as FolderNode).hydrateFromParsed(tree);

  const linkResolution = resolveBlockLinks(store, pendingDescriptionLinks, oldLinkTargets, oldWikilinksByBlock, undefined, 'skip');
  if (linkResolution.resolved > 0 || linkResolution.dangling > 0) {
    console.log(`[ApeironNgn Folders]   description links: ${linkResolution.resolved} resolved, ${linkResolution.dangling} dangling, ${linkResolution.changed} changed.`);
  }

  return { folderCount, sweep, pendingRemovals };
}
