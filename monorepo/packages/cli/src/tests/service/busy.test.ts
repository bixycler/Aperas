// A service whose lock says `ready` and whose process lives is a running service, however busy: it may not answer the 300 ms ping, and that is no reason to say there is none, to clear its lock or to
// start a second service (`kgService.ts#runStart`, `serviceClient.ts#ensureServiceRunning` and `waitForReady`). The busy service is the real scratch service of `support/serviceHarness.ts` held with
// SIGSTOP on its own scratch pid (its event loop does not run, as in a long request) and let go with SIGCONT; the working service is never named. A lock whose process is gone is still a leftover:
// a client says there is no service, and a start clears it and starts one.
import { describe, test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeFixtureStore, type FixtureStore } from '../support/fixture.ts';
import { buildCorpus } from '../support/commandsCorpus.ts';
import { dumpMirror, isolateService, leftoverProcesses, serviceLog, startService, stopService, withStderr, type ServiceIsolation } from '../support/serviceHarness.ts';
import { runStart } from '../../kgService';
import { ensureServiceRunning, ping, waitForReady } from '../../service/serviceClient';
import { getLockPath, getSocketPath, getTokenPath, isProcessAlive, readLock } from '../../service/serviceLock';
import { existsSync, readFileSync, statSync } from 'node:fs';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Runs `runStart`, collecting the status lines it prints. */
async function start(): Promise<string[]> {
  const lines: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
  try { await runStart(); } finally { console.log = log; }
  return lines;
}

describe('a service that is busy is a running service', () => {
  let fx: FixtureStore;
  let iso: ServiceIsolation;
  let pid = 0;
  const saved = process.env.APERAS_READY_TIMEOUT_MS;
  const boots = (): number => serviceLog(iso).filter((l) => l.includes('Flush intervals:')).length; // one line for each boot of a service
  const hold = (): void => { process.kill(pid, 'SIGSTOP'); };
  const release = (): void => { try { process.kill(pid, 'SIGCONT'); } catch { /* gone */ } };
  /** The three files that name a service, as they are: a second service would replace each. */
  const files = (): string[] => [getLockPath(), getTokenPath()].map((f) => (existsSync(f) ? readFileSync(f, 'utf-8') : '(none)')).concat(existsSync(getSocketPath()) ? `socket ${statSync(getSocketPath()).ino}` : '(none)');

  before(async () => {
    fx = makeFixtureStore('cmd_demo');
    buildCorpus(fx);
    dumpMirror(fx);
    iso = await isolateService(fx);
  });
  afterEach(async () => {
    release();
    delete process.env.APERAS_READY_TIMEOUT_MS;
    if (saved !== undefined) process.env.APERAS_READY_TIMEOUT_MS = saved;
  });
  after(async () => {
    release();
    try { await stopService(iso); } finally {
      try { assert.deepEqual(leftoverProcesses(iso), [], 'no process of the test service is left'); } finally { fx.cleanup(); }
    }
  });

  test('a start and a client meet a busy service: each waits, then fails saying it is busy, and the lock, the socket, the token and the process are untouched', async () => {
    pid = await startService(iso);
    assert.equal(boots(), 1);
    const filesBefore = files();
    hold();
    assert.equal(await ping(), false, 'a held service does not answer the ping');
    process.env.APERAS_READY_TIMEOUT_MS = '600';

    const started = await withStderr(() => start().then(() => null, (e: Error) => e));
    assert.ok(started.result instanceof Error && new RegExp(`^ApeironNgn service \\(process ${pid}\\) is running but busy: it did not answer in 0\\.6 s`).test(started.result.message), String(started.result));
    assert.doesNotMatch(String(started.result), /No ApeironNgn service running|did not become ready|died/);

    const client = await ensureServiceRunning().then(() => null, (e: Error) => e);
    assert.ok(client instanceof Error && /is running but busy/.test(client.message) && !/No ApeironNgn service running/.test(client.message), String(client));

    assert.deepEqual(files(), filesBefore, 'the lock, the socket and the token are as they were');
    assert.equal(readLock()?.pid, pid);
    assert.equal(readLock()?.status, 'ready');
    assert.ok(isProcessAlive(pid));
    assert.deepEqual(leftoverProcesses(iso).includes(pid), true);
    release();
    await sleep(50);
    assert.equal(boots(), 1, 'no second service booted');
    assert.ok(await ping());
  });

  test('a busy service that answers while a start or a client waits: the start says it is already running, the client goes on, and no second service starts', async () => {
    assert.equal(readLock()?.pid, pid);
    const filesBefore = files();
    hold();
    const lines: string[] = [];
    const log = console.log;
    console.log = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
    try {
      const both = withStderr(() => Promise.all([runStart(), ensureServiceRunning()]));
      await sleep(1000);
      assert.equal(await ping(), false, 'still held after a second');
      release();
      const done = await both;
      assert.equal(done.result.length, 2);
      assert.ok(done.stderr.every((l) => !/No ApeironNgn/.test(l)));
    } finally { console.log = log; }
    assert.equal(lines.length, 2, lines.join('\n'));
    assert.match(lines[0]!, new RegExp(`^\\[aperas service\\] Running \\(pid ${pid}\\) but busy`));
    assert.match(lines[1]!, new RegExp(`^\\[aperas service\\] Already running \\(pid ${pid}\\), bound to graph: ${fx.apeironRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.deepEqual(files(), filesBefore, 'the lock, the socket and the token are as they were');
    assert.equal(boots(), 1, 'no second service booted');
    assert.ok(await ping());
  });

  test('the wait says that the service is busy, not that it is starting, while the process lives', async () => {
    hold();
    const r = await withStderr(() => waitForReady({ timeoutMs: 1500, noteEveryMs: 100 }).then(() => null, (e: Error) => e));
    assert.ok(r.result instanceof Error && /is running but busy/.test(r.result.message), String(r.result));
    assert.ok(r.stderr.length >= 2 && r.stderr.every((l) => new RegExp(`^\\[aperas service\\] The service \\(process ${pid}\\) is running but busy; still waiting for it to answer \\(\\d+ s\\)\\.\\.\\.$`).test(l)), r.stderr.join('\n'));
    release();
  });

  test('a busy service that dies while a client waits: the wait ends at once and says so', async () => {
    hold();
    process.env.APERAS_READY_TIMEOUT_MS = '120000';
    const waiting = ensureServiceRunning().then(() => null, (e: Error) => e);
    await sleep(300);
    process.kill(pid, 'SIGKILL');
    const e = await waiting;
    assert.ok(e instanceof Error && new RegExp(`^ApeironNgn service \\(process ${pid}\\) stopped while it was not answering`).test(e.message), String(e));
    assert.ok(existsSync(getLockPath()), 'the lock is a leftover now');
  });

  test('a ready lock whose process is gone is a leftover: a client says there is no service, and a start clears it and starts one', async () => {
    const lock = readLock()!; // the dead service's lock, left by the kill
    assert.equal(lock.status, 'ready');
    assert.ok(!isProcessAlive(lock.pid));
    await assert.rejects(ensureServiceRunning(), /No ApeironNgn service running/);
    assert.deepEqual(readLock(), lock, 'the client left the leftover as it was');
    const before = boots();
    const lines = await start();
    assert.match(lines.join('\n'), /Started — bound to/);
    assert.equal(boots() - before, 1, 'one service booted');
    assert.equal(readLock()?.status, 'ready');
    assert.notEqual(readLock()?.pid, lock.pid);
    assert.ok(await ping());
  });
});
