/**
 * Link Integrity Check & Repair Sweep — `issues/linking.md` Shared Fix Direction:
 * Compares live `BlockNode` text against stored `.links` RDF triples in Oxigraph Store.
 * Detects live nodes whose text contains an internal-style link occurrence (`[[code]]`,
 * `aperas://...`, `path#fragment`) that *resolves* (via `artifacts.ts#resolveOneCode`, the same
 * dispatch `resolveBlockLinks` itself uses, read-only here) to a live target with no matching
 * entry in that block's own `.links` — narrower than "any unresolved code," which is routine (a
 * `#fragment` anchor) or already tracked separately (`danglingRef`/`retryDanglingRefs`).
 */

import type { Store } from 'oxigraph';
import { wrap, collectOldWikilinksByBlock, type BlockNode, type Link, type TreeNode } from './node';
import { allIdsOfKind } from './dehydrate';
import { collectLinkCodesFromText, type LinkOccurrence } from '../astParser';
import { resolveBlockLinks, retryDanglingRefs, resolveOneCode } from './artifacts';
import { nodeKindFromId } from './vocab';
import { findByExactPath } from './tree';
import type { PendingLinkCodes } from '../artifacts';

export interface LinkDiscrepancy {
  /** The live BlockNode ID holding the un-persisted or missing link */
  blockId: string;
  /** Owning artifact path */
  artifactPath: string | null;
  /** Title or abstract preview of the block */
  blockTitle: string;
  /** Text preview of the block */
  blockText: string;
  /** Expected link codes found in block text */
  textLinkCodes: string[];
  /** Codes that resolve to a live target with no matching entry in this block's own `.links` */
  missingCodes: string[];
  /** This block's actual resolved Link objects, for comparison */
  resolvedLinks: { id: string; targetId: string | null }[];
}

export interface LinkIntegrityReport {
  /** Total live BlockNodes inspected */
  totalLiveBlocks: number;
  /** Total live BlockNodes with internal link codes in text */
  blocksWithLinkText: number;
  /** Discrepancies found */
  discrepancies: LinkDiscrepancy[];
}

/** Walks .parent up to find the enclosing ArtifactNode's path */
function artifactPathOfBlock(block: BlockNode): string | null {
  let current: TreeNode = block;
  for (;;) {
    const kind = nodeKindFromId(current.id);
    if (kind === 'ArtifactNode' || kind === 'FolderNode') return (current as unknown as { path?: string }).path ?? null;
    if (kind !== 'BlockNode') return null;
    const parent = (current as unknown as BlockNode).parent;
    if (!parent) return null;
    current = parent;
  }
}

/** Recursively collects all live BlockNode children of a node */
function collectAllBlockNodes(node: TreeNode, out: BlockNode[] = []): BlockNode[] {
  for (const child of node.treeChildren) {
    if (nodeKindFromId(child.id) === 'BlockNode') {
      const block = child as unknown as BlockNode;
      if (!block.tombstonedAt) out.push(block);
      collectAllBlockNodes(child, out);
    }
  }
  return out;
}

/**
 * Sweeps the entire Oxigraph Store for live BlockNodes and compares their text against stored
 * `.links`, resolving each occurrence for real (`resolveOneCode`, `createHolder: false` so a scan
 * never mutates the graph) instead of guessing from the raw code string. A substring/containment
 * check against `Link.target.id` only ever happens to work for `path#id/<ID>`/`aperas://id/<ID>`
 * forms, where the id is textually embedded in the code — it can't work at all for `[[<deep-path>]]`
 * addressing (`resolve.ts`'s deep-path grammar, "used extensively" per `history/linking.md`'s own
 * account), where the code is a heading-path string with no relationship to the opaque id it
 * resolves to. Resolving properly also lets this scan be precise about *what* it reports: a code
 * that doesn't resolve to anything at all is a dangling reference — already `resolveBlockLinks`'s
 * own concern via its `danglingRef` prop + `retryDanglingRefs` (and routine, not a defect, for a
 * bare `#fragment` — most of those are ordinary same-page anchors, never meant as an internal
 * reference). This scan exists for the narrower, previously-invisible failure this tool was built
 * for: a code that *does* resolve, correctly, to a live target — yet that target is missing from
 * this block's own `.links` regardless (`issues/linking.md`'s two confirmed incidents both showed
 * "N resolved" at write time with an empty `.links` afterward).
 */
