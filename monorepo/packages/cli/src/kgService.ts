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
 * did as its own first half, just without the respawn after. `status` only looks: it reads the lock, tests the pid and pings once, and starts, stops and clears nothing.
 */

import { readLock, isProcessAlive, clearLock, claimLock, recordStartingPid, resolveHttpPort, getRunDir } from './service/serviceLock';
import { ping, pingAnswer, spawnService, waitForReady } from './service/serviceClient';
import { computeCodeFingerprint } from './service/codeVersion';
import { readCliVersion } from './cliVersion';
import { statSync } from 'node:fs';
import { describeEffectiveApeironRoot, resolveEffectiveApeironRoot, resolveEffectiveArtifactsRoot, resolveEffectiveGraphName } from '@aperas/core/graphConfig';
import { wantsHelp, printHelp } from './kgHelp';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function describeBinding(apeironRoot: string, artifactsRoot: string): string {
  return `graph: ${apeironRoot}, artifacts: ${artifactsRoot}`;
}

/** The refusal text for a start in a place that is not a graph: the Apeiron root `startDir` resolves to (and how it was found) does not exist, or is not a directory; `null` when it is a directory. The same text for `start`, `restart` and everything that starts a service (`serve`), so a user who installed the package and has no graph is told once what to do, in the words of `aperas init`. Nothing is created. */
export function noGraphMessage(startDir: string = process.cwd()): string | null {
  const root = describeEffectiveApeironRoot(startDir);
  let isDir = false;
  try { isDir = statSync(root.path).isDirectory(); } catch { /* absent */ }
  if (isDir) return null;
  const how = root.via === 'variable'
    ? `the environment variable ${root.source}`
    : root.via === 'config'
      ? `the "graph" field of ${root.source}`
      : `the fallback, because no aperas.config.json was found in ${root.source} or above it and APERAS_APEIRON_ROOT is not set`;
  return [
    `There is no graph to start a service on: the Apeiron root is ${root.path} (from ${how}), and it does not exist or is not a directory. Nothing was created.`,
    "To make a graph, create or enter a directory for it and run 'aperas init' there (it writes aperas.config.json, an empty Apeiron/ store and an artifacts/ tree); then run 'aperas service start' from that directory or any directory below it.",
  ].join('\n');
}

function refuseWithoutGraph(): void {
  const message = noGraphMessage();
  if (message !== null) throw new Error(message);
}

/** Resolves both roots from *this* invocation's own `process.cwd()`, claims the lock, spawns the
 *  service bound to them, and waits for it to answer — shared by `start` (nothing was running) and
 *  `restart` (something was, but just got stopped) since both end the same way: one fresh service,
 *  freshly bound. */
async function bindAndSpawn(startAnyway: boolean): Promise<{ apeironRoot: string; artifactsRoot: string }> {
  refuseWithoutGraph();
  const cwd = process.cwd();
  const apeironRoot = resolveEffectiveApeironRoot(cwd);
  const artifactsRoot = resolveEffectiveArtifactsRoot(cwd);
  const graphName = resolveEffectiveGraphName(cwd);
  const httpPort = resolveHttpPort();
  if (claimLock(apeironRoot, artifactsRoot, httpPort) !== 'claimed') {
    throw new Error('Another `aperas service start`/`restart` appears to be in progress — try again shortly.');
  }
  const pid = spawnService(apeironRoot, artifactsRoot, httpPort, graphName, startAnyway);
  if (pid !== undefined) recordStartingPid(pid);
  await waitForReady();
  return { apeironRoot, artifactsRoot };
}

/** Exported for `kgServe.ts` ("aperas serve"): its own "ensure a service is running, bound to the
 *  current graph, start one if not" need is exactly this function's existing behavior. */
export async function runStart(options: { startAnyway?: boolean } = {}): Promise<void> {
  if (await ping()) {
    const lock = readLock();
    console.log(`[aperas service] Already running (pid ${lock?.pid ?? '?'}), bound to ${lock ? describeBinding(lock.apeironRoot, lock.artifactsRoot) : '?'}.`);
    return;
  }
  const lock = readLock();
  if (lock && isProcessAlive(lock.pid)) { // a lock whose process lives is a service, not a leftover: never clear it and start a second one
    if (lock.status === 'starting') { // another start is under way: join its wait
      console.log(`[aperas service] Already starting (pid ${lock.pid}) — waiting for it.`);
      await waitForReady();
      const ready = readLock();
      console.log(`[aperas service] Started — bound to ${ready ? describeBinding(ready.apeironRoot, ready.artifactsRoot) : describeBinding(lock.apeironRoot, lock.artifactsRoot)}.`);
      return;
    }
    console.log(`[aperas service] Running (pid ${lock.pid}) but busy and not answering yet — waiting for it.`); // ready, and too busy to answer the ping in 300 ms
    await waitForReady();
    const now = readLock() ?? lock;
    console.log(`[aperas service] Already running (pid ${now.pid}), bound to ${describeBinding(now.apeironRoot, now.artifactsRoot)}.`);
    return;
  }
  if (lock) clearLock(); // its process is gone — a stale leftover from a crash, not a live claim
  const { apeironRoot, artifactsRoot } = await bindAndSpawn(options.startAnyway === true);
  console.log(`[aperas service] Started — bound to ${describeBinding(apeironRoot, artifactsRoot)}.`);
}

