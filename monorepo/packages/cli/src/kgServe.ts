/**
 * `aperas serve` — the packaged, end-user-facing entry point (Slice 16): ensures a service is
 * running for the graph resolved from the current directory (`runStart`, `kgService.ts` — the exact
 * same behavior `aperas service start` already has, reused rather than reimplemented), then prints
 * the URL of that service's production HTTP+auth listener (Slices 2-3). The listener and its static
 * asset serving do everything else from there — this command's whole job is making sure the right
 * service exists and telling the user where to look.
 */

import { runStart } from './kgService';
import { readLock } from './apeironNgn/serviceLock';
import { wantsHelp, printHelp } from './kgHelp';

export async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  if (wantsHelp(rawArgs)) {
    printHelp({
      description: 'Start (or reuse) the ApeironNgn service for the graph in the current directory, and print the URL of its webapp.',
      usage: 'aperas serve',
    });
    return;
  }
  await runStart();
  const lock = readLock();
  if (!lock) throw new Error('Service did not report a lock after starting — this should not happen.');
  console.log(`[ApeironNgn kg:serve] Open http://127.0.0.1:${lock.httpPort} in a browser.`);
}

if (process.argv[1]?.endsWith('kgServe.ts')) {
  main().catch((err) => {
    console.error('[ApeironNgn kg:serve] Failed:', err.message || err);
    process.exit(1);
  });
}
