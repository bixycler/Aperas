/**
 * ApeironNgn implementation of `kg:track`/`kg:ingest`'s artifact half (Aperas-apeironngn-design.md
 * §4 rollout — "the big one"). Mirrors `artifacts.ts` field-for-field, but writes land directly on
 * a `Store` through `node.ts`'s `set` trap instead of a fetch-merge-`updateDocument` round trip —
 * TerminusDB's whole-document replace forces `artifacts.ts` to reconstruct every carried-forward
 * field by hand (`normalizeArtifactDoc`) before resubmitting; a `Store` write mutates one field at
 * a time in place, so nothing else needs restating just to survive the call. Where the original
 * omits a field from its replacement doc to clear it (`text`/`props`, when the fresh parse yields
 * none), the equivalent here is an explicit `undefined` assignment through the same `set` trap.
 *
 * `astParser.ts`/`reconcile.ts`/`snowflake.ts` are reused directly, unmodified — already pure,
 * DB-less logic (Aperas-apeironngn-design.md §4's rollout note). `listArtifactFiles`/
 * `computeFileHash`/`getArtifactsDir`/`extractLinkCodes`/`countBlocks` are artifacts.ts's own pure
 * helpers, reused the same way.
 */

import { readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import type { Store } from 'oxigraph';
import { wrap, type ApeironNode } from './node';
import { nodeIri, predIri, encodeLiteral, idFromNodeIri, nodeKindFromId } from './vocab';
import { allIdsOfKind } from './dehydrate';
import { resolveIdToPath } from './path';
import { resolveDeepPathDetail } from './resolveCreate';
import { generateNodeId } from '../snowflake';
import {
  listArtifactFiles,
  computeFileHash,
  getArtifactsDir,
  countBlocks,
  extractLinkCodes,
  type PendingLinkCodes,
} from '../artifacts';
import { parseMarkdownTree, extractAbstract, stampParents, WIKILINK_PREDICATE, type ParsedBlockNode } from '../astParser';
import { reconcileTree, matchLeftoverByAbstract, type ReconciliationStats } from '../reconcile';

/** A live (non-tombstoned) node of `kind` at `path` — `path` is unique per kind by construction
 *  (a filesystem path is either a file or a directory, never both), but a tombstoned entry keeps
 *  its old `path` value forever, so a plain `path`-literal lookup alone (`tree.ts`'s
 *  `findByExactPath`) isn't enough once a path has been reused after a rename/removal. */
function findLiveByKindAndPath(store: Store, kind: string, path: string): string | null {
  const matches = store
    .match(null, predIri('path'), encodeLiteral(path), null)
    .map((m) => idFromNodeIri(String(m.subject.value)))
    .filter((id) => nodeKindFromId(id) === kind);
  return matches.find((id) => wrap(store, id).tombstonedAt !== true) ?? null;
}

export function findLiveArtifactByPath(store: Store, path: string): string | null {
  return findLiveByKindAndPath(store, 'ArtifactNode', path);
}

function allLiveIdsOfKind(store: Store, kind: string): string[] {
  return allIdsOfKind(store, kind).filter((id) => wrap(store, id).tombstonedAt !== true);
}

export interface TrackResult {
  tracked: boolean;
}

/** Registers or refreshes the lightweight ArtifactNode for a single file — see `trackArtifact`'s
 *  own doc comment in `artifacts.ts` for the idempotence/skip-when-unchanged rationale, unchanged
 *  here. */
export function trackArtifact(store: Store, artifactPath: string): TrackResult {
  const content = readFileSync(join(getArtifactsDir(), artifactPath), 'utf-8');
  const fileHash = computeFileHash(content);
  const existingId = findLiveArtifactByPath(store, artifactPath);

  if (existingId) {
    const existing = wrap(store, existingId);
    if (existing.fileHash === fileHash) {
      console.log(`[ApeironNgn Artifacts] Skipping '${artifactPath}' — content unchanged (hash: ${fileHash.slice(0, 12)}...)`);
      return { tracked: false };
    }
    existing.path = artifactPath;
    existing.title = basename(artifactPath);
    existing.fileHash = fileHash;
    existing.lastTrackedAt = new Date().toISOString();
    console.log(`[ApeironNgn Artifacts] Tracking '${artifactPath}' (hash: ${fileHash.slice(0, 12)}...)`);
    return { tracked: true };
  }

  const artifactId = generateNodeId();
  const node = wrap(store, `ArtifactNode/${artifactId}`);
  node.artifactId = artifactId;
  node.path = artifactPath;
  node.title = basename(artifactPath);
  node.fileHash = fileHash;
  node.lastTrackedAt = new Date().toISOString();
  console.log(`[ApeironNgn Artifacts] Tracking '${artifactPath}' (hash: ${fileHash.slice(0, 12)}...)`);
  return { tracked: true };
}

export interface ArtifactSweepStats {
  renamed: number;
  removed: number;
}

/** Registers/refreshes ArtifactNodes for every file under `AperasKG/artifacts/`, first detecting
 *  renames/moves across the whole tracked set — see `trackAllArtifacts`'s own doc comment in
 *  `artifacts.ts`, unchanged here. A matched rename mutates the existing node's `path`/`title`/
 *  `fileHash`/`lastTrackedAt` fields in place; a tombstone sets one field. Neither needs the
 *  original's `normalizeArtifactDoc` reconstruction — nothing else on the node is being replaced. */
export function trackAllArtifacts(store: Store): { results: TrackResult[]; sweep: ArtifactSweepStats } {
  const files = listArtifactFiles();
  const diskSet = new Set(files);

  const liveIds = allLiveIdsOfKind(store, 'ArtifactNode');
  const existingByPath = new Map(liveIds.map((id) => [wrap(store, id).path as string, id]));

  const diskOnlyPaths = files.filter((f) => !existingByPath.has(f));
  const dbOnlyIds = liveIds.filter((id) => !diskSet.has(wrap(store, id).path as string));

  const artifactsDir = getArtifactsDir();
  const addedCandidates = diskOnlyPaths.map((path) => {
    const content = readFileSync(join(artifactsDir, path), 'utf-8');
    return { key: extractAbstract(parseMarkdownTree(content).root), item: { path, content } };
  });
  const removedCandidates = dbOnlyIds.map((id) => ({ key: (wrap(store, id).text as string) ?? '', item: id }));

  const { matched, stillRemoved } = matchLeftoverByAbstract(removedCandidates, addedCandidates);

  const sweep: ArtifactSweepStats = { renamed: 0, removed: 0 };

  for (const { old: oldId, new: added } of matched as Array<{ old: string; new: { path: string; content: string } }>) {
    const node = wrap(store, oldId);
    const fileHash = computeFileHash(added.content);
    console.log(`[ApeironNgn Artifacts] Detected rename '${node.path}' -> '${added.path}'`);
    node.path = added.path;
    node.title = basename(added.path);
    node.fileHash = fileHash;
    node.lastTrackedAt = new Date().toISOString();
    sweep.renamed++;
  }

  for (const id of stillRemoved as string[]) {
    const node = wrap(store, id);
    console.log(`[ApeironNgn Artifacts] Tombstoning removed artifact '${node.path}'`);
    node.tombstonedAt = new Date().toISOString();
    sweep.removed++;
  }

  const renamedIntoPaths = new Set((matched as Array<{ new: { path: string } }>).map((m) => m.new.path));
  const results: TrackResult[] = [];
  for (const file of files) {
    if (renamedIntoPaths.has(file)) continue; // already fully handled by the rename write above
    results.push(trackArtifact(store, file));
  }

  return { results, sweep };
}

export function getArtifactPath(store: Store, id: string): string | undefined {
  return wrap(store, id).path as string | undefined;
}

/** The old (already-ingested) tree, rebuilt as a plain nested object in exactly the shape
 *  `reconcile.ts`/`astParser.ts`'s fresh parse output already uses (`type`/`title`/`text`/
 *  `children`/`unfolded`/`blockId`, `links` as bare ref-id strings) — `reconcileTree` doesn't care
 *  whether that shape came from a GraphQL fetch (as under TerminusDB) or a `Store` walk, only that
 *  the shape matches. */
function materializeBlockTree(store: Store, id: string): any {
  const node = wrap(store, id);
  const links = (node.links as ApeironNode[] | undefined)?.map((l) => l.id) ?? [];
  return {
    blockId: node.blockId,
    type: node.type,
    title: node.title,
    ...(node.text !== undefined ? { text: node.text } : {}),
    unfolded: (node.unfolded as boolean) ?? false,
    ...(links.length ? { links } : {}),
    children: (node.children as ApeironNode[]).map((c) => materializeBlockTree(store, c.id)),
  };
}

/** Writes a freshly-parsed-and-reconciled `ParsedBlockNode` tree into the `Store`, one node at a
 *  time — every node already carries a real `blockId` by this point (freshly minted at parse time
 *  for a brand-new node, or carried forward from its old match by `reconcile.ts`'s
 *  `carryForwardFields`), so there's nothing left to mint here. Setting `.children` on a node also
 *  establishes each child's reified `__parent`/`__siblingIndex` quads (`node.ts`'s `writeField`) —
 *  the separate `.parent` field write below is `BaseNode`'s own real schema field
 *  (`astParser.ts`'s `stampParents`), a distinct concept from that internal bookkeeping. */
export function writeBlockTree(store: Store, node: ParsedBlockNode): void {
  const fullId = `BlockNode/${node.blockId}`;
  const n = wrap(store, fullId);
  n.type = node.type;
  n.title = node.title;
  n.text = node.text ?? undefined;
  n.unfolded = node.unfolded ?? false;
  n.parent = (node as any).parent;
  n.props = node.props?.length ? node.props : undefined;
  n.links = (node as any).links?.length ? (node as any).links : undefined;
  for (const child of node.children ?? []) writeBlockTree(store, child);
  n.children = (node.children ?? []).map((c) => `BlockNode/${c.blockId}`);
}

/** Applies one `reconcile.ts` tombstone record — an unmatched old subtree node, already fully
 *  detached from `finalTree`'s own structure, so this only needs to set its own fields (`children:
 *  []` clears whatever it used to point at; nothing re-attaches it). */
function applyTombstone(store: Store, tombstone: any): void {
  const node = wrap(store, `BlockNode/${tombstone.blockId}`);
  node.type = tombstone.type;
  node.title = tombstone.title;
  node.text = tombstone.text ?? undefined;
  node.unfolded = tombstone.unfolded ?? false;
  node.children = [];
  node.tombstonedAt = tombstone.tombstonedAt;
}

/**
 * Resolves each block's raw `linkCodes` into real `Link` entities, run *after* the tree's own
 * write — see `resolveBlockLinks`'s own doc comment in `artifacts.ts` for why (the implicit
 * `[[wikilink]]` base needs an already-persisted `.parent` chain). A fresh `Link` is created
 * directly (mint an id, `wrap()` it, set `target`/`predicate`) and attached by id, not handed to
 * `node.ts`'s `set` trap as a `{"@type": "Link", ...}` literal — the same "create then attach"
 * reasoning `kgLinkNgn.ts` documents (auto-minting always shapes a fresh id as
 * `.../props/<type>/...`, correct for `props`' `StringProp` but wrong for a top-level `Link`).
 */
function resolveBlockLinks(store: Store, pending: PendingLinkCodes[]): void {
  for (const { blockId, codes } of pending) {
    const fullId = `BlockNode/${blockId}`;
    const basePath = resolveIdToPath(store, fullId);
    const links: string[] = [];
    for (const code of codes) {
      let target: string | null = null;
      try {
        const detail = resolveDeepPathDetail(store, code, {
          base: basePath ?? undefined,
          createHolder: true,
          titles: code.split('/').filter((s) => s !== '.' && s !== '..'),
        });
        target = detail?.id ?? null;
      } catch (err: any) {
        console.warn(`[ApeironNgn Artifacts] Link target '[[${code}]]' in block ${blockId} failed to resolve: ${err.message || err}`);
      }
      if (target) {
        const linkId = `Link/${generateNodeId()}`;
        const link = wrap(store, linkId);
        link.target = target;
        link.predicate = WIKILINK_PREDICATE;
        links.push(linkId);
      } else {
        console.warn(`[ApeironNgn Artifacts] Link target '[[${code}]]' in block ${blockId} didn't resolve to any live node — skipping.`);
      }
    }
    if (links.length > 0) {
      const node = wrap(store, fullId);
      const existingLinks = (node.links as ApeironNode[] | undefined)?.map((l) => l.id) ?? [];
      node.links = [...existingLinks, ...links];
    }
  }
}

export interface IngestArtifactResult {
  blockCount: number;
  reconciliation: ReconciliationStats | null;
}

/** AST-parses and commits a tracked artifact into a fractal tree of BlockNodes, only if its file
 *  hash has changed since the last ingestion — see `ingestArtifact`'s own doc comment in
 *  `artifacts.ts` for the reconciliation rationale, unchanged here. */
export function ingestArtifact(store: Store, artifactPath: string): IngestArtifactResult | null {
  const existingId = findLiveArtifactByPath(store, artifactPath);
  if (!existingId) {
    throw new Error(`Artifact '${artifactPath}' is not tracked yet — run track first.`);
  }
  const record = wrap(store, existingId);
  if (record.ingestedHash === record.fileHash) {
    console.log(`[ApeironNgn Artifacts] '${artifactPath}' unchanged since last ingestion — skipping.`);
    return null;
  }

  const content = readFileSync(join(getArtifactsDir(), artifactPath), 'utf-8');
  const { root: newRoot, frontmatter } = parseMarkdownTree(content);
  const now = new Date().toISOString();
  const props = frontmatter !== undefined ? [{ '@type': 'StringProp' as const, key: 'frontmatter', value: frontmatter }] : undefined;

  let finalRoot: ParsedBlockNode = newRoot;
  let reconciliation: ReconciliationStats | null = null;

  const oldRoot = record.root as ApeironNode | undefined;
  if (oldRoot) {
    const oldTree = materializeBlockTree(store, oldRoot.id);
    console.log(`[ApeironNgn Artifacts] Reconciling '${artifactPath}' against its previously ingested tree...`);
    const { finalTree, tombstones, stats } = reconcileTree(oldTree, newRoot, now);
    finalRoot = finalTree;
    reconciliation = stats;
    for (const tombstone of tombstones) applyTombstone(store, tombstone);
    console.log(`[ApeironNgn Artifacts] Reconciliation: ${stats.unchanged} unchanged, ${stats.moved} moved, ${stats.added} added, ${stats.removed} removed.`);
  }

  stampParents(finalRoot);
  (finalRoot as any).parent = `ArtifactNode/${record.artifactId}`;

  const pendingLinks = extractLinkCodes(finalRoot);
  const blockCount = countBlocks(finalRoot);
  console.log(`[ApeironNgn Artifacts] Ingesting '${artifactPath}' as fractal tree (${blockCount} blocks)...`);

  const title = basename(artifactPath);
  const text = extractAbstract(newRoot);

  writeBlockTree(store, finalRoot);

  record.title = title;
  record.text = text || undefined;
  record.ingestedHash = record.fileHash;
  record.lastIngestedAt = now;
  record.root = `BlockNode/${finalRoot.blockId}`;
  record.props = props;

  // After, not before (see resolveBlockLinks's own doc comment): the tree just written is now
  // the queryable, current one — including whatever's brand new in this very edit.
  resolveBlockLinks(store, pendingLinks);

  return { blockCount, reconciliation };
}

/** Ingests every tracked artifact whose file hash has changed since its last ingestion. */
export function ingestAllArtifacts(store: Store): Array<{ path: string } & IngestArtifactResult> {
  const files = listArtifactFiles();
  const results: Array<{ path: string } & IngestArtifactResult> = [];
  for (const file of files) {
    const result = ingestArtifact(store, file);
    if (result) results.push({ path: file, ...result });
  }
  return results;
}