export function checkLinkIntegrity(store: Store): LinkIntegrityReport {
  const t0 = Date.now();
  const ids = allIdsOfKind(store, 'BlockNode');
  const t1 = Date.now();
  const blocks = ids.map((id) => wrap(store, id) as unknown as BlockNode);
  const t2 = Date.now();
  const result = sweepBlocks(store, blocks);
  if (process.env.APERAS_DEBUG_TIMING) {
    const mem = process.memoryUsage();
    console.error(`[checkLinkIntegrity] allIdsOfKind=${t1 - t0}ms wrap(${ids.length})=${t2 - t1}ms sweepBlocks=${Date.now() - t2}ms heapUsed=${(mem.heapUsed / 1e6).toFixed(0)}MB heapTotal=${(mem.heapTotal / 1e6).toFixed(0)}MB external=${(mem.external / 1e6).toFixed(0)}MB rss=${(mem.rss / 1e6).toFixed(0)}MB`);
  }
  return result;
}

/** The same check as `checkLinkIntegrity`, restricted to one artifact's own live `BlockNode`
 *  descendants — cheap enough (tens of ms against a typical concern doc, vs. ~0.6s for the whole
 *  corpus) to run on every write, which is what lets `service.ts` verify a mutation's own link
 *  resolution immediately instead of leaving it to a sweep somebody has to remember. Matches the
 *  corpus scan's coverage exactly: `allIdsOfKind(store, 'BlockNode')` excludes `ArtifactNode`s by
 *  kind, and `collectAllBlockNodes` likewise only collects `BlockNode`-kind descendants, so neither
 *  form inspects an artifact root's own text. */
export function checkArtifactLinkIntegrity(store: Store, artifactId: string): LinkIntegrityReport {
  const artifactNode = wrap(store, artifactId) as unknown as TreeNode;
  return sweepBlocks(store, collectAllBlockNodes(artifactNode));
}

/** Walks `.parent` up from any node to the id of the `ArtifactNode`/`FolderNode` that owns it —
 *  `artifactPathOfBlock`'s id-returning counterpart, for callers that need to scope a sweep rather
 *  than name a file. Returns `nodeId` itself when it already is an artifact/folder root. */
export function owningArtifactId(store: Store, nodeId: string): string | null {
  let current: TreeNode = wrap(store, nodeId) as unknown as TreeNode;
  for (;;) {
    const kind = nodeKindFromId(current.id);
    if (kind === 'ArtifactNode' || kind === 'FolderNode') return current.id;
    if (kind !== 'BlockNode') return null;
    const parent = (current as unknown as BlockNode).parent;
    if (!parent) return null;
    current = parent;
  }
}

function sweepBlocks(store: Store, blocks: BlockNode[]): LinkIntegrityReport {
  let totalLiveBlocks = 0;
  let blocksWithLinkText = 0;
  const discrepancies: LinkDiscrepancy[] = [];
  const debug = !!process.env.APERAS_DEBUG_TIMING;
  let parseMs = 0;
  let resolveMs = 0;
  let pathMs = 0;

  for (const block of blocks) {
    if (block.tombstonedAt) continue;
    totalLiveBlocks++;

    const text = block.text;
    if (!text) continue;

    const tp0 = debug ? Date.now() : 0;
    const occurrences: LinkOccurrence[] = collectLinkCodesFromText(text);
    if (debug) parseMs += Date.now() - tp0;
    if (occurrences.length === 0) continue;

    blocksWithLinkText++;

    const actualLinks = (block.links as unknown as Link[] | undefined) ?? [];
    const actualTargetIds = new Set(actualLinks.map((l) => l.target?.id).filter((tid): tid is string => !!tid));
    const tb0 = debug ? Date.now() : 0;
    const basePath = block.toPath();
    const artifactPath = artifactPathOfBlock(block);
    if (debug) pathMs += Date.now() - tb0;
    const missingCodes: string[] = [];

    for (const occ of occurrences) {
      const code = occ.code;
      let resolved: string | null = null;
      const tr0 = debug ? Date.now() : 0;
      try {
        resolved = resolveOneCode(store, code, basePath, artifactPath, false);
      } catch {
        resolved = null; // an ambiguity/lookup failure here is "no confident candidate," not a crash
      }
      if (debug) resolveMs += Date.now() - tr0;
      // Only a code that genuinely resolves and is still missing from `.links` counts — see
      // `checkLinkIntegrity`'s own doc comment for why an unresolved code isn't reported here.
      if (resolved && !actualTargetIds.has(resolved)) {
        missingCodes.push(code);
      }
    }

    if (missingCodes.length > 0) {
      discrepancies.push({
        blockId: block.id,
        artifactPath,
        blockTitle: block.title || block.id,
        blockText: text.length > 120 ? text.slice(0, 117) + '...' : text,
        textLinkCodes: occurrences.map((o) => o.code),
        missingCodes,
        resolvedLinks: actualLinks.map((l) => ({
          id: l.id,
          targetId: l.target?.id ?? null,
        })),
      });
    }
  }

  if (debug) {
    console.error(`[sweepBlocks] blocks=${blocks.length} withLinkText=${blocksWithLinkText} parse=${parseMs}ms path=${pathMs}ms resolve=${resolveMs}ms`);
  }

  return {
    totalLiveBlocks,
    blocksWithLinkText,
    discrepancies,
  };
}

