// The wait of a start for the service to say `ready` (`serviceClient.ts#waitForReady`; `aperas service start` and `ensureServiceRunning` both wait on it): `APERAS_READY_TIMEOUT_MS` sets
// how long (default 180 s, where the wait once gave up after 5 s and reported a failed start of a service that was starting well). A start that is ready in time returns; one still starting
// when a short override ends fails with a message that says so and leaves the service running; a start that meets a service on its way up (a second `aperas service start`, or any client
// through `ensureServiceRunning`) waits for it and does not start another; a service whose process died before it was ready fails the wait at once, not at the end of the time. The service
// is real, in the scratch directory of `support/serviceHarness.ts`, which asserts the run directory, the port and both roots before anything starts; it is stopped with SIGTERM on its own
// scratch pid, and the last case finds no process left.
import { describe, test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeFixtureStore, type FixtureStore } from '../support/fixture.ts';
import { buildCorpus } from '../support/commandsCorpus.ts';
import { assertIsolated, dumpMirror, isolateService, leftoverProcesses, serviceLog, startService, stopService, withStderr, type ServiceIsolation } from '../support/serviceHarness.ts';
import { runStart } from '../../kgService';
import { DEFAULT_READY_TIMEOUT_MS, ensureServiceRunning, ping, readyTimeoutMs, waitForReady } from '../../service/serviceClient';
import { clearLock, getLockPath, isProcessAlive, readLock } from '../../service/serviceLock';
import { existsSync, writeFileSync } from 'node:fs';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Runs `runStart` with its status line held back, as the harness's `startService` does. */
async function start(): Promise<void> {
  const log = console.log;
  console.log = () => {};
  try { await runStart(); } finally { console.log = log; }
}

