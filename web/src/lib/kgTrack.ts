/**
 * `kg:track` — registers/refreshes lightweight ArtifactNodes for tracked files, via the shared
 * ApeironNgn service (Aperas-apeironngn-design.md §4 rollout step 5). `runTrack` also doubles as
 * the operation `service.ts` dispatches to directly, which is why it takes a live `Store` rather
 * than doing its own rehydrate/dehydrate. A given path may be a directory (`expandArtifactPaths`),
 * tracking every artifact file under it recursively — `kg:track archive` tracks the whole folder.
 *
 * `--reverse` (Aperas-crud-design.md §15) runs `runReverseTrack` instead: the same kind of cheap,
 * read-only drift *report* as plain `kg:track`, just pointed the other way — which real ArtifactNode/
 * FolderNode subtrees have graph-side content `kg:project` hasn't caught up to yet. Never writes to
 * disk or mutates the store; `kg:project` stays the deliberate, separate write, mirroring how
 * `kg:ingest` stays separate from plain `kg:track` today.
 */

import { createInterface } from 'node:readline/promises';
import type { Store } from 'oxigraph';
import { trackArtifact, trackAllArtifacts } from './apeironNgn/artifacts';
import { isReadmeFilename, expandArtifactPaths, listArtifactFiles, computeFileHash } from './artifacts';
import { wrap, type ArtifactNode, type FolderNode } from './apeironNgn/node';
import { allIdsOfKind } from './apeironNgn/dehydrate';
import { createLineReader } from './lineReader';
import { ensureServiceRunning, request } from './apeironNgn/serviceClient';
import { wantsHelp, printHelp } from './kgHelp';

export interface TrackResult {
  trackedCount: number;
  skippedCount: number;
  skippedReadmes: string[];
  renamed?: number;
  removed?: number;
  pendingRemovals?: string[];
}

/** `force` (Aperas-crud-design.md §14): only meaningful for the no-`paths` sweep — an explicit
 *  `<path>...` list only ever tracks/refreshes, it never runs the whole-corpus rename/removal sweep
 *  `trackAllArtifacts` owns, so there's nothing for `force` to gate in that branch. */
export function runTrack(store: Store, paths: string[], force: boolean = false): TrackResult {
  if (paths.length > 0) {
    const expandedPaths = expandArtifactPaths(paths);
    const readmeArgs = expandedPaths.filter((p) => isReadmeFilename(p.split('/').pop() ?? p));
    const trackablePaths = expandedPaths.filter((p) => !readmeArgs.includes(p));
    const results = trackablePaths.map((p) => trackArtifact(store, p));
    const trackedCount = results.filter((r) => r.tracked).length;
    return { trackedCount, skippedCount: results.length - trackedCount, skippedReadmes: readmeArgs };
  }
  const { results, sweep, pendingRemovals } = trackAllArtifacts(store, force);
  const trackedCount = results.filter((r) => r.tracked).length;
  return { trackedCount, skippedCount: results.length - trackedCount, skippedReadmes: [], renamed: sweep.renamed, removed: sweep.removed, pendingRemovals };
}

export interface ReverseTrackEntry {
  path: string;
  kind: 'ArtifactNode' | 'FolderNode';
}

export interface ReverseTrackResult {
  /** Real content that's never been written to disk at all (`projectedHash` never set) — a holder
   *  populated via `kg:insert`/`kg:update` but never yet projected is the typical case. */
  neverProjected: ReverseTrackEntry[];
  /** Real content whose current render no longer matches what `kg:project` last actually wrote —
   *  drifted since the last projection, via further `kg:insert`/`kg:update`/`kg:remove` edits. */
  changed: ReverseTrackEntry[];
  /** Artifact paths that are tombstoned in-graph but still present on disk — `kg:project` only
   *  ever writes, never deletes, so a graph-side removal never reaches the file on its own. */
  staleOnDisk: string[];
}

/** `kg:track`, reversed (Aperas-crud-design.md §15): a cheap, read-only pass — no store mutation,
 *  no disk write — that reports which real (non-tombstoned) ArtifactNode/FolderNode subtrees have
 *  drifted from their last-projected disk state, by recomputing each one's current render
 *  (`toMarkdown`/`toReadme`, pure in-memory) and comparing its hash against `projectedHash`
 *  (`kg:project`'s own write-time baseline — see its doc comment). Mirrors forward `kg:track`'s own
 *  character exactly: cheap bookkeeping/detection, safe to run often, with the actual heavy write
 *  (`kg:project`, the mirror image of `kg:ingest`) staying a deliberate, separate, explicit step. */
