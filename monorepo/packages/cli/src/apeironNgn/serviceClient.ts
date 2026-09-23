/**
 * ApeironNgn shared service client (Aperas-apeironngn-design.md §4 rollout step 5) — every
 * `kg:xxx` script uses this instead of calling `rehydrateStore`/`dehydrateToJsonLd` itself.
 * `ensureServiceRunning` errors with instructions rather than auto-starting one (AperasKG/
 * artifacts/discussion/packaging.md's "Settled: no concurrency..." note: an implicit auto-spawn
 * meant whichever command happened to run first silently decided which graph the service bound to
 * for its whole lifetime — `aperas service start`/`restart` (`kgService.ts`) is now the only place
 * that resolves and claims that binding, deliberately a human-driven action); `request` sends one
 * op and returns its result. `ping`/`spawnService`/`waitForReady` are exported for `kgService.ts`'s
 * own `start`/`restart` to reuse directly.
 */

import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSocketPath } from './serviceLock';
import { encodeMessage, decodeMessage, CONFLICT_RESOLUTION_HINT, type ServiceRequest, type ServiceResponse } from './serviceProtocol';
import { computeCodeFingerprint } from './codeVersion';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PING_TIMEOUT_MS = 300;
const READY_TIMEOUT_MS = 5_000;
const READY_POLL_MS = 100;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function sendRaw(req: ServiceRequest, timeoutMs: number): Promise<ServiceResponse> {
  return new Promise((resolvePromise, reject) => {
    const socket = connect(getSocketPath());
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
      buffer += chunk.toString('utf-8');
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
    console.error(`[ApeironNgn service] Running code is stale (fingerprint ${result.codeFingerprint} vs. current ${current} on disk) — a source change since this service started won't take effect until it's restarted. Run: kg:service restart`);
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

export async function waitForReady(): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await ping()) return;
    await sleep(READY_POLL_MS);
  }
  throw new Error('ApeironNgn service did not become ready in time');
}

/** Spawns the actual long-lived service process, bound to `apeironRoot`/`artifactsRoot` for its
 *  whole lifetime — passed as `APERAS_APEIRON_ROOT`/`APERAS_ARTIFACTS_ROOT` in its environment
 *  rather than relying on the child's own `process.cwd()`. Every function that calls
 *  `getApeironExportDir()`/`getArtifactsDir()` with no argument, anywhere in this process (however
 *  deep — `apeironNgn/service.ts`'s own `main()`, but also `runTrack`/`runIngest`/`runProject` and
 *  the shared `apeironNgn/artifacts.ts`/`folders.ts`/`node.ts` helpers underneath them), sees these
 *  env vars via `resolveEffectiveApeironRoot`/`resolveEffectiveArtifactsRoot`'s own default
 *  resolution (`graphConfig.ts`) — no signature threading needed anywhere else. Two shapes,
 *  distinguished by whether `service.ts` still exists as its own file next to this one:
 *  - **Dev** (running from real source, `service.ts` present): spawn `tsx service.ts` directly.
 *  - **Built** (a single bundled `aperas.js`, `esbuild`-inlined — `service.ts` has no file of its
 *    own anymore): re-invoke *this same running script* (`process.argv[1]`, guaranteed to be the
 *    bundle itself — it's the only entrypoint that exists once built) with plain `node` and the
 *    hidden `--__service` flag `aperas.ts`'s own `main()` checks for first, before normal verb
 *    dispatch. */
export function spawnService(apeironRoot: string, artifactsRoot: string, httpPort: number, graphName?: string): void {
  const env = {
    ...process.env,
    APERAS_APEIRON_ROOT: apeironRoot,
    APERAS_ARTIFACTS_ROOT: artifactsRoot,
    APERAS_HTTP_PORT: String(httpPort),
    ...(graphName ? { APERAS_GRAPH_NAME: graphName } : {}),
  };
  const serviceEntry = resolve(__dirname, 'service.ts');
  // apeironNgn -> src -> cli -> packages -> monorepo root, where `tsx` (a root devDependency,
  // hoisted by the workspace) actually lives.
  const rootDir = resolve(__dirname, '..', '..', '..', '..');

  if (existsSync(serviceEntry)) {
    const tsxBin = resolve(rootDir, 'node_modules', '.bin', 'tsx');
    const child = spawn(tsxBin, [serviceEntry], { cwd: rootDir, detached: true, stdio: 'ignore', env });
    child.unref();
    return;
  }

  const bundlePath = process.argv[1]!;
  const child = spawn(process.execPath, [bundlePath, '--__service'], {
    cwd: dirname(bundlePath),
    detached: true,
    stdio: 'ignore',
    env,
  });
  child.unref();
}

/** Checks whether a service is already listening — never starts one. `aperas service start` is
 *  now the only place that does that (AperasKG/artifacts/discussion/packaging.md's "Settled: no
 *  concurrency..." note); every ordinary `kg:xxx` command just needs to know it can proceed. */
export async function ensureServiceRunning(): Promise<void> {
  if (await ping()) return;
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

export async function request<T>(req: ServiceRequest): Promise<T> {
  const res = await sendRaw(req, 0);
  if (!res.ok) throw new Error(res.error);
  reportStanding(res);
  reportLinkBreakage(res.result);
  return res.result as T;
}
