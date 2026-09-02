/**
 * `kg:track`, migrated to ApeironNgn (Aperas-apeironngn-design.md §4 rollout) — registers/refreshes
 * lightweight ArtifactNodes for tracked files, reading/writing a rehydrated in-process Store
 * instead of TerminusDB. Dehydrates once at the very end (a one-shot batch CLI run, unlike
 * `kg:title`/`kg:link`'s interactive per-answer persistence — nothing here waits on further input
 * mid-run for a crash to lose).
 */

import { rehydrateStore } from './apeironNgn/store';
import { dehydrateToJsonLd } from './apeironNgn/dehydrate';
import { trackArtifact, trackAllArtifacts } from './apeironNgn/artifacts';
import { isReadmeFilename } from './artifacts';

function main(): void {
  const paths = process.argv.slice(2);
  const { store } = rehydrateStore();

  if (paths.length > 0) {
    const readmeArgs = paths.filter((p) => isReadmeFilename(p.split('/').pop() ?? p));
    for (const p of readmeArgs) {
      console.warn(`[ApeironNgn kg:track] '${p}' is a README — it's absorbed into its FolderNode, not tracked as an ordinary artifact. Skipping.`);
    }
    const trackablePaths = paths.filter((p) => !readmeArgs.includes(p));
    const results = trackablePaths.map((p) => trackArtifact(store, p));
    const trackedCount = results.filter((r) => r.tracked).length;
    const skippedCount = results.length - trackedCount;
    dehydrateToJsonLd(store);
    console.log(`[ApeironNgn kg:track] Tracked ${trackedCount} artifact(s), skipped ${skippedCount} unchanged.`);
  } else {
    const { results, sweep } = trackAllArtifacts(store);
    const trackedCount = results.filter((r) => r.tracked).length;
    const skippedCount = results.length - trackedCount;
    dehydrateToJsonLd(store);
    console.log(`[ApeironNgn kg:track] Tracked ${trackedCount} artifact(s), skipped ${skippedCount} unchanged, ${sweep.renamed} renamed, ${sweep.removed} removed.`);
  }
}

try {
  main();
} catch (err: any) {
  console.error('[ApeironNgn kg:track] Failed:', err.message || err);
  process.exit(1);
}
