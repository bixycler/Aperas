/**
 * ApeironNgn shared service client (Aperas-apeironngn-design.md §4 rollout step 5) — every
 * `kg:xxx` script uses this instead of loading and dumping the mirror itself.
 * `ensureServiceRunning` errors with instructions rather than auto-starting one (it waits for a service that is still starting or busy, as a start does) (AperasKG/
 * artifacts/discussion/packaging.md's "Settled: no concurrency..." note: an implicit auto-spawn
 * meant whichever command happened to run first silently decided which graph the service bound to
 * for its whole lifetime — `aperas service start`/`restart` (`kgService.ts`) is now the only place
 * that resolves and claims that binding, deliberately a human-driven action); `request` sends one
 * op and returns its result. `ping`/`spawnService`/`waitForReady` are exported for `kgService.ts`'s
 * own `start`/`restart` to reuse directly.
 */

import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSocketPath, getRunDir, readLock, isProcessAlive, type LockInfo } from './serviceLock';
import { encodeMessage, decodeMessage, CONFLICT_RESOLUTION_HINT, START_ANYWAY_ENV, type ServiceRequest, type ServiceResponse } from './serviceProtocol';
import { computeCodeFingerprint } from './codeVersion';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PING_TIMEOUT_MS = 300;
/** How long a start waits for the lock to say `ready` when `APERAS_READY_TIMEOUT_MS` does not say: a service on a large mirror, or on a loaded machine, takes far longer than a few seconds, and a wait that gives up first reports a failure of a start that is going well. */
export const DEFAULT_READY_TIMEOUT_MS = 180_000;
/** How often the wait says that the service is still starting. */
const STILL_STARTING_NOTE_MS = 10_000;
const READY_POLL_MS = 100;

/** The wait of a start, in milliseconds: `APERAS_READY_TIMEOUT_MS` when it is a positive number, else the default. */
export function readyTimeoutMs(): number {
  const n = Number(process.env.APERAS_READY_TIMEOUT_MS);
  return process.env.APERAS_READY_TIMEOUT_MS?.trim() && Number.isFinite(n) && n > 0 ? n : DEFAULT_READY_TIMEOUT_MS;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function sendRaw(req: ServiceRequest, timeoutMs: number): Promise<ServiceResponse> {
  return new Promise((resolvePromise, reject) => {
    const socket = connect(getSocketPath());
    // Decoded by the socket itself, which keeps the bytes of a character cut between two chunks until the rest arrives; `chunk.toString()` on each chunk would print U+FFFD for each half.
    socket.setEncoding('utf8');
    let buffer = '';
    let settled = false;
    const timer = timeoutMs > 0 ? setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error('ApeironNgn service request timed out'));
    }, timeoutMs) : null;
    socket.on('connect', () => socket.write(encodeMessage(req)));
    socket.on('data', (chunk) => {
      if (settled) return;
      buffer += chunk;
      const idx = buffer.indexOf('\n');
      if (idx === -1) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const line = buffer.slice(0, idx);
      socket.end();
      try {
        resolvePromise(decodeMessage<ServiceResponse>(line));
      } catch (err) {
        reject(err);
      }
    });
    socket.on('error', (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(err);
    });
  });
}

/** Warns (this short-lived client process's own stdio — the service's is `stdio: 'ignore'`) when
 *  the running service's own `codeFingerprint` (stamped once, at *its* startup) no longer matches
 *  what's on disk right now — i.e. a source edit landed after the service last started, which Node
 *  never picks up on its own. Never throws or blocks the call itself; a stale service still answers
 *  requests, just possibly with logic a later fix already replaced. */
function warnIfCodeStale(res: ServiceResponse): void {
  if (!res.ok) return;
  const result = res.result as { codeFingerprint?: string } | undefined;
  if (!result?.codeFingerprint) return;
  const current = computeCodeFingerprint();
  if (result.codeFingerprint !== current) {
    console.error(`[ApeironNgn service] Running code is stale (fingerprint ${result.codeFingerprint} vs. current ${current} on disk) — a source change since this service started won't take effect until it's restarted. Run: aperas service restart`);
  }
}

