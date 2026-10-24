// The link-integrity sweep of a start runs before the service says `ready` (design/packaging.md, "The service lifecycle"): the sweep holds the event loop for seconds on a large mirror, so it
// runs after the HTTP port is bound and before the unix socket is bound and before `markReady`. While it runs the lock says `starting` and a ping finds no socket (a client waits, "Still
// starting"); when it ends the lock says `ready` and the first ping is answered at once; a sweep that fails ends the start like any refusal, with the reason in the log and no lock left.
// The sweep of the small test mirror takes milliseconds, so the service has two hooks of the tests (`startupSweep` in `service.ts`): `APERAS_TEST_SWEEP_HOLD_MS` holds the event loop for that
// long before the sweep, as a long sweep does, and `APERAS_TEST_SWEEP_FAULT=1` makes it throw. The service is real, in the scratch directory of `support/serviceHarness.ts`.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixtureStore, type FixtureStore } from '../support/fixture.ts';
import { buildCorpus } from '../support/commandsCorpus.ts';
import { assertIsolated, dumpMirror, isolateService, leftoverProcesses, serviceLog, startService, stopService, type ServiceIsolation } from '../support/serviceHarness.ts';
import { getLockPath, getSocketPath, getTokenPath, readLock } from '../../service/serviceLock';
import { ping } from '../../service/serviceClient';

const SERVICE = join(import.meta.dirname, '..', '..', 'service', 'service.ts');
const HOLD_MS = 2_500;

describe('the startup link-integrity sweep runs before the service says ready', () => {
  let fx: FixtureStore;
  let iso: ServiceIsolation;
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  const hasLog = (text: string): boolean => serviceLog(iso).some((l) => l.includes(text));
  const clearHooks = (): void => { delete process.env.APERAS_TEST_SWEEP_HOLD_MS; delete process.env.APERAS_TEST_SWEEP_FAULT; };
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
    clearHooks();
    try { await stopService(iso); } finally {
      try { assert.deepEqual(leftoverProcesses(iso), [], 'no process of the test service is left'); } finally { fx.cleanup(); }
    }
  });

  test('during the sweep the lock says starting and a ping gets no answer; when it ends the lock says ready and the first ping is answered at once', async () => {
    process.env.APERAS_TEST_SWEEP_HOLD_MS = String(HOLD_MS);
    try {
      let finished = false;
      const starting = startService(iso).finally(() => { finished = true; });
      let duringSweep = 0;
      let readyUnanswered = 0;
      while (!finished) {
        const loaded = hasLog('Flush intervals:'); // written before the sweep begins
        const lock = readLock();
        const answered = await ping();
        const done = hasLog('Startup link-integrity sweep done');
        if (lock?.status === 'ready') {
          if (!answered) readyUnanswered++;
        } else if (loaded && !done && lock?.status === 'starting' && !answered) duringSweep++;
        assert.equal(lock?.status === 'starting' && answered && !done, false, 'a service that answers while its sweep has not ended');
        await sleep(25);
      }
      await starting;
      assert.ok(duringSweep >= 3, `the lock said starting and nothing answered during the sweep in ${duringSweep} sample(s)`);
      assert.equal(readyUnanswered, 0, 'a lock that said ready was followed by no answer');
      const lock = readLock();
      assert.ok(lock && lock.status === 'ready', JSON.stringify(lock));
      assert.equal(await ping(), true, 'the first ping after the lock says ready is answered');
      assert.ok(hasLog('Startup link-integrity sweep done'), 'the sweep ended before the start');
      // the sweep held the loop for the whole hold: it is not run after the ready mark
      const log = serviceLog(iso);
      const swept = log.findIndex((l) => l.includes('Startup link-integrity sweep done'));
      assert.ok(swept > log.findIndex((l) => l.includes('Flush intervals:')));
    } finally { clearHooks(); }
    assert.equal(await stopService(iso), true);
    assertNothingLeft();
  });

  test('a service started with no hold answers its first ping as soon as the lock says ready', async () => {
    const pid = await startService(iso);
    const lock = readLock();
    assert.ok(lock && lock.status === 'ready' && lock.pid === pid);
    assert.equal(await ping(), true);
    assert.equal(await stopService(iso), true);
    assertNothingLeft();
  });

  test('a sweep that fails refuses to start: status 1, the reason in the log, no lock, no socket, no token', async () => {
    assertIsolated(iso);
    const env: NodeJS.ProcessEnv = { ...process.env, APERAS_TEST_SWEEP_FAULT: '1' };
    delete env.NODE_TEST_CONTEXT;
    const r = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), SERVICE], { encoding: 'utf8', env, timeout: 30_000, killSignal: 'SIGKILL' });
    assert.equal(r.status, 1, `${r.signal ?? ''} ${r.stdout}${r.stderr.slice(-500)}`);
    const refusal = serviceLog(iso).filter((l) => l.includes('REFUSING TO START')).pop();
    assert.ok(refusal && refusal.includes('startup link-integrity sweep failed') && refusal.includes('APERAS_TEST_SWEEP_FAULT'), serviceLog(iso).join('\n'));
    assertNothingLeft();
    assert.equal(await ping(), false);
    assert.deepEqual(leftoverProcesses(iso), []);
  });

  test('aperas service start with a failing sweep fails at once with that reason, and no lock or process is left', async () => {
    process.env.APERAS_TEST_SWEEP_FAULT = '1';
    try {
      const startedAt = Date.now();
      await assert.rejects(startService(iso), (e: unknown) => e instanceof Error && /REFUSING TO START: the startup link-integrity sweep failed/.test(e.message) && e.message.includes('APERAS_TEST_SWEEP_FAULT'), 'the start says why');
      assert.ok(Date.now() - startedAt < 20_000, 'the wait ends at once and does not run to its timeout');
    } finally { clearHooks(); }
    assertNothingLeft();
    for (const deadline = Date.now() + 5_000; Date.now() < deadline && leftoverProcesses(iso).length > 0; ) await sleep(20);
    assert.deepEqual(leftoverProcesses(iso), []);
  });
});
