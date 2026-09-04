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
import { wrap, tombstoneLiveSubtree } from './node';
import type { ArtifactNode, BlockNode, Link, ApeironNode, IngestResult } from './node';
import { predIri, encodeLiteral, idFromNodeIri, nodeKindFromId } from './vocab';
import { allIdsOfKind } from './dehydrate';
import { resolveDeepPathDetail } from './resolveCreate';
import { generateNodeId } from '../snowflake';
import { listArtifactFiles, getArtifactsDir, expandArtifactPaths, type PendingLinkCodes } from '../artifacts';
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
    tombstoneLiveSubtree(node, new Date().toISOString());
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

/** Whether a block's resolved link outcome actually differs — this is *not* the same question as
 *  "did its text change" (`reconcile.ts`'s own `changed`): the same `[[wikilink]]` code can
 *  resolve differently across two separate ingestions purely because the *target*'s existence
 *  changed elsewhere in the graph in between (a forward reference that was dangling now resolves,
 *  or vice versa) — reconciling this artifact's own tree can never see that, since it's a property
 *  of the rest of the graph, not of this artifact's content. */
function targetSetsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

export interface LinkResolutionStats {
  /** Total `[[wikilink]]` codes across every pending block that resolved to a live target. */
  resolved: number;
  /** Total codes that didn't resolve to anything (logged individually as they're hit). */
  dangling: number;
  /** Blocks whose resolved target *set* differs from before this ingestion — the gained/lost
   *  distinction `reconciliation`'s own `changed` can't make, reported as its own line rather than
   *  folded into that count (Aperas-apeironngn-design.md's ingest rollout notes — a link's
   *  resolution outcome and a block's own authored content are orthogonal facts). */
  changed: number;
}

/** Whether two position lists are the same occurrence-for-occurrence, not just the same set —
 *  purely a "does the stored `props` need rewriting at all" check, *not* an identity-match
 *  condition (`resolveBlockLinks` matches wikilink `Link` identity on `target` alone; see its own
 *  doc comment for why). Order-sensitive rather than set-equality on purpose: a target mentioned
 *  twice, with its two occurrences having swapped order between ingestions, is still a real change
 *  to what the `Link`'s `position` props should say, even though the target — the identity key —
 *  hasn't moved. */