export function runReverseTrack(store: Store): ReverseTrackResult {
  const neverProjected: ReverseTrackEntry[] = [];
  const changed: ReverseTrackEntry[] = [];

  for (const id of allIdsOfKind(store, 'ArtifactNode')) {
    const node = wrap(store, id) as unknown as ArtifactNode;
    if (node.tombstonedAt) continue;
    const markdown = node.toMarkdown();
    if (markdown === null) continue; // nothing to project yet
    const hash = computeFileHash(markdown);
    if (node.projectedHash === undefined) neverProjected.push({ path: node.path as string, kind: 'ArtifactNode' });
    else if (node.projectedHash !== hash) changed.push({ path: node.path as string, kind: 'ArtifactNode' });
  }

  for (const id of allIdsOfKind(store, 'FolderNode')) {
    const node = wrap(store, id) as unknown as FolderNode;
    if (node.tombstonedAt) continue;
    const markdown = node.toReadme();
    if (!markdown) continue; // empty README — nothing meaningful to project
    const hash = computeFileHash(markdown);
    if (node.projectedHash === undefined) neverProjected.push({ path: node.path as string, kind: 'FolderNode' });
    else if (node.projectedHash !== hash) changed.push({ path: node.path as string, kind: 'FolderNode' });
  }

  const diskFiles = new Set(listArtifactFiles());
  const staleOnDisk: string[] = [];
  for (const id of allIdsOfKind(store, 'ArtifactNode')) {
    const node = wrap(store, id) as unknown as ArtifactNode;
    if (!node.tombstonedAt) continue;
    if (node.path && diskFiles.has(node.path as string)) staleOnDisk.push(node.path as string);
  }

  return { neverProjected, changed, staleOnDisk };
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  if (wantsHelp(rawArgs)) {
    printHelp({
      description: 'Register/refresh ArtifactNodes for tracked files.',
      usage: [
        'kg:track -- [<path>...] [--force] [--flush] [--reload]',
        'kg:track -- --reverse [--reload]',
      ],
      args: [
        { name: '<path>...', description: 'Files or directories under AperasKG/artifacts/ to track (a directory tracks everything under it recursively). Omit to sweep every file under AperasKG/artifacts/.' },
      ],
      flags: [
        { name: '--reverse', description: "Report which real ArtifactNode/FolderNode subtrees have graph-side content not yet reflected on disk, instead of tracking disk files. Read-only — writes nothing, run kg:project to actually catch disk up." },
        { name: '--force', description: "Apply every removal a full sweep (no <path>...) would otherwise hold back for confirmation, without prompting. Use for non-interactive/scripted runs (e.g. a git hook)." },
        { name: '--flush', description: 'Force an immediate sync to disk after this call, instead of waiting for the normal flush timer.' },
        { name: '--reload', description: 'Reload the store from disk first, in case something else (e.g. a git pull) changed it since the service started.' },
      ],
    });
    return;
  }
  const reload = rawArgs.includes('--reload');

  if (rawArgs.includes('--reverse')) {
    await ensureServiceRunning();
    const result = await request<ReverseTrackResult>({ op: 'trackReverse', reload });
    if (result.neverProjected.length === 0 && result.changed.length === 0 && result.staleOnDisk.length === 0) {
      console.log('[ApeironNgn kg:track --reverse] Everything is projected and up to date.');
      return;
    }
    if (result.neverProjected.length > 0) {
      console.log('[ApeironNgn kg:track --reverse] Never projected (kg:project has never written these):');
      for (const e of result.neverProjected) console.log(`  [${e.kind}] '${e.path}'`);
    }
    if (result.changed.length > 0) {
      console.log('[ApeironNgn kg:track --reverse] Changed since last projection:');
      for (const e of result.changed) console.log(`  [${e.kind}] '${e.path}'`);
    }
    if (result.staleOnDisk.length > 0) {
      console.log('[ApeironNgn kg:track --reverse] Removed in-graph but still on disk (kg:project never deletes — remove manually if intended):');
      for (const p of result.staleOnDisk) console.log(`  '${p}'`);
    }
    return;
  }

  const flush = rawArgs.includes('--flush');
  const force = rawArgs.includes('--force');
  const paths = rawArgs.filter((p) => p !== '--flush' && p !== '--reload' && p !== '--force');

  await ensureServiceRunning();
  let result = await request<TrackResult>({ op: 'track', paths, flush, reload, force });

  for (const p of result.skippedReadmes) {
    console.warn(`[ApeironNgn kg:track] '${p}' is a README — it's absorbed into its FolderNode, not tracked as an ordinary artifact. Skipping.`);
  }

  const pendingRemovals = result.pendingRemovals ?? [];
  if (!force && pendingRemovals.length > 0) {
    console.log('\n[ApeironNgn kg:track] The following would be permanently removed (no matching file found on disk):');
    for (const p of pendingRemovals) console.log(`  '${p}'`);

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const lines = createLineReader(rl);
    process.stdout.write('\nAre you sure you want to remove these? [yes/NO]: ');
    const raw = await lines.next();
    rl.close();
    const answer = (raw ?? '').trim().toLowerCase();

    if (answer === 'yes' || answer === 'y') {
      result = await request<TrackResult>({ op: 'track', paths, flush, reload: false, force: true });
    } else {
      console.log('[ApeironNgn kg:track] Skipped — nothing was removed. Re-run with --force, or answer yes, to apply.');
    }
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
