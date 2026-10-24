// `aperas service status` (design/packaging.md, "The service lifecycle"): it only looks. It reads the lock, tests the process and pings once on the local socket, and it never starts, stops or clears anything,
// so every case also compares the lock, the socket and the token as they were. The states and their exit codes: `ready` 0; `starting` (lock `starting`, live process) and `busy` (process lives, lock `ready`, ping
// unanswered) 1; `stopped` (no lock, or a lock whose process is gone) 3. The service is the real scratch service of `support/serviceHarness.ts` (scratch run directory, port and both roots, asserted before anything
// starts); a hung one is held with SIGSTOP on its own scratch pid, as in `busy.test.ts`. The idle exit after 30 minutes is not reached: the idle timer calls the same `shutdown` that SIGTERM does (the service flushes and
// clears its lock), so a stop by SIGTERM stands for it. The exit codes and the JSON line are read from the command itself, run as a process under `tsx` with the scratch environment.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixtureStore, type FixtureStore } from '../support/fixture.ts';
import { buildCorpus } from '../support/commandsCorpus.ts';
import { dumpMirror, isolateService, leftoverProcesses, startService, stopService, type ServiceIsolation } from '../support/serviceHarness.ts';
import { formatStatus, runStatus, serviceStatus, STATUS_EXIT, type ServiceStatus } from '../../kgService';
import { computeCodeFingerprint } from '../../service/codeVersion';
import { readCliVersion } from '../../cliVersion';
import { getLockPath, getRunDir, getSocketPath, getTokenPath, isProcessAlive, readLock, type LockInfo } from '../../service/serviceLock';

const APERAS = join(import.meta.dirname, '..', '..', 'aperas.ts');

