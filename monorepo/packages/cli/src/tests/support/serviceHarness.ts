// The isolation and the lifecycle of the ApeironNgn service for the tests of the group `service/` (planning/core.md, Batch 11, step 10 for step 8).
//
// A test file gets a fixture store (`makeFixtureStore`: scratch Apeiron and artifacts roots), builds the mirror it wants in them, then calls
// `isolateService(fx)`, which moves the three things that name a service to the scratch directory: the runtime directory (`XDG_RUNTIME_DIR`, which holds the
// socket, the lock, the token and the log), the HTTP port (`APERAS_HTTP_PORT`, a free port chosen here) and, through the fixture, the two roots. `startService` and
// `stopService` assert all of it again, and only then start or signal anything, so a test that has not isolated cannot reach the working service: its socket,
// its lock and its port are never named. The service is the real one, started the way `aperas service start` starts it (`runStart`: claim the lock, spawn
// `service.ts` under `tsx`, wait for the ping). It is stopped with SIGTERM on the pid its own scratch lock names, after the lock's socket is checked to be the scratch socket.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, connect } from 'node:net';
import { join, relative, isAbsolute } from 'node:path';
import { resolveEffectiveApeironRoot, resolveEffectiveArtifactsRoot } from '@aperas/core/graphConfig';
import { dumpMirror as dumpEngineMirror } from '@aperas/core/shell/mirrorDump';
import { runStart } from '../../kgService';
import { getRunDir, getSocketPath, getLockPath, getTokenPath, readLock, resolveHttpPort, isProcessAlive } from '../../service/serviceLock';
import { ping } from '../../service/serviceClient';
import { encodeMessage, decodeMessage, type ServiceRequest, type ServiceResponse } from '../../service/serviceProtocol';
import { assertNotRealMirror, type FixtureStore } from './fixture.ts';

/** The default port of a service of the working checkout; a test service never uses it. */
const DEFAULT_SERVICE_PORT = 2736;

export interface ServiceIsolation {
  fx: FixtureStore;
  /** The run directory the test service uses: `<scratch>/run/aperas`. */
  runDir: string;
  port: number;
  /** What the same variables gave before `isolateService` changed them, i.e. the run directory and the port of the working service in this environment. */
  ambient: { runDir: string; port: number };
}

const isInside = (path: string, dir: string): boolean => {
  const rel = relative(dir, path);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
};

/** A free TCP port on the loopback, found by binding port 0 and letting go of it. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

/** Points the run directory and the port at the scratch directory of `fx` and asserts the result. `threadSizeCap` is set in the environment too, for the service to read at boot. */
export async function isolateService(fx: FixtureStore, options: { threadSizeCap?: number } = {}): Promise<ServiceIsolation> {
  const ambient = { runDir: getRunDir(), port: resolveHttpPort() };
  process.env.XDG_RUNTIME_DIR = join(fx.root, 'run');
  process.env.APERAS_HTTP_PORT = String(await freePort());
  if (options.threadSizeCap !== undefined) process.env.APERAS_THREAD_SIZE_CAP = String(options.threadSizeCap);
  const iso: ServiceIsolation = { fx, runDir: join(fx.root, 'run', 'aperas'), port: Number(process.env.APERAS_HTTP_PORT), ambient };
  assertIsolated(iso);
  process.once('exit', () => { try { killScratchService(iso); } catch { /* the process is ending */ } });
  return iso;
}

/** Throws unless the runtime directory, the socket, the lock, the token, the port and both roots are the scratch ones and none is the working service's or the real mirror's. */
export function assertIsolated(iso: ServiceIsolation): void {
  const { fx } = iso;
  const fail = (what: string): never => { throw new Error(`Refusing to touch a service: ${what}`); };
  if (getRunDir() !== iso.runDir) fail(`the run directory is ${getRunDir()}, not the scratch ${iso.runDir}`);
  if (iso.runDir === iso.ambient.runDir) fail(`the scratch run directory is the working one, ${iso.runDir}`);
  for (const path of [getRunDir(), getSocketPath(), getLockPath(), getTokenPath()]) {
    if (!isInside(path, fx.root)) fail(`${path} is outside the scratch directory ${fx.root}`);
  }
  if (resolveHttpPort() !== iso.port) fail(`the port is ${resolveHttpPort()}, not the scratch ${iso.port}`);
  if (iso.port === DEFAULT_SERVICE_PORT || iso.port === iso.ambient.port) fail(`the port ${iso.port} is the working service's`);
  const apeiron = resolveEffectiveApeironRoot();
  const artifacts = resolveEffectiveArtifactsRoot();
  if (apeiron !== fx.apeironRoot || artifacts !== fx.artifactsRoot) fail(`the roots are ${apeiron} and ${artifacts}, not the scratch ones`);
  for (const root of [apeiron, artifacts]) {
    assertNotRealMirror(root);
    if (!isInside(root, fx.root)) fail(`the root ${root} is outside the scratch directory ${fx.root}`);
  }
}

/** Starts the service the way `aperas service start` does; refuses to run if anything is listening or locked in the scratch run directory already. Returns the pid of the service. */
export async function startService(iso: ServiceIsolation, options: { startAnyway?: boolean } = {}): Promise<number> {
  assertIsolated(iso);
  if (readLock() !== null) throw new Error(`A lock already exists in the scratch run directory ${iso.runDir}`);
  if (await ping()) throw new Error(`Something already answers on the scratch socket ${getSocketPath()}`);
  const log = console.log;
  console.log = () => {}; // `runStart` prints one status line
  try { await runStart(options); } finally { console.log = log; }
  const lock = readLock();
  if (!lock || lock.status !== 'ready') throw new Error(`The service did not leave a ready lock: ${JSON.stringify(lock)}`);
  if (lock.socketPath !== getSocketPath() || lock.apeironRoot !== iso.fx.apeironRoot || lock.artifactsRoot !== iso.fx.artifactsRoot || lock.httpPort !== iso.port) {
    killScratchService(iso);
    throw new Error(`The service bound to something other than the scratch: ${JSON.stringify(lock)}`);
  }
  return lock.pid;
}

