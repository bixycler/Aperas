/**
 * Link Integrity Check & Repair Sweep — `issues/linking.md` Shared Fix Direction:
 * Compares live `BlockNode` text against stored `.links` RDF triples in Oxigraph Store.
 * Detects live nodes whose text contains internal-style link occurrences (`[[code]]`,
 * `aperas://...`, `path#fragment`) but whose `.links` property in store lacks a matching
 * resolved `Link` (or where `.links` is empty).
 */

import type { Store } from 'oxigraph';
import { wrap, type BlockNode, type Link, type TreeNode } from './node';
import { allIdsOfKind } from './dehydrate';
import { collectLinkCodesFromText, type LinkOccurrence } from '../astParser';
import { resolveBlockLinks, retryDanglingRefs } from './artifacts';
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
  /** Missing or unresolved link codes in store */
  missingCodes: string[];
  /** Actual resolved Link objects attached to node in store */
  resolvedLinks: { id: string; targetId: string | null; code: string | null }[];
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
 * Sweeps the entire Oxigraph Store for live BlockNodes and compares their text against stored `.links`.
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
    const missingCodes: string[] = [];

    for (const occ of occurrences) {
      const code = occ.code;
      // Check if any actual link in block.links matches this code or target
      const match = actualLinks.some((l) => {
        if (l.code === code) return true;
        if (l.target?.id) {
          // Check if code contains target id or target matches code resolution
          if (code.includes(l.target.id) || l.target.id.includes(code)) return true;
        }
        return false;
      });

      if (!match) {
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
          code: l.code ?? null,
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