describe('the wait of a start for the service to be ready', () => {
  let fx: FixtureStore;
  let iso: ServiceIsolation;
  const saved = process.env.APERAS_READY_TIMEOUT_MS;
  const setWait = (v: string | undefined): void => { if (v === undefined) delete process.env.APERAS_READY_TIMEOUT_MS; else process.env.APERAS_READY_TIMEOUT_MS = v; };
  /** Waits (a minute at most) until `cond` holds. */
  async function until(cond: () => boolean | Promise<boolean>, what: string, ms = 60_000): Promise<void> {
    for (const deadline = Date.now() + ms; Date.now() < deadline; await sleep(25)) if (await cond()) return;
    throw new Error(`Gave up waiting for ${what}`);
  }
  /** SIGKILL on every process of the scratch service until none is left: a killed `tsx` can leave the service it started. */
  async function killScratch(): Promise<void> {
    assertIsolated(iso);
    for (let clean = 0; clean < 3; await sleep(20)) {
      const pids = leftoverProcesses(iso);
      clean = pids.length === 0 ? clean + 1 : 0;
      for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    }
  }
  before(async () => {
    fx = makeFixtureStore('cmd_demo');
    buildCorpus(fx);
    dumpMirror(fx);
    iso = await isolateService(fx);
  });
  afterEach(async () => {
    setWait(saved);
    assertIsolated(iso);
    if (readLock() !== null || leftoverProcesses(iso).length > 0) { await killScratch(); clearLock(); }
  });
  after(async () => {
    try { await stopService(iso); } finally {
      try { assert.deepEqual(leftoverProcesses(iso), [], 'no process of the test service is left'); } finally { fx.cleanup(); }
    }
  });

  test('the wait is APERAS_READY_TIMEOUT_MS when it is a positive number of milliseconds, else 180 s', () => {
    assert.equal(DEFAULT_READY_TIMEOUT_MS, 180_000);
    for (const [value, expected] of [[undefined, 180_000], ['', 180_000], ['  ', 180_000], ['abc', 180_000], ['0', 180_000], ['-5', 180_000], ['250', 250], ['60000', 60_000]] as const) {
      setWait(value);
      assert.equal(readyTimeoutMs(), expected, JSON.stringify(value));
    }
  });

  test('a service that is ready in time: the start returns with a ready lock, with the default wait and with an override', async () => {
    for (const value of [undefined, '60000']) {
      setWait(value);
      const pid = await startService(iso);
      assert.equal(readLock()?.status, 'ready');
      assert.equal(readLock()?.pid, pid);
      assert.ok(await ping());
      await stopService(iso);
    }
  });

  test('a service still starting at the end of a short override: the start says so, fails, and leaves the service running to become ready', async () => {
    setWait('100');
    const t = Date.now();
    await assert.rejects(start(), (e: unknown) => e instanceof Error
      && /^ApeironNgn service did not become ready in time: it is still starting after 0\.1 s \(process \d+ lives, the lock says "starting"\)\. It is left running/.test(e.message) && !/died|ended/.test(e.message), 'it says it is still starting');
    assert.ok(Date.now() - t < 20_000, 'and at the end of the override, not later');
    const lock = readLock();
    assert.ok(lock && lock.status === 'starting' && isProcessAlive(lock.pid), JSON.stringify(lock));
    assert.ok(leftoverProcesses(iso).length > 0, 'the service process is left running');
    await until(async () => (await ping()) && readLock()?.status === 'ready', 'the service left running to become ready');
    assert.ok(readLock()!.socketPath.startsWith(fx.root), 'and it is the scratch service');
  });

  test('a client that meets a service on its way up waits for it, says it is still starting, and a second start joins it and starts no other', async () => {
    setWait('100');
    await assert.rejects(start(), /still starting/);
    assert.ok(leftoverProcesses(iso).length > 0);
    setWait(undefined);
    const noted = await withStderr(() => waitForReady({ noteEveryMs: 10 }).then(() => ping()));
    // the service may be ready by now; if it was not, the wait said so while it waited
    assert.ok(noted.result);
    if (noted.stderr.length > 0) assert.match(noted.stderr[0]!, /^\[aperas service\] Still starting \(process \d+, \d+ s\)\.\.\./);
    await stopService(iso);

    const boots = (): number => serviceLog(iso).filter((l) => l.includes('Flush intervals:')).length; // one line for each boot of a service
    const bootsBefore = boots();
    setWait('100');
    await assert.rejects(start(), /still starting/);
    setWait(undefined);
    const all = await Promise.all([ensureServiceRunning(), start()]);
    assert.equal(all.length, 2);
    assert.equal(readLock()?.status, 'ready');
    assert.ok(await ping());
    assert.equal(boots() - bootsBefore, 1, 'one service booted: the second start and the client joined the one that was starting');
  });

  test('the wait says it is still starting while the process lives (a fabricated starting lock whose process is a live one)', async () => {
    const lock = { pid: process.pid, socketPath: '', startedAt: new Date().toISOString(), status: 'starting', apeironRoot: fx.apeironRoot, artifactsRoot: fx.artifactsRoot, httpPort: iso.port };
    writeFileSync(getLockPath(), JSON.stringify(lock));
    const r = await withStderr(() => waitForReady({ timeoutMs: 400, noteEveryMs: 100 }).then(() => null, (e: Error) => e));
    assert.ok(r.result instanceof Error && /still starting after 0\.4 s \(process \d+ lives/.test(r.result.message), String(r.result));
    assert.ok(r.stderr.length >= 2 && r.stderr.every((l) => /^\[aperas service\] Still starting \(process \d+, \d+ s\)\.\.\.$/.test(l)), r.stderr.join('\n'));
  });

  test('a service whose process died before it was ready fails the wait at once, with the process named, in a start and in a client', async () => {
    setWait(String(120_000)); // the end of the time is far: only the death can end the wait
    const starting = start();
    const failed = assert.rejects(starting, (e: unknown) => e instanceof Error && /^ApeironNgn service process \d+ died before it was ready/.test(e.message) && !/still starting/.test(e.message));
    await until(() => { const l = readLock(); return l !== null && l.pid !== process.pid && leftoverProcesses(iso).length > 0; }, 'the spawned process to be recorded in the lock');
    const spawned = readLock()!.pid;
    const t = Date.now();
    await killScratch();
    await failed;
    assert.ok(Date.now() - t < 20_000, `the failure came ${Date.now() - t} ms after the kill, not at the end of 120 s`);
    assert.ok(existsSync(getLockPath()) && !isProcessAlive(spawned), 'the lock is left, its process gone');
    await assert.rejects(ensureServiceRunning(), /No ApeironNgn service running/, 'a client does not wait for a process that is gone');
    assert.deepEqual(leftoverProcesses(iso), []);
  });
});
