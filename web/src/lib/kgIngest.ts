/**
 * `kg:ingest` — AST-parses and commits every changed tracked artifact's fractal BlockNode tree,
 * then rebuilds the FolderNode structural tree, via the shared ApeironNgn service
 * (Aperas-apeironngn-design.md §4 rollout step 5).
 */

import type { Store } from 'oxigraph';
import { ingestAllArtifacts } from './apeironNgn/artifacts';
import { ingestFolderTree } from './apeironNgn/folders';
import { ensureServiceRunning, request } from './apeironNgn/serviceClient';

export function runIngest(store: Store) {
  const ingested = ingestAllArtifacts(store);
  const { folderCount, sweep } = ingestFolderTree(store);
  return { ingested, folderCount, renamed: sweep.renamed, removed: sweep.removed };
}

async function main(): Promise<void> {
  const flush = process.argv.slice(2).includes('--flush');
  await ensureServiceRunning();
  const result = await request<ReturnType<typeof runIngest>>({ op: 'ingest', flush });

  if (result.ingested.length === 0) {
    console.log('[ApeironNgn kg:ingest] No artifacts required ingestion.');
  } else {
    for (const r of result.ingested) {
      const recon = r.reconciliation;
      const reconSummary = recon ? ` (reconciled: ${recon.unchanged} unchanged, ${recon.moved} moved, ${recon.added} added, ${recon.removed} removed)` : '';
      console.log(`[ApeironNgn kg:ingest] Ingested '${r.path}' fractal tree (${r.blockCount} blocks)${reconSummary}.`);
    }
  }
  console.log(`[ApeironNgn kg:ingest] Rebuilt FolderNode structural tree (${result.folderCount} folder(s), ${result.renamed} renamed, ${result.removed} removed).`);
}

if (process.argv[1]?.endsWith('kgIngest.ts')) {
  main().catch((err) => {
    console.error('[ApeironNgn kg:ingest] Failed:', err.message || err);
    process.exit(1);
  });
}
