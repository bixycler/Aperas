/**
 * `kg:ingest`, migrated to ApeironNgn (Aperas-apeironngn-design.md §4 rollout) — AST-parses and
 * commits every changed tracked artifact's fractal BlockNode tree, then rebuilds the FolderNode
 * structural tree, reading/writing a rehydrated in-process Store instead of TerminusDB.
 * Dehydrates once at the very end, same one-shot-batch reasoning as `kgTrackNgn.ts`.
 */

import { rehydrateStore } from './apeironNgn/store';
import { dehydrateToJsonLd } from './apeironNgn/dehydrate';
import { ingestAllArtifacts } from './apeironNgn/artifacts';
import { ingestFolderTree } from './apeironNgn/folders';

function main(): void {
  const { store } = rehydrateStore();

  const ingested = ingestAllArtifacts(store);
  if (ingested.length === 0) {
    console.log('[ApeironNgn kg:ingest] No artifacts required ingestion.');
  } else {
    for (const r of ingested) {
      const recon = r.reconciliation;
      const reconSummary = recon ? ` (reconciled: ${recon.unchanged} unchanged, ${recon.moved} moved, ${recon.added} added, ${recon.removed} removed)` : '';
      console.log(`[ApeironNgn kg:ingest] Ingested '${r.path}' fractal tree (${r.blockCount} blocks)${reconSummary}.`);
    }
  }

  const { folderCount, sweep } = ingestFolderTree(store);
  console.log(`[ApeironNgn kg:ingest] Rebuilt FolderNode structural tree (${folderCount} folder(s), ${sweep.renamed} renamed, ${sweep.removed} removed).`);

  dehydrateToJsonLd(store);
}

try {
  main();
} catch (err: any) {
  console.error('[ApeironNgn kg:ingest] Failed:', err.message || err);
  process.exit(1);
}