export async function ping(): Promise<boolean> {
  try {
    const res = await sendRaw({ op: 'ping' }, PING_TIMEOUT_MS);
    warnIfCodeStale(res);
    return res.ok === true;
  } catch {
    return false;
  }
}

/** One ping, for a reader that only looks (`aperas service status`): the answer of a service that replies within `PING_TIMEOUT_MS`, else null. It prints nothing, unlike `ping`, which warns of stale code. */
export async function pingAnswer(): Promise<{ codeFingerprint?: string } | null> {
  try {
    const res = await sendRaw({ op: 'ping' }, PING_TIMEOUT_MS);
    return res.ok === true ? { codeFingerprint: (res.result as { codeFingerprint?: string } | undefined)?.codeFingerprint } : null;
  } catch {
    return null;
  }
}

/** The reason a starting service gave for refusing to start: the last line of its log that says `REFUSING TO START`, written at or after `since`. */
function refusalSince(since: number): string | undefined {
  try {
    const lines = readFileSync(join(getRunDir(), 'service.log'), 'utf-8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const at = lines[i]!.indexOf(' ');
      if (at > 0 && Date.parse(lines[i]!.slice(0, at)) >= since && lines[i]!.includes('REFUSING TO START')) return lines[i]!.slice(lines[i]!.indexOf('REFUSING TO START'));
    }
  } catch { /* no log: no reason to give */ }
  return undefined;
}

/** The reason a service that ended without becoming ready gave, from the log, or the plain fact. */
function endedWithoutReady(startedAt: number, what: string): Error {
  const why = refusalSince(startedAt - 1000);
  return new Error(why ? `ApeironNgn service ${why}` : `ApeironNgn service ${what} (see service.log in the run directory)`);
}

/**
 * Waits for the service to answer, for `APERAS_READY_TIMEOUT_MS` (default 180 s) at most. While the process the lock names lives and the lock does not yet say `ready`, the service
 * is still starting, and the wait says so on stderr every ten seconds; a start fails with a message of its own only when that process died (a service that refuses to start clears
 * the lock the caller claimed and exits: the wait ends at once and says why from the log) or when the time is out, and a time out leaves the service running.
 * A lock that says `ready` with a live process is a service that is busy, however long its last request has run: the wait says so in the same way, and never clears the lock.
 */
export async function waitForReady(options: { timeoutMs?: number; noteEveryMs?: number } = {}): Promise<void> {
  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs ?? readyTimeoutMs();
  const noteEveryMs = options.noteEveryMs ?? STILL_STARTING_NOTE_MS;
  const deadline = startedAt + timeoutMs;
  let nextNote = startedAt + noteEveryMs;
  let last: LockInfo | null = null;
  for (;;) {
    if (await ping()) return;
    const before: LockInfo | null = last;
    last = readLock();
    if (last === null) {
      if (before?.status === 'ready') throw new Error(`ApeironNgn service (process ${before.pid}) stopped while it was not answering. Start one with: aperas service start`);
      throw endedWithoutReady(startedAt, 'ended without becoming ready');
    }
    if (!isProcessAlive(last.pid)) {
      if (last.status === 'ready') throw new Error(`ApeironNgn service (process ${last.pid}) stopped while it was not answering. Start one with: aperas service start`);
      // a refusal clears the lock and then ends the process: the lock read now is the later word
      throw endedWithoutReady(startedAt, readLock() === null ? 'ended without becoming ready' : `process ${last.pid} died before it was ready`);
    }
    const now = Date.now();
    if (now >= deadline) break;
    if (now >= nextNote) {
      const secs = Math.round((now - startedAt) / 1000);
      console.error(last.status === 'ready'
        ? `[aperas service] The service (process ${last.pid}) is running but busy; still waiting for it to answer (${secs} s)...`
        : `[aperas service] Still starting (process ${last.pid}, ${secs} s)...`);
      nextNote += noteEveryMs;
    }
    await sleep(READY_POLL_MS);
  }
  const secs = Math.round(timeoutMs / 1000 * 10) / 10;
  if (last.status === 'ready') {
    throw new Error(`ApeironNgn service (process ${last.pid}) is running but busy: it did not answer in ${secs} s. It is left running, and it is not stopped; run the command again once it is free, or set APERAS_READY_TIMEOUT_MS (milliseconds) for a longer wait.`);
  }
  throw new Error(`ApeironNgn service did not become ready in time: it is still ${last.status === 'starting' ? 'starting' : 'not answering'} after ${secs} s (process ${last.pid} lives, the lock says "${last.status}"). It is left running; try again once it is up, see service.log in the run directory, or set APERAS_READY_TIMEOUT_MS (milliseconds) for a longer wait.`);
}

