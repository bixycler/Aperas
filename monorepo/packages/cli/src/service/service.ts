/**
 * ApeironNgn shared service process (Aperas-apeironngn-design.md §4 rollout step 5) — holds one
 * loaded `Db` (the engine, its maps and the files of the mirror, `shell/db.ts`) in memory across CLI invocations instead of every
 * `kg:xxx` script loading/dumping the whole mirror on its own. Listens on a Unix domain socket; every request is
 * serialized through `enqueue()` so concurrent connections never interleave store mutations.
 *
 * Each graph is flushed on its own (planning/core.md, Batch 11 step 8): the table of settings (`graphConfig.ts`, `resolveGraphSettings`, read from the
 * configuration above the mirror at boot) gives every graph its directory and its flush interval, one timer runs for each graph at its interval
 * (the defaults are the main graph `tree` every 10 s, and `threads.tree` and `treeviews`, the git-ignored `.state/`, every 3 s), and a graph is
 * flushed when it was written (`Db.changed`, which the write layer fills: an op does not say which graph it dirtied, the write layer knows) or
 * immediately when a request carries `flush: true`. Exits after 30 idle minutes or on SIGTERM/SIGINT, flushing every graph written either way.
 *
 * Started explicitly by `aperas service start`/`restart` (`kgService.ts`) — not meant to be run
 * directly, though doing so still works: `getApeironExportDir()`/`getArtifactsDir()` below are
 * called with no argument, so their own default resolution applies — `APERAS_APEIRON_ROOT`/
 * `APERAS_ARTIFACTS_ROOT` (set by `serviceClient.ts#spawnService` in the env of the process it
 * spawns) if present, else the same cwd-or-fallback default a direct run would get anyway (see
 * `graphConfig.ts`'s own doc comment). A direct run just skips the lock-claim race and the graph
 * resolution that only matter when going through the real `start`/`restart` path.
 *
 * A mirror the load did not read in full (design/packaging.md, the rule for a load that rejects a document): when the load returns `rejected` or `errors`
 * the service refuses to start and a reload refuses to replace the graph in memory, naming the files and ids in the log and the response, because a flush
 * would write each file whole and remove what the load skipped. The start-anyway option (`--start-anyway` of `aperas service start`/`restart` and of
 * `aperas reload`) accepts such a load: before anything can flush, the raw documents the load skipped are copied to a side file next to their file
 * (`<file>.rejected-<UTC stamp>.json`, the `.state/` files too), and the service works on the unaffected parts. The load's `warnings` are logged and the
 * service starts; the ids referenced and never defined (`dangling`) are logged as one warning and nothing more.
 *
 * Staleness: the `Db` held here is a snapshot from whenever it was last (re)loaded — nothing
 * notices `AperasKG/Apeiron/` changing on disk underneath it (e.g. a `git pull` merging someone
 * else's commit) on its own. `reloadStore()` is the fix, the revived TDB-era `kg:import`'s
 * equivalent: sweeps and flushes every written graph first (so no unflushed in-memory work is silently
 * discarded), then loads a fresh `Db`, swaps it in and frees the old one (`closeDb`: its graphs are dropped). Reachable directly
 * via `{ op: 'reload' }` (`kg:reload`), or implicitly via any op's own `reload: true` — the
 * reciprocal of a mutating op's `flush: true`: `flush` forces a sync *out* immediately after the
 * op runs, `reload` forces a sync *in* immediately before it does, so a write can pick up an
 * external change and persist the result in one round trip.
 *
 * That pre-reload flush is itself guarded (`flushGraph`'s `diverged` check):
 * the dump of the mirror writes each file whole, a blind full-file replace and not a merge, so
 * flushing this process's own pending mutation over a mirror file an *external* write already
 * changed would silently destroy that external content instead of picking it up. The guard compares
 * each file of the graph against what this process last read or wrote; a mismatch refuses
 * the flush (and whatever op triggered it) instead of overwriting, leaving the local mutation
 * pending for a human to reconcile. It's keyed on the hash, not on the graph being written alone — a pending
 * local edit with no external activity at all is the ordinary, harmless case.
 */

import { createServer, type Socket } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { unlinkSync, readFileSync, readdirSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, closeDb, loadRefusal, REFUSAL_SHOWN_IDS, isThreadScoped, type Db, type Opened } from '@aperas/core/shell/db';
import { dumpMirror } from '@aperas/core/shell/mirrorDump';
import { skippedDocuments } from '@aperas/core/shell/mirrorLoad';
import { MAIN_GRAPH, documentsText } from '@aperas/core/shell/mirrorFiles';
import type { GraphName } from '@aperas/core/apeironNgn/interface';
import type { GraphSettings } from '@aperas/core/graphConfig';
import { computeFileHash, getArtifactsDir } from '@aperas/core/artifacts';
import { sweepTombstones, tombstoneVacuousContainers, wrap, type TreeNode } from '@aperas/core/shell/node';
import { checkLinkIntegrity, checkArtifactLinkIntegrity, owningArtifactId, repairLinkIntegrity, type LinkIntegrityReport } from '@aperas/core/shell/linkIntegrity';
import { resolveDeepPath } from '@aperas/core/shell/resolve';
import { resolveEffectiveApeironRoot, resolveEffectiveThreadSizeCap, resolveGraphSettings } from '@aperas/core/graphConfig';
import { getRunDir, getSocketPath, markReady, clearLock, writeToken, resolveHttpPort } from './serviceLock';
import { computeCodeFingerprint } from './codeVersion';
import { encodeMessage, decodeMessage, CONFLICT_RESOLUTION_HINT, START_ANYWAY_ENV, type ServiceRequest, type ServiceResponse } from './serviceProtocol';
import { handleApiRoute, readRequestBody } from './apiRoutes';
import { checkAuth, allowedOrigins } from './listenerAuth';
import { serveStatic } from './staticServe';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** The webapp's built static assets — bundled alongside the CLI binary (Slice 16's `build.mjs`
 *  step) at `dist/web/`, sibling to the bundle itself, so this just works the same way whether
 *  `service.ts` is running from source under `tsx` or inlined into the packaged bundle (every
 *  module's `import.meta.url` collapses to the same bundle file's own location once esbuild
 *  flattens everything into one file — the built path is checked first for exactly that reason).
 *  In dev, falls back to `packages/web/dist`, built separately via `vite build` in that package. */
