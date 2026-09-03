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
 */

import { createServer, type Socket } from 'node:net';
import { unlinkSync } from 'node:fs';
import { rehydrateStore } from './store';
import { dehydrateToJsonLd, dehydrateStateToJsonLd } from './dehydrate';
import { wrap, ensureDefaultView, type TreeView } from './node';
import { getSocketPath, markReady, clearLock } from './serviceLock';
import { encodeMessage, decodeMessage, type ServiceRequest, type ServiceResponse } from './serviceProtocol';
import { runTrack } from '../kgTrack';
import { runIngest } from '../kgIngest';
import { runUnfold } from '../kgUnfold';
import { runFold } from '../kgFold';
import { runResolve } from '../kgResolve';
import { runTitleCandidates, runSetBlockTitle } from '../kgTitle';
import { runLinkCandidates, runAddBlockLink } from '../kgLink';
import { runProject } from '../kgProject';
import { runTree } from '../kgTree';
import { runPath } from '../kgPath';

const FLUSH_INTERVAL_MS = 10_000;
const STATE_FLUSH_INTERVAL_MS = 3_000;
const IDLE_TIMEOUT_MS = 30 * 60_000;

function main(): void {
  const { store, quadCount } = rehydrateStore();
  console.error(`[ApeironNgn service] Rehydrated ${quadCount} quad(s).`);

  let dirty = false;
  let stateDirty = false;
  let queue: Promise<unknown> = Promise.resolve();
  function enqueue<T>(fn: () => T | Promise<T>): Promise<T> {
    const result = queue.then(fn, fn);
    queue = result.then(() => undefined, () => undefined);
    return result;
  }

  function flushIfDirty(): void {
    if (!dirty) return;
    dehydrateToJsonLd(store);
    dirty = false;
  }

  function flushStateIfDirty(): void {
    if (!stateDirty) return;
    dehydrateStateToJsonLd(store);
    stateDirty = false;
  }

  let idleTimer: NodeJS.Timeout;
  function resetIdleTimer(): void {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => shutdown(0), IDLE_TIMEOUT_MS);
  }

  const flushTimer = setInterval(() => {
    enqueue(() => flushIfDirty()).catch(() => {});
  }, FLUSH_INTERVAL_MS);
  const stateFlushTimer = setInterval(() => {
    enqueue(() => flushStateIfDirty()).catch(() => {});
  }, STATE_FLUSH_INTERVAL_MS);

  let shuttingDown = false;
  function shutdown(code: number): void {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(flushTimer);
    clearInterval(stateFlushTimer);
    clearTimeout(idleTimer);
    server.close();
    enqueue(() => { flushIfDirty(); flushStateIfDirty(); }).finally(() => {
      clearLock();
      process.exit(code);
    });
  }

  async function handle(req: ServiceRequest): Promise<unknown> {
    switch (req.op) {
      case 'ping':
        return { pong: true };
      case 'track': {
        const result = runTrack(store, req.paths);
        dirty = true;
        if (req.flush) flushIfDirty();
        return result;
      }
      case 'ingest': {
        const result = runIngest(store);
        dirty = true;
        if (req.flush) flushIfDirty();
        return result;
      }
      case 'unfold': {
        const view = req.viewRef !== undefined ? (wrap(store, req.viewRef) as unknown as TreeView) : ensureDefaultView(store);
        const result = runUnfold(store, req.ref, view);
        stateDirty = true;
        if (req.flush) flushStateIfDirty();
        return result;
      }
      case 'fold': {
        const view = req.viewRef !== undefined ? (wrap(store, req.viewRef) as unknown as TreeView) : ensureDefaultView(store);
        const result = runFold(store, req.ref, view);
        stateDirty = true;
        if (req.flush) flushStateIfDirty();
        return result;
      }
      case 'resolve': {
        const result = runResolve(store, req);
        if (req.createHolder) dirty = true;
        if (req.flush) flushIfDirty();
        return result;
      }
      case 'titleCandidates':
        return runTitleCandidates(store, req.pathArg, req.recursive);
      case 'setBlockTitle': {
        runSetBlockTitle(store, req.blockId, req.title);
        dirty = true;
        if (req.flush) flushIfDirty();
        return null;
      }
      case 'linkCandidates':
        return runLinkCandidates(store, req.pathArg, req.recursive, req.all);
      case 'addBlockLink': {
        const result = runAddBlockLink(store, req.blockId, req.targetRef);
        if (result.resolved) dirty = true;
        if (req.flush) flushIfDirty();
        return result;
      }
      case 'project':
        return runProject(store, req.path);
      case 'tree':
        return runTree(store, req);
      case 'path':
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
          return { ok: true, result };
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