/** Spawns the actual long-lived service process, bound to `apeironRoot`/`artifactsRoot` for its
 *  whole lifetime — passed as `APERAS_APEIRON_ROOT`/`APERAS_ARTIFACTS_ROOT` in its environment
 *  rather than relying on the child's own `process.cwd()`. Every function that calls
 *  `getApeironExportDir()`/`getArtifactsDir()` with no argument, anywhere in this process (however
 *  deep — `service/service.ts`'s own `main()`, but also `runTrack`/`runIngest`/`runProject` and
 *  the shared `shell/artifacts.ts`/`folders.ts`/`node.ts` helpers underneath them), sees these
 *  env vars via `resolveEffectiveApeironRoot`/`resolveEffectiveArtifactsRoot`'s own default
 *  resolution (`graphConfig.ts`) — no signature threading needed anywhere else. Two shapes,
 *  distinguished by whether `service.ts` still exists as its own file next to this one:
 *  - **Dev** (running from real source, `service.ts` present): spawn `tsx service.ts` directly.
 *  - **Built** (a single bundled `aperas.js`, `esbuild`-inlined — `service.ts` has no file of its
 *    own anymore): re-invoke *this same running script* (`process.argv[1]`, guaranteed to be the
 *    bundle itself — it's the only entrypoint that exists once built) with plain `node` and the
 *    hidden `--__service` flag `aperas.ts`'s own `main()` checks for first, before normal verb
 *    dispatch. */
export function spawnService(apeironRoot: string, artifactsRoot: string, httpPort: number, graphName?: string, startAnyway = false): number | undefined {
  const env = {
    ...process.env,
    APERAS_APEIRON_ROOT: apeironRoot,
    APERAS_ARTIFACTS_ROOT: artifactsRoot,
    APERAS_HTTP_PORT: String(httpPort),
    ...(graphName ? { APERAS_GRAPH_NAME: graphName } : {}),
    ...(startAnyway ? { [START_ANYWAY_ENV]: '1' } : {}),
  };
  if (!startAnyway) delete env[START_ANYWAY_ENV]; // a service started without the option does not inherit it from the caller's environment
  const serviceEntry = resolve(__dirname, 'service.ts');
  // service -> src -> cli -> packages -> monorepo root, where `tsx` (a root devDependency,
  // hoisted by the workspace) actually lives.
  const rootDir = resolve(__dirname, '..', '..', '..', '..');

  if (existsSync(serviceEntry)) {
    const tsxBin = resolve(rootDir, 'node_modules', '.bin', 'tsx');
    const child = spawn(tsxBin, [serviceEntry], { cwd: rootDir, detached: true, stdio: 'ignore', env });
    child.unref();
    return child.pid;
  }

  const bundlePath = process.argv[1]!;
  const child = spawn(process.execPath, [bundlePath, '--__service'], {
    cwd: dirname(bundlePath),
    detached: true,
    stdio: 'ignore',
    env,
  });
  child.unref();
  return child.pid;
}

/** Checks whether a service is already listening — never starts one. `aperas service start` is
 *  now the only place that does that (AperasKG/artifacts/discussion/packaging.md's "Settled: no
 *  concurrency..." note); every ordinary `kg:xxx` command just needs to know it can proceed. */