export interface RepairLinkIntegrityResult {
  reportBefore: LinkIntegrityReport;
  repairedArtifacts: string[];
  reportAfter: LinkIntegrityReport;
}

/**
 * Re-runs link resolution and dangling ref retries for artifacts containing link integrity
 * discrepancies. `knownReportBefore` lets a caller that already has an up-to-date corpus-wide
 * report (nothing mutated the store since) hand it in instead of paying for an identical sweep a
 * second time — a real, measured cost: `verify.ts`'s own step 19 used to call `checkLinkIntegrity`
 * immediately before this function, which computed the exact same report again as its own
 * `reportBefore`, each full sweep costing whatever a corpus-wide scan costs at that point in the
 * process (which can be substantial — see `checkLinkIntegrity`'s own `APERAS_DEBUG_TIMING` notes).
 *
 * Re-resolves only the blocks the report actually names as discrepant, not every link-bearing
 * block in the affected artifact, and passes those blocks' pre-existing wikilink `Link`s
 * (`collectOldWikilinksByBlock`, the same map `ingestFromDisk` builds before an ordinary
 * `resolveBlockLinks` call) so a match on target reuses the old `Link`'s id instead of minting a
 * fresh one. Both matter: without the first, a repair touches every block in the artifact whether
 * or not anything in it was ever wrong; without the second, even a touched block's *other*,
 * already-correct wikilinks would still be reminted, since `resolveBlockLinks` has no old-Link map
 * to reuse from otherwise (`issues/linking.md` — `check-links --repair` re-minted every `Link` id
 * in the affected artifact for exactly this reason).
 */
export function repairLinkIntegrity(store: Store, knownReportBefore?: LinkIntegrityReport): RepairLinkIntegrityResult {
  const reportBefore = knownReportBefore ?? checkLinkIntegrity(store);

  const discrepanciesByArtifact = new Map<string, LinkDiscrepancy[]>();
  for (const d of reportBefore.discrepancies) {
    if (!d.artifactPath) continue;
    const list = discrepanciesByArtifact.get(d.artifactPath);
    if (list) list.push(d);
    else discrepanciesByArtifact.set(d.artifactPath, [d]);
  }

  const repairedArtifacts = Array.from(discrepanciesByArtifact.keys());

  for (const artifactPath of repairedArtifacts) {
    const artifactId = findByExactPath(store, artifactPath);
    if (!artifactId) continue;

    const artifactNode = wrap(store, artifactId) as unknown as TreeNode;
    const oldWikilinksByBlock = new Map<string, Array<{ id: string; target: string; positions: number[] }>>();
    collectOldWikilinksByBlock(artifactNode, oldWikilinksByBlock);

    const pendingLinks: PendingLinkCodes[] = [];
    for (const d of discrepanciesByArtifact.get(artifactPath)!) {
      const block = wrap(store, d.blockId) as unknown as BlockNode;
      if (!block.text) continue;
      const codes = collectLinkCodesFromText(block.text);
      if (codes.length > 0) {
        const bareId = block.id.startsWith('BlockNode:') ? block.id.slice('BlockNode:'.length) : block.id;
        pendingLinks.push({ blockId: bareId, codes });
      }
    }

    if (pendingLinks.length > 0) {
      resolveBlockLinks(store, pendingLinks, undefined, oldWikilinksByBlock, artifactId);
    }
  }

  // Also trigger retryDanglingRefs across store
  retryDanglingRefs(store);

  const reportAfter = checkLinkIntegrity(store);

  return {
    reportBefore,
    repairedArtifacts,
    reportAfter,
  };
}
