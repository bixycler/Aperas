/**
 * `kg:service` — direct control over the shared ApeironNgn service process. Until now the only way
 * to make a source-code change actually take effect was `ps aux | grep service | kill <pid>` by
 * hand (Node doesn't hot-reload; the service holds the whole `Store` and its own loaded code in
 * memory for as long as it runs) — `ensureServiceRunning`'s own stale-code warning
 * (`serviceClient.ts`) tells you *when* a restart is needed; this is the actual restart.
 */

import { readLock, isProcessAlive, clearLock } from './apeironNgn/serviceLock';
import { ensureServiceRunning } from './apeironNgn/serviceClient';
import { wantsHelp, printHelp } from './kgHelp';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function runRestart(): Promise<void> {
  const lock = readLock();
  if (lock && isProcessAlive(lock.pid)) {
    console.log(`[ApeironNgn kg:service] Stopping service (pid ${lock.pid})...`);
    // SIGTERM triggers the service's own graceful shutdown (service.ts) — flushes both mirrors if
    // dirty, then clears the lock itself, same as an ordinary Ctrl-C. No data lost by restarting.
    process.kill(lock.pid, 'SIGTERM');
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && isProcessAlive(lock.pid)) await sleep(100);
    if (isProcessAlive(lock.pid)) {
      throw new Error(`Service (pid ${lock.pid}) didn't stop within 10s of SIGTERM — check it manually before retrying.`);
    }
  } else {
    console.log('[ApeironNgn kg:service] No running service found.');
    if (lock) clearLock(); // a lock file whose pid is already dead — leftover from a crash, not a live claim
  }
  console.log('[ApeironNgn kg:service] Starting a fresh service...');
  await ensureServiceRunning();
  console.log('[ApeironNgn kg:service] Restarted — now running the current on-disk code.');
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  if (wantsHelp(rawArgs)) {
    printHelp({
      description: 'Direct control over the shared ApeironNgn service process.',
      usage: 'kg:service -- restart',
      args: [
        { name: 'restart', description: "Gracefully stop the running service (flushes if dirty, same as SIGTERM/Ctrl-C) and start a fresh one — the only way a source-code change takes effect, short of waiting out the 30-minute idle exit." },
      ],
      flags: [],
    });
    return;
  }
  const [subcommand] = rawArgs;
  if (subcommand !== 'restart') {
    console.error('Usage: kg:service -- restart');
    process.exit(1);
  }
  await runRestart();
}

if (process.argv[1]?.endsWith('kgService.ts')) {
  main().catch((err) => {
    console.error('[ApeironNgn kg:service] Failed:', err.message || err);
    process.exit(1);
  });
}
