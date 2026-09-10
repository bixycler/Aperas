/**
 * ApeironNgn shared service singleton lock (Aperas-apeironngn-design.md §4 rollout step 5) — a
 * file-based guard so only one service process ever owns `AperasKG/Apeiron/`'s mirror at a time.
 * Liveness is decided by whether the recorded socket answers a ping (`serviceClient.ts`), not by
 * this file alone; this module only tracks enough to disambiguate a live-but-still-starting service
 * from one left behind by a crash.
 */

import { existsSync, mkdirSync, openSync, writeSync, closeSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const STARTING_GRACE_MS = 10_000;

export interface LockInfo {
  pid: number;
  socketPath: string;
  startedAt: string;
  status: 'starting' | 'ready';
  /** The Apeiron (JSON-LD mirror) and artifacts (markdown tree) roots this service instance is
   *  bound to for its whole lifetime — resolved once, at `aperas service start`/`restart` time,
   *  from *that* invocation's own `process.cwd()` (AperasKG/artifacts/discussion/packaging.md's
   *  "Settled: no concurrency..." note). Carried here mainly for `aperas service start`'s own
   *  "already running, bound to X" status line — nothing reads it back to re-derive a path. */
  apeironRoot: string;
  artifactsRoot: string;
}

/** Fixed, well-known location for the lock file and socket — independent of both `process.cwd()`
 *  (so it doesn't matter which directory a CLI command happens to run from) and of where the code
 *  itself is installed (so it doesn't need the dev-vs-built hop-counting every other path in this
 *  codebase has needed — see `graphConfig.ts#resolveFallbackGraphRoot`'s own doc comment for that
 *  bug class). `$XDG_RUNTIME_DIR` is exactly what this kind of ephemeral, per-login-session state
 *  (sockets, pid files) is for; a `tmpdir()`-based fallback, namespaced by uid, covers a platform
 *  or session where it isn't set. */
export function getRunDir(): string {
  if (process.env.XDG_RUNTIME_DIR) return resolve(process.env.XDG_RUNTIME_DIR, 'aperas');
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  return resolve(tmpdir(), `aperas-${uid}`);
}

export function getLockPath(): string {
  return resolve(getRunDir(), 'apeironngn.lock');
}

export function getSocketPath(): string {
  return resolve(getRunDir(), 'apeironngn.sock');
}

function ensureRunDir(): void {
  const dir = getRunDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function readLock(): LockInfo | null {
  try {
    return JSON.parse(readFileSync(getLockPath(), 'utf-8')) as LockInfo;
  } catch {
    return null;
  }
}

/** Atomically claims the lock (exclusive create) — the only safe way to decide who starts the
 *  service when multiple `aperas service start`/`restart` invocations race. `apeironRoot`/
 *  `artifactsRoot` are whatever the claiming invocation just resolved from its own
 *  `process.cwd()`, recorded here so they survive into `markReady()`'s own rewrite below. */
export function claimLock(apeironRoot: string, artifactsRoot: string): 'claimed' | 'exists' {
  ensureRunDir();
  let fd: number;
  try {
    fd = openSync(getLockPath(), 'wx');
  } catch (err: any) {
    if (err.code === 'EEXIST') return 'exists';
    throw err;
  }
  const info: LockInfo = { pid: process.pid, socketPath: getSocketPath(), startedAt: new Date().toISOString(), status: 'starting', apeironRoot, artifactsRoot };
  writeSync(fd, JSON.stringify(info));
  closeSync(fd);
  return 'claimed';
}

/** Called by the service itself once its socket is actually listening — overwrites the lock with
 *  its own real pid (the claimer may have been a short-lived CLI process, not the service) and the
 *  same roots it was actually bound to (`apeironNgn/service.ts`'s own `main()`, not re-resolved
 *  here). */
export function markReady(apeironRoot: string, artifactsRoot: string): void {
  ensureRunDir();
  const info: LockInfo = { pid: process.pid, socketPath: getSocketPath(), startedAt: new Date().toISOString(), status: 'ready', apeironRoot, artifactsRoot };
  writeFileSync(getLockPath(), JSON.stringify(info));
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err.code !== 'ESRCH';
  }
}

/** A 'ready' lock is stale once its pid is dead. A 'starting' lock's pid may belong to the
 *  short-lived CLI process that claimed it (already exited normally while the detached service
 *  keeps starting up on its own) — not a reliable liveness signal — so staleness during 'starting'
 *  is decided by the grace window alone. */
export function isLockStale(lock: LockInfo): boolean {
  if (lock.status === 'ready') return !isProcessAlive(lock.pid);
  return Date.now() - Date.parse(lock.startedAt) > STARTING_GRACE_MS;
}

export function clearLock(): void {
  for (const p of [getLockPath(), getSocketPath()]) {
    try {
      unlinkSync(p);
    } catch (err: any) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
}
