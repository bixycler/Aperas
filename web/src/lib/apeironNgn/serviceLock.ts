/**
 * ApeironNgn shared service singleton lock (Aperas-apeironngn-design.md §4 rollout step 5) — a
 * file-based guard so only one service process ever owns `AperasKG/Apeiron/`'s mirror at a time.
 * Liveness is decided by whether the recorded socket answers a ping (`serviceClient.ts`), not by
 * this file alone; this module only tracks enough to disambiguate a live-but-still-starting service
 * from one left behind by a crash.
 */

import { existsSync, mkdirSync, openSync, writeSync, closeSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const STARTING_GRACE_MS = 10_000;

export interface LockInfo {
  pid: number;
  socketPath: string;
  startedAt: string;
  status: 'starting' | 'ready';
}

export function getRunDir(): string {
  // web/src/lib/apeironNgn -> web/src/lib -> web/src -> web -> web/.run
  return resolve(__dirname, '..', '..', '..', '.run');
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
 *  service when multiple CLI invocations race on a cold start. */
export function claimLock(): 'claimed' | 'exists' {
  ensureRunDir();
  let fd: number;
  try {
    fd = openSync(getLockPath(), 'wx');
  } catch (err: any) {
    if (err.code === 'EEXIST') return 'exists';
    throw err;
  }
  const info: LockInfo = { pid: process.pid, socketPath: getSocketPath(), startedAt: new Date().toISOString(), status: 'starting' };
  writeSync(fd, JSON.stringify(info));
  closeSync(fd);
  return 'claimed';
}

/** Called by the service itself once its socket is actually listening — overwrites the lock with
 *  its own real pid (the claimer may have been a short-lived CLI process, not the service). */
export function markReady(): void {
  ensureRunDir();
  const info: LockInfo = { pid: process.pid, socketPath: getSocketPath(), startedAt: new Date().toISOString(), status: 'ready' };
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
