// The HTTP port of the service (design/packaging.md, "The service lifecycle"): the lock says `ready` only once the HTTP listener is bound, and a port that another process holds ends the start
// with the reason in the log and no lock left. The port here is held by a plain listener of the test (a port taken from the kernel by binding port 0, so that no other test can choose it
// while it is held), and the service is real, in the scratch directory of `support/serviceHarness.ts`, which asserts the run directory, the port and both roots before anything starts.
// The first case runs `service.ts` directly and waits for its exit; the second starts it as `aperas service start` does and reads what the start says; the third frees the port and starts
// normally, which also shows that the refused starts left nothing behind.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { makeFixtureStore, type FixtureStore } from '../support/fixture.ts';
import { buildCorpus } from '../support/commandsCorpus.ts';
import { assertIsolated, dumpMirror, isolateService, leftoverProcesses, serviceLog, startService, stopService, type ServiceIsolation } from '../support/serviceHarness.ts';
import { getLockPath, getSocketPath, getTokenPath, readLock } from '../../service/serviceLock';
import { ping } from '../../service/serviceClient';

const SERVICE = join(import.meta.dirname, '..', '..', 'service', 'service.ts');

describe('the HTTP port of the service', () => {
  let fx: FixtureStore;
  let iso: ServiceIsolation;
  let holder: Server | null = null;
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  const closeHolder = async (): Promise<void> => {
    const h = holder;
    holder = null;
    if (h) await new Promise<void>((r) => h.close(() => r()));
  };
  /** Holds a port taken from the kernel and makes it the port of the scratch service. */
  async function holdPort(): Promise<void> {
    await closeHolder();
    holder = createServer();
    await new Promise<void>((resolve, reject) => { holder!.once('error', reject); holder!.listen(0, '127.0.0.1', resolve); });
    iso.port = (holder.address() as { port: number }).port;
    process.env.APERAS_HTTP_PORT = String(iso.port);
    assertIsolated(iso);
  }
  /** Waits for the processes of the scratch service to be gone: the `tsx` process that started the service ends a moment after its child. */
  async function noProcessLeft(): Promise<void> {
    for (const deadline = Date.now() + 5_000; Date.now() < deadline && leftoverProcesses(iso).length > 0; ) await sleep(20);
    assert.deepEqual(leftoverProcesses(iso), []);
  }
  const assertNothingLeft = (): void => {
    for (const path of [getLockPath(), getSocketPath(), getTokenPath()]) assert.equal(existsSync(path), false, `${path} is left`);
    assert.equal(readLock(), null, 'no lock is left');
  };

  before(async () => {
    fx = makeFixtureStore('cmd_demo');
    buildCorpus(fx);
    dumpMirror(fx);
    iso = await isolateService(fx);
  });
  after(async () => {
    try { await closeHolder(); await stopService(iso); } finally {
      try { assert.deepEqual(leftoverProcesses(iso), [], 'no process of the test service is left'); } finally { fx.cleanup(); }
    }
  });

  test('a port that another process holds ends the start: status 1, the reason in the log, no lock, no socket, no token', async () => {
    await holdPort();
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const r = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), SERVICE], { encoding: 'utf8', env, timeout: 30_000, killSignal: 'SIGKILL' });
    assert.equal(r.status, 1, `${r.signal ?? ''} ${r.stdout}${r.stderr.slice(-500)}`);
    const refusal = serviceLog(iso).find((l) => l.includes('REFUSING TO START'));
    assert.ok(refusal && refusal.includes(`HTTP port ${iso.port}`) && refusal.includes('EADDRINUSE'), serviceLog(iso).join('\n'));
    assertNothingLeft();
    assert.equal(await ping(), false, 'nothing answers on the socket');
    assert.deepEqual(leftoverProcesses(iso), []);
  });

  test('aperas service start fails with that reason, leaves no ready lock and no process, and the port is still the other process\'s', async () => {
    await holdPort();
    const startedAt = Date.now();
    await assert.rejects(startService(iso), (e: unknown) => e instanceof Error && /REFUSING TO START/.test(e.message) && e.message.includes(`HTTP port ${iso.port}`) && e.message.includes('EADDRINUSE'), 'the start says why');
    assert.ok(Date.now() - startedAt < 20_000, 'the wait ends at once and does not run to its timeout');
    assertNothingLeft();
    await noProcessLeft();
    assert.ok(holder!.listening, 'the other process still holds the port');
  });

  test('a normal start is ready once the port is bound: the port is held by the service, and a stop leaves nothing', async () => {
    await closeHolder();
    iso.port = Number(process.env.APERAS_HTTP_PORT); // the same port, now free
    const pid = await startService(iso);
    const lock = readLock();
    assert.ok(lock && lock.status === 'ready' && lock.pid === pid && lock.httpPort === iso.port, JSON.stringify(lock));
    assert.equal(await ping(), true);
    // the port is bound by the service: a second listener on it fails
    await assert.rejects(new Promise<void>((resolve, reject) => {
      const probe = createServer();
      probe.once('error', reject);
      probe.listen(iso.port, '127.0.0.1', () => probe.close(() => resolve()));
    }), (e: NodeJS.ErrnoException) => e.code === 'EADDRINUSE');
    assert.equal(await stopService(iso), true);
    assertNothingLeft();
    await noProcessLeft();
  });
});
