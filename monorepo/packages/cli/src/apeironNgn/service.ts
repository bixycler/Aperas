/**
 * ApeironNgn shared service process (Aperas-apeironngn-design.md §4 rollout step 5) — holds one
 * rehydrated `Store` in memory across CLI invocations instead of every `kg:xxx` script rehydrating/
 * dehydrating the whole mirror on its own. Listens on a Unix domain socket; every request is
 * serialized through `enqueue()` so concurrent connections never interleave store mutations.
 * Flushes to `AperasKG/Apeiron/`'s JSON-LD mirror every 10s if dirty, or immediately when a
 * request carries `flush: true`. A second, independent interval/dirty-flag pair
 * (`STATE_FLUSH_INTERVAL_MS`/`stateDirty`) does the same for `TreeView`'s own `.state/` mirror
 * (Aperas-treeview-design.md §8) — expand/collapse churns far more often than content edits, and
 * `.state/` is cheap and gitignored, so it's tuned separately rather than riding the content
 * mirror's cadence. `Profile` moved out of `.state/` into the ordinary content mirror (§8/§11) —
 * it's per-viewer identity, but stable, not ephemeral, so it now rides the `dirty`/
 * `FLUSH_INTERVAL_MS` cadence like `BlockNode`/`ArtifactNode`/`FolderNode`. Exits after 30 idle
 * minutes or on SIGTERM/SIGINT, flushing both if dirty either way.
 *
 * Started explicitly by `aperas service start`/`restart` (`kgService.ts`) — not meant to be run
 * directly, though doing so still works: `getApeironExportDir()`/`getArtifactsDir()` below are
 * called with no argument, so their own default resolution applies — `APERAS_APEIRON_ROOT`/
 * `APERAS_ARTIFACTS_ROOT` (set by `serviceClient.ts#spawnService` in the env of the process it
 * spawns) if present, else the same cwd-or-fallback default a direct run would get anyway (see
 * `graphConfig.ts`'s own doc comment). A direct run just skips the lock-claim race and the graph
 * resolution that only matter when going through the real `start`/`restart` path.
 *
 * Staleness: the `Store` held here is a snapshot from whenever it was last (re)hydrated — nothing
 * notices `AperasKG/Apeiron/` changing on disk underneath it (e.g. a `git pull` merging someone
 * else's commit) on its own. `reloadStore()` is the fix, the revived TDB-era `kg:import`'s
 * equivalent: flushes both dirty flags first (so no unflushed in-memory work is silently
 * discarded), then rehydrates fresh and swaps the in-memory `Store` reference. Reachable directly
 * via `{ op: 'reload' }` (`kg:reload`), or implicitly via any op's own `reload: true` — the
 * reciprocal of a mutating op's `flush: true`: `flush` forces a sync *out* immediately after the
 * op runs, `reload` forces a sync *in* immediately before it does, so a write can pick up an
 * external change and persist the result in one round trip.
 *
 * That pre-reload flush is itself guarded (`flushIfDirty`/`flushStateIfDirty`'s `diverged` check):
 * `dehydrateToJsonLd`/`dehydrateStateToJsonLd` are blind full-file replaces, not merges, so
 * flushing this process's own pending mutation over a mirror file an *external* write already
 * changed would silently destroy that external content instead of picking it up. The guard compares
 * each managed file's content hash against what this process last read or wrote; a mismatch refuses
 * the flush (and whatever op triggered it) instead of overwriting, leaving the local mutation
 * pending for a human to reconcile. It's keyed on the hash, not the `dirty` flag alone — `dirty` by
 * itself is the ordinary, harmless case (a pending local edit, no external activity at all).
 */