describe('aperas service status', () => {
  let fx: FixtureStore;
  let iso: ServiceIsolation;
  let pid = 0;
  const children: ChildProcess[] = [];
  /** The three files that name a service, as they are. */
  const files = (): string[] => [getLockPath(), getTokenPath()].map((f) => (existsSync(f) ? readFileSync(f, 'utf-8') : '(none)')).concat(existsSync(getSocketPath()) ? `socket ${statSync(getSocketPath()).ino}` : '(none)');
  const hold = (): void => { process.kill(pid, 'SIGSTOP'); };
  const release = (): void => { try { process.kill(pid, 'SIGCONT'); } catch { /* gone */ } };
  /** Runs the command `aperas service status [--json]` as the user would, in the scratch environment. */
  function cli(...args: string[]): { status: number | null; stdout: string; stderr: string } {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const r = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), APERAS, 'service', 'status', ...args], { encoding: 'utf8', env, timeout: 30_000, killSignal: 'SIGKILL' });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  }
  /** A pid that no process has: a child that has ended. */
  function deadPid(): number {
    const r = spawnSync(process.execPath, ['-e', '0']);
    assert.ok(r.pid && !isProcessAlive(r.pid));
    return r.pid;
  }
  /** A process of the test that lives for a while and answers nothing, to stand for a service whose lock exists. */
  function livePid(): number {
    const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 120000)'], { stdio: 'ignore' });
    children.push(child);
    return child.pid!;
  }
  function writeLock(over: Partial<LockInfo> & { pid: number }): LockInfo {
    const lock: LockInfo = { socketPath: getSocketPath(), startedAt: new Date(Date.now() - 65_000).toISOString(), status: 'ready', apeironRoot: fx.apeironRoot, artifactsRoot: fx.artifactsRoot, httpPort: iso.port, ...over };
    mkdirSync(getRunDir(), { recursive: true });
    writeFileSync(getLockPath(), JSON.stringify(lock));
    return lock;
  }
  /** Removes what a test left in the scratch run directory, for the next one. */
  const clearRunDir = (): void => { for (const p of [getLockPath(), getSocketPath(), getTokenPath()]) if (existsSync(p)) unlinkSync(p); };
  const json = (r: { stdout: string }): ServiceStatus => {
    assert.equal(r.stdout.trimEnd().split('\n').length, 1, 'one line');
    return JSON.parse(r.stdout) as ServiceStatus;
  };

  before(async () => {
    fx = makeFixtureStore('cmd_demo');
    buildCorpus(fx);
    dumpMirror(fx);
    iso = await isolateService(fx);
  });
  after(async () => {
    release();
    for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
    try { if (readLock() !== null && isProcessAlive(readLock()!.pid)) await stopService(iso); } finally {
      try { assert.deepEqual(leftoverProcesses(iso), [], 'no process of the test service is left'); } finally { fx.cleanup(); }
    }
  });

  test('no lock: stopped, exit 3, and nothing is created', async () => {
    assert.equal(existsSync(getRunDir()), false, 'no run directory yet');
    const st = await serviceStatus();
    assert.equal(st.state, 'stopped');
    assert.equal(st.staleLock, false);
    assert.equal(st.pid, null);
    assert.equal(st.runDir, getRunDir());
    assert.equal(st.version, readCliVersion());
    assert.equal(existsSync(getRunDir()), false, 'status created no run directory');
    const text = cli();
    assert.equal(text.status, 3, text.stderr);
    assert.match(text.stdout, /^stopped\n/);
    assert.match(text.stdout, /no service lock in /);
    const j = cli('--json');
    assert.equal(j.status, 3);
    assert.equal(json(j).state, 'stopped');
    assert.equal(existsSync(getRunDir()), false, 'the command created no run directory');
  });

  test('a stale lock (its process is gone): stopped, exit 3, reported as stale, and the lock is left as it was', async () => {
    for (const status of ['ready', 'starting'] as const) {
      const dead = deadPid();
      const lock = writeLock({ pid: dead, status });
      const before = files();
      const st = await serviceStatus();
      assert.equal(st.state, 'stopped', status);
      assert.equal(st.staleLock, true);
      assert.equal(st.lockStatus, status);
      assert.equal(st.pid, dead);
      assert.equal(st.uptimeSeconds, null);
      assert.equal(st.apeironRoot, fx.apeironRoot);
      assert.match(formatStatus(st), new RegExp(`^stopped\\n  a stale lock of a process that is gone \\(pid ${dead}\\) is left in place`));
      const r = cli('--json');
      assert.equal(r.status, 3);
      const j = json(r);
      assert.equal(j.state, 'stopped');
      assert.equal(j.staleLock, true);
      assert.deepEqual(files(), before, 'the stale lock is as it was');
      assert.deepEqual(readLock(), lock);
      assert.equal(cli().status, 3);
      assert.deepEqual(files(), before, 'the stale lock is as it was after the text form too');
    }
    clearRunDir();
  });

  test('a lock that says starting and a process that lives: starting, exit 1, lock untouched', async () => {
    const live = livePid();
    writeLock({ pid: live, status: 'starting' });
    const before = files();
    const st = await serviceStatus();
    assert.equal(st.state, 'starting');
    assert.equal(st.staleLock, false);
    assert.equal(st.pid, live);
    assert.ok(st.uptimeSeconds !== null && st.uptimeSeconds >= 60 && st.uptimeSeconds < 120, String(st.uptimeSeconds));
    assert.equal(st.codeFingerprint, null);
    const r = cli();
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stdout, /^starting\n/);
    assert.equal(json(cli('--json')).state, 'starting');
    assert.deepEqual(files(), before);
    clearRunDir();
  });

  test('a ready lock and a process that lives but has no socket: busy, exit 1', async () => {
    const live = livePid();
    writeLock({ pid: live, status: 'ready' });
    const before = files();
    const st = await serviceStatus();
    assert.equal(st.state, 'busy');
    const r = cli();
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stdout, /^busy\n  the process lives and did not answer the ping\n/);
    assert.deepEqual(files(), before);
    clearRunDir();
  });

  test('a running service: ready, exit 0, every detail, the fingerprint of the code it runs; and the command only looks', async () => {
    pid = await startService(iso);
    const lock = readLock()!;
    const before = files();
    const st = await serviceStatus();
    assert.equal(st.state, 'ready');
    assert.equal(st.lockStatus, 'ready');
    assert.equal(st.pid, pid);
    assert.equal(st.httpPort, iso.port);
    assert.equal(st.apeironRoot, fx.apeironRoot);
    assert.equal(st.artifactsRoot, fx.artifactsRoot);
    assert.equal(st.runDir, iso.runDir);
    assert.equal(st.startedAt, lock.startedAt);
    assert.ok(st.uptimeSeconds !== null && st.uptimeSeconds >= 0 && st.uptimeSeconds < 120);
    assert.equal(st.version, readCliVersion());
    assert.equal(st.codeFingerprint, computeCodeFingerprint());
    assert.equal(st.currentCodeFingerprint, st.codeFingerprint);
    assert.equal(st.codeStale, false);
    const text = formatStatus(st);
    assert.match(text, /^ready\n/);
    for (const part of [`pid: ${pid}`, `http port: ${iso.port}`, `apeiron root: ${fx.apeironRoot}`, `artifacts root: ${fx.artifactsRoot}`, `run directory: ${iso.runDir}`, `version: ${readCliVersion()}`, `service code: ${st.codeFingerprint} (the code on disk now)`]) {
      assert.ok(text.includes(part), `${part} in\n${text}`);
    }
    const printed: string[] = [];
    const log = console.log;
    console.log = (...a: unknown[]) => { printed.push(a.map(String).join(' ')); };
    let code: number;
    try { code = await runStatus({ json: true }); } finally { console.log = log; }
    assert.equal(code, STATUS_EXIT.ready);
    assert.equal(printed.length, 1);
    assert.equal(JSON.parse(printed[0]!).pid, pid);
    const r = cli();
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`^ready\\n  pid: ${pid}\\n`));
    const j = json(cli('--json'));
    assert.equal(j.state, 'ready');
    assert.equal(j.pid, pid);
    assert.equal(j.httpPort, iso.port);
    assert.equal(j.codeStale, false);
    assert.deepEqual(files(), before, 'the lock, the socket and the token are as they were');
    assert.equal(readLock()?.pid, pid);
    assert.ok(isProcessAlive(pid));
  });

  test('a service that runs older code than the source says so', async () => {
    // The source of the working checkout is not touched to make a scratch service stale: the text of a status whose two fingerprints differ is what is checked.
    const st = await serviceStatus();
    const stale: ServiceStatus = { ...st, codeFingerprint: 'aaaaaaaaaaaa', currentCodeFingerprint: 'bbbbbbbbbbbb', codeStale: true };
    assert.match(formatStatus(stale), /service code: aaaaaaaaaaaa — differs from the code on disk \(bbbbbbbbbbbb\): the service runs older code; run: aperas service restart/);
  });

  test('a hung service (held with SIGSTOP) reads busy, exit 1; let go, it reads ready again; the lock and the process are untouched', async () => {
    const before = files();
    hold();
    try {
      const st = await serviceStatus();
      assert.equal(st.state, 'busy');
      assert.equal(st.pid, pid);
      assert.equal(st.codeFingerprint, null, 'a held service gave no answer');
      const r = cli();
      assert.equal(r.status, 1, r.stderr);
      assert.match(r.stdout, /^busy\n/);
      assert.equal(json(cli('--json')).state, 'busy');
      assert.deepEqual(files(), before);
      assert.ok(isProcessAlive(pid));
    } finally { release(); }
    assert.equal((await serviceStatus()).state, 'ready');
  });

  test('a service stopped (the exit that the idle timer also takes) reads stopped, exit 3, with no lock', async () => {
    assert.equal(await stopService(iso), true);
    assert.equal(readLock(), null);
    const st = await serviceStatus();
    assert.equal(st.state, 'stopped');
    assert.equal(st.staleLock, false);
    const r = cli('--json');
    assert.equal(r.status, 3, r.stderr);
    assert.equal(json(r).state, 'stopped');
  });

  test('a service killed (SIGKILL) leaves a lock whose process is gone: stopped, exit 3, stale, and the lock stays', async () => {
    pid = await startService(iso);
    process.kill(pid, 'SIGKILL');
    for (const deadline = Date.now() + 5_000; Date.now() < deadline && isProcessAlive(pid); ) await new Promise((r) => setTimeout(r, 20));
    assert.ok(!isProcessAlive(pid));
    const before = files();
    const st = await serviceStatus();
    assert.equal(st.state, 'stopped');
    assert.equal(st.staleLock, true);
    assert.equal(st.pid, pid);
    assert.equal(cli().status, 3);
    assert.deepEqual(files(), before, 'the stale lock is left in place');
    clearRunDir(); // the killed service cleared nothing; `after` has no service to stop
  });
});