function positionsEqual(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Resolves each block's raw `linkCodes` into real `Link` subdocuments, run *after* the tree's own
 * write (the implicit `[[wikilink]]` base needs an already-persisted `.parent` chain) — a
 * multi-block sweep over the union of every block with pending codes *and* every block that had
 * wikilink `Link`s before this ingestion (`oldWikilinksByBlock`) — a block whose `[[wikilink]]`s
 * were all removed has no entry in `pending` at all (`extractLinkCodes` only records blocks with at
 * least one code), so it would never get its now-stale `Link`s cleaned up if the sweep only walked
 * `pending`. `oldLinkTargets` (`ingestFromDisk`'s own doc comment) is this same artifact's per-block
 * resolved target sets from *before* this ingestion — diffed against each block's freshly-resolved
 * set here to compute `changed`, the one comparison only possible at this point in the pipeline
 * (not during reconciliation, before any of this ran).
 *
 * One `Link` per distinct target per block, not per raw occurrence (Aperas-apeironngn-design.md §4
 * Step 8). `oldWikilinksByBlock` (id/target/positions, captured by `ingestFromDisk` before
 * `hydrateFromParsed` touched anything) is what makes a wikilink `Link`'s identity stable across a
 * re-ingestion that doesn't actually change it (§5's "tractable half" of the Link-tombstone open
 * question): a freshly-resolved target reuses an old `Link`'s id whenever some old entry names the
 * *same target* — `target` is the real identity key for a wikilink edge, not the position list, so
 * matching is on target alone. `position` drifting (an edit earlier in the same block's text shifts
 * every later occurrence's offset, with no change to the wikilink itself) is deliberately *not*
 * grounds to mint a fresh `Link` — a matched `Link`'s `props` are instead rewritten in place to the
 * fresh position list when they differ, keeping its id (and anything referencing it, e.g.
 * `TreeView.unfolds`) stable. A target with no old match at all mints a fresh `Link`. `block.links`
 * is written exactly once at the end with the full surviving set (manual `kg:link`s untouched,
 * wikilink `Link`s either reused-and-repositioned or freshly minted) — `writeField`'s own embed-diff
 * cleanup deletes whatever old wikilink `Link` isn't in that final set, i.e. one whose target
 * disappeared from this block's text entirely.
 */
export function resolveBlockLinks(
  store: Store,
  pending: PendingLinkCodes[],
  oldLinkTargets: Map<string, Set<string>> = new Map(),
  oldWikilinksByBlock: Map<string, Array<{ id: string; target: string; positions: number[] }>> = new Map()
): LinkResolutionStats {
  let resolved = 0;
  let dangling = 0;
  let changed = 0;
  const codesByBlock = new Map(pending.map((p) => [p.blockId, p.codes]));
  const blockIds = new Set([...codesByBlock.keys(), ...oldWikilinksByBlock.keys()]);
  for (const blockId of blockIds) {
    const codes = codesByBlock.get(blockId) ?? [];
    const fullId = `BlockNode/${blockId}`;
    const block = wrap(store, fullId) as unknown as BlockNode;
    const basePath = block.toPath();
    const newTargets = new Set<string>();
    const positionsByTarget = new Map<string, number[]>();
    for (const { code, position } of codes) {
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
        newTargets.add(target);
        resolved++;
        const positions = positionsByTarget.get(target);
        if (positions) positions.push(position);
        else positionsByTarget.set(target, [position]);
      } else {
        console.warn(`[ApeironNgn Artifacts] Link target '[[${code}]]' in block ${blockId} didn't resolve to any live node — skipping.`);
        dangling++;
      }
    }

    const oldWikilinks = oldWikilinksByBlock.get(blockId) ?? [];
    const manualLinkIds = ((block.links as unknown as Link[] | undefined) ?? [])
      .filter((l) => l.predicate !== WIKILINK_PREDICATE)
      .map((l) => l.id);
    const wikilinkIds = [...positionsByTarget.entries()].map(([target, positions]) => {
      const reused = oldWikilinks.find((w) => w.target === target);
      if (!reused) return block.mintWikilink(target, positions);
      if (!positionsEqual(reused.positions, positions)) {
        // Same edge (same target), just re-anchored — an unrelated edit earlier in this block's
        // own text shifts every later occurrence's offset without the wikilink itself having
        // "changed" in any sense a reader would recognize, so position drift alone must not churn
        // the `Link`'s id (Aperas-apeironngn-design.md §5 — target is the real identity key here,
        // `position` is metadata *on* that identity, not part of it). Updates in place: `Link.
        // props` is itself `storageKind: 'embed'` (Step 8), so this assignment's own embed-diff
        // (`writeField`) deletes the stale position `StringProp`s and mints the fresh ones, without
        // touching the `Link`'s own id or its `target`/`predicate`.
        (wrap(store, reused.id) as unknown as Link).props = positions.map(
          (position) => ({ '@type': 'StringProp', key: 'position', value: String(position) })
        ) as unknown as ApeironNode[];
      }
      return reused.id;
    });
    const finalLinkIds = [...manualLinkIds, ...wikilinkIds];
    block.links = finalLinkIds.length ? (finalLinkIds as unknown as ApeironNode[]) : undefined;

    if (!targetSetsEqual(oldLinkTargets.get(blockId) ?? new Set(), newTargets)) changed++;
  }
  return { resolved, dangling, changed };
}

/** AST-parses and commits a tracked artifact into a fractal tree of BlockNodes, delegating the
 *  actual work to `ArtifactNode.ingestFromDisk` (`node.ts`) — this wrapper only finds the node and
 *  resolves the wikilinks it turned up, once its own tree write has finished. */
export function ingestArtifact(store: Store, artifactPath: string): (IngestResult & { linkResolution: LinkResolutionStats }) | null {
  const existingId = findLiveArtifactByPath(store, artifactPath);
  if (!existingId) {
    throw new Error(`Artifact '${artifactPath}' is not tracked yet — run track first.`);
  }
  const record = wrap(store, existingId) as unknown as ArtifactNode;
  const result = record.ingestFromDisk();
  if (!result) return null;
  const { pendingLinks, oldLinkTargets, oldWikilinksByBlock, ...rest } = result;
  const linkResolution = resolveBlockLinks(store, pendingLinks, oldLinkTargets, oldWikilinksByBlock);
  return { ...rest, linkResolution };
}

/** `ingestArtifact`'s own non-null result shape, incl. `linkResolution` — named once here so
 *  `ingestAllArtifacts`/`ingestArtifacts` don't each separately (and driftably) redeclare it. */
type SingleIngestResult = NonNullable<ReturnType<typeof ingestArtifact>>;

/** Ingests every already-tracked artifact whose file hash has changed since its last ingestion.
 *  A file on disk with no `ArtifactNode` yet is skipped (reported via `untracked`, not thrown)
 *  rather than aborting the whole sweep — run `kg:track` (or pass the path directly to
 *  `kg:ingest`) to pick it up. `untracked` is returned rather than logged directly because this
 *  runs inside the shared service process, spawned with `stdio: 'ignore'` (`serviceClient.ts`) —
 *  anything printed here is discarded; only the CLI client that issued the request can surface it. */
export function ingestAllArtifacts(store: Store): { ingested: Array<{ path: string } & SingleIngestResult>; untracked: string[] } {
  const files = listArtifactFiles();
  const ingested: Array<{ path: string } & SingleIngestResult> = [];
  const untracked: string[] = [];
  for (const file of files) {
    if (!findLiveArtifactByPath(store, file)) {
      untracked.push(file);
      continue;
    }
    const result = ingestArtifact(store, file);
    if (result) ingested.push({ path: file, ...result });
  }
  return { ingested, untracked };
}

/** Ingests exactly the given artifact paths (`expandArtifactPaths` turns any directory among them
 *  into every artifact file under it, recursively — `kg:ingest archive` ingests the whole folder).
 *  Assumes every path is already tracked — `kgIngest.ts`'s `runIngest` tracks each one first (and
 *  rebuilds the folder tree) *before* calling this, specifically so a brand-new file's own folder
 *  is already attached by the time this ingests it and resolves its wikilinks against it. */
export function ingestArtifacts(store: Store, paths: string[]): Array<{ path: string } & SingleIngestResult> {
  const results: Array<{ path: string } & SingleIngestResult> = [];
  for (const path of expandArtifactPaths(paths)) {
    const result = ingestArtifact(store, path);
    if (result) results.push({ path, ...result });
  }
  return results;
}
