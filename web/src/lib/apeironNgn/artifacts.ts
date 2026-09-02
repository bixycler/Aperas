/**
 * ApeironNgn implementation of `kg:track`/`kg:ingest`'s artifact half (Aperas-apeironngn-design.md
 * §4 rollout — "the big one"). §4 rollout step 3 folded the per-node work onto `ArtifactNode`
 * (`node.ts`'s `trackFromDisk`/`ingestFromDisk`) — what's left here is the store-wide search/sweep
 * that has no single node to be `this` until *after* it runs: finding an artifact by path,
 * detecting renames across the whole tracked set, and resolving each ingested block's wikilinks
 * (a multi-block sweep, run once per artifact after its own tree write completes).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from 'oxigraph';
import { wrap } from './node';
import type { ArtifactNode, BlockNode, IngestResult } from './node';
import { predIri, encodeLiteral, idFromNodeIri, nodeKindFromId } from './vocab';
import { allIdsOfKind } from './dehydrate';
import { resolveDeepPathDetail } from './resolveCreate';
import { generateNodeId } from '../snowflake';
import { listArtifactFiles, getArtifactsDir, type PendingLinkCodes } from '../artifacts';
import { parseMarkdownTree, extractAbstract, WIKILINK_PREDICATE } from '../astParser';
import { matchLeftoverByAbstract } from '../reconcile';

/** A live (non-tombstoned) node of `kind` at `path` — `path` is unique per kind by construction
 *  (a filesystem path is either a file or a directory, never both), but a tombstoned entry keeps
 *  its old `path` value forever, so a plain `path`-literal lookup alone (`tree.ts`'s
 *  `findByExactPath`) isn't enough once a path has been reused after a rename/removal. */
function findLiveByKindAndPath(store: Store, kind: string, path: string): string | null {
  const matches = store
    .match(null, predIri('path'), encodeLiteral(path), null)
    .map((m) => idFromNodeIri(String(m.subject.value)))
    .filter((id) => nodeKindFromId(id) === kind);
  return matches.find((id) => !(wrap(store, id) as unknown as ArtifactNode).tombstonedAt) ?? null;
}

export function findLiveArtifactByPath(store: Store, path: string): string | null {
  return findLiveByKindAndPath(store, 'ArtifactNode', path);
}

function allLiveIdsOfKind(store: Store, kind: string): string[] {
  return allIdsOfKind(store, kind).filter((id) => !(wrap(store, id) as unknown as ArtifactNode).tombstonedAt);
}

export interface TrackResult {
  tracked: boolean;
}

/** Registers or refreshes the lightweight ArtifactNode for a single file, minting a fresh one if
 *  none is tracked yet — `ArtifactNode.trackFromDisk` (`node.ts`) handles both cases uniformly now
 *  that there's no separate `artifactId` to mint (a brand-new node's `fileHash` just reads
 *  `undefined`, so it's unconditionally "changed"). */
export function trackArtifact(store: Store, artifactPath: string): TrackResult {
  const existingId = findLiveArtifactByPath(store, artifactPath);
  const node = (existingId ? wrap(store, existingId) : wrap(store, `ArtifactNode/${generateNodeId()}`)) as unknown as ArtifactNode;
  return node.trackFromDisk(artifactPath);
}

export interface ArtifactSweepStats {
  renamed: number;
  removed: number;
}

/** Registers/refreshes ArtifactNodes for every file under `AperasKG/artifacts/`, first detecting
 *  renames/moves across the whole tracked set via `reconcile.ts`'s Gestalt matcher (same abstract-
 *  text similarity `kg:ingest`'s own reconciliation uses) — a rename mutates the existing node in
 *  place (`trackFromDisk`); an unmatched removal is tombstoned. */
