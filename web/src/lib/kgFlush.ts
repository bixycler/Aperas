/**
 * `kg:flush` — forces the shared ApeironNgn service to sync its in-memory `Store` out to
 * `AperasKG/Apeiron/` right now, independent of any specific mutation (the 10s/3s timers and every
 * mutating op's own `flush: true` are the implicit ways this already happens; this is the explicit,
 * on-demand one). Without `--clobber`, this is the same guarded flush every other path already goes
 * through — refuses (throws, nothing written) if a managed mirror file changed on disk since this
 * service last read it, rather than silently overwriting whatever landed there. `--clobber` resolves
 * that conflict by writing current memory over disk unconditionally, keeping the local mutation and
 * discarding the external change — the counterpart to `kg:reload --discard`, which keeps the
 * external change and discards the local mutation instead.
 *
 * Named `--clobber`, not `--force`, since `--force` reads as what it does here — but the name isn't
 * actually what matters for `npm run kg:flush --force`'s original footgun: *any* `--flag` typed
 * after `npm run <script>` without npm's own `--` separator gets swallowed by npm's argument parser
 * before it reaches this script, recognized npm option or not (`--force` at least gets an
 * "npm warn using --force" telling you something happened; an unrecognized flag like `--clobber`
 * vanishes with no warning at all). The correct invocation is always
 * `npm run kg:flush -- --clobber` (`--` before the flag), or call this script directly:
 * `npx tsx src/lib/kgFlush.ts --clobber`.
 */

import { ensureServiceRunning, request } from './apeironNgn/serviceClient';
import { wantsHelp, printHelp } from './kgHelp';

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  if (wantsHelp(rawArgs)) {
    printHelp({
      description: 'Force an immediate sync of the ApeironNgn store out to the AperasKG/Apeiron/ mirror on disk.',
      usage: 'kg:flush -- [--clobber]',
      flags: [
        { name: '--clobber', description: "Write the current in-memory state over disk unconditionally, discarding any external change that diverged since the last read — the counterpart to `kg:reload --discard`, which keeps disk's change and discards the local mutation instead." },
      ],
    });
    return;
  }
  const clobber = rawArgs.includes('--clobber');
  await ensureServiceRunning();
  const { clobbered } = await request<{ clobbered: boolean }>({ op: 'flush', clobber });
  console.log(`[ApeironNgn kg:flush] Flushed${clobbered ? ' (clobbered — any on-disk divergence was overwritten)' : ''}.`);
}

main().catch((err) => {
  console.error('[ApeironNgn kg:flush] Failed:', err.message || err);
  process.exit(1);
});