export async function ensureServiceRunning(): Promise<void> {
  if (await ping()) return;
  const lock = readLock();
  if (lock && isProcessAlive(lock.pid)) { // a service on its way up, or one too busy to answer the ping: wait for it, as a start does; a lock whose process lives is never "no service"
    await waitForReady();
    return;
  }
  throw new Error('No ApeironNgn service running. Start one with: aperas service start');
}

/** The service's two standing conditions — an unresolved flush conflict, and a corpus link-integrity
 *  finding (`ServiceResponse`'s own doc comment) — ride on *every* response until they clear,
 *  regardless of the op that response is for. Printed here, on this short-lived client process's own
 *  stdio, since the long-running service is normally spawned with `stdio: 'ignore'` and can't make
 *  itself heard any other way. This is what makes either one "emerge" on the very next `kg:xxx` call
 *  of any kind rather than sitting silently forever, visible only to whichever explicit
 *  `flush`/`reload`/`check-links` happens to go looking for it. */
function reportStanding(res: Extract<ServiceResponse, { ok: true }>): void {
  if (res.conflict) {
    if (res.conflict.content) console.error(`[ApeironNgn service] UNRESOLVED CONFLICT (content mirror): ${res.conflict.content}`);
    if (res.conflict.state) console.error(`[ApeironNgn service] UNRESOLVED CONFLICT (.state mirror): ${res.conflict.state}`);
    console.error(`[ApeironNgn service] ${CONFLICT_RESOLUTION_HINT}`);
  }
  // Same channel, same reason (see this function's own doc comment): a link that lost its
  // resolution is invisible in every ordinary rendering, so it has to arrive unasked-for.
  if (res.linkWarning) console.error(`[ApeironNgn service] LINK INTEGRITY: ${res.linkWarning}`);
}

/** One entry per link a write reported resolving that still isn't in the block's own `.links`
 *  afterward — `service.ts#withLinkCheck` attaches these to a mutating op's own result. */
interface LinkBreakage {
  blockId: string;
  blockTitle: string;
  code: string;
}

/** Printed from here, not from each `kgX.ts`, for the same reason the check itself runs service-side
 *  rather than as a discipline step: anything a caller has to remember to do is something a caller
 *  eventually doesn't. Every op that carries `linkBreakage` reports it, including ops added later. */
function reportLinkBreakage(result: unknown): void {
  const breakage = (result as { linkBreakage?: LinkBreakage[] } | null)?.linkBreakage;
  if (!breakage || breakage.length === 0) return;
  console.error(
    `[ApeironNgn service] LINK INTEGRITY: this write resolved ${breakage.length} link(s) that are still missing from '.links' afterward:`
  );
  for (const b of breakage) console.error(`  • ${b.blockId} — '${b.code}' (${b.blockTitle})`);
  console.error(`  Re-running the identical write has fixed this before; 'aperas check-links --repair' also re-resolves. See issues/linking.md.`);
}

/** `service.ts#withLinkCheck`'s other splice-on field (design/aperas-skill.md's Threads): a
 *  `.threads/`-scoped artifact whose post-write live-block count is over its cap. Printed from
 *  here, not from each `kgX.ts`, for the same reason `reportLinkBreakage` is — the grapher's own
 *  discipline is to prune once it sees this, not something every caller has to remember to check. */
interface ThreadSizeWarning {
  count: number;
  cap: number;
  artifactPath: string | null;
}

function reportThreadSizeWarning(result: unknown): void {
  const warning = (result as { threadSize?: ThreadSizeWarning } | null)?.threadSize;
  if (!warning) return;
  console.error(
    `[ApeironNgn service] THREAD SIZE: '${warning.artifactPath ?? '?'}' has ${warning.count} live block(s), over its cap of ${warning.cap} — prune finished tasks whose content has been promoted.`
  );
}

export async function request<T>(req: ServiceRequest): Promise<T> {
  const res = await sendRaw(req, 0);
  if (!res.ok) throw new Error(res.error);
  reportStanding(res);
  reportLinkBreakage(res.result);
  reportThreadSizeWarning(res.result);
  return res.result as T;
}