function resolveWebRoot(): string {
  const builtPath = resolve(__dirname, 'web');
  if (existsSync(builtPath)) return builtPath;
  return resolve(__dirname, '..', '..', '..', 'web', 'dist'); // service -> src -> cli -> packages -> web/dist
}
import { runTrack, runReverseTrack } from '../kgTrack';
import { runIngest } from '../kgIngest';
import { runUnfoldOp } from '../kgUnfold';
import { runFoldOp } from '../kgFold';
import { runZoomOp } from '../kgZoom';
import { runResolve } from '../kgResolve';
import { runInsert } from '../kgInsert';
import { runUpdate } from '../kgUpdate';
import { runRemove } from '../kgRemove';
import { runRetype } from '../kgRetype';
import { runProject } from '../kgProject';
import { runTree } from '../kgTree';
import { runPath } from '../kgPath';
import { runBacklinks } from '../kgBacklinks';
import { runShow } from '../kgShow';
import { runProfileCreate, runProfileList, runProfileRemove, runProfileCreateView, runProfileListView, runProfileRemoveView } from '../kgProfile';

const IDLE_TIMEOUT_MS = 30 * 60_000;

type Stamps = Record<string, string | null>;

/** Content hash of one managed `.jsonld` file, or `null` if it doesn't exist yet (a fresh
 *  `.state/` before anything's ever been unfolded). Used to detect an external write to the
 *  mirror — the dump writes each file whole, a blind full-file replace and not a merge,
 *  so overwriting a file that changed on disk since this process last read it would silently
 *  destroy whatever landed there (another process's `git pull`, a hand-edit). */
function fileHash(path: string): string | null {
  return existsSync(path) ? computeFileHash(readFileSync(path, 'utf-8')) : null;
}

/** The files of the mirror that one graph's flush writes, from the mapping. */
function mirrorFilesOf(db: Db, root: string, graph: GraphName): string[] {
  return db.mapping.filter((m) => m.graph === graph).map((m) => resolve(root, m.file));
}

/** The stamps of files, keyed by the path of the file. */
function stampAll(files: readonly string[]): Stamps {
  const stamps: Stamps = {};
  for (const file of files) stamps[file] = fileHash(file);
  return stamps;
}

/** Which of `files` no longer match their last-known stamp — empty when nothing external touched
 *  the mirror since this process last read or wrote it, regardless of how long ago that was. */
function diverged(files: readonly string[], known: Stamps): string[] {
  return files.filter((file) => fileHash(file) !== known[file]);
}

/** Durable fallback for events that matter after the fact but would otherwise only ever reach
 *  `console.error` — which goes nowhere under the service's normal `stdio: 'ignore'` spawn
 *  (`serviceClient.ts#spawnService`: both the dev and built-bundle paths spawn detached with stdio
 *  ignored, unconditionally, so nothing printed here is ever visible in real use). Appends one line
 *  to a fixed, `getRunDir()`-based log file so a startup GC sweep or a shutdown-time flush refusal
 *  leaves a trace a human can actually go read later, instead of vanishing every single time.
 *  Best-effort: a logging failure must never take the service down. */
function logService(message: string): void {
  console.error(message);
  try {
    const dir = getRunDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'service.log'), `${new Date().toISOString()} ${message}\n`);
  } catch {
    // best-effort only
  }
}