export function trackAllArtifacts(store: Store): { results: TrackResult[]; sweep: ArtifactSweepStats } {
  const files = listArtifactFiles();
  const diskSet = new Set(files);

  const liveIds = allLiveIdsOfKind(store, 'ArtifactNode');
  const existingByPath = new Map(liveIds.map((id) => [(wrap(store, id) as unknown as ArtifactNode).path as string, id]));

  const diskOnlyPaths = files.filter((f) => !existingByPath.has(f));
  const dbOnlyIds = liveIds.filter((id) => !diskSet.has((wrap(store, id) as unknown as ArtifactNode).path as string));

  const artifactsDir = getArtifactsDir();
  const addedCandidates = diskOnlyPaths.map((path) => {
    const content = readFileSync(join(artifactsDir, path), 'utf-8');
    return { key: extractAbstract(parseMarkdownTree(content).root), item: path };
  });
  const removedCandidates = dbOnlyIds.map((id) => ({ key: ((wrap(store, id) as unknown as ArtifactNode).text as string) ?? '', item: id }));

  const { matched, stillRemoved } = matchLeftoverByAbstract(removedCandidates, addedCandidates);

  const sweep: ArtifactSweepStats = { renamed: 0, removed: 0 };

  for (const { old: oldId, new: newPath } of matched as Array<{ old: string; new: string }>) {
    const node = wrap(store, oldId) as unknown as ArtifactNode;
    console.log(`[ApeironNgn Artifacts] Detected rename '${node.path}' -> '${newPath}'`);
    node.trackFromDisk(newPath);
    sweep.renamed++;
  }

  for (const id of stillRemoved as string[]) {
    const node = wrap(store, id) as unknown as ArtifactNode;
    console.log(`[ApeironNgn Artifacts] Tombstoning removed artifact '${node.path}'`);
    node.tombstonedAt = new Date().toISOString();
    sweep.removed++;
  }

  const renamedIntoPaths = new Set((matched as Array<{ new: string }>).map((m) => m.new));
  const results: TrackResult[] = [];
  for (const file of files) {
    if (renamedIntoPaths.has(file)) continue; // already fully handled by the rename write above
    results.push(trackArtifact(store, file));
  }

  return { results, sweep };
}

/**
 * Resolves each block's raw `linkCodes` into real `Link` subdocuments, run *after* the tree's own
 * write (the implicit `[[wikilink]]` base needs an already-persisted `.parent` chain) — a
 * multi-block sweep over every pending code across the whole freshly-ingested tree, so it stays a
 * free function rather than folding onto any single node. Each resolved target is attached via
 * `BaseNode.addLink` (`node.ts`) — no more "mint a `Link/<snowflake>` id, `wrap()` it, set fields,
 * attach by id" now that `links` is `storageKind: 'embed'`.
 */
export function resolveBlockLinks(store: Store, pending: PendingLinkCodes[]): void {
  for (const { blockId, codes } of pending) {
    const fullId = `BlockNode/${blockId}`;
    const block = wrap(store, fullId) as unknown as BlockNode;
    const basePath = block.toPath();
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
        block.addLink(WIKILINK_PREDICATE, target);
      } else {
        console.warn(`[ApeironNgn Artifacts] Link target '[[${code}]]' in block ${blockId} didn't resolve to any live node — skipping.`);
      }
    }
  }
}

/** AST-parses and commits a tracked artifact into a fractal tree of BlockNodes, delegating the
 *  actual work to `ArtifactNode.ingestFromDisk` (`node.ts`) — this wrapper only finds the node and
 *  resolves the wikilinks it turned up, once its own tree write has finished. */
export function ingestArtifact(store: Store, artifactPath: string): IngestResult | null {
  const existingId = findLiveArtifactByPath(store, artifactPath);
  if (!existingId) {
    throw new Error(`Artifact '${artifactPath}' is not tracked yet — run track first.`);
  }
  const record = wrap(store, existingId) as unknown as ArtifactNode;
  const result = record.ingestFromDisk();
  if (!result) return null;
  const { pendingLinks, ...rest } = result;
  resolveBlockLinks(store, pendingLinks);
  return rest;
}

/** Ingests every tracked artifact whose file hash has changed since its last ingestion. */
export function ingestAllArtifacts(store: Store): Array<{ path: string } & IngestResult> {
  const files = listArtifactFiles();
  const results: Array<{ path: string } & IngestResult> = [];
  for (const file of files) {
    const result = ingestArtifact(store, file);
    if (result) results.push({ path: file, ...result });
  }
  return results;
}
