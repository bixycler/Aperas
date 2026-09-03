/**
 * `kg:reload` — the revived TDB-era `kg:import`'s equivalent (`kg:export` stays retired: there's
 * no second store to export *to* anymore). Discards the shared ApeironNgn service's in-memory
 * `Store` and rehydrates a fresh one from `AperasKG/Apeiron/` (content mirror + `.state/`) — the
 * only way to pick up a change that landed on disk after the service started (e.g. a `git pull`
 * merging someone else's commit), since nothing else re-reads the mirror once the service is
 * running (`service.ts`'s own doc comment). Flushes any unflushed in-memory work first, so nothing
 * pending is silently discarded by the reload.
 */

import { ensureServiceRunning, request } from './apeironNgn/serviceClient';

async function main(): Promise<void> {
  await ensureServiceRunning();
  const { quadCount, nodeCount } = await request<{ quadCount: number; nodeCount: number }>({ op: 'reload' });
  console.log(`[ApeironNgn kg:reload] Reloaded ${quadCount} quad(s), ${nodeCount} node(s).`);
}

main().catch((err) => {
  console.error('[ApeironNgn kg:reload] Failed:', err.message || err);
  process.exit(1);
});
