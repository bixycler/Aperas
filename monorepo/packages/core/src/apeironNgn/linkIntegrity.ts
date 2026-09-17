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
import { wrap, type BlockNode, type Link, type TreeNode } from './node';
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
  let totalLiveBlocks = 0;
  let blocksWithLinkText = 0;
  const discrepancies: LinkDiscrepancy[] = [];

  for (const id of allIdsOfKind(store, 'BlockNode')) {
    const block = wrap(store, id) as unknown as BlockNode;
    if (block.tombstonedAt) continue;
    totalLiveBlocks++;

    const text = block.text;
    if (!text) continue;

    const occurrences: LinkOccurrence[] = collectLinkCodesFromText(text);
    if (occurrences.length === 0) continue;

    blocksWithLinkText++;

    const actualLinks = (block.links as unknown as Link[] | undefined) ?? [];
    const actualTargetIds = new Set(actualLinks.map((l) => l.target?.id).filter((tid): tid is string => !!tid));
    const basePath = block.toPath();
    const artifactPath = artifactPathOfBlock(block);
    const missingCodes: string[] = [];

    for (const occ of occurrences) {
      const code = occ.code;
      let resolved: string | null = null;
      try {
        resolved = resolveOneCode(store, code, basePath, artifactPath, false);
      } catch {
        resolved = null; // an ambiguity/lookup failure here is "no confident candidate," not a crash
      }
      // Only a code that genuinely resolves and is still missing from `.links` counts — see this
      // function's own doc comment for why an unresolved code is deliberately not reported here.
      if (resolved && !actualTargetIds.has(resolved)) {
        missingCodes.push(code);
      }
    }

    if (missingCodes.length > 0) {
      discrepancies.push({
        blockId: block.id,
        artifactPath: artifactPathOfBlock(block),
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
 * Re-runs link resolution and dangling ref retries for artifacts containing link integrity discrepancies.
 */
export function repairLinkIntegrity(store: Store): RepairLinkIntegrityResult {
  const reportBefore = checkLinkIntegrity(store);
  const affectedArtifacts = new Set<string>();

  for (const d of reportBefore.discrepancies) {
    if (d.artifactPath) {
      affectedArtifacts.add(d.artifactPath);
    }
  }

  const repairedArtifacts = Array.from(affectedArtifacts);

  for (const artifactPath of repairedArtifacts) {
    const artifactId = findByExactPath(store, artifactPath);
    if (!artifactId) continue;

    const artifactNode = wrap(store, artifactId) as unknown as TreeNode;
    const blocks = collectAllBlockNodes(artifactNode);

    const pendingLinks: PendingLinkCodes[] = [];
    for (const block of blocks) {
      if (!block.text) continue;
      const codes = collectLinkCodesFromText(block.text);
      if (codes.length > 0) {
        const bareId = block.id.startsWith('BlockNode:') ? block.id.slice('BlockNode:'.length) : block.id;
        pendingLinks.push({ blockId: bareId, codes });
      }
    }

    if (pendingLinks.length > 0) {
      resolveBlockLinks(store, pendingLinks, undefined, undefined, artifactId);
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
