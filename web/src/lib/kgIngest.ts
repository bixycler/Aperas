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
 *
 * Reconciling real disk content against the graph is only ever supposed to be a secondary,
 * occasional direction now — `kg:project` (graph → disk) is the normal one (Aperas-crud-design.md
 * §14). So whenever this would actually remove something (an artifact's reconciliation tombstoning
 * a node, or the folder sweep tombstoning a whole removed Folder/Artifact), it's held back and
 * reported instead of applied silently: this CLI prints what would be removed and asks for
 * confirmation (default NO). `--force` skips the prompt and applies it unconditionally — for
 * scripted/hook use, where nothing can answer a prompt.
 */

import { createInterface } from 'node:readline/promises';
import type { Store } from 'oxigraph';
import { expandArtifactPaths } from './artifacts';
import { runTrack, type TrackResult } from './kgTrack';
import { ingestAllArtifacts, ingestArtifacts, findLiveArtifactByPath, trackArtifact, retryDanglingRefs } from './apeironNgn/artifacts';
import { ingestFolderTree } from './apeironNgn/folders';
import { createLineReader } from './lineReader';
import { ensureServiceRunning, request } from './apeironNgn/serviceClient';
import { wantsHelp, printHelp } from './kgHelp';

/** `force` (Aperas-crud-design.md §14): threaded into both destructive-removal sites this
 *  orchestrates — the per-artifact content reconciliation (`ingestArtifact`/`ingestFromDisk`) and
 *  the FolderNode structural sweep (`ingestFolderTree`). Without it, either one can hold back a
 *  removal it would otherwise have applied, reporting it instead so the CLI client can confirm
 *  interactively (or the caller can just retry with `force: true`). */
export function runIngest(store: Store, paths: string[] = [], track: boolean = false, force: boolean = false) {
  const trackResult: TrackResult | null = track ? runTrack(store, paths, force) : null;

  // Every explicit path must be tracked *before* the folder tree gets rebuilt below — otherwise a
  // brand-new file's own containing folder wouldn't be attached into the tree in time for its own
  // wikilinks (resolved during the content-ingestion step further down) to see a consistent tree.
  if (paths.length > 0) {
    for (const path of expandArtifactPaths(paths)) {
      if (!findLiveArtifactByPath(store, path)) trackArtifact(store, path);
    }
  }

  const { folderCount, sweep, pendingRemovals } = ingestFolderTree(store, force);

  const { ingested, untracked } = paths.length > 0
    ? { ingested: ingestArtifacts(store, paths, force), untracked: [] as string[] }
    : ingestAllArtifacts(store, force);

  // Cross-artifact dangling-reference retry (AperasKG/artifacts/history/linking.md's Milestones):
  // an artifact whose own text never changes never gets re-ingested on its own, so a link it
  // couldn't resolve last time stays stale even after whatever it was looking for comes into
  // existence elsewhere in this same run. Runs last, once the folder tree and every explicitly-
  // requested artifact are both already settled, so it sees the fullest possible picture.
  const retriedDanglingRefs = retryDanglingRefs(store, force);

  return { trackResult, ingested, untracked, folderCount, renamed: sweep.renamed, removed: sweep.removed, pendingFolderRemovals: pendingRemovals, retriedDanglingRefs };
}

type IngestResponse = Awaited<ReturnType<typeof runIngest>>;

function printCommitted(ingested: Array<IngestResponse['ingested'][number]>, result: IngestResponse): void {
  if (ingested.length === 0) {
    console.log('[ApeironNgn kg:ingest] No artifacts required ingestion.');
  } else {
    for (const r of ingested) {
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
  if (result.retriedDanglingRefs.length > 0) {
    console.log(`[ApeironNgn kg:ingest] Re-resolved links in ${result.retriedDanglingRefs.length} artifact(s) whose own text didn't change but a target they reference just did: ${result.retriedDanglingRefs.join(', ')}.`);
  }
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  if (wantsHelp(rawArgs)) {
    printHelp({
      description: "AST-parse and commit changed tracked artifacts' fractal trees, then rebuild the FolderNode structural tree.",
      usage: 'kg:ingest -- [<path>...] [--track] [--force] [--flush] [--reload]',
      args: [
        { name: '<path>...', description: "Files or directories to ingest, tracking each one first if it isn't tracked yet. Omit to sweep every already-tracked artifact." },
      ],
      flags: [
        { name: '--track', description: "Run a kg:track refresh against the same paths first (or a full sweep, given none) — without it, an on-disk edit to an already-tracked file is invisible to ingestion until something else re-reads it." },
        { name: '--force', description: "Apply every removal this run would otherwise hold back for confirmation, without prompting. Use for non-interactive/scripted runs (e.g. a git hook)." },
        { name: '--flush', description: 'Force an immediate sync to disk after this call, instead of waiting for the normal flush timer.' },
        { name: '--reload', description: 'Reload the store from disk first, in case something else (e.g. a git pull) changed it since the service started.' },
      ],
    });
    return;
  }
  const flush = rawArgs.includes('--flush');
  const reload = rawArgs.includes('--reload');
  const track = rawArgs.includes('--track');
  const force = rawArgs.includes('--force');
  const paths = rawArgs.filter((p) => p !== '--flush' && p !== '--reload' && p !== '--track' && p !== '--force');
  await ensureServiceRunning();
  let result = await request<IngestResponse>({ op: 'ingest', paths, flush, reload, track, force });

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

  const pendingArtifacts = result.ingested.filter((r) => r.pendingConfirmation);
  const committedArtifacts = result.ingested.filter((r) => !r.pendingConfirmation);
  const pendingTrackedRemovals = result.trackResult?.pendingRemovals ?? [];

  if (!force && (pendingArtifacts.length > 0 || result.pendingFolderRemovals.length > 0 || pendingTrackedRemovals.length > 0)) {
    console.log('\n[ApeironNgn kg:ingest] The following would be permanently removed:');
    for (const r of pendingArtifacts) {
      console.log(`  '${r.path}':`);
      const preview = r.pendingConfirmation!.slice(0, 10);
      for (const t of preview) console.log(`    - [${t.type ?? '?'}] ${t.title ?? t.blockId}`);
      if (r.pendingConfirmation!.length > preview.length) {
        console.log(`    ...and ${r.pendingConfirmation!.length - preview.length} more`);
      }
    }
    for (const p of result.pendingFolderRemovals) {
      console.log(`  '${p}' (folder)`);
    }
    for (const p of pendingTrackedRemovals) {
      console.log(`  '${p}' (untracked from disk)`);
    }

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const lines = createLineReader(rl);
    process.stdout.write('\nAre you sure you want to remove these? [yes/NO]: ');
    const raw = await lines.next();
    rl.close();
    const answer = (raw ?? '').trim().toLowerCase();

    if (answer === 'yes' || answer === 'y') {
      result = await request<IngestResponse>({ op: 'ingest', paths, flush, reload: false, track: false, force: true });
    } else {
      console.log('[ApeironNgn kg:ingest] Skipped — nothing was removed. Re-run with --force, or answer yes, to apply.');
      printCommitted(committedArtifacts, result);
      return;
    }
  }

  printCommitted(result.ingested.filter((r) => !r.pendingConfirmation), result);
}

if (process.argv[1]?.endsWith('kgIngest.ts')) {
  main().catch((err) => {
    console.error('[ApeironNgn kg:ingest] Failed:', err.message || err);
    process.exit(1);
  });
}