import { createServer, type Socket } from 'node:net';
import { unlinkSync, readFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { rehydrateStore, getApeironExportDir } from '@aperas/core/apeironNgn/store';
import { dehydrateToJsonLd, dehydrateStateToJsonLd, DEHYDRATE_CLASSES, STATE_CLASSES } from '@aperas/core/apeironNgn/dehydrate';
import { computeFileHash, getArtifactsDir } from '@aperas/core/artifacts';
import { resolveTreeView, pruneUnreachableTombstones, tombstoneVacuousContainers, pruneStaleUnfolds } from '@aperas/core/apeironNgn/node';
import { checkLinkIntegrity, checkArtifactLinkIntegrity, owningArtifactId, repairLinkIntegrity, type LinkIntegrityReport } from '@aperas/core/apeironNgn/linkIntegrity';
import { resolveDeepPath } from '@aperas/core/apeironNgn/resolve';
import { getRunDir, getSocketPath, markReady, clearLock } from './serviceLock';
import { computeCodeFingerprint } from './codeVersion';
import { encodeMessage, decodeMessage, CONFLICT_RESOLUTION_HINT, type ServiceRequest, type ServiceResponse } from './serviceProtocol';
import { runTrack, runReverseTrack } from '../kgTrack';
import { runIngest } from '../kgIngest';
import { runUnfold } from '../kgUnfold';
import { runFold } from '../kgFold';
import { runResolve } from '../kgResolve';
import { runInsert } from '../kgInsert';
import { runUpdate } from '../kgUpdate';
import { runRemove } from '../kgRemove';
import { runRetype } from '../kgRetype';
import { runLinkCandidates, runAddBlockLink, runRemoveBlockLink } from '../kgLink';
import { runProject } from '../kgProject';
import { runTree } from '../kgTree';
import { runPath } from '../kgPath';
import { runBacklinks } from '../kgBacklinks';
import { runShow } from '../kgShow';
import { runProfileCreate, runProfileList, runProfileRemove, runProfileCreateView, runProfileListView, runProfileRemoveView } from '../kgProfile';

const FLUSH_INTERVAL_MS = 10_000;
const STATE_FLUSH_INTERVAL_MS = 3_000;
const IDLE_TIMEOUT_MS = 30 * 60_000;

type Stamps = Record<string, string | null>;

/** Content hash of one managed `.jsonld` file, or `null` if it doesn't exist yet (a fresh
 *  `.state/` before anything's ever been unfolded). Used to detect an external write to the
 *  mirror — `dehydrateToJsonLd`/`dehydrateStateToJsonLd` are blind full-file replaces, not merges,
 *  so overwriting a file that changed on disk since this process last read it would silently
 *  destroy whatever landed there (another process's `git pull`, a hand-edit). */
function fileHash(dir: string, kind: string): string | null {
  const path = join(dir, `${kind}.jsonld`);
  return existsSync(path) ? computeFileHash(readFileSync(path, 'utf-8')) : null;
}

function stampAll(dir: string, kinds: readonly string[]): Stamps {
  const stamps: Stamps = {};
  for (const kind of kinds) stamps[kind] = fileHash(dir, kind);
  return stamps;
}

/** Which of `kinds` no longer match their last-known stamp — empty when nothing external touched
 *  the mirror since this process last read or wrote it, regardless of how long ago that was. */
function diverged(dir: string, kinds: readonly string[], known: Stamps): string[] {
  return kinds.filter((kind) => fileHash(dir, kind) !== known[kind]);
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
  const contentDir = getApeironExportDir();
  const artifactsDir = getArtifactsDir();

  let { store, quadCount, duplicateIds: initDuplicateIds } = rehydrateStore(contentDir);
  logService(`[ApeironNgn service] Rehydrated ${quadCount} quad(s) from ${contentDir}.`);
  if (initDuplicateIds.length > 0) {
    logService(
      `[ApeironNgn service] WARNING: ${initDuplicateIds.length} duplicate @id(s) in the mirror — quads from every occurrence merged onto one subject, so at most one document per id survives the next dehydrate: ${initDuplicateIds.join(', ')}`
    );
  }

  const stateDir = join(contentDir, '.state');
  let contentStamps = stampAll(contentDir, DEHYDRATE_CLASSES);
  let stateStamps = stampAll(stateDir, STATE_CLASSES);

  let dirty = false;
  let stateDirty = false;
  // Set the instant a divergence refuses a flush, cleared the instant it's resolved (a later
  // flush that no longer diverges, or an explicit `discard`/`clobber`) — independent of `dirty`,
  // which a resolved-but-not-yet-retried mutation can still be. Recorded here, at the service
  // level, rather than only thrown to whichever single request happened to hit it: the 10s/3s
  // timers hit `flushIfDirty`/`flushStateIfDirty` too, with no request behind them to surface an
  // error to — without this, a conflict the *timer* discovers would sit `dirty` forever, with
  // nothing ever telling anyone. `handleConnection` below attaches whichever of these is set to
  // *every* response it sends, regardless of that request's own `op` — so a conflict "emerges" on
  // the very next `kg:xxx` call of any kind, not just a `flush`/`reload`.
  let contentConflict: string | null = null;
  let stateConflict: string | null = null;
  // Standing result of the last corpus-wide link-integrity sweep (startup/reload), attached to every
  // response the same way the two conflicts above are — see `serviceProtocol.ts#ServiceResponse`.
  let linkWarning: string | null = null;

  // Startup GC (Aperas-apeironngn-design.md §5) — the same companion sweep `reloadStore`/
  // `clobberFlush`/`shutdown` already run at their own explicit boundaries, run here too so a
  // backlog never survives indefinitely across however many restarts land between one real
  // (non-`--discard`) `reload`/`clobber`/graceful shutdown and the next. Must flush immediately
  // rather than just mark dirty and rely on the periodic timer or some later, unrelated mutation to
  // carry it along: at cold boot, disk can't have diverged yet (this store was just rehydrated from
  // it), so this flush is guaranteed to succeed. Deferring it is what let a real backlog (four
  // already-tombstoned blocks from earlier the same day) survive 8+ hours and several restarts
  // untouched — computed in memory every boot, never once written back, gone the moment the
  // process exited before anything else happened to flush.
  const { tombstoned: initTombstoned } = tombstoneVacuousContainers(store);
  const { pruned: initPruned } = pruneUnreachableTombstones(store);
  const { pruned: initStaleUnfolds } = pruneStaleUnfolds(store);
  if (initTombstoned > 0 || initPruned > 0 || initStaleUnfolds > 0) {
    dirty = true;
    stateDirty = true;
    logService(
      `[ApeironNgn service] Startup GC: cleaned ${initPruned} unreachable tombstone(s), ${initTombstoned} vacuous container(s), ${initStaleUnfolds} stale unfold(s).`
    );
    flushIfDirty();
    flushStateIfDirty();
  }

  let queue: Promise<unknown> = Promise.resolve();
  function enqueue<T>(fn: () => T | Promise<T>): Promise<T> {
    const result = queue.then(fn, fn);
    queue = result.then(() => undefined, () => undefined);
    return result;
  }

  /** Keyed on an actual content-hash mismatch, not `dirty` alone: `dirty` only means *this*
   *  process has a pending local mutation, which is the common, harmless case (no external write
   *  at all) — refusing on `dirty` by itself would nag on every ordinary flush. Only a genuine
   *  divergence since the last read/write is worth refusing over; when one's found, the write is
   *  skipped entirely (nothing partially overwritten) and the local mutation stays pending in
   *  memory (still `dirty`) for the caller to resolve and retry. */
  function flushIfDirty(): void {
    if (!dirty) return;
    const bad = diverged(contentDir, DEHYDRATE_CLASSES, contentStamps);
    if (bad.length > 0) {
      contentConflict =
        `${bad.map((k) => `${k}.jsonld`).join(', ')} changed on disk since this service last read it — an external ` +
        `process (another git pull, a hand-edit) wrote to the mirror while this service held unflushed local changes.`;
      throw new Error(`Refusing to flush: ${contentConflict} ${CONFLICT_RESOLUTION_HINT}`);
    }
    dehydrateToJsonLd(store, contentDir);
    contentStamps = stampAll(contentDir, DEHYDRATE_CLASSES);
    dirty = false;
    contentConflict = null;
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
   *  artifact isn't re-reported on every subsequent edit to it. */
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
    return introduced.length > 0 ? { ...result, linkBreakage: introduced } : result;
  }

  function flushStateIfDirty(): void {
    if (!stateDirty) return;
    const bad = diverged(stateDir, STATE_CLASSES, stateStamps);
    if (bad.length > 0) {
      stateConflict =
        `.state/${bad.map((k) => `${k}.jsonld`).join(', ')} changed on disk since this service last read it.`;
      throw new Error(`Refusing to flush: ${stateConflict} ${CONFLICT_RESOLUTION_HINT}`);
    }
    dehydrateStateToJsonLd(store, stateDir);
    stateStamps = stampAll(stateDir, STATE_CLASSES);
    stateDirty = false;
    stateConflict = null;
  }

  /** Flushes both mirrors if dirty, then rehydrates a fresh `Store` from disk and swaps it in —
   *  see this file's own doc comment for why. `dirty`/`stateDirty` need no explicit reset here:
   *  the flushes above already cleared them if they were set, and a fresh rehydrate starts clean
   *  regardless. A divergence during either flush above propagates out of this function too — a
   *  reload that can't safely flush first refuses rather than silently discarding the external
   *  change it exists to pick up — unless `discard` says to drop the pending local mutation
   *  instead of trying to preserve it, the deliberate, explicit way to resolve a conflict in
   *  favor of the external change (`kg:reload --discard`; never implied by any op's own bare
   *  `reload: true`, which always takes the safe, preserving path — a read shouldn't have the
   *  side effect of silently dropping someone else's pending write). */
  function reloadStore(discard = false): {
    quadCount: number;
    nodeCount: number;
    prunedTombstones: number;
    tombstonedContainers: number;
    prunedUnfolds: number;
  } {
    let tombstoned = 0;
    let pruned = 0;
    let staleUnfolds = 0;
    if (discard) {
      dirty = false;
      stateDirty = false;
      contentConflict = null;
      stateConflict = null;
    } else {
      // Mark-and-sweep tombstone GC (Aperas-apeironngn-design.md §5) — run here, not discarded:
      // this is exactly the "next service startup/reload" boundary the design settled on, and
      // `reloadStore` always flushes both mirrors together right after, so a pruned tombstone
      // reliably stays gone rather than reappearing from the very rehydrate this triggers below.
      // Skipped on `discard`, since that path throws away in-memory state instead of flushing it.
      ({ tombstoned } = tombstoneVacuousContainers(store));
      ({ pruned } = pruneUnreachableTombstones(store));
      if (tombstoned > 0 || pruned > 0) {
        dirty = true;
        stateDirty = true; // a pruned node's own dangling `unfolds` entries may have been swept too
      }
      // Own sweep, not folded into the above: a stale `unfolds` entry (issues/treeview.md) isn't
      // necessarily tied to anything just pruned here — it can predate this run entirely.
      ({ pruned: staleUnfolds } = pruneStaleUnfolds(store));
      if (staleUnfolds > 0) stateDirty = true;
      flushIfDirty();
      flushStateIfDirty();
    }
    const result = rehydrateStore();
    store = result.store;
    contentStamps = stampAll(contentDir, DEHYDRATE_CLASSES);
    stateStamps = stampAll(stateDir, STATE_CLASSES);
    const gcParts: string[] = [];
    if (pruned) gcParts.push(`${pruned} unreachable tombstone(s) pruned`);
    if (tombstoned) gcParts.push(`${tombstoned} vacuous container(s) tombstoned`);
    if (staleUnfolds) gcParts.push(`${staleUnfolds} stale unfold(s) cleared`);
    logService(
      `[ApeironNgn service] Reloaded ${result.quadCount} quad(s), ${result.nodeCount} node(s).` +
        (gcParts.length > 0 ? ` GC: ${gcParts.join(', ')}.` : '')
    );
    if (result.duplicateIds.length > 0) {
      logService(
        `[ApeironNgn service] WARNING: ${result.duplicateIds.length} duplicate @id(s) in the mirror — quads from every occurrence merged onto one subject, so at most one document per id survives the next dehydrate: ${result.duplicateIds.join(', ')}`
      );
    }
    // The other boundary where the graph can have changed without this process doing it — a reload
    // exists precisely to pick up someone else's write, which is exactly when a link can arrive
    // already broken.
    corpusLinkSweep('reload');
    return {
      quadCount: result.quadCount,
      nodeCount: result.nodeCount,
      prunedTombstones: pruned,
      tombstonedContainers: tombstoned,
      prunedUnfolds: staleUnfolds,
    };
  }

  /** The other side of `reloadStore(discard: true)`: resolves a conflict in favor of the *local*
   *  mutation instead, by writing current memory over disk unconditionally — no dirty check, no
   *  divergence check. Deliberately its own explicit op (`kg:flush --clobber`) rather than a flag
   *  folded into some unrelated mutating op's own `flush`, since this isn't tied to any particular
   *  mutation — it's "push out whatever's pending right now, no matter what's on disk," the direct
   *  counterpart to `--discard`'s "pull in whatever's on disk, no matter what's pending." Named
   *  `clobber`, not `force` — see `kgFlush.ts`'s doc comment for why the name alone doesn't route
   *  around `npm run kg:flush --force`'s original footgun (npm's own `--` separator requirement
   *  applies to any `--flag`, not just recognized npm options). */
  function clobberFlush(): { clobbered: true; prunedTombstones: number; tombstonedContainers: number; prunedUnfolds: number } {
    const { tombstoned } = tombstoneVacuousContainers(store); // same companion sweep `reloadStore` runs — see its own comment
    const { pruned } = pruneUnreachableTombstones(store); // same GC pass `reloadStore` runs — see its own comment
    const { pruned: staleUnfolds } = pruneStaleUnfolds(store); // same `unfolds` audit `reloadStore` runs — see its own comment
    dehydrateToJsonLd(store, contentDir);
    contentStamps = stampAll(contentDir, DEHYDRATE_CLASSES);
    dirty = false;
    contentConflict = null;
    dehydrateStateToJsonLd(store, stateDir);
    stateStamps = stampAll(stateDir, STATE_CLASSES);
    stateDirty = false;
    stateConflict = null;
    return { clobbered: true, prunedTombstones: pruned, tombstonedContainers: tombstoned, prunedUnfolds: staleUnfolds };
  }

  let idleTimer: NodeJS.Timeout;
  function resetIdleTimer(): void {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => shutdown(0), IDLE_TIMEOUT_MS);
  }

  // Both timers already swallow a thrown divergence rather than crash the process — logged (even
  // though `stdio: 'ignore'` on the normal detached spawn means it goes nowhere in practice) so a
  // foreground/debug run at least shows it, instead of a silently-stuck `dirty` flag retrying every
  // interval forever. An explicit `--flush`/`--reload`/`--discard` from a CLI command always
  // surfaces the same error normally through the request/response path regardless.
  const flushTimer = setInterval(() => {
    enqueue(() => flushIfDirty()).catch((err) => logService(`[ApeironNgn service] Timed flush: ${err.message}`));
  }, FLUSH_INTERVAL_MS);
  const stateFlushTimer = setInterval(() => {
    enqueue(() => flushStateIfDirty()).catch((err) => logService(`[ApeironNgn service] Timed state flush: ${err.message}`));
  }, STATE_FLUSH_INTERVAL_MS);

  let shuttingDown = false;
  /** Each flush attempted and caught independently: a divergence on one mirror must not skip the
   *  other (they're unrelated files), and neither may throw unhandled here — `.finally()` below
   *  has no `.catch()` after it, so an uncaught rejection from inside would go unhandled entirely.
   *  A stop must always complete, so a divergence at shutdown time is accepted as data loss (the
   *  pending local mutation never got flushed) rather than silently swallowed with no trace — the
   *  same conflict `kg:reload --discard`/`kg:flush --clobber` resolve deliberately, forced here by
   *  the process simply having to end. */
  function shutdown(code: number): void {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(flushTimer);
    clearInterval(stateFlushTimer);
    clearTimeout(idleTimer);
    server.close();
    enqueue(() => {
      // Same GC pass as `reloadStore`/`clobberFlush` (see `reloadStore`'s own comment) — shutdown
      // is the other half of the "gone at next startup" boundary: whatever's pruned here is what
      // the *next* service start rehydrates from, including after a plain idle-timeout exit with
      // no other pending mutation at all (`pruned > 0` alone must still trigger a flush below, same
      // reasoning as `reloadStore`). Wrapped in its own try/catch for the same "a stop must always
      // complete" reason the two flushes already are.
      try {
        const { tombstoned } = tombstoneVacuousContainers(store);
        const { pruned } = pruneUnreachableTombstones(store);
        if (tombstoned > 0 || pruned > 0) { dirty = true; stateDirty = true; }
        const { pruned: staleUnfolds } = pruneStaleUnfolds(store);
        if (staleUnfolds > 0) stateDirty = true;
      } catch (err: any) { logService(`[ApeironNgn service] Shutdown: tombstone GC failed — ${err.message}`); }
      try { flushIfDirty(); } catch (err: any) { logService(`[ApeironNgn service] Shutdown WARNING: content mirror flush refused — ${err.message}. Discarding un-flushed in-memory changes.`); }
      try { flushStateIfDirty(); } catch (err: any) { logService(`[ApeironNgn service] Shutdown WARNING: .state mirror flush refused — ${err.message}. Discarding un-flushed in-memory state.`); }
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
        return reloadStore(req.discard);
      case 'flush':
        if (req.clobber) return clobberFlush();
        else {
          flushIfDirty();
          flushStateIfDirty();
          return { clobbered: false };
        }
      case 'track': {
        if (req.reload) reloadStore();
        const result = runTrack(store, req.paths, req.force);
        dirty = true;
        if (req.flush) flushIfDirty();
        return result;
      }
      case 'trackReverse':
        if (req.reload) reloadStore();
        return runReverseTrack(store);
      case 'ingest': {
        if (req.reload) reloadStore();
        const result = runIngest(store, req.paths, req.track, req.force);
        dirty = true;
        if (req.flush) flushIfDirty();
        return result;
      }
      case 'unfold': {
        if (req.reload) reloadStore();
        // `peek` (no `--view` at all on the CLI call): read-only, matching `kg:tree`'s own
        // no-`--view` default — resolves and previews without bootstrapping or mutating the
        // default view (issues/treeview.md's "bare unfold mutates the default view" gap).
        if (req.peek) return runUnfold(store, req.ref, null, req.showTombstoned);
        const view = resolveTreeView(store, req.viewRef);
        const result = runUnfold(store, req.ref, view, req.showTombstoned);
        stateDirty = true;
        // `resolveTreeView`'s `ensureDefaultView` fallback may have just minted a first-use
        // `Profile` as a side effect -- `Profile` lives in the content mirror now, not `.state/`
        // (Aperas-treeview-design.md §8/§11), so only `dirty`'s own flush cadence would ever
        // persist it. Harmless to set unconditionally: a no-op re-dehydrate when nothing new was
        // actually minted, same as `dirty` already tolerates from every other mutating op here.
        dirty = true;
        if (req.flush) { flushStateIfDirty(); flushIfDirty(); }
        return result;
      }
      case 'fold': {
        if (req.reload) reloadStore();
        const view = resolveTreeView(store, req.viewRef);
        const result = runFold(store, req.ref, view);
        stateDirty = true;
        dirty = true; // see the matching comment in 'unfold' above
        if (req.flush) { flushStateIfDirty(); flushIfDirty(); }
        return result;
      }
      case 'resolve': {
        if (req.reload) reloadStore();
        const result = runResolve(store, req);
        if (req.createHolder) dirty = true;
        if (req.flush) flushIfDirty();
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
        dirty = true;
        if (req.flush) flushIfDirty();
        return withLinkCheck(result, artifactId, before);
      }
      case 'update': {
        if (req.reload) reloadStore();
        const artifactId = artifactForRef(req.path, req.base);
        const before = artifactId ? checkArtifactLinkIntegrity(store, artifactId) : null;
        const result = runUpdate(store, req);
        dirty = true;
        if (req.flush) flushIfDirty();
        return withLinkCheck(result, artifactId, before);
      }
      case 'remove': {
        if (req.reload) reloadStore();
        const artifactId = artifactForRef(req.path, req.base);
        const before = artifactId ? checkArtifactLinkIntegrity(store, artifactId) : null;
        const result = runRemove(store, req);
        dirty = true;
        if (req.flush) flushIfDirty();
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
        dirty = true;
        if (req.flush) flushIfDirty();
        return withLinkCheck(result, artifactId, before);
      }
      case 'linkCandidates':
        if (req.reload) reloadStore();
        return runLinkCandidates(store, req.pathArg, req.recursive, req.all);
      case 'addBlockLink': {
        const result = runAddBlockLink(store, req.blockId, req.targetRef);
        if (result.resolved) dirty = true;
        if (req.flush) flushIfDirty();
        return result;
      }
      case 'removeBlockLink': {
        const result = runRemoveBlockLink(store, req.blockId, req.targetRef);
        if (result.removed) dirty = true;
        if (req.flush) flushIfDirty();
        return result;
      }
      case 'project': {
        if (req.reload) reloadStore();
        const result = runProject(store, req.path, req.dryRun, req.force);
        if (!req.dryRun && !('conflict' in result)) dirty = true;
        if (req.flush) flushIfDirty();
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
        dirty = true;
        if (req.flush) flushIfDirty();
        return result;
      }
      case 'profileList':
        if (req.reload) reloadStore();
        return runProfileList(store, req.handle);
      case 'profileRemove': {
        if (req.reload) reloadStore();
        const result = runProfileRemove(store, req.handle);
        if (result.removed) dirty = true; // the Profile itself -- content mirror
        if (result.viewsRemoved > 0) stateDirty = true; // its cascade-deleted TreeViews -- state mirror
        if (req.flush) { flushIfDirty(); flushStateIfDirty(); }
        return result;
      }
      case 'profileCreateView': {
        if (req.reload) reloadStore();
        // A new TreeView only -- it never auto-creates its owning Profile the way `ensureDefaultView`
        // does (`createTreeView` throws if `--profile` doesn't already resolve), so `stateDirty`
        // alone is right here, unlike 'unfold'/'fold' above.
        const result = runProfileCreateView(store, req.name, req.profileHandle);
        stateDirty = true;
        if (req.flush) flushStateIfDirty();
        return result;
      }
      case 'profileListView':
        if (req.reload) reloadStore();
        return runProfileListView(store, req.name);
      case 'profileRemoveView': {
        if (req.reload) reloadStore();
        const result = runProfileRemoveView(store, req.name);
        if (result.removed) stateDirty = true;
        if (req.flush) flushStateIfDirty();
        return result;
      }
      case 'checkLinks': {
        if (req.reload) reloadStore();
        if (req.repair) {
          const res = repairLinkIntegrity(store);
          dirty = true;
          if (req.flush) flushIfDirty();
          return res;
        }
        return checkLinkIntegrity(store);
      }
      default:
        throw new Error(`ApeironNgn service: unknown op '${(req as { op?: string }).op}'`);
    }
  }

  function handleConnection(socket: Socket): void {
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf-8');
      const idx = buffer.indexOf('\n');
      if (idx === -1) return;
      const line = buffer.slice(0, idx);
      buffer = '';
      enqueue(async (): Promise<ServiceResponse> => {
        try {
          const req = decodeMessage<ServiceRequest>(line);
          const result = await handle(req);
          resetIdleTimer();
          // Attached regardless of `req.op` — see `contentConflict`/`stateConflict`'s own doc
          // comment for why this can't wait for a `flush`/`reload` call to surface it.
          const conflict = (contentConflict || stateConflict)
            ? { content: contentConflict ?? undefined, state: stateConflict ?? undefined }
            : undefined;
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

  process.on('SIGTERM', () => shutdown(0));
  process.on('SIGINT', () => shutdown(0));

  const socketPath = getSocketPath();
  try {
    unlinkSync(socketPath);
  } catch (err: any) {
    if (err.code !== 'ENOENT') throw err;
  }
  server.listen(socketPath, () => {
    markReady(contentDir, artifactsDir);
    resetIdleTimer();
    // Deliberately *after* `markReady`, and queued rather than run inline: `waitForReady` gives a
    // starting service 5s, and this sweep costs ~0.6s of that budget on an idle machine and more
    // under load — enough to turn `aperas service start` into a spurious "did not become ready in
    // time" failure (hit exactly once, on a loaded machine, before this was moved). Nothing depends
    // on the result being ready before the first request: it rides on responses until it clears, so
    // arriving a fraction of a second late costs nothing. `enqueue` keeps it from interleaving with
    // a request already in flight.
    enqueue(() => corpusLinkSweep('startup')).catch(() => {});
  });
}

if (process.argv[1]?.endsWith('service.ts')) main();