export function main(): void {
  // Computed once, at this process's own startup, from whatever source was on disk at that
  // moment — deliberately never recomputed afterward. `ping`'s response carries it so
  // `serviceClient.ts` can compare it against the *current* on-disk fingerprint and warn when
  // they've drifted apart, i.e. when this long-lived process is running code a later edit already
  // superseded (Node doesn't hot-reload; only a restart picks up a source change).
  const codeFingerprint = computeCodeFingerprint();

  // The one binding for this process's whole lifetime — see this file's own doc comment above.
  // Both resolve via their own default (env var, then config discovery, then fallback); nothing
  // here re-derives cwd itself.
  const contentDir = resolveEffectiveApeironRoot();
  const artifactsDir = getArtifactsDir();

  // Per-run trust anchor for the production HTTP+auth listener below (discussion/webapp.md's
  // "Auth for the in-service listener") — fresh every service start, same as the socket itself.
  const httpToken = writeToken();
  const httpPort = resolveHttpPort();

  /** Ends the start: the lock is cleared so that the client's wait ends at once and `aperas service start` can say why from the log. */
  const refuseToStart = (why: string): never => {
    logService(`[ApeironNgn service] REFUSING TO START: ${why}`);
    clearLock();
    process.exit(1);
  };

  // The table of settings (directory and flush interval of each graph) is read from the configuration above the mirror, once, and used for every load of this process.
  let settings: readonly GraphSettings[];
  try {
    const table = resolveGraphSettings(contentDir);
    settings = table.graphs;
    for (const warning of table.warnings) logService(`[ApeironNgn service] WARNING: ${warning}`);
    logService(`[ApeironNgn service] Flush intervals: ${settings.map((g) => `${g.graph} ${g.flushIntervalMs} ms`).join(', ')}.`);
  } catch (err: any) {
    return refuseToStart(`the table of graph settings is not readable: ${err.message || err}`);
  }

  const startAnyway = process.env[START_ANYWAY_ENV] === '1';

  /** Logs what a load says besides its problems, and copies the documents it skipped to a side file before anything can flush over them. */
  function acceptLoad(opened: Opened, atBoot: boolean): void {
    if (atBoot) logService(`[ApeironNgn service] Loaded ${opened.load.documents + opened.load.embedded} record(s) from ${contentDir}.`);
    for (const warning of opened.warnings) logService(`[ApeironNgn service] WARNING: ${warning}`);
    if (opened.load.dangling.length > 0) {
      const shown = opened.load.dangling.slice(0, 10).join(', ');
      logService(`[ApeironNgn service] WARNING: ${opened.load.dangling.length} id(s) referenced and never defined: ${shown}${opened.load.dangling.length > 10 ? ', …' : ''}`);
    }
    const refusal = loadRefusal(opened.load);
    if (refusal === undefined) return;
    logService(`[ApeironNgn service] START-ANYWAY: ${refusal}`);
    for (const path of saveSkipped(opened)) logService(`[ApeironNgn service] The documents the load skipped are copied to ${path}.`);
  }

  /** Copies the raw documents the load skipped to a side file next to their file; a file already copied with the same documents is not copied again. Gives the paths written. */
  function saveSkipped(opened: Opened): string[] {
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
    const written: string[] = [];
    for (const { file, documents } of skippedDocuments(contentDir, opened.db.mapping, opened.load)) {
      const text = documentsText(documents);
      const base = `${file}.rejected-`;
      const present = readdirSync(dirname(file)).filter((name) => join(dirname(file), name).startsWith(base) && name.endsWith('.json'));
      if (present.some((name) => readFileSync(join(dirname(file), name), 'utf-8') === text)) continue;
      const side = `${base}${stamp}.json`;
      writeFileSync(side, text);
      written.push(side);
    }
    return written;
  }

  const opened = openDb(contentDir, settings);
  let store: Db = opened.db;
  const bootRefusal = loadRefusal(opened.load);
  if (bootRefusal !== undefined && !startAnyway) {
    logService(`[ApeironNgn service] Loaded ${opened.load.documents + opened.load.embedded} record(s) from ${contentDir}.`);
    for (const warning of opened.warnings) logService(`[ApeironNgn service] WARNING: ${warning}`);
    // the log holds the whole list; the line the client prints from it names REFUSAL_SHOWN_IDS ids, the count, and where the rest is
    logService(`[ApeironNgn service] Refused documents, the full list: ${bootRefusal}`);
    const shortRefusal = loadRefusal(opened.load, { limit: REFUSAL_SHOWN_IDS, fullListIn: join(getRunDir(), 'service.log') });
    refuseToStart(`${shortRefusal} (to work on the unaffected parts and fix the affected ones in memory: aperas service start --start-anyway)`);
  }
  acceptLoad(opened, true);

  /** The stamps of the files of each graph as this process last read or wrote them, and the standing conflict of each graph. */
  const stamps = new Map<GraphName, Stamps>();
  const conflicts = new Map<GraphName, string | null>();
  const stampGraphs = (): void => {
    for (const graph of store.graphs) {
      stamps.set(graph, stampAll(mirrorFilesOf(store, contentDir, graph)));
      conflicts.set(graph, null);
    }
  };
  stampGraphs();
  const threadSizeCap = resolveEffectiveThreadSizeCap();

  // Standing result of the last corpus-wide link-integrity sweep (startup/reload), attached to every
  // response the same way the conflicts are — see `serviceProtocol.ts#ServiceResponse`.
  let linkWarning: string | null = null;

  /** The conflicts as a response carries them: `content` is the main graph's, `state` the others'. Recorded at the service level, rather than only thrown to whichever
   *  single request happened to hit it: the timers hit `flushGraph` too, with no request behind them to surface an error to — without this, a conflict the *timer*
   *  discovers would sit pending forever, with nothing ever telling anyone. `handleConnection` below attaches it to *every* response it sends, regardless of
   *  that request's own `op` — so a conflict "emerges" on the very next `kg:xxx` call of any kind, not just a `flush`/`reload`. */
  function standingConflict(): { content?: string; state?: string } | undefined {
    const content = conflicts.get(MAIN_GRAPH) ?? undefined;
    const others = [...conflicts].filter(([graph, text]) => graph !== MAIN_GRAPH && text).map(([, text]) => text);
    const state = others.length > 0 ? others.join(' ') : undefined;
    return content || state ? { content, state } : undefined;
  }

  /** The rules of the sweep, at the boundaries where the service runs them: a container that holds nothing live is tombstoned (the boot rule), then the engine's
   *  sweep deletes the tombstones nothing reaches, graph by graph. A graph written by either is flushed by the caller. */
  function sweeps(): { tombstoned: number; pruned: number } {
    const { tombstoned } = tombstoneVacuousContainers(store);
    const { pruned } = sweepTombstones(store);
    return { tombstoned, pruned };
  }

  // Startup GC (Aperas-apeironngn-design.md §5) — the same sweeps `reloadStore`/
  // `clobberFlush`/`shutdown` already run at their own explicit boundaries, run here too so a
  // backlog never survives indefinitely across however many restarts land between one real
  // (non-`--discard`) `reload`/`clobber`/graceful shutdown and the next. Must flush immediately
  // rather than just mark the graph written and rely on the periodic timer or some later, unrelated mutation to
  // carry it along: at cold boot, disk can't have diverged yet (this store was just loaded from
  // it), so this flush is guaranteed to succeed. Deferring it is what let a real backlog (four
  // already-tombstoned blocks from earlier the same day) survive 8+ hours and several restarts
  // untouched — computed in memory every boot, never once written back, gone the moment the
  // process exited before anything else happened to flush.
  const bootSweep = sweeps();
  if (bootSweep.tombstoned > 0 || bootSweep.pruned > 0) {
    logService(`[ApeironNgn service] Startup GC: cleaned ${bootSweep.pruned} unreachable tombstone(s), ${bootSweep.tombstoned} vacuous container(s).`);
    flushAll();
  }

  let queue: Promise<unknown> = Promise.resolve();
  function enqueue<T>(fn: () => T | Promise<T>): Promise<T> {
    const result = queue.then(fn, fn);
    queue = result.then(() => undefined, () => undefined);
    return result;
  }

  /** Writes the files of one graph of the mapping, whole. The graphs of the whole mapping are read
   *  across: a node's container may be in a graph whose files are not written now. */
  function writeGraph(graph: GraphName): void {
    dumpMirror(store.engine, contentDir, store.mapping, (m) => m.graph === graph);
    stamps.set(graph, stampAll(mirrorFilesOf(store, contentDir, graph)));
    store.changed.delete(graph);
    conflicts.set(graph, null);
  }

  /** Flushes one graph if it was written. Keyed on an actual content-hash mismatch, not on the graph being written alone: that only means *this* process has a pending
   *  local mutation, which is the common, harmless case (no external write at all) — refusing on it by itself would nag on every ordinary flush. Only a genuine
   *  divergence since the last read/write is worth refusing over; when one's found, the write is skipped entirely (nothing partially overwritten) and the local
   *  mutation stays pending in memory (the graph still written) for the caller to resolve and retry. */
  function flushGraph(graph: GraphName): void {
    if (!store.changed.has(graph)) return;
    const bad = diverged(mirrorFilesOf(store, contentDir, graph), stamps.get(graph) ?? {});
    if (bad.length > 0) {
      const text = `${bad.map((file) => relative(contentDir, file)).join(', ')} changed on disk since this service last read it — an external ` +
        `process (another git pull, a hand-edit) wrote to the mirror while this service held unflushed local changes.`;
      conflicts.set(graph, text);
      throw new Error(`Refusing to flush: ${text} ${CONFLICT_RESOLUTION_HINT}`);
    }
    writeGraph(graph);
  }

  /** Flushes every graph that was written, each on its own: a divergence in one must not skip the others (they are unrelated files). The first refusal is thrown once all were tried. */
  function flushAll(): void {
    let first: Error | undefined;
    for (const graph of store.graphs) {
      try { flushGraph(graph); } catch (err: any) { first ??= err; }
    }
    if (first) throw first;
  }

  /** Corpus-wide link-integrity sweep (~0.6s, measured), run at the two boundaries where the graph
   *  can have changed without this process doing it: cold boot, and `reload`. Sets/clears the
   *  standing `linkWarning` rather than throwing — a broken link is a data problem to report, never
   *  a reason to refuse an unrelated request. Never repairs: the known workaround for the still-
   *  unreproduced regression in `issues/linking.md` is "re-run the identical write and it sticks,"
   *  and a silent auto-retry here would destroy the evidence that bug is still being hunted with. */
  function corpusLinkSweep(context: string): void {
    try {
      const report = checkLinkIntegrity(store);
      if (report.discrepancies.length === 0) {
        linkWarning = null;
        return;
      }
      const blocks = report.discrepancies.map((d) => d.blockId).join(', ');
      linkWarning =
        `${report.discrepancies.length} live block(s) cite a resolvable target that's missing from their own '.links' ` +
        `(found at ${context}): ${blocks}. Run 'aperas check-links --verbose' for detail, ` +
        `'aperas check-links --repair' to re-resolve them.`;
      logService(`[ApeironNgn service] LINK INTEGRITY: ${linkWarning}`);
    } catch (err: any) {
      logService(`[ApeironNgn service] Link integrity sweep (${context}) failed — ${err.message}`);
    }
  }

  /** Which artifact a mutating op is about to touch, resolved from the same `path`/`base` pair the
   *  op itself resolves — read-only (`resolveDeepPath` mints nothing without `createHolder`), and
   *  best-effort: a ref this can't resolve just means no scoped check, never a failed write. */
  function artifactForRef(ref: string, base?: string): string | null {
    try {
      const id = resolveDeepPath(store, ref, { base });
      return id ? owningArtifactId(store, id) : null;
    } catch {
      return null;
    }
  }

  function discrepancyKeys(report: LinkIntegrityReport): Set<string> {
    const keys = new Set<string>();
    for (const d of report.discrepancies) for (const code of d.missingCodes) keys.add(`${d.blockId}\u0000${code}`);
    return keys;
  }

  /** Re-checks the written artifact and appends anything *this write* broke to the op's own result,
   *  right where the caller is already reading its `Links: N resolved…` summary — the exact line
   *  that reported success while `.links` came back empty in both recorded incidents. Diffed against
   *  a sweep taken just before the write, so a pre-existing discrepancy elsewhere in the same
   *  artifact isn't re-reported on every subsequent edit to it.
   *
   *  Also splices on a `threadSize` warning (design/aperas-skill.md's Threads) when `artifactId` is
   *  `.threads/`-scoped and its post-write live-block count is over `threadSizeCap` — reusing
   *  `after.totalLiveBlocks`, already computed above for the link check, rather than a second
   *  traversal. Appears on *every* write past the cap, not just the one that crossed it: unlike
   *  `linkBreakage` (a regression to flag once), a thread over its cap stays worth nagging about
   *  until it's actually pruned. */
  function withLinkCheck<T extends object>(result: T, artifactId: string | null, before: LinkIntegrityReport | null): T {
    if (!artifactId || !before) return result;
    let after: LinkIntegrityReport;
    try {
      after = checkArtifactLinkIntegrity(store, artifactId);
    } catch {
      return result;
    }
    const known = discrepancyKeys(before);
    const introduced = after.discrepancies.flatMap((d) =>
      d.missingCodes
        .filter((code) => !known.has(`${d.blockId}\u0000${code}`))
        .map((code) => ({ blockId: d.blockId, blockTitle: d.blockTitle, code }))
    );
    let out = result;
    if (introduced.length > 0) out = { ...out, linkBreakage: introduced };
    if (after.totalLiveBlocks > threadSizeCap && isThreadScoped(store, artifactId)) {
      const artifactPath = (wrap(store, artifactId) as unknown as TreeNode).toPath();
      out = { ...out, threadSize: { count: after.totalLiveBlocks, cap: threadSizeCap, artifactPath } };
    }
    return out;
  }

  /** Sweeps and flushes every written graph, then loads a fresh `Db` from disk, swaps it in and frees the old one — see this file's own doc comment for why. A divergence
   *  during the flush propagates out of this function too — a reload that can't safely flush first refuses rather than silently discarding the external
   *  change it exists to pick up — unless `discard` says to drop the pending local mutation
   *  instead of trying to preserve it, the deliberate, explicit way to resolve a conflict in
   *  favor of the external change (`kg:reload --discard`; never implied by any op's own bare
   *  `reload: true`, which always takes the safe, preserving path — a read shouldn't have the
   *  side effect of silently dropping someone else's pending write). A load that did not read the mirror in full refuses the reload and the graph in memory
   *  (with its pending changes) stays as it is, unless `anyway` accepts it (see the doc comment of this file). */
  function reloadStore(discard = false, anyway = false): {
    recordCount: number;
    documentCount: number;
    prunedTombstones: number;
    tombstonedContainers: number;
    freedGraphs: number;
  } {
    let tombstoned = 0;
    let pruned = 0;
    if (!discard) {
      // Mark-and-sweep tombstone GC (Aperas-apeironngn-design.md §5) — run here, not discarded:
      // this is exactly the "next service startup/reload" boundary the design settled on, and
      // the flush right after writes every graph the sweeps changed, so a pruned tombstone
      // reliably stays gone rather than reappearing from the very load this triggers below.
      // Skipped on `discard`, since that path throws away in-memory state instead of flushing it.
      ({ tombstoned, pruned } = sweeps());
      flushAll();
    }
    // What is on disk is read after the flush; with `discard` it is read before the pending changes are given up, so that a load that cannot be accepted leaves them.
    const result = openDb(contentDir, settings);
    const refusal = loadRefusal(result.load);
    if (refusal !== undefined && !anyway) {
      closeDb(result.db);
      logService(`[ApeironNgn service] Reload refused, the graph in memory is kept: ${refusal}`);
      const shortRefusal = loadRefusal(result.load, { limit: REFUSAL_SHOWN_IDS, fullListIn: join(getRunDir(), 'service.log') });
      throw new Error(`Refusing to reload: ${shortRefusal} (to accept it and work on the unaffected parts: aperas reload --start-anyway)`);
    }
    const old = store;
    store = result.db;
    const freed = closeDb(old);
    stampGraphs();
    acceptLoad(result, false);
    const records = result.load.documents + result.load.embedded;
    const gcParts: string[] = [];
    if (pruned) gcParts.push(`${pruned} unreachable tombstone(s) pruned`);
    if (tombstoned) gcParts.push(`${tombstoned} vacuous container(s) tombstoned`);
    logService(
      `[ApeironNgn service] Reloaded ${records} record(s), ${result.load.documents} document(s); ${freed.length} graph(s) of the old store freed.` +
        (gcParts.length > 0 ? ` GC: ${gcParts.join(', ')}.` : '')
    );
    // The other boundary where the graph can have changed without this process doing it — a reload
    // exists precisely to pick up someone else's write, which is exactly when a link can arrive
    // already broken.
    corpusLinkSweep('reload');
    return { recordCount: records, documentCount: result.load.documents, prunedTombstones: pruned, tombstonedContainers: tombstoned, freedGraphs: freed.length };
  }

  /** The other side of `reloadStore(discard: true)`: resolves a conflict in favor of the *local*
   *  mutation instead, by writing current memory over disk unconditionally — no divergence
   *  check, and every graph is written whether it was or not. Deliberately its own explicit op (`kg:flush --clobber`) rather than a flag
   *  folded into some unrelated mutating op's own `flush`, since this isn't tied to any particular
   *  mutation — it's "push out whatever's pending right now, no matter what's on disk," the direct
   *  counterpart to `--discard`'s "pull in whatever's on disk, no matter what's pending." Named
   *  `clobber`, not `force` — see `kgFlush.ts`'s doc comment for why the name alone doesn't route
   *  around `npm run kg:flush --force`'s original footgun (npm's own `--` separator requirement
   *  applies to any `--flag`, not just recognized npm options). */
  function clobberFlush(): { clobbered: true; prunedTombstones: number; tombstonedContainers: number } {
    const { tombstoned, pruned } = sweeps(); // the same sweeps `reloadStore` runs — see its own comment
    for (const graph of store.graphs) writeGraph(graph);
    return { clobbered: true, prunedTombstones: pruned, tombstonedContainers: tombstoned };
  }

  let idleTimer: NodeJS.Timeout;
  function resetIdleTimer(): void {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => shutdown(0), IDLE_TIMEOUT_MS);
  }

  // One timer for each graph, at the flush interval of the table of settings. Every timer already swallows a thrown divergence rather than crash the process — logged (even
  // though `stdio: 'ignore'` on the normal detached spawn means it goes nowhere in practice) so a
  // foreground/debug run at least shows it, instead of a silently-stuck written flag retrying every
  // interval forever. An explicit `--flush`/`--reload`/`--discard` from a CLI command always
  // surfaces the same error normally through the request/response path regardless.
  const flushTimers = settings.map(({ graph, flushIntervalMs }) =>
    setInterval(() => {
      enqueue(() => flushGraph(graph)).catch((err) => logService(`[ApeironNgn service] Timed flush of ${graph}: ${err.message}`));
    }, flushIntervalMs)
  );

  let shuttingDown = false;
  /** Each graph flushed and caught independently: a divergence on one must not skip the
   *  others (they're unrelated files), and none may throw unhandled here — `.finally()` below
   *  has no `.catch()` after it, so an uncaught rejection from inside would go unhandled entirely.
   *  A stop must always complete, so a divergence at shutdown time is accepted as data loss (the
   *  pending local mutation never got flushed) rather than silently swallowed with no trace — the
   *  same conflict `kg:reload --discard`/`kg:flush --clobber` resolve deliberately, forced here by
   *  the process simply having to end. */
  function shutdown(code: number): void {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const timer of flushTimers) clearInterval(timer);
    clearTimeout(idleTimer);
    server.close();
    httpServer.close();
    enqueue(() => {
      // Same sweeps as `reloadStore`/`clobberFlush` (see `reloadStore`'s own comment) — shutdown
      // is the other half of the "gone at next startup" boundary: whatever's pruned here is what
      // the *next* service start loads, including after a plain idle-timeout exit with
      // no other pending mutation at all (a sweep that removed something alone must still trigger a flush below, same
      // reasoning as `reloadStore`). Wrapped in its own try/catch for the same "a stop must always
      // complete" reason the flushes already are.
      try {
        sweeps();
      } catch (err: any) { logService(`[ApeironNgn service] Shutdown: tombstone GC failed — ${err.message}`); }
      for (const graph of store.graphs) {
        try { flushGraph(graph); } catch (err: any) { logService(`[ApeironNgn service] Shutdown WARNING: ${graph} mirror flush refused — ${err.message}. Discarding un-flushed in-memory changes.`); }
      }
    }).finally(() => {
      clearLock();
      process.exit(code);
    });
  }

  async function handle(req: ServiceRequest): Promise<unknown> {
    switch (req.op) {
      case 'ping':
        return { pong: true, codeFingerprint };
      case 'reload':
        return reloadStore(req.discard, req.startAnyway === true);
      case 'flush':
        if (req.clobber) return clobberFlush();
        else {
          flushAll();
          return { clobbered: false };
        }
      case 'track': {
        if (req.reload) reloadStore();
        const result = runTrack(store, req.paths, req.force);
        if (req.flush) flushAll();
        return result;
      }
      case 'trackReverse':
        if (req.reload) reloadStore();
        return runReverseTrack(store);
      case 'ingest': {
        if (req.reload) reloadStore();
        const result = runIngest(store, req.paths, req.track, req.force);
        if (req.flush) flushAll();
        return result;
      }
      case 'unfold': {
        if (req.reload) reloadStore();
        // `peek` (no `--view` at all on the CLI call): read-only, matching `kg:tree`'s own
        // no-`--view` default — resolves and previews without bootstrapping or mutating the
        // default view (issues/treeview.md's "bare unfold mutates the default view" gap).
        // A refusal takes the view and the profile it minted with it (`runUnfoldOp`).
        if (req.peek) return runUnfoldOp(store, req);
        const result = runUnfoldOp(store, req);
        // `resolveTreeView`'s `ensureDefaultView` fallback may have just minted a first-use
        // `Profile` as a side effect -- `Profile` lives in the main graph (Aperas-treeview-design.md
        // §8/§11): the write layer marks the graph it was written in, so the flush finds it.
        if (req.flush) flushAll();
        return result;
      }
      case 'fold': {
        if (req.reload) reloadStore();
        const result = runFoldOp(store, req);
        if (req.flush) flushAll();
        return result;
      }
      case 'zoom': {
        if (req.reload) reloadStore();
        const result = runZoomOp(store, req);
        if (req.flush) flushAll();
        return result;
      }
      case 'resolve': {
        if (req.reload) reloadStore();
        const result = runResolve(store, req);
        if (req.flush) flushAll();
        return result;
      }
      // The three write paths where a link resolved at write time has been seen not to persist
      // (`issues/linking.md`) — each re-checks its own artifact afterward and reports what the write
      // itself broke. `ingest` deliberately isn't one of them: it always ran `resolveBlockLinks`
      // correctly, reports its own link stats already, and can span the whole corpus in one call.
      case 'insert': {
        if (req.reload) reloadStore();
        const artifactId = artifactForRef(req.path, req.base);
        const before = artifactId ? checkArtifactLinkIntegrity(store, artifactId) : null;
        const result = runInsert(store, req);
        if (req.flush) flushAll();
        return withLinkCheck(result, artifactId, before);
      }
      case 'update': {
        if (req.reload) reloadStore();
        const artifactId = artifactForRef(req.path, req.base);
        const before = artifactId ? checkArtifactLinkIntegrity(store, artifactId) : null;
        const result = runUpdate(store, req);
        if (req.flush) flushAll();
        return withLinkCheck(result, artifactId, before);
      }
      case 'remove': {
        if (req.reload) reloadStore();
        const artifactId = artifactForRef(req.path, req.base);
        const before = artifactId ? checkArtifactLinkIntegrity(store, artifactId) : null;
        const result = runRemove(store, req);
        if (req.flush) flushAll();
        return withLinkCheck(result, artifactId, before);
      }
      // Same scoped link-integrity check every other mutating op gets: a retype rewrites `.type`/
      // `.title` and can drop a type-specific prop, but never `.links` — so anything this sweep
      // reports here is a real regression, not expected churn.
      case 'retype': {
        if (req.reload) reloadStore();
        const artifactId = artifactForRef(req.path, req.base);
        const before = artifactId ? checkArtifactLinkIntegrity(store, artifactId) : null;
        const result = runRetype(store, req);
        if (req.flush) flushAll();
        return withLinkCheck(result, artifactId, before);
      }
      case 'project': {
        if (req.reload) reloadStore();
        const result = runProject(store, req.path, req.dryRun, req.force);
        if (req.flush) flushAll();
        return result;
      }
      case 'tree':
        if (req.reload) reloadStore();
        return runTree(store, req);
      case 'path':
        if (req.reload) reloadStore();
        return runPath(store, req.idArg);
      case 'backlinks':
        if (req.reload) reloadStore();
        return runBacklinks(store, req.pathArg, req.includeText);
      case 'show':
        if (req.reload) reloadStore();
        return runShow(store, req.pathArg);
      case 'profileCreate': {
        if (req.reload) reloadStore();
        const result = runProfileCreate(store, req.handle, req.name, req.kind);
        if (req.flush) flushAll();
        return result;
      }
      case 'profileList':
        if (req.reload) reloadStore();
        return runProfileList(store, req.handle);
      case 'profileRemove': {
        if (req.reload) reloadStore();
        const result = runProfileRemove(store, req.handle);
        if (req.flush) flushAll();
        return result;
      }
      case 'profileCreateView': {
        if (req.reload) reloadStore();
        // A new TreeView only -- it never auto-creates its owning Profile the way `ensureDefaultView`
        // does (`createTreeView` throws if `--profile` doesn't already resolve).
        const result = runProfileCreateView(store, req.name, req.profileHandle);
        if (req.flush) flushAll();
        return result;
      }
      case 'profileListView':
        if (req.reload) reloadStore();
        return runProfileListView(store, req.name);
      case 'profileRemoveView': {
        if (req.reload) reloadStore();
        const result = runProfileRemoveView(store, req.name);
        if (req.flush) flushAll();
        return result;
      }
      case 'checkLinks': {
        if (req.reload) reloadStore();
        if (req.repair) {
          const res = repairLinkIntegrity(store);
          if (req.flush) flushAll();
          return res;
        }
        return checkLinkIntegrity(store);
      }
      default:
        throw new Error(`ApeironNgn service: unknown op '${(req as { op?: string }).op}'`);
    }
  }

  function handleConnection(socket: Socket): void {
    // Decoded by the socket, which holds the bytes of a character cut between two chunks until the rest arrives (a request over one chunk, about 64 KiB, would otherwise reach the graph with U+FFFD for each half).
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const idx = buffer.indexOf('\n');
      if (idx === -1) return;
      const line = buffer.slice(0, idx);
      buffer = '';
      enqueue(async (): Promise<ServiceResponse> => {
        try {
          const req = decodeMessage<ServiceRequest>(line);
          const result = await handle(req);
          resetIdleTimer();
          // Attached regardless of `req.op` — see `standingConflict`'s own doc
          // comment for why this can't wait for a `flush`/`reload` call to surface it.
          const conflict = standingConflict();
          return {
            ok: true,
            result,
            ...(conflict ? { conflict } : {}),
            ...(linkWarning ? { linkWarning } : {}),
          };
        } catch (err: any) {
          resetIdleTimer();
          return { ok: false, error: err.message || String(err) };
        }
      }).then((response) => socket.end(encodeMessage(response))).catch(() => socket.destroy());
    });
    socket.on('error', () => {});
  }

  const server = createServer(handleConnection);
  server.on('error', (err) => {
    console.error('[ApeironNgn service] Server error:', err);
    process.exit(1);
  });

  // The production HTTP+auth listener (discussion/webapp.md's "Transport"/"Auth for the in-service
  // listener") — an addition beside the unix socket above, never a replacement for it: CLI callers
  // keep using the socket exactly as they do today. In-process, so `/api/*` calls `handle()`
  // directly rather than round-tripping through the socket the way a separate process (the old dev
  // bridge) has to. Reachable, in principle, by any page open in the user's browser the moment it
  // binds a TCP port — the auth checks below (`listenerAuth.ts`) are what keep that safe, not the
  // network.
  const webRoot = resolveWebRoot();
  const httpServer = createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${httpPort}`);
    const origin = req.headers.origin;

    if (req.method === 'OPTIONS') {
      // Restrictive preflight: only ever grants the one origin this listener actually serves.
      // A hostile cross-origin page's own preflight gets no such grant, so the browser never sends
      // its real request at all — the actual point of the custom `X-Aperas-Token` header.
      if (origin && allowedOrigins(httpPort).includes(origin)) {
        res.setHeader('access-control-allow-origin', origin);
        res.setHeader('access-control-allow-headers', 'X-Aperas-Token, Content-Type');
        res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
      }
      res.statusCode = 204;
      res.end();
      return;
    }

    const isApi = url.pathname.startsWith('/api/');
    const auth = checkAuth(
      { host: req.headers.host, origin, 'x-aperas-token': req.headers['x-aperas-token'] as string | undefined },
      { token: httpToken, port: httpPort },
      isApi,
    );
    if (!auth.ok) {
      res.statusCode = auth.status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: auth.error }));
      return;
    }
    if (origin) res.setHeader('access-control-allow-origin', origin); // same-origin calls never need this; kept for symmetry with the preflight above

    if (isApi) {
      const { status, body } = await handleApiRoute(
        url.pathname, url.searchParams, req.method ?? 'GET',
        () => readRequestBody(req),
        (r) => handle(r),
      );
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(body));
      return;
    }

    const asset = await serveStatic(webRoot, url.pathname, httpToken);
    if (!asset) {
      res.statusCode = 404;
      res.end('Not found');
      return;
    }
    res.statusCode = asset.status;
    for (const [key, value] of Object.entries(asset.headers)) res.setHeader(key, value);
    res.end(asset.body);
  });
  let httpListening = false;
  httpServer.on('error', (err: NodeJS.ErrnoException) => {
    // A port that cannot be bound ends the start like any other refusal: the reason goes to the log, the lock this start claimed is cleared, and `aperas service start` says why.
    if (!httpListening) refuseToStart(`the HTTP port ${httpPort} (127.0.0.1) could not be bound: ${err.code ?? 'error'} ${err.message}`);
    logService(`[ApeironNgn service] HTTP listener error: ${err.message}`);
    process.exit(1);
  });

  process.on('SIGTERM', () => shutdown(0));
  process.on('SIGINT', () => shutdown(0));

  const socketPath = getSocketPath();
  // Order: the HTTP port first, then the startup link sweep, then the unix socket, then `markReady`. A client's wait (`waitForReady`) takes the first answer of the socket for a service that is up,
  // so the socket must not answer while the port is still unbound or refused: were the socket first, a start whose port is in use would be told "ready" in the gap and the service would then end.
  // The lock is the claim (made by the starting CLI before this process exists). The sweep comes before the socket because it holds the event loop for seconds on a large mirror: a socket bound
  // before it would accept a ping that is answered only when the sweep ends, and a lock marked `ready` before it would say `ready` while the service does not answer. So the lock says `starting`
  // during the sweep (a client waits, with "Still starting"), and `ready` only when the socket is bound and a request is answered at once; the lock is truthful. All the other binds take milliseconds.
  httpServer.listen(httpPort, '127.0.0.1', () => {
    httpListening = true;
    try {
      startupSweep();
    } catch (err: any) {
      refuseToStart(`the startup link-integrity sweep failed: ${err?.message ?? err}`);
    }
    listenOnSocket();
  });

  /** The link-integrity sweep of the start, with the two hooks of the tests: `APERAS_TEST_SWEEP_HOLD_MS` holds the event loop for that long first (the sweep of a large mirror does, for seconds), and
   *  `APERAS_TEST_SWEEP_FAULT=1` makes the sweep throw. The service does not use either in production. */
  function startupSweep(): void {
    const began = Date.now();
    const hold = Number(process.env.APERAS_TEST_SWEEP_HOLD_MS);
    if (hold > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, hold);
    if (process.env.APERAS_TEST_SWEEP_FAULT === '1') throw new Error('a fault injected by APERAS_TEST_SWEEP_FAULT');
    corpusLinkSweep('startup');
    logService(`[ApeironNgn service] Startup link-integrity sweep done in ${Date.now() - began} ms.`);
  }

  function listenOnSocket(): void {
    try {
      unlinkSync(socketPath);
    } catch (err: any) {
      if (err.code !== 'ENOENT') throw err;
    }
    server.listen(socketPath, onReady);
  }

  function onReady(): void {
    markReady(contentDir, artifactsDir, httpPort);
    resetIdleTimer();
  }
}

if (process.argv[1]?.endsWith('service.ts')) main();
