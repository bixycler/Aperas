/**
 * `kg:unlink` — removes a manually-added `kg:link` between two nodes, via the shared ApeironNgn
 * service (Aperas-apeironngn-design.md §4 rollout step 5, §5's missing-removal-counterpart fix).
 * Non-interactive, unlike `kg:link`: unlike "add a link to one of several candidate blocks," a
 * removal already needs both endpoints named explicitly, so there's no useful candidate list to
 * prompt over.
 */

import { ensureServiceRunning, request } from './apeironNgn/serviceClient';
import { runRemoveBlockLink } from './kgLink';
import { wantsHelp, printHelp } from './kgHelp';

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  if (wantsHelp(rawArgs)) {
    printHelp({
      description: "Remove a manually-added kg:link between two nodes. Scoped to manual (references) links only — a wikilink is self-managing and would just reappear on the next ingestion if force-removed here.",
      usage: 'kg:unlink -- <block> <target> [--flush]',
      args: [
        { name: '<block>', description: 'Block the manual link is on (path, deep path, bare node code, or full id).' },
        { name: '<target>', description: 'Link target to remove (same addressing as <block>).' },
      ],
      flags: [
        { name: '--flush', description: 'Force an immediate sync to disk after this call, instead of waiting for the normal flush timer.' },
      ],
    });
    return;
  }
  const flush = rawArgs.includes('--flush');
  const [blockRef, targetRef] = rawArgs.filter((p) => p !== '--flush');
  if (!blockRef || !targetRef) {
    console.error('Usage: kg:unlink -- <block> <target> [--flush]');
    process.exit(1);
  }

  await ensureServiceRunning();
  const { removed } = await request<ReturnType<typeof runRemoveBlockLink>>({
    op: 'removeBlockLink',
    blockId: blockRef,
    targetRef,
    flush,
  });
  if (!removed) {
    console.log(`[ApeironNgn kg:unlink] No manual link from '${blockRef}' to '${targetRef}' found.`);
    process.exit(1);
  }
  console.log(`[ApeironNgn kg:unlink] Removed the manual link from '${blockRef}' to '${targetRef}'.`);
}

if (process.argv[1]?.endsWith('kgUnlink.ts')) {
  main().catch((err) => {
    console.error('[ApeironNgn kg:unlink] Failed:', err.message || err);
    process.exit(1);
  });
}
