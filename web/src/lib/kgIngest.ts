/**
 * `kg:ingest` — AST-parses and commits changed tracked artifacts' fractal BlockNode trees, then
 * rebuilds the FolderNode structural tree, via the shared ApeironNgn service
 * (Aperas-apeironngn-design.md §4 rollout step 5).
 *
 * With no path args, sweeps every file under `AperasKG/artifacts/`, ingesting the ones already
 * tracked and warning (not failing) on any that aren't. Given explicit paths, targets exactly
 * those, tracking each one first if it isn't tracked yet.
 *
 * `--track` folds `kg:track`'s own refresh in first, against the same paths (or a full
 * `trackAllArtifacts` sweep, given none) — `kg:ingest`'s own check is `ingestedHash === fileHash`
 * (has the *tracked* hash moved since last ingestion), separate from the file on disk having
 * changed; without a fresh `kg:track`, an on-disk edit to an already-tracked artifact is invisible
 * to it. `kg:ingest <path> --track` is `kg:track <path> && kg:ingest <path>` in one call.
 */

import type { Store } from 'oxigraph';
import { expandArtifactPaths } from './artifacts';
import { runTrack, type TrackResult } from './kgTrack';
import { ingestAllArtifacts, ingestArtifacts, findLiveArtifactByPath, trackArtifact } from './apeironNgn/artifacts';
import { ingestFolderTree } from './apeironNgn/folders';
import { ensureServiceRunning, request } from './apeironNgn/serviceClient';
import { wantsHelp, printHelp } from './kgHelp';

export function runIngest(store: Store, paths: string[] = [], track: boolean = false) {
  const trackResult: TrackResult | null = track ? runTrack(store, paths) : null;

  // Every explicit path must be tracked *before* the folder tree gets rebuilt below — otherwise a
  // brand-new file's own containing folder wouldn't be attached into the tree in time for its own
  // wikilinks (resolved during the content-ingestion step further down) to see a consistent tree.
  if (paths.length > 0) {
    for (const path of expandArtifactPaths(paths)) {
      if (!findLiveArtifactByPath(store, path)) trackArtifact(store, path);
    }
  }

  const { folderCount, sweep } = ingestFolderTree(store);

  const { ingested, untracked } = paths.length > 0
    ? { ingested: ingestArtifacts(store, paths), untracked: [] as string[] }
    : ingestAllArtifacts(store);

  return { trackResult, ingested, untracked, folderCount, renamed: sweep.renamed, removed: sweep.removed };
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  if (wantsHelp(rawArgs)) {
    printHelp({
      description: "AST-parse and commit changed tracked artifacts' fractal trees, then rebuild the FolderNode structural tree.",
      usage: 'kg:ingest -- [<path>...] [--track] [--flush] [--reload]',
      args: [
        { name: '<path>...', description: "Files or directories to ingest, tracking each one first if it isn't tracked yet. Omit to sweep every already-tracked artifact." },
      ],
      flags: [
        { name: '--track', description: "Run a kg:track refresh against the same paths first (or a full sweep, given none) — without it, an on-disk edit to an already-tracked file is invisible to ingestion until something else re-reads it." },
        { name: '--flush', description: 'Force an immediate sync to disk after this call, instead of waiting for the normal flush timer.' },
        { name: '--reload', description: 'Reload the store from disk first, in case something else (e.g. a git pull) changed it since the service started.' },
      ],
    });
    return;
  }
  const flush = rawArgs.includes('--flush');
  const reload = rawArgs.includes('--reload');
  const track = rawArgs.includes('--track');
  const paths = rawArgs.filter((p) => p !== '--flush' && p !== '--reload' && p !== '--track');
  await ensureServiceRunning();
  const result = await request<ReturnType<typeof runIngest>>({ op: 'ingest', paths, flush, reload, track });

  if (result.trackResult) {
    for (const p of result.trackResult.skippedReadmes) {
      console.warn(`[ApeironNgn kg:ingest] '${p}' is a README — it's absorbed into its FolderNode, not tracked as an ordinary artifact. Skipping.`);
    }
    const extra = result.trackResult.renamed !== undefined ? `, ${result.trackResult.renamed} renamed, ${result.trackResult.removed} removed` : '';
    console.log(`[ApeironNgn kg:ingest] Tracked ${result.trackResult.trackedCount} artifact(s), skipped ${result.trackResult.skippedCount} unchanged${extra}.`);
  }
  for (const p of result.untracked) {
    console.warn(`[ApeironNgn kg:ingest] '${p}' is not tracked yet — skipping (run kg:track, or pass --track, or pass it directly to kg:ingest).`);
  }
  if (result.ingested.length === 0) {
    console.log('[ApeironNgn kg:ingest] No artifacts required ingestion.');
  } else {
    for (const r of result.ingested) {
      const recon = r.reconciliation;
      const reconSummary = recon ? ` (reconciled: ${recon.matched} matched, ${recon.moved} moved, ${recon.changed} changed, ${recon.added} added, ${recon.removed} removed)` : '';
      console.log(`[ApeironNgn kg:ingest] Ingested '${r.path}' fractal tree (${r.blockCount} blocks)${reconSummary}.`);
      const links = r.linkResolution;
      if (links.resolved + links.dangling > 0) {
        console.log(`[ApeironNgn kg:ingest]   Links: ${links.resolved} resolved, ${links.dangling} dangling, ${links.changed} changed.`);
      }
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