/**
 * Writes the table of settings of the graphs (`aperas.config.json` in the scratch directory, which the service finds above the mirror): the flush interval of each graph, in
 * milliseconds. The service reads it at its start; a case sets an interval of a few hundred milliseconds so that a timer is reached by the setting and not by waiting for the default.
 */
export function writeGraphIntervals(fx: FixtureStore, intervals: Record<string, number>): void {
  const graphs = Object.fromEntries(Object.entries(intervals).map(([graph, flushIntervalMs]) => [graph, { flushIntervalMs }]));
  writeFileSync(join(fx.root, 'aperas.config.json'), JSON.stringify({ graphs }, null, 2), 'utf-8');
}

/** The pid the scratch lock names, after checking that the lock is the scratch one. */
function scratchPid(iso: ServiceIsolation): number | null {
  assertIsolated(iso);
  const lock = readLock();
  if (!lock) return null;
  if (lock.socketPath !== getSocketPath() || !isInside(lock.socketPath, iso.fx.root)) throw new Error(`The lock names the socket ${lock.socketPath}, which is not the scratch socket`);
  return lock.pid;
}

/** SIGKILL on the scratch service, synchronously: the safety net at the exit of the test process. */
function killScratchService(iso: ServiceIsolation): void {
  for (const pid of leftoverProcesses(iso)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
}

/** Stops the scratch service with SIGTERM (its own graceful shutdown: sweep, flush, clear the lock) and waits for the process to be gone. Returns false if none was running. */
export async function stopService(iso: ServiceIsolation, timeoutMs = 10_000): Promise<boolean> {
  const pid = scratchPid(iso);
  if (pid === null) return false;
  process.kill(pid, 'SIGTERM');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && isProcessAlive(pid)) await new Promise((r) => setTimeout(r, 20));
  if (isProcessAlive(pid)) throw new Error(`The scratch service (pid ${pid}) did not stop within ${timeoutMs} ms of SIGTERM`);
  // The `tsx` process that started the service ends a moment after it, once it has seen its child exit.
  while (Date.now() < deadline && leftoverProcesses(iso).length > 0) await new Promise((r) => setTimeout(r, 20));
  return true;
}

/** The pids of the processes of a service of this scratch directory: a command line with `service.ts` and, in the environment the service was started with, the scratch Apeiron root. Linux only. */
export function leftoverProcesses(iso: ServiceIsolation): number[] {
  if (!existsSync('/proc/self/environ')) return [];
  const needle = `APERAS_APEIRON_ROOT=${iso.fx.apeironRoot}\0`;
  const pids: number[] = [];
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    try {
      const cmdline = readFileSync(`/proc/${name}/cmdline`, 'utf-8');
      if (!cmdline.includes('service.ts')) continue;
      if (readFileSync(`/proc/${name}/environ`, 'utf-8').includes(needle)) pids.push(Number(name));
    } catch { /* the process ended, or is not ours */ }
  }
  return pids;
}

/** One request on the scratch socket, answered whole (`request` of the client returns the result only and prints the standing warnings). */
export function rawRequest(req: ServiceRequest): Promise<ServiceResponse> {
  return new Promise((resolve, reject) => {
    const socket = connect(getSocketPath());
    let buffer = '';
    socket.on('connect', () => socket.write(encodeMessage(req)));
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf-8');
      const idx = buffer.indexOf('\n');
      if (idx === -1) return;
      socket.end();
      resolve(decodeMessage<ServiceResponse>(buffer.slice(0, idx)));
    });
    socket.on('error', reject);
  });
}

/** The lines of the service log of the scratch run directory (`logService`), or none. */
export function serviceLog(iso: ServiceIsolation): string[] {
  const file = join(iso.runDir, 'service.log');
  return existsSync(file) ? readFileSync(file, 'utf-8').split('\n').filter(Boolean) : [];
}

/** Runs `fn` with `console.error` collected, and returns what it printed besides the result. The client prints the standing warnings of a response there. */
export async function withStderr<T>(fn: () => Promise<T>): Promise<{ result: T; stderr: string[] }> {
  const stderr: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { stderr.push(args.map(String).join(' ')); };
  try { return { result: await fn(), stderr }; } finally { console.error = original; }
}

/** Overwrites one mirror file of the scratch Apeiron root, as a process other than the service would. */
export function writeMirrorFile(iso: ServiceIsolation, kind: string, text: string): void {
  writeFileSync(join(iso.fx.apeironRoot, `${kind}.jsonld`), text, 'utf-8');
}

/** The text of one mirror file of the scratch Apeiron root. */
export function readMirrorFile(iso: ServiceIsolation, kind: string): string {
  return readFileSync(join(iso.fx.apeironRoot, `${kind}.jsonld`), 'utf-8');
}

/** Writes the whole store of a fixture to its scratch Apeiron root, content mirror and `.state/`, the files a service reads at boot. */
export function dumpMirror(fx: FixtureStore): void {
  dumpEngineMirror(fx.store.engine, fx.root, fx.store.mapping);
}
