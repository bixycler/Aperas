/**
 * ApeironNgn shared service process (Aperas-apeironngn-design.md §4 rollout step 5) — holds one
 * rehydrated `Store` in memory across CLI invocations instead of every `kg:xxx` script rehydrating/
 * dehydrating the whole mirror on its own. Listens on a Unix domain socket; every request is
 * serialized through `enqueue()` so concurrent connections never interleave store mutations.
 * Flushes to `AperasKG/Apeiron/`'s JSON-LD mirror every 10s if dirty, or immediately when a
 * request carries `flush: true`. A second, independent interval/dirty-flag pair
 * (`STATE_FLUSH_INTERVAL_MS`/`stateDirty`) does the same for `Profile`/`TreeView`'s own
 * `.state/` mirror (Aperas-treeview-design.md §8) — expand/collapse churns far more often than
 * content edits, and `.state/` is cheap and gitignored, so it's tuned separately rather than
 * riding the content mirror's cadence. Exits after 30 idle minutes or on SIGTERM/SIGINT, flushing
 * both if dirty either way.
 *
 * Started on demand by `serviceClient.ts#ensureServiceRunning` — not meant to be run directly,
 * though doing so still works (it just skips the lock-claim race that only matters when multiple
 * clients might be starting a service at once).
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
import { unlinkSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { rehydrateStore, getApeironExportDir } from './store';
import { dehydrateToJsonLd, dehydrateStateToJsonLd, DEHYDRATE_CLASSES, STATE_CLASSES } from './dehydrate';
import { computeFileHash } from '../artifacts';
import { wrap, ensureDefaultView, pruneUnreachableTombstones, type TreeView } from './node';
import { getSocketPath, markReady, clearLock } from './serviceLock';
import { encodeMessage, decodeMessage, CONFLICT_RESOLUTION_HINT, type ServiceRequest, type ServiceResponse } from './serviceProtocol';
import { runTrack } from '../kgTrack';
import { runIngest } from '../kgIngest';
import { runUnfold } from '../kgUnfold';
import { runFold } from '../kgFold';
import { runResolve } from '../kgResolve';
import { runTitleCandidates, runSetBlockTitle } from '../kgTitle';
import { runLinkCandidates, runAddBlockLink, runRemoveBlockLink } from '../kgLink';
import { runProject } from '../kgProject';
import { runTree } from '../kgTree';
import { runPath } from '../kgPath';

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

function main(): void {
  let { store, quadCount } = rehydrateStore();
  console.error(`[ApeironNgn service] Rehydrated ${quadCount} quad(s).`);

  const contentDir = getApeironExportDir();
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
    dehydrateToJsonLd(store);
    contentStamps = stampAll(contentDir, DEHYDRATE_CLASSES);
    dirty = false;
    contentConflict = null;
  }

  function flushStateIfDirty(): void {
    if (!stateDirty) return;
    const bad = diverged(stateDir, STATE_CLASSES, stateStamps);
    if (bad.length > 0) {
      stateConflict =
        `.state/${bad.map((k) => `${k}.jsonld`).join(', ')} changed on disk since this service last read it.`;
      throw new Error(`Refusing to flush: ${stateConflict} ${CONFLICT_RESOLUTION_HINT}`);
    }
    dehydrateStateToJsonLd(store);
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
  function reloadStore(discard = false): { quadCount: number; nodeCount: number } {
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
      const { pruned } = pruneUnreachableTombstones(store);
      if (pruned > 0) {
        dirty = true;
        stateDirty = true; // a pruned node's own dangling `unfolds` entries may have been swept too
      }
      flushIfDirty();
      flushStateIfDirty();
    }
    const result = rehydrateStore();
    store = result.store;
    contentStamps = stampAll(contentDir, DEHYDRATE_CLASSES);
    stateStamps = stampAll(stateDir, STATE_CLASSES);
    console.error(`[ApeironNgn service] Reloaded ${result.quadCount} quad(s).`);
    return { quadCount: result.quadCount, nodeCount: result.nodeCount };
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
  function clobberFlush(): void {
    pruneUnreachableTombstones(store); // same GC pass `reloadStore` runs — see its own comment
    dehydrateToJsonLd(store);
    contentStamps = stampAll(contentDir, DEHYDRATE_CLASSES);
    dirty = false;
    contentConflict = null;
    dehydrateStateToJsonLd(store);
    stateStamps = stampAll(stateDir, STATE_CLASSES);
    stateDirty = false;
    stateConflict = null;
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
    enqueue(() => flushIfDirty()).catch((err) => console.error(`[ApeironNgn service] Timed flush: ${err.message}`));
  }, FLUSH_INTERVAL_MS);
  const stateFlushTimer = setInterval(() => {
    enqueue(() => flushStateIfDirty()).catch((err) => console.error(`[ApeironNgn service] Timed state flush: ${err.message}`));
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
        const { pruned } = pruneUnreachableTombstones(store);
        if (pruned > 0) { dirty = true; stateDirty = true; }
      } catch (err: any) { console.error(`[ApeironNgn service] Shutdown: tombstone GC failed — ${err.message}`); }
      try { flushIfDirty(); } catch (err: any) { console.error(`[ApeironNgn service] Shutdown: content mirror not flushed — ${err.message}`); }
      try { flushStateIfDirty(); } catch (err: any) { console.error(`[ApeironNgn service] Shutdown: .state mirror not flushed — ${err.message}`); }
    }).finally(() => {
      clearLock();
      process.exit(code);
    });
  }

  async function handle(req: ServiceRequest): Promise<unknown> {
    switch (req.op) {
      case 'ping':
        return { pong: true };
      case 'reload':
        return reloadStore(req.discard);
      case 'flush':
        if (req.clobber) clobberFlush();
        else { flushIfDirty(); flushStateIfDirty(); }
        return { clobbered: req.clobber };
      case 'track': {
        if (req.reload) reloadStore();
        const result = runTrack(store, req.paths);
        dirty = true;
        if (req.flush) flushIfDirty();
        return result;
      }
      case 'ingest': {
        if (req.reload) reloadStore();
        const result = runIngest(store, req.paths, req.track);
        dirty = true;
        if (req.flush) flushIfDirty();
        return result;
      }
      case 'unfold': {
        if (req.reload) reloadStore();
        const view = req.viewRef !== undefined ? (wrap(store, req.viewRef) as unknown as TreeView) : ensureDefaultView(store);
        const result = runUnfold(store, req.ref, view);
        stateDirty = true;
        if (req.flush) flushStateIfDirty();
        return result;
      }
      case 'fold': {
        if (req.reload) reloadStore();
        const view = req.viewRef !== undefined ? (wrap(store, req.viewRef) as unknown as TreeView) : ensureDefaultView(store);
        const result = runFold(store, req.ref, view);
        stateDirty = true;
        if (req.flush) flushStateIfDirty();
        return result;
      }
      case 'resolve': {
        if (req.reload) reloadStore();
        const result = runResolve(store, req);
        if (req.createHolder) dirty = true;
        if (req.flush) flushIfDirty();
        return result;
      }
      case 'titleCandidates':
        if (req.reload) reloadStore();
        return runTitleCandidates(store, req.pathArg, req.recursive);
      case 'setBlockTitle': {
        runSetBlockTitle(store, req.blockId, req.title);
        dirty = true;
        if (req.flush) flushIfDirty();
        return null;
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
      case 'project':
        if (req.reload) reloadStore();
        return runProject(store, req.path);
      case 'tree':
        if (req.reload) reloadStore();
        return runTree(store, req);
      case 'path':
        if (req.reload) reloadStore();
        return runPath(store, req.idArg);
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
          return conflict ? { ok: true, result, conflict } : { ok: true, result };
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
    markReady();
    resetIdleTimer();
  });
}

main();
