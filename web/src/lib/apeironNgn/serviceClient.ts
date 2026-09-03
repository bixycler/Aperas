/**
 * ApeironNgn shared service client (Aperas-apeironngn-design.md §4 rollout step 5) — every
 * `kg:xxx` script uses this instead of calling `rehydrateStore`/`dehydrateToJsonLd` itself.
 * `ensureServiceRunning` auto-starts the service on a cold invocation, racing safely against other
 * concurrent invocations via `serviceLock.ts`'s atomic claim; `request` sends one op and returns
 * its result.
 */

import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSocketPath, readLock, claimLock, isLockStale, clearLock } from './serviceLock';
import { encodeMessage, decodeMessage, type ServiceRequest, type ServiceResponse } from './serviceProtocol';

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

async function ping(): Promise<boolean> {
  try {
    const res = await sendRaw({ op: 'ping' }, PING_TIMEOUT_MS);
    return res.ok === true;
  } catch {
    return false;
  }
}

async function waitForReady(): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await ping()) return;
    await sleep(READY_POLL_MS);
  }
  throw new Error('ApeironNgn service did not become ready in time');
}

function spawnService(): void {
  const serviceEntry = resolve(__dirname, 'service.ts');
  const webDir = resolve(__dirname, '..', '..', '..');
  const child = spawn('npx', ['tsx', serviceEntry], { cwd: webDir, detached: true, stdio: 'ignore' });
  child.unref();
}

/** Ensures a service is listening, auto-starting one if not. Safe to call from many concurrent
 *  CLI invocations at once — at most one of them spawns a new service (see serviceLock.ts). */
export async function ensureServiceRunning(): Promise<void> {
  if (await ping()) return;

  const lock = readLock();
  if (lock && isLockStale(lock)) clearLock();

  if (claimLock() === 'claimed') spawnService();

  await waitForReady();
}

export async function request<T>(req: ServiceRequest): Promise<T> {
  const res = await sendRaw(req, 0);
  if (!res.ok) throw new Error(res.error);
  return res.result as T;
}
