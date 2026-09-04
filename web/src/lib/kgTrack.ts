/**
 * `kg:track` — registers/refreshes lightweight ArtifactNodes for tracked files, via the shared
 * ApeironNgn service (Aperas-apeironngn-design.md §4 rollout step 5). `runTrack` also doubles as
 * the operation `service.ts` dispatches to directly, which is why it takes a live `Store` rather
 * than doing its own rehydrate/dehydrate. A given path may be a directory (`expandArtifactPaths`),
 * tracking every artifact file under it recursively — `kg:track archive` tracks the whole folder.
 */

import type { Store } from 'oxigraph';
import { trackArtifact, trackAllArtifacts } from './apeironNgn/artifacts';
import { isReadmeFilename, expandArtifactPaths } from './artifacts';
import { ensureServiceRunning, request } from './apeironNgn/serviceClient';
import { wantsHelp, printHelp } from './kgHelp';

export interface TrackResult {
  trackedCount: number;
  skippedCount: number;
  skippedReadmes: string[];
  renamed?: number;
  removed?: number;
}

export function runTrack(store: Store, paths: string[]): TrackResult {
  if (paths.length > 0) {
    const expandedPaths = expandArtifactPaths(paths);
    const readmeArgs = expandedPaths.filter((p) => isReadmeFilename(p.split('/').pop() ?? p));
    const trackablePaths = expandedPaths.filter((p) => !readmeArgs.includes(p));
    const results = trackablePaths.map((p) => trackArtifact(store, p));
    const trackedCount = results.filter((r) => r.tracked).length;
    return { trackedCount, skippedCount: results.length - trackedCount, skippedReadmes: readmeArgs };
  }
  const { results, sweep } = trackAllArtifacts(store);
  const trackedCount = results.filter((r) => r.tracked).length;
  return { trackedCount, skippedCount: results.length - trackedCount, skippedReadmes: [], renamed: sweep.renamed, removed: sweep.removed };
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  if (wantsHelp(rawArgs)) {
    printHelp({
      description: 'Register/refresh ArtifactNodes for tracked files.',
      usage: 'kg:track -- [<path>...] [--flush] [--reload]',
      args: [
        { name: '<path>...', description: 'Files or directories under AperasKG/artifacts/ to track (a directory tracks everything under it recursively). Omit to sweep every file under AperasKG/artifacts/.' },
      ],
      flags: [
        { name: '--flush', description: 'Force an immediate sync to disk after this call, instead of waiting for the normal flush timer.' },
        { name: '--reload', description: 'Reload the store from disk first, in case something else (e.g. a git pull) changed it since the service started.' },
      ],
    });
    return;
  }
  const flush = rawArgs.includes('--flush');
  const reload = rawArgs.includes('--reload');
  const paths = rawArgs.filter((p) => p !== '--flush' && p !== '--reload');

  await ensureServiceRunning();
  const result = await request<TrackResult>({ op: 'track', paths, flush, reload });

  for (const p of result.skippedReadmes) {
    console.warn(`[ApeironNgn kg:track] '${p}' is a README — it's absorbed into its FolderNode, not tracked as an ordinary artifact. Skipping.`);
  }
  const extra = result.renamed !== undefined ? `, ${result.renamed} renamed, ${result.removed} removed` : '';
  console.log(`[ApeironNgn kg:track] Tracked ${result.trackedCount} artifact(s), skipped ${result.skippedCount} unchanged${extra}.`);
}

if (process.argv[1]?.endsWith('kgTrack.ts')) {
  main().catch((err) => {
    console.error('[ApeironNgn kg:track] Failed:', err.message || err);
    process.exit(1);
  });
}
