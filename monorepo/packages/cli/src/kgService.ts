/**
 * `kg:service` — direct control over the shared ApeironNgn service process. `start`/`restart` are
 * the only place `process.cwd()` is ever read to resolve which graph the service binds to
 * (AperasKG/artifacts/discussion/packaging.md's "Settled: no concurrency..." note) — every other
 * `kg:xxx` command just connects to whatever's already running, at the fixed location
 * `serviceLock.ts#getRunDir` returns, and errors if nothing's there rather than silently starting
 * one bound to whatever cwd it happened to be called from. `restart` also remains the only way a
 * source-code change takes effect (Node doesn't hot-reload; the service holds the whole `Store`
 * and its own loaded code in memory for as long as it runs) — `ensureServiceRunning`'s own
 * stale-code warning (`serviceClient.ts`) tells you *when* one's needed. `stop` is the explicit,
 * graceful counterpart to reaching for `kill` by hand — same SIGTERM-and-wait `restart` already
 * did as its own first half, just without the respawn after.
 */

import { readLock, isProcessAlive, clearLock, claimLock } from './apeironNgn/serviceLock';
import { ping, spawnService, waitForReady } from './apeironNgn/serviceClient';
import { resolveEffectiveApeironRoot, resolveEffectiveArtifactsRoot } from '@aperas/core/graphConfig';
import { wantsHelp, printHelp } from './kgHelp';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function describeBinding(apeironRoot: string, artifactsRoot: string): string {
  return `graph: ${apeironRoot}, artifacts: ${artifactsRoot}`;
}

/** Resolves both roots from *this* invocation's own `process.cwd()`, claims the lock, spawns the
 *  service bound to them, and waits for it to answer — shared by `start` (nothing was running) and
 *  `restart` (something was, but just got stopped) since both end the same way: one fresh service,
 *  freshly bound. */
async function bindAndSpawn(): Promise<{ apeironRoot: string; artifactsRoot: string }> {
  const cwd = process.cwd();
  const apeironRoot = resolveEffectiveApeironRoot(cwd);
  const artifactsRoot = resolveEffectiveArtifactsRoot(cwd);
  if (claimLock(apeironRoot, artifactsRoot) !== 'claimed') {
    throw new Error('Another `aperas service start`/`restart` appears to be in progress — try again shortly.');
  }
  spawnService(apeironRoot, artifactsRoot);
  await waitForReady();
  return { apeironRoot, artifactsRoot };
}

async function runStart(): Promise<void> {
  if (await ping()) {
    const lock = readLock();
    console.log(`[ApeironNgn kg:service] Already running (pid ${lock?.pid ?? '?'}), bound to ${lock ? describeBinding(lock.apeironRoot, lock.artifactsRoot) : '?'}.`);
    return;
  }
  const lock = readLock();
  if (lock) clearLock(); // not actually answering — a stale leftover from a crash, not a live claim
  const { apeironRoot, artifactsRoot } = await bindAndSpawn();
  console.log(`[ApeironNgn kg:service] Started — bound to ${describeBinding(apeironRoot, artifactsRoot)}.`);
}

/** Gracefully stops whatever's running — SIGTERM triggers the service's own graceful shutdown
 *  (`service.ts`): flushes both mirrors if dirty, then clears the lock itself, same as an ordinary
 *  Ctrl-C. Returns whether anything was actually stopped, vs. nothing being live to begin with (a
 *  stale leftover lock from a crash is cleared either way). Shared by `stop` and `restart`'s own
 *  first half — the only difference between them is whether a fresh service follows. */
async function stopIfRunning(): Promise<boolean> {
  const lock = readLock();
  if (lock && isProcessAlive(lock.pid)) {
    console.log(`[ApeironNgn kg:service] Stopping service (pid ${lock.pid})...`);
    process.kill(lock.pid, 'SIGTERM');
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && isProcessAlive(lock.pid)) await sleep(100);
    if (isProcessAlive(lock.pid)) {
      throw new Error(`Service (pid ${lock.pid}) didn't stop within 10s of SIGTERM — check it manually before retrying.`);
    }
    return true;
  }
  if (lock) clearLock(); // a lock file whose pid is already dead — leftover from a crash, not a live claim
  return false;
}

async function runStop(): Promise<void> {
  const stopped = await stopIfRunning();
  console.log(stopped ? '[ApeironNgn kg:service] Stopped.' : '[ApeironNgn kg:service] No running service found.');
}

async function runRestart(): Promise<void> {
  const stopped = await stopIfRunning();
  if (!stopped) console.log('[ApeironNgn kg:service] No running service found — starting fresh instead of restarting.');
  const { apeironRoot, artifactsRoot } = await bindAndSpawn();
  console.log(`[ApeironNgn kg:service] Restarted — now running the current on-disk code, bound to ${describeBinding(apeironRoot, artifactsRoot)}.`);
}

export async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  if (wantsHelp(rawArgs)) {
    printHelp({
      description: 'Direct control over the shared ApeironNgn service process.',
      usage: 'aperas service <start|stop|restart>',
      args: [
        { name: 'start', description: "Start the service if none is already running, binding it to the graph resolved from the current directory (aperas.config.json discovery, or the dev fallback) for its whole lifetime. A no-op (with a status line naming the bound graph) if one's already running." },
        { name: 'stop', description: "Gracefully stop the running service (flushes if dirty, same as SIGTERM/Ctrl-C) — the explicit counterpart to finding its pid and killing it by hand. A no-op if none is running." },
        { name: 'restart', description: "Stop whatever's running (same as `stop`) and start a fresh one, re-resolving and rebinding the graph from the current directory — the only way both a source-code change and a graph switch take effect." },
      ],
      flags: [],
    });
    return;
  }
  const [subcommand] = rawArgs;
  if (subcommand === 'start') return runStart();
  if (subcommand === 'stop') return runStop();
  if (subcommand === 'restart') return runRestart();
  console.error('Usage: aperas service <start|stop|restart>');
  process.exit(1);
}

if (process.argv[1]?.endsWith('kgService.ts')) {
  main().catch((err) => {
    console.error('[ApeironNgn kg:service] Failed:', err.message || err);
    process.exit(1);
  });
}