/** Gracefully stops whatever's running — SIGTERM triggers the service's own graceful shutdown
 *  (`service.ts`): flushes both mirrors if dirty, then clears the lock itself, same as an ordinary
 *  Ctrl-C. Returns whether anything was actually stopped, vs. nothing being live to begin with (a
 *  stale leftover lock from a crash is cleared either way). Shared by `stop` and `restart`'s own
 *  first half — the only difference between them is whether a fresh service follows. */
async function stopIfRunning(): Promise<boolean> {
  const lock = readLock();
  if (lock && isProcessAlive(lock.pid)) {
    console.log(`[aperas service] Stopping service (pid ${lock.pid})...`);
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
  console.log(stopped ? '[aperas service] Stopped.' : '[aperas service] No running service found.');
}

async function runRestart(startAnyway: boolean): Promise<void> {
  refuseWithoutGraph(); // before the stop: a restart that cannot start again leaves the running service alone
  const stopped = await stopIfRunning();
  if (!stopped) console.log('[aperas service] No running service found — starting fresh instead of restarting.');
  const { apeironRoot, artifactsRoot } = await bindAndSpawn(startAnyway);
  console.log(`[aperas service] Restarted — now running the current on-disk code, bound to ${describeBinding(apeironRoot, artifactsRoot)}.`);
}

/** The states of `aperas service status` and their exit codes: `ready` 0; `starting` and `busy` 1 (a process lives and does not answer yet); `stopped` 3 (no lock, or a lock whose process is gone). */
export type ServiceState = 'ready' | 'starting' | 'busy' | 'stopped';
export const STATUS_EXIT: Record<ServiceState, number> = { ready: 0, starting: 1, busy: 1, stopped: 3 };

export interface ServiceStatus {
  state: ServiceState;
  /** True for a lock whose process is gone: reported, and left in place. */
  staleLock: boolean;
  /** What the lock says; null when there is none. */
  lockStatus: 'starting' | 'ready' | null;
  pid: number | null;
  startedAt: string | null;
  uptimeSeconds: number | null;
  httpPort: number | null;
  apeironRoot: string | null;
  artifactsRoot: string | null;
  runDir: string;
  /** The version of this CLI (its `package.json`). */
  version: string;
  /** The fingerprint of the code the service runs (its answer to the ping); null unless it answered. */
  codeFingerprint: string | null;
  /** The fingerprint of the code on disk now. */
  currentCodeFingerprint: string;
  /** True when the service answered with a fingerprint other than the one on disk now: it runs code older than the source. */
  codeStale: boolean;
}

/** Reads the state of the service without changing anything: the lock, whether its process lives, and one ping (on the local socket). Never starts, stops or clears. */
export async function serviceStatus(): Promise<ServiceStatus> {
  const lock = readLock();
  const alive = lock !== null && isProcessAlive(lock.pid);
  let state: ServiceState = 'stopped';
  let codeFingerprint: string | null = null;
  if (lock !== null && alive) {
    if (lock.status === 'starting') state = 'starting';
    else {
      const answer = await pingAnswer();
      state = answer ? 'ready' : 'busy';
      codeFingerprint = answer?.codeFingerprint ?? null;
    }
  }
  const currentCodeFingerprint = computeCodeFingerprint();
  const startedMs = lock ? Date.parse(lock.startedAt) : NaN;
  return {
    state,
    staleLock: lock !== null && !alive,
    lockStatus: lock?.status ?? null,
    pid: lock?.pid ?? null,
    startedAt: lock?.startedAt ?? null,
    uptimeSeconds: state !== 'stopped' && Number.isFinite(startedMs) ? Math.max(0, Math.round((Date.now() - startedMs) / 1000)) : null,
    httpPort: lock?.httpPort ?? null,
    apeironRoot: lock?.apeironRoot ?? null,
    artifactsRoot: lock?.artifactsRoot ?? null,
    runDir: getRunDir(),
    version: readCliVersion(),
    codeFingerprint,
    currentCodeFingerprint,
    codeStale: codeFingerprint !== null && codeFingerprint !== currentCodeFingerprint,
  };
}

function formatDuration(totalSeconds: number): string {
  const d = Math.floor(totalSeconds / 86400);
  const h = Math.floor((totalSeconds % 86400) / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const sec = totalSeconds % 60;
  return [d ? `${d}d` : '', d || h ? `${h}h` : '', d || h || m ? `${m}m` : '', `${sec}s`].filter(Boolean).join(' ');
}

/** The lines `aperas service status` prints: the state word, then one detail per line. */
export function formatStatus(st: ServiceStatus): string {
  const lines: string[] = [st.state];
  const detail = (label: string, value: string | number | null): void => { if (value !== null) lines.push(`  ${label}: ${value}`); };
  if (st.state === 'stopped') {
    lines.push(st.staleLock ? `  a stale lock of a process that is gone (pid ${st.pid}) is left in place in ${st.runDir}` : `  no service lock in ${st.runDir}`);
  } else if (st.state === 'starting') {
    lines.push('  the lock says starting and its process lives');
  } else if (st.state === 'busy') {
    lines.push('  the process lives and did not answer the ping');
  }
  detail('pid', st.pid);
  detail('uptime', st.uptimeSeconds === null ? null : formatDuration(st.uptimeSeconds));
  detail('http port', st.httpPort);
  detail('apeiron root', st.apeironRoot);
  detail('artifacts root', st.artifactsRoot);
  detail('run directory', st.runDir);
  detail('version', st.version);
  if (st.codeFingerprint !== null) {
    detail('service code', `${st.codeFingerprint}${st.codeStale ? ` — differs from the code on disk (${st.currentCodeFingerprint}): the service runs older code; run: aperas service restart` : ' (the code on disk now)'}`);
  }
  return lines.join('\n');
}

/** Prints the status (`json`: one JSON object on one line) and returns the exit code of its state. */
export async function runStatus(options: { json?: boolean } = {}): Promise<number> {
  const st = await serviceStatus();
  console.log(options.json ? JSON.stringify(st) : formatStatus(st));
  return STATUS_EXIT[st.state];
}

export async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  if (wantsHelp(rawArgs)) {
    printHelp({
      description: 'Direct control over the shared ApeironNgn service process.',
      usage: 'aperas service {start|stop|restart|status} [--start-anyway] [--json]',
      args: [
        { name: 'start', description: "Start the service if none is already running, binding it to the graph resolved from the current directory (aperas.config.json discovery, or the dev fallback) for its whole lifetime. Refuses, creating nothing, when the graph it resolves does not exist (run `aperas init` first). A no-op (with a status line naming the bound graph) if one's already running." },
        { name: 'stop', description: "Gracefully stop the running service (flushes if dirty, same as SIGTERM/Ctrl-C) — the explicit counterpart to finding its pid and killing it by hand. A no-op if none is running." },
        { name: 'restart', description: "Stop whatever's running (same as `stop`) and start a fresh one, re-resolving and rebinding the graph from the current directory — the only way both a source-code change and a graph switch take effect." },
        { name: 'status', description: "Say whether the service is running, without starting, stopping or clearing anything. Prints one state word and its details (pid, uptime, HTTP port, Apeiron and artifacts roots, run directory, the version of the CLI and the code fingerprint the service runs, with a note when the code on disk now differs). Exit code: ready 0; starting or busy (a process lives and does not answer yet) 1; stopped (no lock, or a stale lock, which is reported and left in place) 3." },
      ],
      flags: [
        { name: '--start-anyway', description: "`start` and `restart` only. Start even when the load of the mirror did not read it in full (an id carried by more than one document, or a document the engine refused): the service works on the unaffected parts, and copies the documents it skipped to a side file next to their file (`<file>.rejected-<stamp>.json`) before anything can flush over them. Without it the service refuses to start and its log names the files and ids." },
        { name: '--json', description: '`status` only. Print the same as one JSON object on one line, the state word under `state`.' },
      ],
    });
    return;
  }
  const [subcommand] = rawArgs;
  const startAnyway = rawArgs.includes('--start-anyway');
  if (subcommand === 'start') return runStart({ startAnyway });
  if (subcommand === 'stop') return runStop();
  if (subcommand === 'restart') return runRestart(startAnyway);
  if (subcommand === 'status') {
    process.exitCode = await runStatus({ json: rawArgs.includes('--json') });
    return;
  }
  console.error('Usage: aperas service {start|stop|restart|status} [--start-anyway] [--json]');
  process.exit(1);
}

if (process.argv[1]?.endsWith('kgService.ts')) {
  main().catch((err) => {
    console.error('[aperas service] Failed:', err.message || err);
    process.exit(1);
  });
}
