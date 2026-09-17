/**
 * `kg:reload` — the revived TDB-era `kg:import`'s equivalent (`kg:export` stays retired: there's
 * no second store to export *to* anymore). Discards the shared ApeironNgn service's in-memory
 * `Store` and rehydrates a fresh one from `AperasKG/Apeiron/` (content mirror + `.state/`) — the
 * only way to pick up a change that landed on disk after the service started (e.g. a `git pull`
 * merging someone else's commit), since nothing else re-reads the mirror once the service is
 * running (`service.ts`'s own doc comment). Flushes any unflushed in-memory work first, so nothing
 * pending is silently discarded by the reload — unless that flush is itself refused because disk
 * diverged since this service last read it (someone else's write landed while local work was
 * still pending here): `--discard` resolves that conflict by dropping the pending local mutation
 * and taking disk as-is, instead of leaving the reload stuck. `kg:flush --clobber` is the opposite
 * resolution — keep the local mutation, overwrite whatever's on disk.
 *
 * Unless `--discard` is given, this is also one of the three explicit boundaries (alongside
 * `kg:flush --clobber` and a graceful service shutdown) where the tombstone/vacuous-container/
 * stale-unfold GC sweep runs — see `service.ts#reloadStore`'s own doc comment. The counts below
 * reflect that sweep, not just the rehydrate.
 */

import { ensureServiceRunning, request } from './apeironNgn/serviceClient';
import { wantsHelp, printHelp } from './kgHelp';

export async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  if (wantsHelp(rawArgs)) {
    printHelp({
      description: 'Discard the in-memory ApeironNgn store and rehydrate it from the AperasKG/Apeiron/ mirror on disk (pick up an external change, e.g. a git pull).',
      usage: 'aperas reload [--discard]',
      flags: [
        { name: '--discard', description: "Resolve a flush conflict (disk diverged since this service last read it) by dropping the pending local mutation and taking disk's content as-is, instead of leaving the reload stuck." },
      ],
    });
    return;
  }
  const discard = rawArgs.includes('--discard');
  await ensureServiceRunning();
  const { quadCount, nodeCount, prunedTombstones, tombstonedContainers, prunedUnfolds } = await request<{
    quadCount: number;
    nodeCount: number;
    prunedTombstones: number;
    tombstonedContainers: number;
    prunedUnfolds: number;
  }>({ op: 'reload', discard });

  const gcParts: string[] = [];
  if (prunedTombstones) gcParts.push(`${prunedTombstones} unreachable tombstone(s) pruned`);
  if (tombstonedContainers) gcParts.push(`${tombstonedContainers} vacuous container(s) tombstoned`);
  if (prunedUnfolds) gcParts.push(`${prunedUnfolds} stale unfold(s) cleared`);

  console.log(
    `[ApeironNgn kg:reload] Reloaded ${quadCount} quad(s), ${nodeCount} node(s).` +
      (gcParts.length > 0 ? ` GC: ${gcParts.join(', ')}.` : '')
  );
}

if (process.argv[1]?.endsWith('kgReload.ts')) {
  main().catch((err) => {
    console.error('[ApeironNgn kg:reload] Failed:', err.message || err);
    process.exit(1);
  });
}
